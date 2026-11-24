#!/usr/bin/env python3
"""Rebuild the versioned catalog from the unchanged business attachment; no inference calls."""
import hashlib, json, re, sys, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


def clean(text):
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    return re.sub(r"\\([\\`*_{}\[\]()#+\-.!])", r"\1", text).strip()


meta = [
    (
        "mindflow",
        "Mindflow 产品发布",
        20,
        ["三张 UI 均参与演示", "三个卖点清楚、无虚构功能"],
    ),
    ("manus-template", "Manus 风格发布模板", None, ["具体产品名或 URL 未提供"]),
    (
        "hush-buds",
        "Hush Buds 耳机发布",
        20,
        ["真人展示素材缺失，不能仅用产品动效宣称完整通过"],
    ),
    (
        "paper-template",
        "Paper Trail 品牌模板",
        None,
        ["品牌参数、模板代码、图像槽位与音轨缺失"],
    ),
    (
        "coffee-journey",
        "咖啡豆的拼贴旅程",
        None,
        ["种植园→城市咖啡馆的旅程可理解", "纸张拼贴风格"],
    ),
    (
        "protein-age",
        "不同年龄的蛋白质需求",
        None,
        ["年龄差异表达清楚", "营养信息需要人工核验，不能只检查排版"],
    ),
    (
        "sleep-age",
        "不同年龄的睡眠时长",
        None,
        ["年龄分组与时长关系清楚", "健康信息需要人工核验"],
    ),
    (
        "microwave",
        "微波炉内部原理",
        None,
        ["可辨认的炉体与内部工作关系", "结构拆解帮助解释原理，不仅是文字标签"],
    ),
    (
        "reel-projector",
        "Seko REEL 01 放映机",
        None,
        [
            "双盘胶片、片门与压片板、输片齿轮与胶片、灯室与聚光镜可辨认",
            "产品全貌及细节特写",
            "准确出现产品名与两句指定文案",
        ],
    ),
    (
        "time-pause",
        "暂停时间的超能力",
        None,
        ["暂停与未暂停状态形成可理解的情节和空间对比"],
    ),
    (
        "airtag",
        "AirTag 远程定位",
        None,
        ["解释没有自身 GPS/网络时的定位链路", "不得把设问误解为完全不依赖任何外部网络"],
    ),
    (
        "earth-tunnel",
        "穿过地球的隧道",
        None,
        ["空间位置与运动关系可辨认", "说明理想化设定，不伪装成现实可行工程"],
    ),
    (
        "sitcom-template",
        "卡通情景喜剧模板",
        60,
        ["受众、主题、逐字台词、片尾等仍是占位符"],
    ),
    (
        "postit",
        "便利贴的意外发明",
        None,
        ["马克笔手绘漫画风格", "因果故事及史实人工核验"],
    ),
    (
        "neighbor",
        "NEIGHBOR 邻里品牌",
        None,
        ["八个主题完整", "品牌名、标语、结尾文案准确", "温暖邻里日常及矢量图风格"],
    ),
    (
        "no-sleep",
        "连续不睡觉的变化",
        None,
        ["变化过程可理解", "健康风险与科学表述人工核验"],
    ),
    (
        "caffeine",
        "咖啡因影响大脑",
        None,
        ["咖啡因与脑部作用的因果解释", "Violet Flat 参考仅为风格，不是内容答案"],
    ),
    (
        "animal-vision",
        "动物视觉世界",
        None,
        ["不同视觉能力有可辨认差异", "Pixel Night 风格"],
    ),
    (
        "civilization",
        "文明科技闯关",
        None,
        [
            "石器时代→太空时代的递进",
            "每关解锁对应时代科技",
            "游戏闯关与 Pixel Night 风格",
        ],
    ),
]
source = ROOT / "source/business-20261124/Code2Video Seko需求.md"
section = source.read_text().split("# 测试集", 1)[1].split("# 部分竞品", 1)[0]
rows = [x for x in section.splitlines() if x.startswith("|")][2:]
assert len(rows) == len(meta) == 19
assets = {}


def asset(path, role):
    path = path.resolve()
    digest = sha(path)
    aid = "asset-" + digest[:16]
    if aid not in assets:
        assets[aid] = {
            "id": aid,
            "path": str(path.relative_to(ROOT)),
            "sha256": digest,
            "bytes": path.stat().st_size,
            "name": path.name,
            "roles": [],
        }
    if role not in assets[aid]["roles"]:
        assets[aid]["roles"].append(role)
    return aid


