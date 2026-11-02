# ARCHITECTURE — SenseNova Coding Video & 3D Blockout 试用平台

> ⚠️ **V2 变更声明（2026-10-23）**
>
> 本文档部分内容已被 V2 需求变更覆盖，**冲突处以 [`V2_REQUIREMENTS.md`](V2_REQUIREMENTS.md) 为准**：
>
> | 本文档原设计 | V2 实际 |
> |---|---|
> | 不支持 Reference 附件 | **支持**，每 session ≤10，放 `references/` |
> | Prompt Review Card + 用户确认后才建 Job | **增强结果不回传，直接投产**（异步，Job 先以 `ENHANCING` 秒回） |
> | 关闭网页不影响生成 | **心跳断 10 分钟自动停止**（切标签页不算断） |
> | 生成期并发对话按后端能力决定 | **一律禁止 steering** |
> | 最长运行 3 小时 | **12 小时** |
> | Job 状态 10 个 | 新增 `ENHANCING` 与 `OUT_OF_SCOPE` 两个 |
>


> 版本 v1.0 / 2026-10-23 / Phase 1 交付物
> 配套阅读：`LONG_RUNNING_JOBS.md`（长任务）、`API_CONTRACT.md`（接口）、`BACKEND_REQUIREMENTS.md`（后端改造项）

---

## 1. 设计约束（决定了全部架构选择）

| # | 约束 | 架构后果 |
|---|---|---|
| C-1 | 单次生成 **1~2 小时甚至更长** | 禁止同步 HTTP 承载生成；必须异步 Job + 持久化 |
| C-2 | 关闭浏览器 / 断网 / 登录过期**不得**影响任务 | 浏览器不持有任何任务生命周期的话语权 |
| C-3 | Session **固定** Worker Process，不迁移 | 需要亲和性队列，而非全局抢占队列 |
| C-4 | 两种 mode 共享生成并发 | 并发配额按 Process 与全局双层计量，与 mode 无关 |
| C-5 | 取消必须真正停止计算，且不能杀共享进程 | 需要后端协作式取消（见 B-2） |
| C-6 | DB 是 Job 状态的**唯一权威来源** | Redis 仅做队列/锁/事件广播，可重建 |
| C-7 | 必须区分「浏览器关闭 / 用户取消 / 进程失联 / 执行失败」 | 四类事件在状态机中是不同迁移，不可合并 |
| C-8 | 后端是远程机器，IP+Port 访问，产物走共享存储 | Gateway 承担协议适配层，后端协议未定时用 Adapter 隔离 |

---

## 2. 系统全景

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 浏览器 (Next.js 前端, 桌面优先)                                        │
│  · 对话 UI / Prompt Review Card / 任务卡片 / HTML5 Video Player        │
│  · localStorage 仅存「恢复入口标识」(session_id / job_id / mode)       │
│  · 认证: HttpOnly + Secure + SameSite 的服务端 Session Cookie          │
└───────────────┬──────────────────────────────────────────────────────┘
                │ HTTPS: REST + SSE  (仅展示与控制, 不维持 Job 存活)
┌───────────────▼──────────────────────────────────────────────────────┐
│ ① Web 层  Next.js (App Router, Node 22)                               │
│  · 页面渲染 / 认证会话 / 管理后台                                      │
│  · BFF: 轻量转发到 Gateway, 不含调度逻辑                               │
│  · 可随时重启、水平扩容、无状态                                        │
└───────────────┬──────────────────────────────────────────────────────┘
                │ 内网 HTTP (mTLS 或共享密钥)
┌───────────────▼──────────────────────────────────────────────────────┐
│ ② Gateway / Scheduler  独立常驻 Node 服务 (本架构的核心)                │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ API Facade   : 公开 API 的业务实现 (session/job/asset/admin)     │  │
│  │ Dispatcher   : 亲和性队列出队 → 调用后端 Worker                   │  │
│  │ Watchdog     : Worker 心跳 / Job 租约 / 停滞检测 / 对账           │  │
│  │ Cancel Broker: 取消意图落库 → 下达后端 → 确认停止                  │  │
│  │ Event Hub    : Job 事件持久化 + 序号化 + SSE 扇出                 │  │
│  │ Asset Service: 共享存储产物校验 / 播放 / Range 下载                │  │
│  │ Backend Adapter: 后端协议适配 (唯一与后端耦合之处)                 │  │
│  └────────────────────────────────────────────────────────────────┘  │
│  · 单实例起步, 以 DB 行级锁实现 Leader 选举后可多实例                   │
│  · 重启后从 DB 恢复全部状态, 不重复启动已在运行的 Job                   │
└──────┬───────────────────────┬───────────────────────┬───────────────┘
       │                       │                       │
