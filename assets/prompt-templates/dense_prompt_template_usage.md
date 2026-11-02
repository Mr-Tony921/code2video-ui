# Dense prompt 模板使用说明

模板文件：[dense_prompt_template.md](dense_prompt_template.md)

用途：输入用户的原始做视频指令和上传的素材，交给 Opus 5.5，让它先判断这是不是一个做视频的请求；如果是，就生成一份详细的 dense prompt，交给 code-to-video 模型去做视频。

## 输入

模板里有两个占位符，调用前替换掉：

| 占位符 | 内容 |
|---|---|
| `{{USER_INSTRUCTION}}` | 用户的原始指令，原样放入 |
| `{{ASSETS_JSON}}` | 素材列表（JSON 数组），没有素材时填 `[]` |

素材列表里每个对象的字段：

| 字段 | 是否必填 | 说明 |
|---|---|---|
| `path` | 必填 | 素材在任务目录里的相对路径，例如 `assets/refer.mp4`。生成的 dense prompt 会原样引用这个路径，所以要和最终放进任务目录的路径一致 |
| `type` | 必填 | `image`、`video`、`audio` 或 `other` |
| `note` | 可选 | 用户对这个素材说了什么，例如"参考这个视频的风格""这是我们的 logo" |
| `meta` | 建议填 | 实测信息：时长、分辨率、帧率、是否有音轨等（用 ffprobe 测）。有了它模型能自己算，例如"这段 24 s，要在 5 s 内放完，就是 4.8 倍速" |
| `description` | 可选 | 素材内容的文字描述（caption 或摘要） |

示例：

```json
[
  {"path": "assets/refer.mp4", "type": "video",
   "note": "复刻这个视频的风格",
   "meta": {"duration_s": 30.0, "width": 1920, "height": 1080, "fps": 60, "has_audio": true},
   "description": "一个 SaaS 产品宣传片，深色背景，白色大标题"},
  {"path": "assets/logo.png", "type": "image", "note": "我们的 logo"}
]
```

**素材本身不会发给写 dense prompt 的模型**，它只能看到上面这些字段。模板因此要求模型：

- 不描述素材里它没看到的内容（颜色、版式、文字、镜头、节奏等），只用 `note`、`description` 和 `meta` 里给出的信息。
- 片子依赖素材细节时，在 dense prompt 里让做片子的模型（它能拿到文件）先自己分析素材，例如抽帧、找剪辑点、读出画面文字、取主色、分析配乐节拍，写进 `SPEC.md`，后面的指令再引用这些分析结果。

所以 `description` 写得越具体（风格、主要内容、画面文字、节奏等），生成的 prompt 就越具体；没有 `description` 时，prompt 会更多地依赖做片子的模型自己分析素材。

## 输出

模型只返回一个 JSON 对象：

```json
{"is_video_request": true, "dense_prompt": "Make a 30-second ...\n\n## Format\n..."}
```

| 字段 | 说明 |
|---|---|
| `is_video_request` | 布尔值。要做或修改视频，或者描述了一个要做的视频：`true`。提问、闲聊、只要静态图片或海报、只分析已有视频不做新视频：`false`。模糊情况倾向于 `true` |
| `dense_prompt` | 完整的 dense prompt，是一个 Markdown 字符串；`is_video_request` 为 `false` 时是 `null` |

## 模板让模型做什么

1. **先判断。** 给了"算视频请求"和"不算"的明确规则和例子。
2. **写之前先在心里分析：** 片子的核心想法、片子类型、用户定死的要求和留给模型决定的选择，以及这部片子最难的两三处。每个难点在 prompt 里都要有一条具体规则和一项检查。
3. **用户没说时的默认值：**
   - 时长按片子类型选（社交短片 10–20 s，宣传片 15–45 s，科普 45–120 s，艺术片 20–90 s，MV 跟随音乐长度）。
   - 画幅：默认 1920×1080；提到手机、竖屏、抖音、小红书、Reels 等就用 1080×1920；要方形就用 1080×1080。
   - 默认有音乐和音效；只有科普、儿童内容或用户要求时才加旁白，有旁白就加字幕。
   - 不编造真实品牌、真人、价格、数据或宣传语。