cases = []
category = ""
for i, (row, (slug, title, duration, checks)) in enumerate(zip(rows, meta), 1):
    cells = row[1:-1].split("|")
    assert len(cells) == 3
    category = clean(cells[0]) or category
    raw = clean(cells[1])
    refs = []
    outputs = []
    for p in re.findall(r"!\[[^\]]*\]\(([^)]*)\)", cells[1]):
        refs.append(asset(source.parent / urllib.parse.unquote(p), "input"))
    for label, target in re.findall(r"\[([^\]]+)\]\(([^)]*)\)", cells[2]):
        url = (
            target
            if target.startswith("https://")
            else label if label.startswith("https://") else None
        )
        if url:
            outputs.append(
                {
                    "kind": "reference_output",
                    "url": url,
                    "model": None,
                    "model_status": "unknown",
                    "quality_status": "business_reference_not_gold",
                }
            )
        elif target:
            outputs.append(
                {
                    "kind": "reference_output",
                    "asset_id": asset(
                        source.parent / urllib.parse.unquote(target), "reference_output"
                    ),
                    "model": None,
                    "model_status": "unknown",
                    "quality_status": "business_reference_not_gold",
                }
            )
    visual_notes = {
        1: "参考片约 15 秒，抽帧出现宠物业务画面；不是 20 秒 Mindflow 需求的内容答案。",
        5: "抽帧是 THE SHORTCUT / MAKE YOUR OWN WAY 的城市纸拼贴，未见咖啡豆旅程；只作拼贴风格参考。",
        9: "抽帧见 DREAMINA REEL 01，当前 prompt 写 Seko REEL 01，参考片品牌对应关系尚未确认。测试输出以 prompt 为准；若生成品牌名或指定文案有误，记录为指令偏差。",
        14: "抽帧展示议会、法案和表决流程，与便利贴发明不同；只作马克笔漫画风格参考。",
    }
    for o in outputs:
        o["use"] = (
            "style_or_structure_only" if i in visual_notes else "reference_not_gold"
        )
        o["inspection_note"] = visual_notes.get(
            i, "仅做关键帧抽查，尚未完成全片质量评价。"
        )
    state = "ready" if i not in [2, 3, 4, 13] else "blocked_missing_input"
    reasons = {
        2: "这是风格/skill 说明，缺少具体产品名称或网站。",
        3: "原要求需要真人展示视频，但只提供产品图；C2V 不负责合成真人视频。",
        4: "缺少已准备好的模板及品牌字段，不能按占位符直接生产。",
        13: "主题、指定台词、片尾等尚未填写；示例值不是确认需求。",
    }
    exact = []
    if i == 9:
        exact = ["Seko REEL 01", "把光放进胶片", "Seko · 放映开始"]
    if i == 15:
        exact = [
            "NEIGHBOR",
            "问好",
            "归属",
            "关心",
            "美好",
            "共享",
            "相遇",
            "日常",
            "互助",
            "每一声问好，都让我们更近一点",
            "好邻居，从问好开始",
        ]
    cases.append(
        {
            "id": f"{i:02d}-{slug}",
            "title": title,
            "category": category,
            "source_row": i,
            "status": state,
            "block_reason": reasons.get(i),
            "prompt_original": raw,
            "prompt_submitted": f"视频类型：{category}\n\n{raw}",
            "prompt_adapter": "category-prefix-v1",
            "input_assets": refs,
            "reference_outputs": outputs,
            "requirements": {
                "duration_seconds": duration,
                "aspect_ratio": "16:9" if i in [1, 3, 13] else None,
                "exact_text": exact,
                "quality_checks": checks,
            },
            "notes": [
                "未指定时长、分辨率或音轨的项目，不由 benchmark 擅自补成硬约束。",
                "参考成片不作为模型输入，也不是理想标准。",
            ],
        }
    )
corrections = json.loads((ROOT / "dataset/v0.1.0/corrections.json").read_text())
for correction in corrections:
    assert correction["type"] == "move_reference_outputs"
    source_case = next(c for c in cases if c["id"] == correction["from_case"])
    target_case = next(c for c in cases if c["id"] == correction["to_case"])
    assert not target_case["reference_outputs"]
    target_case["reference_outputs"] = source_case["reference_outputs"]
    source_case["reference_outputs"] = []
    source_case["notes"].append(correction["basis"])
    for output in target_case["reference_outputs"]:
        output["use"] = "reference_not_gold"
        output["inspection_note"] = correction["inspection_note"]
    target_case["notes"].append(correction["basis"])
