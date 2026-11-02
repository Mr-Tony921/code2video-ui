# Code2Video — Codex 独立开发环境

基于 `/mnt/afs_if/codevideo/workspace/code2video-dev` 的 **1.4.6** 接手，当前版本为 **1.5.0**，以 `VERSION` 为准。代码、数据、Cookie、进程和端口独立；不复制用户数据，不修改原 dev 或线上 `coding-video-web`。

当前内网入口：**http://10.120.6.65:8002**。页面显示「Codex 开发环境」。未设置公网入口。

| 服务 | 主机与端口 | 启动目标 |
| --- | --- | --- |
| Next.js 前端/BFF | 10.120.6.65:8002 | `web` |
| Gateway | 10.120.3.60:9996 | `gateway` |
| Worker Bridge | 10.120.3.60:18082 | `bridge cvw-codex-360` |
| Worker Bridge | 10.120.3.50:18082 | `bridge cvw-codex-350` |

两个 worker 与原 dev 共用机器资源，但实例及存储独立。并发配置与 dev 一致：2 + 4，实际有效容量 6。常规冒烟只同时运行少量任务。

## 运行

所有命令均从 `/mnt/afs_if/codevideo/workspace/code2video-dev-codex` 执行。`service.py` 会检查目录、存储、命名空间、配置端口和主机；不会通过全局 `pkill` 停服务。只在服务所属主机运行对应命令。需要 Node **22 或更新版本**；可用 `CVW_NODE_BIN` 指定其 bin 目录。

```bash
# 前端主机 10.120.6.65
python3 scripts/service.py web status
python3 scripts/service.py web stop
python3 scripts/service.py web build
python3 scripts/service.py web start

# 后端主机 10.120.3.60
python3 scripts/service.py gateway start
python3 scripts/service.py bridge start cvw-codex-360

# 后端主机 10.120.3.50
python3 scripts/service.py bridge start cvw-codex-350
```

`start`、`stop`、`restart`、`status`、`logs` 共用同一实现；只有 web 有 `build`。旧 `start-frontend.sh`、`start-backend.sh`、`restart-service.sh` 是薄包装。`start-backend.sh` 用于 .60 的 gateway + 本机 bridge；.50 使用 bridge 命令。

服务读取 `config/backend.json` 和 `runtime/.secrets`；前端构建时固化版本、环境角标与 basePath。改这些值后需重新构建。模型设置保留 dev 当前的 SenseNova-6.8-Code2Video；不升级框架、模型、技能内容或渲染依赖。

热更新用 `bash scripts/hot-update.sh run`：设置维护态、先 Bridge 后 Gateway、检查任务认领、清除维护态并执行部署检查。该命令不构建前端。重启失败时返回失败；维护状态有到期时间。

## 账户和验证

`test` 是普通用户，授予 3D 功能权限；`test-peer` 是普通用户、无 3D 权限，用于验证跨用户隔离。均无管理员角色。测试凭据分别保存在 `runtime/test-account.json`、`runtime/test-peer-account.json`（权限 600），不写入日志。

```bash
# 普通用户 HTTP 冒烟，不启动模型任务
bash scripts/smoke.sh

# 真实生成验收：2D + 3D + 同会话续改 + 运行中取消
CVW_TEST_LABEL=acceptance bash scripts/e2e-checklist.sh

# 后端执行：真实 ffmpeg/子进程条件下的 31 项故障回归
bash tests/risk/run-all.sh
node --test tests/unit/*.mjs
python3 tests/unit/service_test.py

# 后端执行：浏览器登录、历史切换、播放、刷新恢复
node scripts/browser-check.mjs

# 前端主机执行：版本/构建/端点/实例/数据完整性
bash scripts/release-check.sh
```

风险测试每个进程使用独立临时数据，日志保存在 `runtime/validation/risk.*`。真实验收记录与下载视频位于 `runtime/validation/<label>/`。`scripts/verify-adoption.py` 用于本次 `refactored` 验收运行期间的 worker 认领验证，不应在无测试任务时调用。

## 代码导航

- `apps/web`：登录、创作、历史、素材、示例、管理界面；API 代理、视频与 SSE 流转发。
- `apps/gateway/src`：鉴权、会话与任务持久化、调度、租约、事件、取消、增强、管理 API。
- `apps/worker-bridge/src`：工作区、模式技能、Claude 进程、事件采集、恢复认领、素材处理、成片固定。
- `apps/shared/http.mjs`：两种服务共用 HTTP 响应、路由匹配和显式 JSON 解析策略。
- `assets/skillsets`：仅保留运行时实际使用的 `coding_to_video`、`blockout_3d` 技能集。
- `runtime`：本副本的依赖、私密配置、用户数据、任务和验证产物，整体忽略提交。

接手理解、设计约束与验证范围见 [docs/TAKEOVER.md](docs/TAKEOVER.md)。其余旧文档、SYNC 记录和旧 CHANGELOG 是历史资料，不是本环境的部署指令。复制前的原始文件摘要见 `runtime/validation/baseline-manifest.json`；重构前独立副本快照见 `runtime/validation/before-refactor.tar.gz`。

## Git 管理

私有仓库：https://github.com/Mr-Tony921/code2video-ui 。默认分支为 `main`。
`v1.4.6-codex.1` 保留首次重构基线，`v1.5.0` 对应当前版本。提交署名为 Tony，仅在本仓库设置。

开发时创建功能分支、验证后提交并推送，完成评审再合并到 `main`；详细命令见 [docs/GIT_WORKFLOW.md](docs/GIT_WORKFLOW.md)。

实际的 `config/backend.json` 保存在本地并被 Git 忽略；仓库提供 `config/backend.example.json`。
新 clone 需要复制模板并配置自己的部署路径、主机和密钥，还需要独立准备 `runtime/` 的浏览器和渲染依赖。
Git 管理代码版本，任务数据和运行凭据需单独备份。
