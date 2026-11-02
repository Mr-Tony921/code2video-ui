# 接手记录与当前实现

日期：2026-11-02。源：`/mnt/afs_if/codevideo/workspace/code2video-dev`，版本 1.4.6。先阅读现有代码、部署配置及 cc 迁移记录，再独立启动；没有运行源目录启动脚本。源目录与线上均不写入。

## 功能链路

1. 浏览器登录经 Next `/api/[...path]` 转发到 Gateway。Gateway 用 HMAC 签名 Cookie；本环境 Cookie 名为 `cvw_codex_session`，不会与同一主机其他端口上的 dev Cookie 混淆。账号、邀请、渠道、示例及权限功能保留；测试不创建管理员。
2. 创建会话先做用户/3D 权限检查，再从 WorkerPool 选择可用 worker。会话绑定 worker，后续素材和任务都沿此绑定发送。`max_sessions` 与任务并发是不同的限制。
3. 会话准备阶段按模式复制技能，3D 技能只进入 3D 会话。素材经 Gateway multipart 接收，在共享存储暂存，Bridge 校验并持久化元信息；首次任务提交后素材集合冻结。
4. 提交立即持久化 Job 并返回 202。幂等键保证并发重放得到同一个 Job；同会话不能同时生成。提示词增强是后台步骤，失败保留原始 prompt 继续；用户关闭增强、续改等路径可跳过。常规真实冒烟显式关闭增强。
5. Dispatcher 定期选取排队任务，检查 worker 注册状态、会话归属及容量，预占槽位、签发租约，然后调用 Bridge。取消先持久化意图并撤销租约，防止旧执行者提交结果。
6. Bridge 在会话共享工作区启动 Claude。prompt 经 stdin；stdout 直接写文件；进程独立于 Bridge 生命周期。任务使用 user/mount namespace，工作区映射 `/workspace`，`/mnt` 被隐藏，HOME 和 `/tmp` 是任务私有目录。此副本关闭 soft isolation 回退，浏览器和 previs 依赖均来自副本。
7. Bridge 从 JSONL 日志解析事件；Gateway 持久化事件并提供 SSE。浏览器关闭不等于取消任务；presence 与 watchdog 处理超时/失联。代理传递客户端断开信号，视频/SSE 不缓冲、不 gzip；普通 JSON 可以 gzip。
8. 完成时验证 MP4 并把它固定到对应轮次目录。只有终态任务暴露成片。网页播放可以使用低码率预览；下载返回原片；Range、SSE 终态回放及跨用户访问均需保持原有语义。
9. 续改复用会话工作区与 Claude session ID。上一轮源代码、HOME、对话记录仍在原处；新的结果固定到新轮次，不能覆盖旧轮次回放。旧 `jobs/<jid>` 布局的读取/迁移兼容仍保留。
10. Bridge 重启时，先扫描 sidecar 与 running index，使用 PID、启动 tick、任务 token 等确认进程身份，再认领并注册。Gateway 重新绑定实例；心跳、对账与租约阻止过期实例写入。故障状态机是核心行为，本次未重写。

## 存储与模块

控制面在 `runtime/gateway/`：会话/任务 JSON、事件 JSONL、租约、幂等记录、用户等。任务数据在 `runtime/data/sessions/<sid>/`：

```text
workspace/                  同会话各轮复用
  .home/ .tmp/ .claude/      对话历史、私有临时目录、模式技能
  src/ assets/ output/       代码、参考素材和当前轮输出
rounds/<jid>/               每轮独立簿记
  _meta.json prompt.md
  .running.json .cc-session
  .done | .failed | .cancelled | .aborted
  final.mp4                 固定的历史成片
```

主要职责对应：

| 问题 | 模块 |
| --- | --- |
| 用户和内部鉴权 | `gateway/src/auth.mjs`、`users.mjs` |
| 任务状态与原子持久化 | `gateway/src/store/job-store.mjs` |
| 容量与派发 | `worker-pool.mjs`、`dispatcher.mjs` |
| 失联、取消与长任务 | `watchdog.mjs`、`presence.mjs`、`watchdog-prompts.mjs` |
| 增强与降级 | `enhancer.mjs`、`enhance-agent.mjs` |
| worker 执行与恢复 | `job-runner.mjs`、`job-adopter.mjs`、`supervisor.mjs` |
| 工作区与多轮历史 | `session-workspace.mjs`、`job-workspace.mjs`、`job-paths.mjs` |
| 事件与日志 | `log-tailer.mjs`、`stream-parser.mjs`、`gateway/stream-pump.mjs` |
| 视频预览与下发 | `gateway/asset-preview.mjs`、Gateway asset routes、Next API 代理 |

