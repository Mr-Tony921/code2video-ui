# Seko C2V benchmark · 0.1.0

本目录用于 C2V 业务需求整理、网页提交模型测试和独立评价。与既有白模 benchmark、Seko 白模 skill/harness 分开维护。

- [需求与边界](docs/需求与边界.md)
- [19 案测试清单](docs/测试集.md)：原始 prompt、输入图片、参考成片、就绪状态；完整机器清单在 `dataset/v0.1.0/suite.json`。
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

当前 19 条中 **15 条可提交，4 条待补充输入**。参考成片的生成模型全部未知。7 个历史 showcase 单列，不计入本版通过率。本次构建测试基建，不代表已经完成 15 案的新一轮模型生成测试。