┌──────▼────────┐  ┌───────────▼──────────┐  ┌─────────▼──────────────┐
│ ③ PostgreSQL  │  │ ④ Redis               │  │ ⑤ 后端 Worker 机器群    │
│   权威状态     │  │   队列 / 锁 / Pub-Sub  │  │   IP:Port, 多进程       │
│ · users       │  │ · 亲和性就绪队列       │  │ · Agent 主进程          │
│ · sessions    │  │ · 并发信号量           │  │ · Skill: video/blockout │
│ · jobs        │  │ · 幂等键短期缓存       │  │ · 上报 Worker/Job 心跳  │
│ · job_events  │  │ · SSE 跨实例广播       │  │ · 接受协作式取消        │
│ · job_leases  │  │  (全部可从 DB 重建)    │  └─────────┬──────────────┘
│ · assets ...  │  └──────────────────────┘            │
└───────────────┘                                      │
                        ┌──────────────────────────────▼──────────────┐
                        │ ⑥ 共享存储 (所有 Worker + Gateway 可见)       │
                        │   视频产物: 绝对路径 + 完成状态标记           │
                        └─────────────────────────────────────────────┘
```

### 为什么 Gateway 必须独立于 Next.js

任务 10.4 要求「执行中的两小时任务不能绑定到短生命周期的 Web Request Handler」。
Next.js 实例会因发版、扩缩容、OOM 被重启；若 Watchdog 与 Dispatcher 跑在其中：

- Web 发版 → 心跳监测中断 → 正常运行的 Job 被误判失联
- 多实例 → 多个 Watchdog 并行对账 → 重复下达取消 / 重复分配

因此 **Web 可随时重启，Gateway 独立部署、单独发版、带 Drain 流程**。

---

## 3. 技术选型

### 3.1 已核实的上游复用（2026-10-23 实测）

| 仓库 | 许可证 | 复用内容 | 不复用 |
|---|---|---|---|
| `vercel/ai-chatbot` | **Apache-2.0** ✅ | 对话布局骨架、消息列表、自动贴底 (`use-stick-to-bottom`)、输入框交互、next-auth 服务端会话、Drizzle schema 组织方式、`resumable-stream` 断线续流思路、Playwright 配置 | **LLM 推理调用** (`ai` / `@ai-sdk/*` / `streamText`)、匿名登录 (`isAnonymous`)、Artifacts/Document/Suggestion/Vote、CodeMirror、ProseMirror、weather 等演示 tool、`@vercel/blob`、`botid`、`@vercel/analytics`、`geolocation` |
| `openai/openai-sora-sample-app` | **MIT** ✅ | 视频结果卡片网格、生成中占位态、`/videos/{id}` **轮询直到完成**的任务模型（与我们的 Job 轮询兜底同构）、Remix 入口（对应「旧视频修改」）、shadcn/Radix 组件约定 | `openai` SDK 直连、前端直接持有 API Key、Versions Count 批量提交、图片输入（V1 禁用 Reference） |

> 核实方式：经 `http://10.120.0.246:7890` 代理拉取 `LICENSE` / `package.json` / `lib/db/schema.ts` / `app/(chat)/api/chat/route.ts`，快照存 `_research/untrusted/`。
> **未核实项**：`ai-chatbot` main 分支的 `components/*.tsx` 路径已重构（旧路径 404），组件文件级结构需在 Phase 2 开工时重新 clone 核对。

### 3.2 技术栈决策

| 层 | 选型 | 理由 / 否决项 |
|---|---|---|
| 前端 | Next.js 15 App Router + React 19 + TypeScript strict | 对齐上游；**Node 必须 ≥ 20**（本机默认 v16 过旧，用 `~/.nvm` 的 v22.23.4） |
| 样式 | Tailwind CSS + shadcn/ui (Radix) | 两个上游一致；浅色主题为默认 |
| 状态 | SWR（服务端快照）+ 自研 `useJobStream`（SSE+轮询兜底）；**不引入 Redux** | 服务端是权威来源，客户端只需缓存与订阅，全局 store 会诱发任务 17 所禁的「大一统前端 State」 |
| 认证 | next-auth v5（Credentials）+ 服务端 Session Cookie | 否决 JWT-in-localStorage：任务 8.2 明令禁止在 localStorage 存 Token |
| Gateway | 独立 Node 22 + Fastify + TypeScript | Fastify 原生支持 SSE 与流式 Range 响应；否决 Express（流式与类型较弱） |
| 校验 | Zod（运行时）+ 由 Zod 生成 OpenAPI | 单一事实来源，前后端共享类型 |
| ORM | Drizzle ORM + PostgreSQL | 对齐上游；迁移可审计 |
| 队列 | **PostgreSQL `FOR UPDATE SKIP LOCKED` 为权威，Redis 为就绪索引与信号量** | 否决纯 BullMQ：BullMQ 状态在 Redis，Redis 丢失即丢业务记录，违反 C-6 |
| 事件 | SSE + `job_events` 持久化 + 单调 `seq` + Redis Pub/Sub 扇出 | 否决 WebSocket：单向推送无需双向，SSE 原生支持 `Last-Event-ID` 断点续传 |
| 测试 | Vitest（单元）+ Playwright（E2E）+ 时间可注入的 Fake Clock | 长任务测试必须能「加速时间」，否则两小时用例无法在 CI 跑 |
| 配置 | 集中 `config/` 模块，Zod 校验环境变量，启动即失败 | 任务 1.3：禁止组件内散落 IP/Port |

### 3.3 为什么队列落在 Postgres 而不是纯 Redis

| 能力 | 需求出处 | Postgres | 纯 Redis |
|---|---|---|---|
| Job 状态可恢复 | 7.3 | ✅ 事务持久化 | ❌ RDB/AOF 丢窗口 |
| 取消意图不可丢 | 9.5 | ✅ | ❌ |
| 完成/取消竞争单一终态 | 11.7 | ✅ 行锁 + CHECK 约束 | ❌ 需自建 Lua |
| Lease fencing | 9.3 | ✅ 单调 `lease_epoch` 列 | ⚠️ 需额外设计 |
| 亲和性出队 | 10.2 | ✅ `WHERE process_instance_id=? SKIP LOCKED` | ⚠️ 每进程一队列，容量难全局约束 |

Redis 的职责被严格限定为**加速与广播**：清空 Redis 后，Gateway 可从 Postgres 完整重建队列与信号量。

---

## 4. 模块划分

```text
coding-video-web/
├── docs/                       # Phase 1 交付文档
├── openapi/openapi.yaml        # 机器可读接口协议
├── apps/
│   ├── web/                    # Next.js: UI + 认证 + BFF 转发
│   │   ├── app/(auth)/         # 登录 / 邀请码注册
│   │   ├── app/(chat)/         # 主工作区
│   │   ├── app/(admin)/        # 邀请码 / 用户 / 权限管理
│   │   ├── components/         # UI 组件(纯展示, 无业务状态)
│   │   ├── features/           # 业务状态 hooks (useJobStream 等)
│   │   └── lib/api/            # 类型化 API Adapter (唯一出网口)
│   └── gateway/                # Fastify: 调度 / 心跳 / 取消 / 事件 / 产物
│       └── src/
│           ├── api/            # 公开 API 实现
│           ├── internal/       # 内部 Worker API (独立鉴权)
│           ├── scheduler/      # 亲和性队列 + 并发信号量
│           ├── watchdog/       # 心跳 / 租约 / 停滞 / 对账
│           ├── cancel/         # 取消编排
│           ├── events/         # 事件持久化 + SSE 扇出
│           ├── assets/         # 共享存储校验 / 播放 / Range 下载
│           └── backend/        # Backend Adapter (后端协议唯一耦合点)
├── packages/
│   ├── contracts/              # Zod schema + TS 类型 (web/gateway 共享)
│   └── db/                     # Drizzle schema + 迁移
├── mocks/mock-worker/          # 可配置时长的假 Worker (支持加速时钟)
├── tests/{unit,integration,e2e}/
├── TASK_PLAN.md
├── README.md
└── .env.example
```

**三层分离**（任务 1.3）：`components/`（UI，无 fetch）→ `features/`（业务状态）→ `lib/api/`（类型化 Adapter）。
后端 IP/Port 只出现在 Gateway 的 `config/`，前端代码中不存在任何后端地址。

---

## 5. 关键数据流

### 5.1 创建 Session 并绑定进程（C-3）

```text
用户 → POST /api/sessions {mode}
  Web   : 校验登录
  GW    : 1. 校验 mode 权限 (blockout_3d 需 can_use_blockout_3d)
          2. 候选 process: status=HEALTHY ∧ 支持该 skill ∧ 心跳新鲜 ∧ 会话未满
          3. 按 (活跃会话数, 运行 Job 数) 升序择优
          4. 事务内 INSERT sessions + session_bindings(process_instance_id)
          5. 调用后端 Adapter 初始化会话上下文
  ← 201 {session_id, mode, binding:{worker_id, process_instance_id, status}}
```

绑定写入后，该 Session 的所有对话与生成**永久路由至该 `process_instance_id`**。
进程失联 → `binding.status = PROCESS_LOST`，Session 转 `DEGRADED`，**不自动迁移**（C-3），
前端提示「该会话所在后端进程已失联，请新建会话；已完成产物仍可访问」。

### 5.2 Prompt 增强 → 确认 → 创建 Job（幂等）

```text
用户消息 → GW → 后端意图识别 → {new_generation|edit_generation|prompt_revision|
                                 video_discussion|out_of_scope}
new_generation → 创建 prompt_workflow(ENHANCING)
              → 后端增强 → prompt_revisions(rev=1) → workflow=AWAITING_APPROVAL
              → 前端 Prompt Review Card

用户修订 → POST /workflows/{id}/revise → rev=2 ... (旧 rev 自动失效)
用户确认 → POST /workflows/{id}/approve {revision_id, idempotency_key}
            ├ revision_id ≠ 最新 → 409 REVISION_STALE (任务 6: 过期版本)
            ├ 同 idempotency_key 已存在 → 200 返回**同一** job_id (任务 11.1)
            └ 事务: workflow→APPROVED + INSERT jobs(QUEUED) + 入队
          ← 202 {job_id, status:QUEUED, created_at, poll_url, events_url}
```

HTTP 在此处**立即返回**（C-1），生成由 Dispatcher 异步推进。

### 5.3 Job 执行与事件

```text
Dispatcher: 取并发槽(全局 ∧ 该 process) → 原子 QUEUED→ASSIGNED
            → 创建 job_leases(lease_epoch=N, ttl)
            → Adapter.startJob(process, job, lease_token)
Worker    : 每 15~30s → POST /internal/jobs/{id}/heartbeat {lease_token, phase}
            Gateway 响应里回带控制指令 {continue | cancel | abort_stale_lease}
            阶段推进 → POST /internal/jobs/{id}/progress → job_events(seq++)
            完成 → 共享存储写产物 + 完成标记
                 → POST /internal/jobs/{id}/complete {lease_token, asset}
Gateway   : 校验 lease_epoch 匹配 → 校验产物完整 → jobs=COMPLETED + assets.ready
            → 释放并发槽 → 发布 job.completed 事件
前端      : SSE 收到 → 渲染播放器; 或轮询兜底发现终态
```

完整时序图（含关闭浏览器、取消、心跳丢失、Scheduler 重启、取消与完成竞争、新建 Session 等 7 个场景）见 `LONG_RUNNING_JOBS.md` §G。

---

## 6. 安全架构

| 面 | 措施 |
|---|---|
| 公开 API vs 内部 API | 物理分离：公开走 `/api/*`（Cookie 会话）；内部走 `/internal/*`，**仅绑定内网网卡 + mTLS 或共享密钥 + IP 白名单**。普通用户无法调用心跳 / 取消控制接口（任务 14 要求） |
| 越权调 Skill | `mode` 权限在**服务端**四个点校验：创建 Session、发消息、执行 Workflow、提交 Job（任务 4.3）。前端传入的 `mode` 仅用于创建；后续一律以 DB 中 Session 的 `mode` 为准，杜绝请求体篡改 |
| Job 归属 | 所有 `/api/jobs/*`、`/api/assets/*` 强制 `job.user_id = session_user.id`，越权返回 **404**（不泄露存在性） |
| 文件路径 | 共享存储绝对路径**永不出现在任何面向浏览器的响应中**；只暴露 `asset_id`，下载经权限校验的流式入口（任务 13.3） |
| 邀请码 | 只存哈希（Argon2id），明文仅创建时返回一次；注册时事务内原子扣减（任务 4.1） |
| 管理员 | 经一次性 CLI `pnpm admin:bootstrap` 创建，密码从环境变量或交互输入读取，**不硬编码**（任务 4.1） |
| localStorage | 仅 `{user_scope_hash, session_id, job_id, mode, last_seen_at}`；禁存 Token / 密码 / 密钥 / 完整 Prompt / 权限位（任务 8.2） |
| 敏感配置 | 仅服务端；前端可见变量一律 `NEXT_PUBLIC_` 前缀并经 code review |

---

## 7. 部署与运维

```text
[Nginx / LB] → [Next.js ×N 无状态, 可随时发版]
                     ↓ 内网
               [Gateway ×1 (或 Leader 选举多实例), 独立发版 + Drain]
                     ↓
         [PostgreSQL 主从]   [Redis]   [后端 Worker 机器群 IP:Port]
                                              ↓
                                        [共享存储]
```

**长任务对部署的硬要求**（任务 10.4）：

| 场景 | 要求 |
|---|---|
| Web 发版 | 不影响运行中 Job（Web 不持有 Job 状态） |
| Gateway 发版 | Drain：停止出队与新分配 → 等待在途 RPC 结束 → 退出；**不取消任何 Job** |
| Gateway 启动 | 从 DB 重建队列与信号量；对运行中 Job 先**对账**而非重启（任务 18 测试 J） |
| Worker 发版 | Graceful：停止接新 Job → 等现有 Job 完成或由管理员显式终止 → 退出 |
| Worker 重启 | `process_instance_id` **必须变更**；旧 Session 标 `PROCESS_LOST`，不假装可迁移 |
| 监控分离 | Worker 心跳与 Job 心跳**分别**告警，二者含义不同 |

---

## 8. 后端耦合隔离

后端真实协议尚未确认（阻塞项 B-1）。全部耦合收敛于 `apps/gateway/src/backend/`：

```ts
interface BackendAdapter {
  initSession(p: ProcessRef, s: SessionInit): Promise<SessionHandle>;
  sendMessage(p: ProcessRef, s: SessionRef, m: UserMessage): Promise<IntentResult>;
  enhancePrompt(p: ProcessRef, s: SessionRef, raw: string): Promise<PromptRevision>;
  revisePrompt(p: ProcessRef, s: SessionRef, base: RevisionRef, note: string): Promise<PromptRevision>;
  startJob(p: ProcessRef, job: JobSpec, lease: LeaseToken): Promise<StartAck>;
  cancelJob(p: ProcessRef, jobId: string, reason: CancelReason): Promise<CancelAck>;
  probeJob(p: ProcessRef, jobId: string): Promise<JobTruth>;   // 对账用
  probeProcess(p: ProcessRef): Promise<ProcessHealth>;
}
```

两份实现：`HttpBackendAdapter`（真实，按后端回复填充）与 `MockBackendAdapter`（Phase 2 开发用，可配置任意时长与故障注入）。
**Mock 与真实数据不混用**（任务 1.3）：由启动期 `BACKEND_MODE` 决定，运行期不可切换，Mock 模式下 UI 显示明显水印。

---

## 9. 已确认事实 vs 待确认

| 项 | 状态 | 说明 |
|---|---|---|
| 上游两仓库许可证与依赖 | **CONFIRMED** | Apache-2.0 / MIT，已实测 |
| Node 22 可用 | **CONFIRMED** | `~/.nvm/versions/node/v22.23.4` |
| PostgreSQL + Redis 可用 | **CONFIRMED（用户答复）** | 但本机未监听，需连接串 → B-7 |
| Gateway 独立 Node 服务 | **CONFIRMED（用户答复）** | Next.js 只做前端 |
| 后端为远程机器 IP+Port | **CONFIRMED（用户答复）** | 具体协议 TO_CONFIRM |
| 产物经共享存储「路径+状态」 | **CONFIRMED（用户答复）** | 状态标记约定 TO_CONFIRM → B-5 |
| 后端单任务级取消能力 | **TO_CONFIRM** | **P0 风险**，见 `BACKEND_REQUIREMENTS.md` §F |
| 后端真实进度上报 | **TO_CONFIRM** | 若无，UX 只显示耗时与心跳，不伪造百分比 |
| `process_instance_id` 语义 | **TO_CONFIRM** | 不得用 OS PID |
| `mode` → Skill 切换机制 | **TO_CONFIRM** | |
| 单任务真实耗时分布 | **TO_CONFIRM** | 心跳 / 超时参数需压测定档 |
