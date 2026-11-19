# Code2Video — Codex 独立开发环境

基于 `/mnt/afs_if/codevideo/workspace/code2video-dev` 的 **1.4.6** 接手，当前代码版本以根目录 `VERSION` 为准。代码、Cookie 和进程按接手版隔离，数据直接复用原 dev 存储；不修改原 dev 代码或线上 `coding-video-web`。

当前 dev 入口为 **http://10.210.9.14:20211/**，前端直连 `http://10.120.7.224:8000`。页面显示「Codex 开发环境」。

| 服务 | 主机与端口 | 容量 / 启动目标 |
| --- | --- | --- |
| Next.js 前端/BFF | 10.120.7.224:8000 | `web` |
| Gateway | 10.120.4.121:19998 | `gateway` |
| Worker Bridge | 10.120.4.121:18081 | 2 槽 / `bridge cvw-codex-4121` |
| Worker Bridge | 10.120.4.112:18081 | 4 槽 / `bridge cvw-codex-4112` |
| Worker Bridge | 10.120.4.84:18081 | 4 槽 / `bridge cvw-codex-4084` |
| Worker Bridge | 10.120.4.55:18081 | 4 槽 / `bridge cvw-codex-4055` |

所有账号和模式共用 14 槽，任务按入队时间派发。同一会话串行执行，未开始的任务可在共享工作区的 Worker 间选择空槽。历史 session、参考文件、原生轨迹和成片保留在原存储中。

## 运行

所有命令均从 `/mnt/afs_if/codevideo/workspace/code2video-dev-codex` 执行。`service.py` 会检查目录、存储、命名空间、配置端口和主机；不会通过全局 `pkill` 停服务。只在服务所属主机运行对应命令。需要 Node **22 或更新版本**；可用 `CVW_NODE_BIN` 指定其 bin 目录。

```bash
# 前端主机 10.120.7.224
python3 scripts/service.py web status
python3 scripts/service.py web stop
python3 scripts/service.py web build
python3 scripts/service.py web start

# Gateway 主机 10.120.4.121
python3 scripts/service.py gateway start
python3 scripts/service.py bridge start cvw-codex-4121

# 其余三台分别启动对应 Worker
python3 scripts/service.py bridge start cvw-codex-4112  # 10.120.4.112
python3 scripts/service.py bridge start cvw-codex-4084  # 10.120.4.84
python3 scripts/service.py bridge start cvw-codex-4055  # 10.120.4.55
```

`start` 在专用 tmux socket `cvw-codex` 下启动常驻监护进程，服务退出后自动拉起，退出 SSH/Codex 不影响服务。
`start`、`stop`、`restart`、`status`、`logs` 共用同一实现；只有 web 有 `build`。旧 `start-frontend.sh`、`start-backend.sh`、`restart-service.sh` 是薄包装。`start-backend.sh` 在 Gateway 主机管理 Gateway 与本机 Worker；其余主机使用 bridge 命令。

服务读取 `config/backend.json` 和 `runtime/.secrets`；前端构建时固化版本、环境角标与 basePath。改这些值后需重新构建。白模模型由管理员统一配置，新白模使用固定 Seko skill 与独立 harness，普通用户不能修改模型或上传替换 skill；实验模式保留自己的配置。详见 docs/WHITEBOX-SEKO.md。

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
- `runtime`：本副本的依赖、私密配置、日志、备份与验证产物，整体忽略提交。原 dev 用户/任务数据位于 `code2video-dev/runtime`，会话工作区位于 `session-dev`，均直接复用。

接手理解、设计约束与验证范围见 [docs/TAKEOVER.md](docs/TAKEOVER.md)。其余旧文档、SYNC 记录和旧 CHANGELOG 是历史资料，不是本环境的部署指令。复制前的原始文件摘要见 `runtime/validation/baseline-manifest.json`；重构前独立副本快照见 `runtime/validation/before-refactor.tar.gz`。

## Git 管理

私有仓库：https://github.com/Mr-Tony921/code2video-ui 。默认分支为 `main`。
`v1.4.6-codex.1` 保留首次重构基线，`v1.5.0` 保留首个常规版本，后续以 VERSION 与发布标签追溯。提交署名为 Tony，仅在本仓库设置。

按用户要求只在 `main` 上线性提交，拉取使用 `git pull --ff-only`，不另建分支或 worktree；详细命令见 [docs/GIT_WORKFLOW.md](docs/GIT_WORKFLOW.md)。

实际的 `config/backend.json` 保存在本地并被 Git 忽略；仓库提供 `config/backend.example.json`。
新 clone 需要复制模板并配置自己的部署路径、主机和密钥，还需要独立准备 `runtime/` 的浏览器和渲染依赖。
Git 管理代码版本，任务数据和运行凭据需单独备份。

## 查看常驻服务

在对应主机执行，全部使用独立 socket，避免影响其他 tmux 会话：

```bash
tmux -L cvw-codex ls
# 前端主机
tmux -L cvw-codex attach -t cvw-codex-web-local
# Gateway 主机 10.120.4.121
tmux -L cvw-codex attach -t cvw-codex-gateway
```

用 Ctrl-b 然后 d 离开 tmux。日志仍在 runtime/logs；停止/重启使用 service.py，避免只杀 Node 后被监护进程立即拉起。
端口接管记录保存在 runtime/deployment/dev-takeover.json，隔离校验只允许记录中已授权的 dev 端口复用，正式服务的目录、端口与进程保持隔离。
当前账号、任务和素材直接使用原 cc dev 数据；原密码、用户权限、历史视频及工作区保留，普通 test/test-peer 另行保留。

## 原 dev 数据复用

代码从本目录运行，数据直接使用：

- 用户、任务、邀请码、示例和事件：`/mnt/afs_if/codevideo/workspace/code2video-dev/runtime/gateway`
- 原 session 工作区：`/mnt/afs_if/codevideo/workspace/session-dev/sessions`
- 原会话索引：`/mnt/afs_if/codevideo/workspace/session-dev/session-index.jsonl`

旧 cc dev 服务保持停止，避免两个实现同时写同一批数据。原 cc 源码保持不变；接手版是 dev 数据的唯一运行写入者。
复用授权记录位于 `runtime/deployment/dev-data-reuse.json`；守卫只放行这组明确的 dev 路径，生产目录始终禁止。
首次切换采用的独立测试数据留作验证证据；未完成的原数据复制目录已清理，不保留重复的 16GB 工作区。

## dev 实验模式

管理员在用户页显式授予实验权限，用户可选择服务端配置的模型，关闭内置 skill 并粘贴或上传自定义 skill。模型配置、工作区留存和验收入口见 [EXPERIMENTAL_MODE.md](docs/EXPERIMENTAL_MODE.md)。所有模式支持下载完整会话。
