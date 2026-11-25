# Seko C2V benchmark · 测试台 0.1.3 / 测试集 0.1.3

本目录用于 C2V 业务需求整理、网页提交模型测试和独立评价。与既有白模 benchmark、Seko 白模 skill/harness 分开维护。

- [需求与边界](docs/需求与边界.md)
- [21 案测试清单](docs/测试集.md)：原始 prompt、输入图片、参考成片、就绪状态；完整机器清单在 `dataset/v0.1.3/suite.json`。
- [代码与 Anatomy 接入说明](docs/代码与Anatomy.md)
- [结构拆解适配 Gate](docs/Anatomy适配Gate.md)：微波炉、放映机适用；按需求目标判断，不做关键词路由。
- [测试方法和统计口径](docs/测试方法.md)
- [Baseline 来源](docs/Baseline.md)
- [使用及维护](docs/使用及维护.md)

## 启动网页

Python 3.8+；测试台无第三方 Python 依赖。原片检测另需 `ffmpeg`、`ffprobe`。在本目录运行：

```bash
python3 bench/server.py --port 18942 --showcase-root /home/tongronglei/work/02_code_video/01_video_showcase
```

打开 **http://127.0.0.1:18942/**。不登录可浏览全部案例、原始素材与业务参考；登录 dev 普通账号后可选择模型、保存计划、提交队列、比较成片、评价和导出。默认对接 `http://10.210.9.14:20211`。不改现有 dev 页面和默认模型。

`source/` 原始资料与缓存媒体、`runtime/` 结果/检查证据不进远程代码 Git。`dataset/` 固定测试定义，`bench/` 测试台代码，`tests/` 必要回归，`docs/` 使用与协议说明进入工程版本管理。大文件保留一份，原 ZIP 中相同内容已硬链接去重。历史 7 个 showcase 读取原目录，不复制约 0.94 GB 成片。

当前 **20 行拆为 21 案，20 案可测试，仅 Hush Buds 缺真人素材**。0.1.3 逐案原文直接提交，不追加类型或制作要求；仅 Paper Trail 拆为 Kestrel / YETI 两案。详见[本版对齐及原文规则](docs/测试集变更-0.1.3.md)。本轮未提交任务，先前两条拼贴任务已取消。历史结果按各自冻结版本查看，不计入新版通过率。


## 审核已生成结果

打开 `http://127.0.0.1:18942/?tab=results` 查看按任务并排的模型结果；结果页可选择测试集版本，历史 0.1.0 视频仍可查看，按当时冻结要求评价；“逐案审核”显示验收要点、两组视频、原始/提交 prompt、输入图和业务参考，可保存带时间点证据的评价。默认 2 倍速，动作、剪辑与音画同步检查建议切回 1 倍速。

原片在 `runtime/originals/<model>/<case>/<run>.mp4`，不转码。`runtime/review/审核索引.md` 与 CSV/JSON 用于离线查阅；原片旁的 JSON 和 `任务说明.md` 保留需求、来源、版本与校验信息。下载、解码与内容评价分别记录，撤回批次不混入正式结果。批量下载/导出操作见[使用及维护](docs/使用及维护.md)。

## 当前原文校验

```bash
python3 tools/validate_dataset.py --suite-version 0.1.3 --media
python3 -m unittest discover -s tests -p 'test*.py'
node tests/test_web_versions.js
```

`dataset/v0.1.3/prompts/` 为逐案原文；`business-text.json` 保留业务文字块证据。旧版和取消记录保留供追溯，不自动恢复生成。
