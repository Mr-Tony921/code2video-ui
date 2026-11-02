# 本副本的工作边界

- 工作目录固定为 `/mnt/afs_if/codevideo/workspace/code2video-dev-codex`。
- `/mnt/afs_if/codevideo/workspace/code2video-dev` 是 cc 的原 dev，只读；两个挂载下的 `coding-video-web` / `codeing-video-web` 均禁止修改、重启或写入业务数据。
- 所有运行数据、日志、安装依赖放本副本 `runtime/`。不可用软链接把可写目录指回原 dev。
- 使用 `scripts/service.py` 管理进程，操作前必须通过 isolation guard；禁止 `pkill node`、`pkill next` 等全局进程操作。
- 冒烟使用普通 `test` / `test-peer`；不要创建或使用管理员来测试。凭据保存在 `runtime/*account.json`，不打印、不提交。
- 当前命令、拓扑和验证入口见 README；旧 SYNC/部署记录仅作背景，不授权修改线上。
- 先理解对应状态机再修改；调度、租约、取消、历史成片、任务认领均有回归约束。测试用独立 fixtures，真实生成用带标签的验证报告。
