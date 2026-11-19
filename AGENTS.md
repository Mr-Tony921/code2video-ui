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
