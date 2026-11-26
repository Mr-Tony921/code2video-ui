# Code2Video — Codex 独立开发环境

当前版本 **1.5.8**（以根目录 `VERSION` 为准），开发副本位于 `/mnt/afs_if/codevideo/workspace/code2video-dev-codex`。代码、Cookie 和进程按接手版隔离，数据直接复用原 dev 存储；不修改原 dev 代码或线上 `coding-video-web`。

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


## 快速模式与接口接入

C2V 输入区在「智能扩写需求」后提供「快速模式」，默认关闭，提示减少检查和修改轮数、可能牺牲画面质量。它与扩写独立：同时开启仍先扩写；关闭扩写则使用原文。实验模式和白模不受影响。历史卡片标注当轮模式，续改默认继承最近一轮选择，可在发送前切换；新会话默认关闭。

快速模式挂载冻结的 `assets/c2v-fast/releases/0.1.0/c2v-fast-compact`，明确要求模型先 Read 完整 skill；不同时挂载常规创意/审美 skill。一次实现后批量录制、元数据与完整解码校验；无可播放文件才允许一次局部技术修复，不循环改审美。追问仅修改用户指定范围，复用原代码/素材，最多一次局部实现与一次技术修复。约5分钟是参考目标，不强制中止；也不表示只有一次模型请求。复杂需求可能超时或质量降低，普通模式仍用于更充分打磨。

通过正常登录 Cookie 调用 `POST /api/sessions/:id/jobs`，保留 `Idempotency-Key`：

```json
{"prompt":"用户原文","enhance":false,"fast_mode":true,"is_revision":false}
```

先创建 `mode: "coding_to_video"` 的会话，并按原流程上传 reference。`fast_mode` 必须为布尔值；省略为 false。服务端生成 `fast_skill`（skill/version/SHA-256），客户端不能指定文件或版本。任务、排队载荷、历史 API 和本轮 `_meta.json` 保存快照，Worker 校验后加载；发行目录不得原地修改，升级新增版本。是否履行有限流程以轨迹核实，当前是 skill 约束，不伪称有程序级质量循环计数器。

完整 API 和接入步骤见 [INTEGRATION.md](INTEGRATION.md)。

## 模型与 Claude Code 启动

C2V 默认内网服务：`http://app-309ce2c5435d493daee192aff417dcea.ns-zuhu2026-c9929bca.svc.cluster.local:60011`，模型 `deepseek-c2v-v1`，上下文配置 1,048,576、输出上限 64,000、自动压缩阈值 80%。这是当前服务配置，不代表其它渠道同样支持。管理员保存的默认模型快照优先于 `config/backend.json` 的 fallback；既有会话继续使用创建时的模型快照。集成环境须能解析该集群域名；不要用外网映射端口直接替代集群端口。

C2V 和实验模式使用 CC，白模使用独立 Seko Python harness。Bridge 在隔离工作区内以 stdin 传入本轮 prompt，等价启动形态为：

```bash
claude -p --permission-mode bypassPermissions --output-format stream-json --verbose --session-id <uuid>
# 续改使用 --resume <uuid> 替代 --session-id；prompt 由 stdin 传入
```

工作区浅挂载到 `/workspace`，每会话独立 HOME，模型地址/凭据由受控环境注入；`bypassPermissions` 必须与现有 Linux user/mount namespace 隔离同时使用，不能裸跑在共享源码目录。首轮与续改共享 source/assets/CC 会话，但每轮 prompt、meta、原生轨迹索引和最终视频单独保留。运行时真实命令含模式对应工具开关，以 `job-runner.mjs` 为准；快速模式不改 CC 的模型和权限设置。

## 后端依赖与并发

后端镜像为 `registry.cn-tj-01.sensecore.cn/ccr-zuhu2026/coding-video-cc-v2-261023:hjw-hermes-20261023112829`（用户提供，需内部拉取权限；本轮未重新拉取或验证digest）。仓库不是完整镜像，也未附 Dockerfile。依赖边界见 [部署说明](docs/DEPLOYMENT.md)。Node22、Claude Code、FFmpeg/ffprobe、Python、字体、Chrome、`/opt/videokit` 的 Node/Python 包须事先就绪。Chrome 与部分白模依赖位于共享存储，复制容器镜像并不会带走这些数据。依赖核查用 `scripts/verify-deps.sh`，配置路径以 `config/backend.example.json` 为模板、按实际环境修改。

