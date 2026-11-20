# 本副本的工作边界

- 工作目录固定为 `/mnt/afs_if/codevideo/workspace/code2video-dev-codex`。
- `/mnt/afs_if/codevideo/workspace/code2video-dev` 是 cc 的原 dev，代码保留，dev 数据经用户授权由接手版直接复用；用户已授权停止其 dev 服务并接管 dev 端口。不得修改其代码、删除目录或重新启动旧 dev。两个挂载下的 `coding-video-web` / `codeing-video-web` 均禁止修改、重启或写入业务数据。
- 日志、凭据、安装依赖、验证结果和备份放本副本 `runtime/`。用户与任务直接复用原 dev `code2video-dev/runtime`，会话使用 `session-dev`；仅此两处数据路径获得授权，原 cc 代码仍不可修改，生产数据路径仍禁止。
- 使用 `scripts/service.py` 在专用 tmux socket `cvw-codex` 中管理进程，操作前必须通过 isolation guard；禁止 `pkill node`、`pkill next` 等全局进程操作。
- 冒烟使用普通 `test` / `test-peer`；不要创建或使用管理员来测试。测试凭据保存在本副本 `runtime/*account.json`，不打印、不提交。
- 当前命令、拓扑和验证入口见 README；旧 SYNC/部署记录仅作背景，不授权修改线上。
- 先理解对应状态机再修改；调度、租约、取消、历史成片、任务认领均有回归约束。测试用独立 fixtures，真实生成用带标签的验证报告。
- 实验模式生产默认选择 `builtin: none`。只有用户或原始任务明确要求 `coding_to_video` 时，才启用这套内置 skill。整理清单时自动填入的设置不视为原始任务要求。

## 白模 CC 适配暂停记录（2026-11-18）

- 用户已暂停白模全量实验并结束任务；槽位已清空，不得自动重排或运行完整 Python 对照。全量质量对齐尚未完成。
- 后续 skill 更新必须重新核对并适配 CC 的 CLI/schema、阶段规则、模型补丁、事实/图像回执及追问流程；上传 ZIP 不等于完成适配。CC 继续管理模型循环，未经用户批准不得替换成外部 Python harness。
- 当前 host v9/MCP15/skill 视频 0.11.1 已部署；HTTP v16 候选未部署，300 秒响应头超时长复现未完成。详见 [暂停交接](runtime/whitebox-goal-20261118/PAUSED-CONCLUSIONS-2026-11-18.txt)。

## 白模 Seko 迁移记忆（2026-11-19）

- 用户已后续明确授权：**仅 dev 白模**从 CC 迁移到独立简单 Python Seko harness；本条覆盖上一节对未来白模必须保留 CC 的限制。C2V/实验模式继续原 CC 路径，正式线上禁止改动。旧 CC 白模会话只读保留，新 `seko-v1` 会话支持基于最后已交付源码的续改。
- 管理员统一配置白模模型，默认现有 DeepSeek sfb，支持 Tokenhub key 与内网无认证；普通用户不能换模型/skill。固定业务包通过版本/hash、协议和单案验收接入升级，不直接混用上传 skill。原图、实际模型图片、完整响应/签名与每轮产物保留；图片压缩与上下文整理不占 skill 反思/修正上限。
- 工程约10分钟为软目标，MP4单独计时，不设600秒平台强杀。当前单案首轮实际17分12秒，含明显上传/响应等待，不能称为10分钟达标；用户已允许暂不因传图慢阻塞本轮开发。续改工程6分58秒、0次追加修正、有限自检通过，旧版哈希不变。见 `docs/WHITEBOX-SEKO.md` 和 `docs/WHITEBOX-SEKO-ACCEPTANCE.md`。后续性能比较需使用真实原话和实际发送媒体，明确控制阶段、生成、审查、传输、工具及视频耗时。

## 线性提交与白模压缩（2026-11-19 补充）

- 用户要求只在 main 上线性提交，不另建功能分支或 worktree，不创建 merge commit。同步使用 git pull --ff-only。
- 白模图片使用固定 whitebox-media-v2：长边1024，优先64KiB、最多96KiB；原始图不覆盖，保留实际发送副本及SHA、编码参数。不能以压缩为由省略参考图或审查页，也不占修正次数。
- 研发三案报告包含多个版本/不同微调条件，不能将旧工程回放算成新生成，也不能将API累计耗时直接当作纯推理；当前网络差时优先核对输入、结构、实际回放和独立有限质量。

## GPT 接手记录（2026-11-20）

- 用户因 DeepSeek SFB 下线要求 dev 白模默认改 GPT 6.1 Sol。当前新会话使用 TokenHub Responses 与 Seko 0.1.10；旧会话仍绑定原快照，生产未发布。
- 初稿/审查 low，源码编辑/修正 high，输出32768；初稿最多2次修正，追问一次编辑最多1次修正。不把仅证据不足改成质量通过，也不因缺一张证明而修改场景。
- 普通文本镜头标记和明确时间区间已兼容；网页 FAILED 快照可暂缺 failure 详情，组件必须允许空值。
- 当前完整结果与网络限制见 docs/WHITEBOX-GPT-20261120.md；固定回归入口 scripts/check-seko.py。工程扣实测上传与视频渲染分开统计，未宣称所有复杂案例稳定10分钟。
