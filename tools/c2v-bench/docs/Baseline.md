# Baseline 来源与模型记录

## 业务参考输出

19 案中 16 案有参考成片、3 案未提供。所有业务参考的生成模型均未知；域名或水印不能用来推断底层模型。它们不是理想效果，其中部分仅提供风格参考，详见案例说明。12 个视频来自 ZIP，4 个为原文公开外链，现已缓存。

## 历史 Showcase（不计本套通过率）

| 展示片 | 实际模型 | builtin / 自定义技能 | 视频时长 | 该轮执行墙钟 | 轮次 |
|---|---|---|---|---|---|
| Ebru 水拓艺术 | claude-opus-5-5/ccmax/sfa | none / 无 | 51s | 597.8min | 历史展示（不计本版首轮） |
| 玻璃金色马赛克 | claude-opus-5-5/ccmax/sfa | none / 无 | 80s | 64.8min | 历史展示（不计本版首轮） |
| Risograph 鸟群 | claude-opus-5-5/ccmax/sfa | none / 无 | 70s | 233.9min | 历史展示（不计本版首轮） |
| Anatomy 结构片修改版 | claude-opus-5-5/ccmax/sfa | none / anatomy | 30s | 76.6min | 追问修改 |
| A THOUSAND YEARS IN ONE PAGE | claude-opus-5-5/ccmax/sfa | none / 无 | 40s | 135.4min | 历史展示（不计本版首轮） |
| 按钮与灯泡结构拆解 | claude-opus-5-5/ccmax/sfa | none / anatomy | 18s | 19.1min | 历史展示（不计本版首轮） |
| THE FIRST SPARK | claude-opus-5-5/ccmax/sfa | none / 无 | 60s | 109.9min | 历史展示（不计本版首轮） |

来源为 dev job 原记录，不是文件名猜测。完整 job/session/model revision/skill revision 已记录在 `baselines.json`。5 案未挂 builtin C2V，2 案挂 Anatomy，其中放映结构修改片为 follow-up；不同策略不能直接形成当前模型通过率排名。执行墙钟包含代码制作、工具、自检和渲染，不是纯 inference。

## 2026-11-24 实际可见实验模型目录

| Profile | 模型 | 上下文 / 输出上限 | Revision | 当前连通性 |
|---|---|---|---|---|
| enhancement-default | claude-opus-5-5/ccmax/sfa | 未明确 / 未明确 | 0aecba933ae778cf | 本轮未做推理测试 |
| intranet-default | SenseNova-6.8-Code2Video | 524288 / 64000 | 946737839da509e0 | 本轮未做推理测试 |
| tokenhub-fable-52-sfo-test | claude-fable-5-2/anthropic_L/sfo | 未明确 / 未明确 | 1bd7b88e0f9c3c5d | 本轮未做推理测试 |
| tokenhub-gemini-4-argon | gemini-4-argon/aistudio_S/sfk | 未明确 / 未明确 | 574449fca6a541c6 | 本轮未做推理测试 |
| tokenhub-deepseek-v41-flash | deepseek-v4.1-flash-1017/zijian/sfb | 未明确 / 未明确 | 48e2f8a63e34488f | 本轮未做推理测试 |
| deepseekv41-c2v1-0 | deepseekv41-c2v1-0 | 524288 / 64000 | 33eb8505ce272da5 | 本轮未做推理测试 |
| jiaoyu-video-20261118 | jiaoyu-video | 1048576 / 64000 | be9b1b1c890fe367 | 本轮未做推理测试 |
| managed-551b3e6ba4ef1f5d354c16355622146e | deepseekv41-c2v1-1 | 1024000 / 64000 | 551b3e6ba4ef1f5d | 本轮未做推理测试 |

目录中当前没有 GPT 6.1 Sol。白模服务里有 GPT 配置不等于 C2V 的 CC 实验链路已有该配置，后续需单独适配验证；不自动把白模 key 或接口搬进来。DeepSeek 目录仍有旧名称，其存在仅表示已配置，不表示当前可用。网页提交时从实时目录读可用选择；模型 revision 改变即分组。
