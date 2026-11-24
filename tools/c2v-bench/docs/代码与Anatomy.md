# C2V 代码与 Anatomy 接入

## 代码基线

远程目录 `/mnt/afs_if/codevideo/workspace/code2video-dev-codex`，接手检查基线 `3230dd268bddce8a69b18ea4661d4a82064997b9`，Web 1.5.7。当前线上白模 0.1.16 与 C2V 路径独立；本轮不修改冻结白模引擎。

| 层 | 主要位置 | 作用 |
|---|---|---|
| Web | `apps/web/lib/api.ts`、`types.ts` | 普通会话、任务、实验模型与技能操作 |
| 网关 | `apps/gateway/src/server.mjs`、`presence.mjs` | 登录/授权、排队、幂等、附件和心跳、最终产物门控 |
| 模型和技能快照 | `apps/shared/experimental*.mjs` | 模型 revision 与每轮 skill-revisions；校验 Anatomy 包版本/hash |
| Worker | `apps/worker-bridge/src/job-runner.mjs`、`session-workspace.mjs`、`references.mjs` | 准备工作区、挂载技能与输入、运行 Claude Code、保存结果/轨迹 |
| C2V 内置技能 | `assets/skillsets/coding_to_video/` | 代码视频核心流程与按需专项技能 |
| Anatomy | `assets/experimental-skills/anatomy/` | 固定源码包与来源证明 |
| 原有接口冒烟 | `scripts/verify-anatomy.mjs` | 权限、挂载、调用、导出及归档验证，非业务质量跑分 |

正常 C2V 使用管理端配置；实验模式可以显式选模型和技能。本套使用实验模式，但明确打开 `builtin: coding_to_video`，结构案再加 Anatomy。用户本次明确要求测试 C2V，因此不是把实验模式默认 `none` 擅自全局改掉。

C2V skill 集：`code-video-core`、`explainer-diagrams`、`stylized-looks`、`simulations-and-generative`、`character-and-creature-motion`、`threejs-scenes-and-cameras`、`motion-graphics-and-promos`、`sound-design-and-narration`、`music-and-beat-sync`。

核心约束包括 SPEC 明确事实与参数；先有完整粗剪；`frame(t)` / `window.seek(t)` 确定性随机访问；按帧离线渲染；两轮以上视觉检查、关键帧联系表、编码后 MP4 复查与 VERIFY 记录。音频单独生成/合成并共享时间轴。不能用网页实时播放成功代替最终视频验证。与白模“首稿加两修”的有限 Python loop 不同，目前不人为把它改成白模循环。

## Anatomy 的能力及代价

来源：`wheresryan22/anatomy`，MIT，固定 commit `1482e8469b0a9e0d8cc18ea2740a01423d29ae80`。配置 ZIP SHA256 为 `d7c3b72c54099de6d333745c385a287613d220e13236a2bd9dbe17b1ae5675a0`；完整来源写在 `dataset/v0.1.0/baselines.json`。

它主要用于精细、可交互的等轴测 SVG 物理机制讲解，也有 WebGL/3D 扩展。重点是让物体本身解释原理：部件清单、几何约束、深度顺序、爆炸/装配关系与交互。不是现成 CAD 库，也不保证一句主题就产出写实 3D。

原 skill 的工作量分级明显重于白模：Figure 约 40–80 部件、最多约 1 小时；Hero 80–150 部件、约 2–4 小时；Epic 更长；还包含多轮视觉、几何、线条和明暗主题检查。这是 skill 中的预算指导，不是本次实测时长或 SLA。只有微波炉、放映机两案使用它，单列统计。

适配视频时需要将交互状态、弹簧/循环或鼠标驱动改为按时间求值，把展开、拆解、运动按固定时间线呈现。若直接录网页 autoplay，会破坏精确时间和随机 seek。放映机 prompt 明确“三维产品展示”，因此不能仅凭 Anatomy 的二维 SVG 好看就判定完全满足；三维全貌/内部结构/特写的实际表达仍需独立人工检查。

原 dev 已有 Anatomy 配置选择和冻结包挂载；不需再全局安装一份，也不需要改名复制。已存在的两秒导出冒烟证明的是集成，不是本次复杂结构视频的质量。

## 可追溯性限制

网页 API 能返回模型配置 revision、输出/上下文配置、任务阶段、时间和 skill 快照。配置为空时按实际值记 `null`，不猜测 high 或上下文大小。完整归档可以保留原生 Claude JSONL、工具调用、回复和返回的思考/签名；没有返回的思考内容不补造。

builtin 快照字段并不等于所有内置文件的内容 hash。每批应保留 dev Git commit 及完整 session 归档中的 `round_meta`/实际工作区；当前 `platform_baseline` 只是本次检查基线，后续运行不能把它当实时部署版本证明。模型、工具、渲染拆分耗时需要来自真实轨迹，API 墙钟不能直接当推理时间。