sys.path.insert(0, str(ROOT / "bench"))
from gate import evaluate_gate, adapt_prompt
intakes = json.loads((ROOT / "dataset/v0.1.0/gate-intake.json").read_text())
for case in cases:
    intake = intakes[case["id"]]
    assert intake["source_evidence"]["excerpt"] in case["prompt_original"]
    case["gate_intake"] = intake
    case["skill_gate"] = evaluate_gate(intake)
    case["skill_policy"] = case["skill_gate"]["recommended_policy"]
    case["prompt_submitted"], case["prompt_adapter"] = adapt_prompt(case["category"], case["prompt_original"], case["skill_gate"])
anatomy = json.loads(
    (
        ROOT / "runtime/discovery/assets/experimental-skills/anatomy/provenance.json"
    ).read_text()
)
cat = json.loads((ROOT / "runtime/discovery/live-catalog.json").read_text())
policies = {
    "c2v-core-v1": {"builtin": "coding_to_video", "configured": []},
    "c2v-anatomy-v1": {
        "builtin": "coding_to_video",
        "configured": [
            {
                "id": "anatomy",
                "version": "1482e8469b0a9e0d8cc18ea2740a01423d29ae80",
                "archive_sha256": "d7c3b72c54099de6d333745c385a287613d220e13236a2bd9dbe17b1ae5675a0",
            }
        ],
    },
}
showcases = []
titles = [
    "Ebru 水拓艺术",
    "玻璃金色马赛克",
    "Risograph 鸟群",
    "按钮与灯泡结构拆解",
    "Anatomy 结构片修改版",
    "THE FIRST SPARK",
    "A THOUSAND YEARS IN ONE PAGE",
]
from datetime import datetime

for rec in json.loads((ROOT / "runtime/discovery/showcase-metadata.json").read_text()):
    j = rec["job"]
    p = (
        ROOT.parents[2]
        / "01_video_showcase"
        / ("experimental-" + j["id"][:12] + ".mp4")
    )
    # Historical metadata is evidence; keep heavy files in their existing directory.
    prefix = j["id"].split("-")[0]
    order = [
        "job_00a15f49",
        "job_1c51c95e",
        "job_33f1ea7b",
        "job_eb29b834",
        "job_b34ef9de",
        "job_f592e7ec",
        "job_ba6d7fe3",
    ]
    idx = order.index(prefix)
    video = ROOT.parents[2] / "01_video_showcase" / f"experimental-{prefix}.mp4"
    showcases.append(
        {
            "id": prefix,
            "title": titles[idx],
            "job_id": j["id"],
            "session_id": j["session_id"],
            "prompt": j["prompt"],
            "model_selection": j["model_selection"],
            "experimental_skills": j["experimental_skills"],
            "status": j["status"],
            "started_at": j["started_at"],
            "finished_at": j["finished_at"],
            "wall_seconds": (
                datetime.fromisoformat(j["finished_at"].replace("Z", "+00:00"))
                - datetime.fromisoformat(j["started_at"].replace("Z", "+00:00"))
            ).total_seconds(),
            "is_revision": idx == 4,
            "video_filename": video.name,
            "video": {
                k: j["result_asset"].get(k)
                for k in ["duration_ms", "width", "height", "size_bytes"]
            },
            "evaluation": "历史展示素材，非本套测试结果；不纳入通过率。",
        }
    )
suite = {
    "schema_version": 1,
    "id": "seko-c2v-business",
    "version": "0.1.0",
    "created_at": "2026-11-24",
    "source": {
        "archive_sha256": json.loads((ROOT / "source/manifest.json").read_text())[
            "archive_sha256"
        ],
        "document": str(source.relative_to(ROOT)),
    },
    "code_baseline": {
        "remote_commit": "3230dd268bddce8a69b18ea4661d4a82064997b9",
        "web_version": "1.5.7",
        "harness": "Claude Code",
        "generation_mode": "experimental",
    },
    "source_corrections": corrections,
    "policies": policies,
    "cases": cases,
    "assets": list(assets.values()),
}
save(ROOT / "dataset/v0.1.0/suite.json", suite)
save(
    ROOT / "dataset/v0.1.0/baselines.json",
    {
        "business_reference_models": "unknown",
        "live_catalog_as_of": "2026-11-24",
        "configured_models": cat["/api/experimental/models"]["models"],
        "connectivity_tested": False,
        "showcases": showcases,
        "anatomy_source": anatomy,
    },
)
print(
    json.dumps(
        {
            "cases": len(cases),
            "ready": sum(c["status"] == "ready" for c in cases),
            "assets": len(assets),
            "suite_sha256": sha(ROOT / "dataset/v0.1.0/suite.json"),
        }
    )
)