模型上下文配置与 dev 保持一致：524288 tokens，输出上限 64000，自动压缩阈值 80%；worker 会用模型接口校验上下文长度。实际模型调用没有替换成 mock。

## 复现与重构边界

独立复制代码和运行依赖，没有复制真实用户、任务、Cookie、旧日志或 Git 工作区。基线真实产物保存在 `runtime/validation/baseline/`；基线完成后才制作 `before-refactor.tar.gz` 并开始重构。

重构包括：

- Gateway 鉴权从大路由文件提取；Gateway/Bridge 共用 HTTP 原语，保留 Gateway 容忍非法 JSON 与 Bridge 严格拒绝的不同策略。
- 五个启停入口汇入 `scripts/service.py`。精确匹配 cwd、进程角色和启动 tick，使用本副本锁；拒绝低版本 Node、重复实例、错误主机、端口冲突或不完整构建。
- 删除没有调用方的辅助函数和退役的 `assets/skills`、`assets/skills-v2`、`assets/bench-runner-ref`；安装器与白模测试改用当前 `assets/skillsets`。
- 删除依赖旧身份/端口/数据布局的集成脚本，使用普通用户真实验收替代；原子读写测试迁入独立 fixture，保留 400 次并发读取覆盖。
- 风险测试不再硬编码仓库位置、不共用 `/tmp/risk-*` 或固定 fixture 目录；每次调用独立临时数据和日志。
- 删除配置中大量历史说明字段，当前说明集中在 README 和本文；运行时配置值保持 dev 功能一致，环境路径/端口/标识与隔离策略除外。

没有更换模型、框架、技能提示词，也没有重写调度、租约、取消、多轮恢复和管理功能。保留了仍在使用的旧会话兼容路径，避免把兼容代码误删成死代码。

## 验证与限制

验证结果的原始依据在 `runtime/validation/`，具体结果汇总见 `validation-summary.json`（任务完成时生成）。

- `baseline/report.json`：重构前真实 2D、3D、续改；下载成片、Range、SSE、普通用户权限、会话归属。
- `refactored/report.json`：同样的生成路径，加素材上传/删除/冻结和运行中取消。
- `refactored/adoption.json`：生成期间重启独立 worker，记录前后 agent PID/启动时间和认领状态。
- `browser/report.json` 与截图：普通用户登录、首次弹窗、历史选择、播放、刷新恢复；不以直接调用前端内部函数代替可见点击。
- `refactored-risk.log`：31 项故障回归。部分是源码约束，部分真实启动子进程/媒体工具；不能把它们统称为 31 项端到端测试。
- `module-tests.log`、`service-tests.log`：HTTP/认证、原子读写并发、Node 版本、精确进程归属、健康接口。
- `refactored-build.log`：Next 构建与类型检查。

普通用户测试只验证管理员入口被拒绝，未用 admin 执行管理页写操作；管理功能仍保留源实现。短片生成与故障恢复的验证不等同于已经完成所有 1–2 小时复杂内容的压力测试。公网入口没有配置或修改，访问地址目前为内网地址。

## 2026-11-02 数据连续性修正

接管入口后，用户要求继续使用原管理员帐密和历史会话。最终改为代码独立、dev 数据原位复用；不再复制历史工作区。
原 dev 控制面与 session-dev 工作区继续作为权威数据源，旧 cc dev 服务保持停止。
原有 3 个用户、183 个会话、156 个任务及成片、邀请码和示例均保留；原密码哈希和权限未重置，测试仍使用普通 test/test-peer。
守卫通过单独的数据复用授权记录，只放行明确的旧 dev 数据目录及 worker 身份，保持对生产环境的禁止。
未完成的历史工作区复制目录已删除。接手初期的独立验证产物仍留在本副本 runtime 中，作为验证证据；当前服务不再使用它作为业务数据库。