4. **按用途处理素材，并用准确路径引用：** 复刻参考、借鉴风格、片中播放的视频、logo、产品照片或截图、配乐、旁白录音、要动起来的图片、数据文件，各有各的规则。例如复刻要先逐帧分析、用 SSIM 对比、不能拷贝原片像素、不复刻水印；片中播放的视频按"时长 ÷ 画面时长"算倍速，而且不能被遮挡。模型看不到素材，所以不编造素材内容；需要的细节写成让做片子的模型先分析文件再使用。
5. **13 个必备部分：** 开场陈述、格式、素材、精确内容、画面风格、版式布局、运镜、分段时间表（各段起止时间加起来等于总时长）、动作、声音、制作要求、检查和修改、交付规格。
6. **返回前自检：** 用户要求和素材路径都在，时间加总正确，屏幕文字逐字给出，没有编造内容，声音和画面事件挂钩，每个难点都有检查。

## 两个设计选择

- **语言：** dense prompt 正文用英文，和我们 benchmark 里的 prompt 一致。凡是会出现在片子里的文字（标题、旁白、按钮文字），都按片子本身的语言逐字给出，所以中文片子也没问题。
- **不含 output contract：** dense prompt 里不写项目路径和交付位置，这部分由 `prepare_run.py` / `new_session.py` 在后面追加。素材路径统一写成 `assets/...`，和任务目录结构对得上。

## 调用示例

最简单的方式是把填好的整份模板作为一条 user 消息发出去：

```python
import json, subprocess
from pathlib import Path

def probe(path):
    """用 ffprobe 测视频/音频素材的 meta（图片可以跳过）。"""
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                          "format=duration:stream=codec_type,width,height,r_frame_rate",
                          "-of", "json", path], capture_output=True, text=True).stdout
    d = json.loads(out)
    v = next((s for s in d.get("streams", []) if s["codec_type"] == "video"), {})
    meta = {"duration_s": round(float(d["format"]["duration"]), 3)} if "duration" in d.get("format", {}) else {}
    if v:
        num, den = map(int, v["r_frame_rate"].split("/"))
        meta.update(width=v["width"], height=v["height"], fps=round(num / den, 3))
    meta["has_audio"] = any(s["codec_type"] == "audio" for s in d.get("streams", []))
    return meta

instruction = "做一个 30 秒的产品宣传片，参考 refer.mp4 的风格，结尾放我们的 logo"
assets = [
    {"path": "assets/refer.mp4", "type": "video", "note": "风格参考", "meta": probe("assets/refer.mp4")},
    {"path": "assets/logo.png", "type": "image", "note": "我们的 logo"},
]

tpl = Path("dense_prompt_template.md").read_text()
msg = (tpl.replace("{{USER_INSTRUCTION}}", instruction)
          .replace("{{ASSETS_JSON}}", json.dumps(assets, ensure_ascii=False, indent=2)))

# 把 msg 发给 Opus 5.5，拿到回复文本 text 后解析：
def parse(text):
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        t = text.strip()
        if t.startswith("```"):                       # 万一被包在代码块里
            t = t.split("\n", 1)[1].rsplit("```", 1)[0]
        return json.loads(t)

# out = parse(text)
# if out["is_video_request"]: Path("prompt_dense.md").write_text(out["dense_prompt"])
```

## 接到 benchmark 流程

把输出的 `dense_prompt` 存成任务目录里的 `prompt_dense.md`，素材放进同一任务目录的 `assets/`，就能直接用现有流程跑：

- 批量：放进 `benchmark/<类别>/<任务名>/`，再补一个 `meta.json`，然后 `python3 prepare_run.py --categories <类别>`。
- 交互：`python3 new_session.py <名字> --prompt prompt_dense.md --skills ../benchmark/skills --assets <素材目录>`。

注意 `path` 要和素材最终在任务目录里的位置一致（`assets/<文件名>`），否则生成的 prompt 会引用错的路径。