当前全局 **14 个生成槽位**，4台Worker按 **2+4+4+4** 分配，单机上限4。与Gateway同机的Worker留2槽给调度/增强等服务留余量；其它机器4槽控制Chrome、FFmpeg、内存与I/O竞争。这是当前dev运行配置，并非吞吐能力上限结论。所有用户/模式共享槽位，同会话串行、跨会话FIFO。prompt增强另有6个并发额度，属于前置流程，不额外增加生成槽位。部署到不同规格需实测后调整，不能简单按模型各开14槽。

## 共享仓库与私有运行数据

Git包含代码、冻结skill、依赖锁、必要回归和使用文档。`config/backend.json`、`runtime/`、`.secrets`、`.env*local`、日志、Cookie、TokenHub key、参考素材与生成视频不提交。`config/backend.example.json` 可以公开给授权同事，其中凭据为空或环境变量名。运行中的TokenHub凭据仍需保留在私有配置以支持已授权模型，不能把整个dev目录打包共享。

新机器先clone、`git pull --ff-only`，复制配置模板、设置自己的部署/存储路径与私有凭据，并安装依赖。不要直接复用本dev的生产数据路径；isolation guard 所需的部署授权记录需在目标环境单独配置。下载源码不等于获得模型或原dev数据的访问权限。

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

## 工作区首屏

登录、刷新默认显示新对话入口，不自动恢复本地或服务端最近会话，也不自动创建空会话。首屏仅等待登录验证；进行中和维护状态通过后台brief请求更新，brief不扫描历史会话。侧栏已完成历史与示例登录后自动在后台加载，失败可重试，不阻塞新对话入口；「创作历史」保留完整记录，点选任务仅取一次归属校验快照。新建时的模型设置按需加载；现有草稿、后台任务、历史视频和续改绑定保持保留。

真实浏览器回归：在有Chrome的dev worker运行 `node scripts/browser-startup-check.mjs`，验证首屏、带缓存刷新、历史/示例自动补载、慢后台请求、加载失败重试、历史回看及新白模默认skill。只创建一个普通test空会话，不启动模型任务；报告与截图写入runtime/validation（可用CVW_BROWSER_CHECK_OUT指定runtime内的目录）。

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

接手理解、设计约束与验证范围见 [docs/TAKEOVER.md](docs/TAKEOVER.md)。旧 CHANGELOG 与未更新的设计资料仅用于追溯；过期根目录 SYNC-1.4.x 已删除，可从 Git 历史恢复。当前部署只遵循本 README 和 [部署说明](docs/DEPLOYMENT.md)。复制前的原始文件摘要见 `runtime/validation/baseline-manifest.json`；重构前独立副本快照见 `runtime/validation/before-refactor.tar.gz`。

## Git 管理

公开仓库：https://github.com/Mr-Tony921/code2video-ui 。默认分支为 `main`。同事无需邀请即可通过 HTTPS clone 或下载 ZIP，不授予协作者写权限。

`main-owner-only` 分支规则已启用：匹配 `main`，限制更新和删除，要求线性历史并阻止强推；仅所有者 `Mr-Tony921` 在绕过名单中。其他人可以下载或 fork，但不能直接更新本仓库的 `main`。仓库公开意味着源码及提交历史公开，提交前仍须检查密钥与业务敏感信息；运行数据继续保存在私有存储。
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


## Seko C2V benchmark

独立本地测试台和固定测试集见 [tools/c2v-bench/README.md](tools/c2v-bench/README.md)。测试集 0.1.3 包含 20 行业务需求拆成的 21 案，其中 20 案可执行、Anatomy 适配 gate 与普通 Web API 提交/评价工具。原始媒体和运行证据位于 `runtime/c2v-bench/`，不进入 Git；不改变现有生成、模型默认值或白模流程。
