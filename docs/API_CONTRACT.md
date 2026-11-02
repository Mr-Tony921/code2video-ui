# API_CONTRACT — 接口协议

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


> 版本 **v1.0** / 2026-10-23 / Phase 1 交付物 · **供后端 Review**
> 服务端口：**9999**（Gateway）。Base URL：`http://<gateway-host>:9999`
> 机器可读版本：`openapi/openapi.yaml`
> 配套：`STATE_MACHINE.md`（状态定义）、`LONG_RUNNING_JOBS.md`（长任务语义）、`BACKEND_INTEGRATION.md`（后端映射）

---

## 0. 给 Reviewer 的阅读指引

本文档分三部分，**后端同学请重点看 §8 与 §9**：

| 章节 | 内容 | 实现方 |
|---|---|---|
| §1~§3 | 通用约定（鉴权、错误、幂等） | 双方 |
| §4~§7 | **浏览器公开 API** `/api/*` | Gateway（我方） |
| **§8** | **内部 Worker/Scheduler API** `/internal/*` | **后端 Worker 需调用/实现** |
| **§9** | **Gateway → 后端的出向调用（待后端确认协议）** | **后端需提供** |

> §9 的每一项都标注了 `TO_CONFIRM`，是本次 review 最需要后端回复的部分。

---

## 1. 通用约定

### 1.1 两套物理隔离的 API 面

| | 公开 API | 内部 API |
|---|---|---|
| 前缀 | `/api/*` | `/internal/*` |
| 监听 | `0.0.0.0:9999` | **仅内网网卡**（如 `10.0.0.0/8`），或独立端口 `9998` |
| 鉴权 | HttpOnly Session Cookie | **mTLS 或 `X-Internal-Token` 共享密钥 + IP 白名单** |
| 调用方 | 浏览器 | 后端 Worker / Scheduler |
| 普通用户可达 | ✅ | ❌ **绝对不可** |

> 任务 14 要求：「内部接口需要有独立认证，不允许普通用户直接调用 Worker 心跳或取消控制接口。」
> Gateway 启动时校验：若 `INTERNAL_API_TOKEN` 未设置或长度 < 32，**直接拒绝启动**。

### 1.2 公共请求头

| 头 | 适用 | 说明 |
|---|---|---|
| `Cookie: cvw_session=…` | 公开 API | HttpOnly + Secure + SameSite=Lax |
| `X-Internal-Token: <token>` | 内部 API | 共享密钥（或改用 mTLS 客户端证书） |
| `Idempotency-Key: <uuid>` | 所有写操作 | 见 §3 |
| `X-Request-Id: <uuid>` | 全部 | 链路追踪；未提供则由 Gateway 生成并回传 |

### 1.3 时间与数值约定

- 所有时间为 **ISO 8601 UTC**，含毫秒：`2026-10-23T07:42:10.123Z`
- **一律使用服务端时间**。客户端不得用本地时钟计算任务耗时；响应含 `server_time` 供校正
- 时长字段统一以 `_ms` / `_seconds` 后缀明示单位
- `progress_percent` 为 `0~100` 的整数，**可为 `null`**（后端不提供时）。
  **前端在 `null` 时不得显示任何百分比**（任务 7.4）

### 1.4 响应包络

成功响应直接返回资源对象（无额外包装）。错误响应统一：

```jsonc
{
  "error": {
    "code": "REVISION_STALE",              // 机器可读，稳定不变
    "message": "提示词已更新到第 3 版，请重新确认",   // 面向用户，可本地化
    "details": { "latest_revision_id": "...", "latest_revision_no": 3 },
    "request_id": "req_7f2a..."
  }
}
```

---

## 2. 错误码总表

### 2.1 HTTP 状态码语义

| 码 | 用法 |
|---|---|
| 200 | 成功 |
| 201 | 资源已创建（Session / 邀请码 / 用户） |
| **202** | **已接受，异步处理中**（创建 Job、取消 Job）—— 长任务的标准返回 |
| 204 | 成功无内容（登出） |
| 400 | 请求格式/参数错误（Zod 校验失败） |
| 401 | 未登录或会话过期 |
| 403 | 已登录但无权限（如无白模权限） |
| **404** | 资源不存在 **或无权访问**（不泄露存在性） |
| 409 | 状态冲突（版本过期、已终态、租约失效） |
| 410 | 资源已过期（邀请码过期） |
| 413 | 请求体过大（超长 Prompt） |
| 422 | 业务规则不满足（邀请码用尽） |
| 429 | 限流 |
| 500 | 服务端错误 |
| 503 | 依赖不可用（无健康 Worker） |

### 2.2 业务错误码

| code | HTTP | 含义 | 客户端应做 |
|---|---|---|---|
| `VALIDATION_FAILED` | 400 | 参数校验失败 | 展示字段错误 |
| `UNAUTHENTICATED` | 401 | 未登录/过期 | 弹登录框，**不取消任务** |
| `ACCOUNT_DISABLED` | 403 | 账号被禁用 | 提示联系管理员 |
| `BLOCKOUT_3D_FORBIDDEN` | 403 | 无白模权限 | 置灰模式入口 |
| `MODE_MISMATCH` | 403 | 请求 mode 与 Session 实际 mode 不符 | **越权尝试**，记审计日志 |
| `NOT_FOUND` | 404 | 不存在或无权 | 返回列表 |
| `INVITE_INVALID` | 422 | 邀请码无效 | 提示重新输入 |
| `INVITE_EXPIRED` | 410 | 邀请码过期 | 同上 |
| `INVITE_EXHAUSTED` | 422 | 使用次数已用尽 | 同上 |
| `USERNAME_TAKEN` | 409 | 用户名已存在 | 提示换名 |
| `SESSION_NOT_ACTIVE` | 409 | Session 为 `DEGRADED`/`CLOSED` | 提示新建会话 |
| `PROCESS_UNAVAILABLE` | 503 | 无健康进程可分配 | 提示稍后重试 |
| `SESSION_BUSY` | 409 | 该 Session 有生成任务进行中 | 禁用输入框并说明 |
| `REVISION_STALE` | 409 | 确认的不是最新 Prompt 版本 | 静默刷新并提示重新确认 |
| `WORKFLOW_NOT_APPROVABLE` | 409 | Workflow 状态不允许确认 | 刷新快照 |
| `JOB_ALREADY_TERMINAL` | 409 | Job 已终态 | 展示真实状态（见 §6.3） |
| `JOB_NOT_CANCELLABLE` | 409 | 当前状态不可取消 | 展示真实状态 |
| `LEASE_INVALID` | 409 | 租约失效/epoch 过期 | **内部**：Worker 应停止并放弃结果 |
| `ASSET_NOT_READY` | 409 | 产物未就绪 | 显示「准备中」，不给下载 |
| `PROMPT_TOO_LONG` | 413 | Prompt 超长 | 提示精简 |
| `RATE_LIMITED` | 429 | 限流 | 退避重试 |
| `BACKEND_UNAVAILABLE` | 503 | 后端不可用 | 提示稍后重试 |
| `INTERNAL_AUTH_FAILED` | 401 | 内部 Token 无效 | **内部**：检查配置 |

---

## 3. 幂等性约定（长任务的生命线）

### 3.1 规则

| 操作 | 幂等机制 |
|---|---|
| `POST /api/workflows/{id}/approve` | `Idempotency-Key` **必填** + `(user_id, key)` UNIQUE + `workflow_id` UNIQUE。重复请求返回**同一** `job_id`，HTTP **200**（首次为 202） |
| `POST /api/jobs/{id}/cancel` | 天然幂等。重复请求只追加审计记录，返回当前真实状态 |
| `POST /api/sessions` | `Idempotency-Key` 可选；提供则重复返回同一 Session |
| `POST /api/sessions/{id}/messages` | `Idempotency-Key` **必填**，防断线重试产生重复消息 |
| `POST /api/workflows/{id}/revise` | `Idempotency-Key` **必填**，防重复提交同一修改意见 |
| `POST /internal/jobs/{id}/complete` | `lease_token` 作为 fencing；重复提交同一结果返回 200，过期租约返回 **409** |
| `POST /internal/jobs/{id}/heartbeat` | 天然幂等 |

### 3.2 「提交成功但响应丢失」的处理（任务 11.11）

```text
客户端 POST approve (Idempotency-Key: K) → 服务端成功创建 Job-X → 响应在网络中丢失
客户端超时 → 用【同一个 K】重试
  → 服务端命中 idempotency_records → 返回 Job-X（HTTP 200）
  → ✅ 绝不产生第二个昂贵任务
```

`idempotency_records` 保留 **24 小时**。Key 由客户端生成（UUIDv4），
**在 Prompt Review Card 首次渲染时生成并缓存**，而非点击时生成——
否则双击会产生两个不同 Key，绕过幂等（这是最常见的实现错误）。

---

## 4. 认证与用户 API

### 4.1 `POST /api/auth/register`

邀请码注册。**无需登录**。

```jsonc
// 请求
{ "invite_code": "SNV-3F2A-9K1D-7X2M",
  "username": "alice",
  "password": "<明文, TLS 保护>",
  "email": "alice@example.com"        // 可选
}
// 201
{ "user": { "id": "...", "username": "alice", "role": "user",
            "can_use_blockout_3d": false, "status": "active",
            "created_at": "2026-10-23T06:00:00.000Z" } }
```

| 项 | 说明 |
|---|---|
| 鉴权 | 无 |
| 幂等 | 否（用户名 UNIQUE 兜底 → `USERNAME_TAKEN`） |
| 事务 | 校验码 → **原子扣减 `used_count`** → 创建用户 → 若 `grants_blockout_3d` 则置权限。任一步失败全回滚 |
| 错误 | `INVITE_INVALID` / `INVITE_EXPIRED` / `INVITE_EXHAUSTED` / `USERNAME_TAKEN` / `VALIDATION_FAILED` |
| 限流 | 按 IP 10 次/小时 |
| 密码策略 | ≥10 字符，含大小写与数字；Argon2id 存储 |

### 4.2 `POST /api/auth/login`

```jsonc
// 请求 { "username": "alice", "password": "..." }
// 200  → Set-Cookie: cvw_session=...; HttpOnly; Secure; SameSite=Lax; Max-Age=604800
{ "user": { "id": "...", "username": "alice", "role": "user",
            "can_use_blockout_3d": true, "status": "active" },
  "server_time": "2026-10-23T06:00:00.000Z" }
```

错误：`UNAUTHENTICATED`（凭据错误，**不区分**用户不存在与密码错误）/ `ACCOUNT_DISABLED` / `RATE_LIMITED`（5 次/5 分钟/IP+用户名）。

### 4.3 `POST /api/auth/logout` → `204`

清除服务端会话。**对运行中的 Job 零影响**（任务 11.8）。

### 4.4 `GET /api/auth/me`

```jsonc
// 200
{ "user": { "id": "...", "username": "alice", "role": "user",
            "can_use_blockout_3d": true, "status": "active" },
  "permissions": { "modes": ["coding_to_video", "blockout_3d"], "is_admin": false },
  "server_time": "2026-10-23T07:42:10.123Z" }
```

> `permissions.modes` 是 UI 的**唯一**权限依据（不读 localStorage）。
> 401 时前端**不得**发起任何取消请求。

### 4.5 `POST /api/auth/change-password`

```jsonc
// 请求 { "current_password": "...", "new_password": "..." }
// 204  → 使该用户其他会话失效（更新 password_changed_at），但【不影响运行中 Job】
```

---

## 5. Session API

### 5.1 `POST /api/sessions` — 创建会话并绑定进程

```jsonc
// 请求
{ "mode": "coding_to_video" }        // 或 "blockout_3d"
// 201
{ "session": {
    "id": "sess_...", "mode": "coding_to_video", "status": "ACTIVE",
    "title": null,
    "created_at": "2026-10-23T07:00:00.000Z",
    "last_activity_at": "2026-10-23T07:00:00.000Z" },
  "binding": {
    "worker_id": "gpu-node-07",
    "process_instance_id": "gpu-node-07:9f3c1a8e-4b2d-...",
    "status": "BOUND", "bound_at": "2026-10-23T07:00:00.000Z" },
  "server_time": "..." }
```

| 项 | 说明 |
|---|---|
| 鉴权 | 必须登录；`mode=blockout_3d` 需 `can_use_blockout_3d=true`（**服务端校验点 1/4**） |
| 幂等 | `Idempotency-Key` 可选 |
| 选进程 | `status=HEALTHY` ∧ `mode ∈ supported_modes` ∧ 心跳新鲜 ∧ `active_sessions < max_sessions`，按 `(active_sessions, running_jobs)` 升序 |
| 不变式 | 绑定写入后 `process_instance_id` **永不变更**（任务 5） |
| 错误 | `BLOCKOUT_3D_FORBIDDEN` / `PROCESS_UNAVAILABLE`(503) |
| 副作用 | **不影响任何已存在的 Session 或运行中 Job**（任务 8.6） |

### 5.2 `GET /api/sessions/{id}` — 恢复会话快照（恢复流程的核心接口）

一次调用返回恢复 UI 所需的全部信息。

```jsonc
// 200
{
  "session": { "id": "sess_...", "mode": "coding_to_video", "status": "ACTIVE",
               "title": "赛博朋克城市夜景",
               "created_at": "...", "last_activity_at": "..." },
  "binding": { "worker_id": "gpu-node-07",
               "process_instance_id": "gpu-node-07:9f3c...",
               "status": "BOUND",          // BOUND|SUSPECTED|PROCESS_LOST|RELEASED
               "health_note": null },      // PROCESS_LOST 时为人类可读说明
  "messages": [
    { "id": "...", "seq": 1, "role": "user", "kind": "text",
      "content": { "text": "帮我生成赛博朋克城市夜景" },
      "created_at": "..." },
    { "id": "...", "seq": 2, "role": "assistant", "kind": "prompt_review",
      "content": { "text": "我已为你增强提示词，请确认：" },
      "workflow_id": "wf_...", "created_at": "..." },
    { "id": "...", "seq": 3, "role": "assistant", "kind": "job_card",
      "content": {}, "job_id": "job_...", "created_at": "..." }
  ],
  "active_workflow": {                    // 可为 null
    "id": "wf_...", "status": "AWAITING_APPROVAL",
    "intent": "new_generation", "base_asset_id": null,
    "latest_revision": {
      "id": "rev_...", "revision_no": 2,
      "enhanced_prompt": "赛博朋克风格城市夜景，雨后湿滑街道…",
      "user_note": "镜头再慢一些", "is_stale": false, "created_at": "..." },
    "revision_count": 2,
    "idempotency_hint": "wf_...:rev_...:approve"   // 建议的幂等键种子
  },
  "active_job": { /* 同 §6.1 的 Job 对象，可为 null */ },
  "assets": [ /* 本会话已生成的产物，含版本链，见 §7.1 */ ],
  "server_time": "2026-10-23T07:42:10.123Z"
}
```

> 这一个接口满足任务 8.3 的第 5~9 步与 11.3（关页面时 Prompt 还在增强）。
> `binding.status = PROCESS_LOST` 时前端必须明示失联，**不假装恢复成功**（任务 8.3 第 10 条）。

### 5.3 `POST /api/sessions/{id}/messages` — 发送消息

```jsonc
// 请求  Header: Idempotency-Key: <uuid>   (必填)
{ "text": "帮我生成一个赛博朋克风格的城市夜景短视频",
  "intent_hint": "new_generation",   // 可选，仅提示，后端有最终判定权
  "base_asset_id": null              // 仅 edit_generation 时提供
}
// 202
{ "message": { "id": "...", "seq": 4, "role": "user", "kind": "text",
               "content": { "text": "..." }, "created_at": "..." },
  "processing": { "kind": "intent_classification",
                  "events_url": "/api/sessions/sess_.../events" },
  "server_time": "..." }
```

| 项 | 说明 |
|---|---|
| 鉴权 | 登录 + Session 归属 + **mode 权限（校验点 2/4）**。mode 一律取 DB 中 Session 的值，**忽略请求体中的任何 mode** |
| 前置 | `session.status = ACTIVE`，否则 `SESSION_NOT_ACTIVE` |
| 并发 | 若该 Session 有非终态 Job 且后端不支持并发对话 → `SESSION_BUSY`（任务 11.4）。后端确认支持后此限制可配置放开 |
| 幂等 | `Idempotency-Key` 必填，防断线重试产生重复消息 |
| 异步 | **立即返回 202**；意图识别与 Prompt 增强结果经 SSE 推送 |
| 限制 | `text` ≤ 8000 字符，超出 `PROMPT_TOO_LONG`(413) |
| V1 限制 | **无 `attachments` 字段**。请求体出现该字段 → 400（任务 3.1 / 测试 O） |

### 5.4 `GET /api/sessions/{id}/events` — 会话级 SSE

`text/event-stream`。推送会话级事件（消息、意图结果、workflow 变化）。
支持 `Last-Event-ID`。事件类型：

| type | payload 要点 |
|---|---|
| `message.created` | 完整 message 对象 |
| `intent.classified` | `{message_id, intent, notice?}`（`out_of_scope` 时带结构化提示） |
| `workflow.created` | `{workflow_id, status:'ENHANCING'}` |
| `workflow.revision_ready` | `{workflow_id, status:'AWAITING_APPROVAL', latest_revision}` |
| `workflow.enhance_failed` | `{workflow_id, failure_code, failure_message}` |
| `workflow.approved` | `{workflow_id, job_id}` |
| `binding.status_changed` | `{status, health_note}` |
| `session.status_changed` | `{status}` |
| `keepalive` | `{server_time}`（每 15s；**仅证明连接可用，不证明后端在算**） |

### 5.5 `POST /api/sessions/{id}/close` → `200`

关闭会话（`status=CLOSED`）。**不取消其下运行中的 Job**（任务 8.6）；
响应体返回 `{"running_jobs_kept": ["job_..."]}` 供 UI 提示。

---

## 6. Prompt Workflow 与 Job API

### 6.1 Job 对象（统一结构，全文复用）

```jsonc
{
  "id": "job_...",
  "session_id": "sess_...",
  "workflow_id": "wf_...",
  "prompt_revision_id": "rev_...",
  "mode": "coding_to_video",
  "base_asset_id": null,                  // edit_generation 时指向被修改的旧视频

  "status": "RUNNING",                    // 枚举见下方 §6.1.1
  "phase": "RENDERING",                   // 可为 null
  "progress_percent": 62,                 // ⚠️ 可为 null → 前端不得显示百分比

  "created_at":        "2026-10-23T07:00:00.000Z",
  "queued_at":         "2026-10-23T07:00:00.100Z",
  "assigned_at":       "2026-10-23T07:00:02.000Z",
  "started_at":        "2026-10-23T07:00:05.000Z",
  "phase_started_at":  "2026-10-23T08:05:00.000Z",
  "last_heartbeat_at": "2026-10-23T08:23:50.000Z",
  "last_progress_at":  "2026-10-23T08:23:30.000Z",
  "finished_at":       null,   // ★ 唯一权威的【终态时间】，三种终态（COMPLETED/
                               //   FAILED/CANCELLED）都写它。**没有 completed_at
                               //   这个字段**，别去找：按它统计"今天完成多少"会得到 0，
                               //   曾因此差点误报成"今天没有任务完成"。

  "elapsed": { "queued_ms": 100, "running_ms": 4985000, "current_phase_ms": 1090000 },

  "health": {
    "worker_status": "HEALTHY",           // HEALTHY|SUSPECTED_UNAVAILABLE|UNAVAILABLE|DRAINING
    "job_heartbeat_age_ms": 20000,
    "progress_age_ms": 40000,
    "stalled": false,                     // 心跳正常但长时间无进度
    "assessment": "HEALTHY_RUNNING"
    // HEALTHY_RUNNING | HEALTHY_STALLED | HEARTBEAT_LOST | CONFIRMED_FAILED | STATE_UNKNOWN
  },

  "queue": { "position": null, "global_used": 3, "global_capacity": 4 },

  "cancellation": {                       // 非 null 即表示有取消请求
    "requested_at": null, "requested_by": null, "reason": null,
    "acked_at": null, "effective": null, "resources_released_at": null
  },

  "failure": { "code": null, "message": null },
  "result_asset_id": null,
  "attempt": 1,
  "max_runtime_seconds": 10800,
  "worker_id": "gpu-node-07",
  "process_instance_id": "gpu-node-07:9f3c...",
  "poll_url":   "/api/jobs/job_...",
  "events_url": "/api/jobs/job_.../events"
}
```

> `health.assessment` 直接对应任务 7.5 的五分类，前端据此选择文案，**不自行推断**。

#### 6.1.1 `status` 枚举（与 `STATE_MACHINE.md` §2.4 及 OpenAPI `JobStatus` 完全一致）

| 值 | 终态 | 语义 | 前端要点 |
|---|---|---|---|
| `QUEUED` | | 已入队，等并发槽 | 显示已等待时长 + 队列位置 |
| `ASSIGNED` | | 已分配进程与租约，待后端确认开始 | 「正在启动」 |
| `RUNNING` | | 执行中，细分由 `phase` 表达 | 显示已运行时长 + 状态新鲜度 |
| `CANCEL_REQUESTED` | | 取消意图已持久化，尚未确认 | 「正在请求停止…」**不得显示为已取消** |
| `CANCELLING` | | 后端已收到并在停止 | 「正在停止，回收资源中…」 |
| `CANCELLED` | ✅ | 已确认停止 | 「已取消」+ 是否释放资源 |
| `COMPLETED` | ✅ | 产物已完整写入并校验 | 播放器 + 下载 + 继续修改 |
| `FAILED` | ✅ | 已确认失败 | 真实失败原因 + 重试入口 |
| `UNKNOWN` | | 服务端**无法确认**真实执行状态 | 「正在确认后端状态…」**禁止当作失败，禁止自动重试** |
| `RECOVERING` | | 正在对账 / 恢复 | 「正在与后端核对任务状态」 |

终态为 `COMPLETED` / `FAILED` / `CANCELLED`，三者互斥且不可再迁移。
`UNKNOWN` / `RECOVERING` 不是失败，也不是自动重试信号（任务 7.2）。

### 6.2 Prompt Workflow

#### `GET /api/workflows/{id}` → `200`

```jsonc
{ "workflow": { "id": "wf_...", "session_id": "...", "mode": "coding_to_video",
                "intent": "new_generation", "status": "AWAITING_APPROVAL",
                "base_asset_id": null,
                "latest_revision_id": "rev_2", "approved_revision_id": null,
                "job_id": null, "created_at": "...", "updated_at": "..." },
  "revisions": [
    { "id": "rev_1", "revision_no": 1, "enhanced_prompt": "...",
      "user_note": null, "is_stale": true,  "created_at": "..." },
    { "id": "rev_2", "revision_no": 2, "enhanced_prompt": "...",
      "user_note": "镜头再慢一些", "is_stale": false, "created_at": "..." }
  ] }
```

#### `POST /api/workflows/{id}/revise` — 提交修改意见

```jsonc
// Header: Idempotency-Key: <uuid>  (必填)
// 请求
{ "base_revision_id": "rev_2", "note": "希望镜头运动再慢一些，增加雨滴特写" }
// 202
{ "workflow": { "id": "wf_...", "status": "REVISING", ... },
  "server_time": "..." }
```

| 项 | 说明 |
|---|---|
| 前置 | `status ∈ {AWAITING_APPROVAL, ENHANCE_FAILED}`，否则 `WORKFLOW_NOT_APPROVABLE` |
| `base_revision_id` | 必须等于 `latest_revision_id`，否则 `REVISION_STALE`(409) |
| 异步 | 202 返回，新版本就绪后经 SSE `workflow.revision_ready` 推送 |
| 副作用 | 旧 revision 置 `is_stale=true` |

#### `POST /api/workflows/{id}/approve` — **确认生成（创建 Job）**

> **本协议最关键的接口。** 必须快速返回，绝不等待生成完成（任务 7.1）。

```jsonc
// Header: Idempotency-Key: <uuid>   ★必填★
// 请求
{ "revision_id": "rev_2" }
// 202 (首次)  /  200 (幂等重放)
{ "job": { "id": "job_...", "status": "QUEUED",
           "created_at": "2026-10-23T07:00:00.000Z",
           "queued_at":  "2026-10-23T07:00:00.100Z",
           "queue": { "position": 2, "global_used": 4, "global_capacity": 4 },
           "max_runtime_seconds": 10800,
           "poll_url":   "/api/jobs/job_...",
           "events_url": "/api/jobs/job_.../events" },
  "idempotent_replay": false,
  "server_time": "..." }
```

| 项 | 说明 | 出处 |
|---|---|---|
| 鉴权 | 登录 + 归属 + **mode 权限（校验点 3/4：执行 Workflow）** | 4.3 |
| **响应时间** | **目标 < 500ms，硬上限 1s。不得等待任何生成动作** | 7.1 |
| 事务 | `workflow→APPROVED` + `INSERT jobs(QUEUED)` + `INSERT job_events(seq=1)` 同一事务 | 6 |
| 幂等 | `(user_id, Idempotency-Key)` UNIQUE **且** `workflow_id` UNIQUE。重放返回同一 `job_id` + `idempotent_replay:true` + HTTP 200 | 11.1 |
| 版本守卫 | `revision_id ≠ latest_revision_id` → `REVISION_STALE`(409) | 6 |
| 状态守卫 | `status ≠ AWAITING_APPROVAL` → `WORKFLOW_NOT_APPROVABLE`(409) | 6 |
| 权限守卫 | 确认时**重新**校验 mode 权限（可能已被撤销） | 11.9 |
| 不阻塞 | HTTP 结束后由 Gateway Dispatcher 异步推进 | 7.1 |

#### `POST /api/workflows/{id}/cancel` → `200`

放弃未确认的 workflow（`status=ABANDONED`）。
**仅适用于尚未创建 Job 的 workflow**；已有 Job 请用 §6.4。

### 6.3 `GET /api/jobs/{id}` — 权威状态快照

返回 §6.1 的 Job 对象。**这是前端的权威数据来源**，SSE 仅为加速。

| 项 | 说明 |
|---|---|
| 鉴权 | 登录 + `job.user_id = me`，否则 **404** |
| 幂等 | 是（GET） |
| 轮询建议 | 页面可见 5s；隐藏 60s；重新可见立即同步一次（任务 12.2） |
| 缓存 | `Cache-Control: no-store` |

### 6.4 `POST /api/jobs/{id}/cancel` — 请求取消

```jsonc
// Header: Idempotency-Key: <uuid>  (建议)
// 请求 { "reason_note": "不需要了" }          // 可选
// 202
{ "job": { "id": "job_...", "status": "CANCEL_REQUESTED",
           "cancellation": { "requested_at": "2026-10-23T08:30:00.000Z",
                             "requested_by": "usr_...", "reason": "user",
                             "acked_at": null, "effective": null,
                             "resources_released_at": null } },
  "server_time": "..." }
```

| 项 | 说明 | 出处 |
|---|---|---|
| **返回状态** | **`CANCEL_REQUESTED`，绝不是 `CANCELLED`** | 9.5 |
| 步骤 | ①校验归属 ②校验可取消 ③**持久化取消意图**（先落库） ④撤销租约 ⑤通知后端 ⑥后端实际停止 ⑦更新终态 ⑧释放并发槽 | 9.5 |
| 幂等 | 重复调用只追加审计记录，返回当前状态，**不重复触发副作用** | 11.6 |
| 已终态 | `409 JOB_ALREADY_TERMINAL`，`details` 含真实 `status` 与 `result_asset_id` | 11.7 |
| 竞争 | 与 complete 并发时单事务裁决，**完成优先**（产物 READY 时） | 11.7 |
| 后续 | 前端订阅 `job.cancelling` / `job.cancelled` 事件，逐步展示 | 9.5 |

### 6.5 `GET /api/jobs/{id}/events` — Job 级 SSE

```text
GET /api/jobs/job_abc/events
Accept: text/event-stream
Last-Event-ID: 42            ← 断线重连时携带已收到的最大 seq
```

```text
id: 43
event: job.phase
data: {"job_id":"job_abc","status":"RUNNING","phase":"RENDERING",
       "phase_started_at":"2026-10-23T08:05:00.000Z","server_time":"..."}

id: 44
event: job.progress
data: {"job_id":"job_abc","status":"RUNNING","phase":"RENDERING",
       "progress_percent":62,"last_progress_at":"...","server_time":"..."}

id: 45
event: job.heartbeat_status
data: {"job_id":"job_abc","health":{"worker_status":"HEALTHY",
       "job_heartbeat_age_ms":20000,"progress_age_ms":1500000,
       "stalled":true,"assessment":"HEALTHY_STALLED"},"server_time":"..."}

: keepalive 2026-10-23T08:24:05.000Z
```

| 事件 type | 语义 |
|---|---|
| `job.queued` | 已入队 |
| `job.assigned` | 已分配进程与租约 |
| `job.started` | 后端确认开始执行 |
| `job.phase` | 阶段变化 |
| `job.progress` | 进度更新（仅后端提供时） |
| `job.heartbeat_status` | **心跳/停滞健康评估**（与业务进度区分） |
| `job.cancel_requested` / `job.cancelling` / `job.cancelled` | 取消三阶段 |
| `job.completed` | `{result_asset_id, asset:{...}}` |
| `job.failed` | `{failure:{code,message}}` |
| `job.state_unknown` | 无法确认真实状态 |
| `job.recovering` | 正在对账恢复 |

**事件契约**（任务 12.1）：

1. `id:` 即 `job_events.seq`，**Job 内严格单调递增**
2. 每个事件携带**完整状态字段**（非增量 diff）→ 天然幂等，可乱序可重复
3. 客户端维护 `maxSeenSeq`，丢弃 `seq <= maxSeenSeq`
4. `Last-Event-ID` 回放 `seq > N` 的持久化事件，再接实时流
5. `: keepalive` 注释行**仅表示连接可用，不表示后端在计算**（任务 12 明确要求区分）
6. 终态事件后服务端主动关闭流
7. **SSE 断开不触发任何 Job 状态变化**（不变式 I-4）

---

## 7. 任务恢复与产物 API

### 7.1 `GET /api/me/active-context` — 恢复兜底（缓存丢失时的关键接口）

```jsonc
// 200
{
  "active_session": { /* session 对象，可为 null */ },
  "running_jobs": [ /* 该用户所有非终态 Job 的精简对象 */
    { "id": "job_...", "session_id": "sess_...", "mode": "coding_to_video",
      "status": "RUNNING", "phase": "RENDERING", "progress_percent": 62,
      "started_at": "...", "elapsed": { "running_ms": 4985000 },
      "health": { "assessment": "HEALTHY_RUNNING", "stalled": false },
      "prompt_summary": "赛博朋克风格城市夜景…",
      "session_available": true }          // binding 是否仍有效（能否回到该会话）
  ],
  "recent_completed_jobs": [
    { "id": "job_...", "session_id": "...", "status": "COMPLETED",
      "finished_at": "...", "result_asset_id": "asset_...",
      "prompt_summary": "海边日落…",
      "asset": { "id": "asset_...", "state": "READY", "duration_ms": 10200,
                 "width": 1920, "height": 1080, "size_bytes": 19293696,
                 "playable": true,
                 "playback_url": "/api/assets/asset_.../playback",
                 "download_url": "/api/assets/asset_.../download" } }
  ],
  "limits": { "recent_completed_limit": 10 },
  "server_time": "..."
}
```

| 项 | 说明 | 出处 |
|---|---|---|
| 用途 | localStorage 丢失 / 隐私模式 / 换浏览器 / 换设备时的**服务端兜底恢复** | 8.4 |
| 鉴权 | 仅返回**当前用户**的数据 | 4.3 |
| 范围 | 全部运行中 Job + 限量最近完成 Job。**不是**完整历史 Session 系统 | 8.4 / 8.5 |
| `session_available` | `false` 表示原会话进程已失联，只能看产物不能回会话 | 8.3 |

### 7.2 `GET /api/me/jobs?status=active|recent|all&limit=20`

左侧「进行中的任务 / 最近结果」面板的数据源。字段同上，支持分页（`cursor`）。

### 7.3 Asset API

#### `GET /api/assets/{id}`

```jsonc
// 200
{ "asset": {
    "id": "asset_...", "job_id": "job_...", "session_id": "sess_...",
    "kind": "video",                       // video|preview_image|blockout_video
    "state": "READY",                      // PENDING|VERIFYING|READY|CORRUPT|ABANDONED
    "mime_type": "video/mp4",
    "size_bytes": 19293696,
    "duration_ms": 10200,
    "width": 1920, "height": 1080,
    "checksum": "sha256:7f2a...",
    "playable": true,
    "derived_from_asset_id": null,         // 版本链：B 指向 A
    "version_chain": ["asset_v1", "asset_v2"],
    "created_at": "...", "ready_at": "...",
    "playback_url": "/api/assets/asset_.../playback",
    "download_url": "/api/assets/asset_.../download" } }
```

> ⚠️ **响应中永不包含 `storage_path`**（任务 13.3）。共享存储绝对路径只存在于 DB 与 Gateway 内部。

#### `GET /api/assets/{id}/playback`

流式返回视频，支持 `Range`（`206 Partial Content`）。
`state ≠ READY` → `409 ASSET_NOT_READY`（**绝不返回半写入文件**，任务 11.7）。

#### `GET /api/assets/{id}/download`

同上，附加 `Content-Disposition: attachment; filename="..."`。
必须以流式转发（不整体读入内存），支持 Range 断点续传（任务 13.3）。

### 7.4 `GET /api/system/capacity`

```jsonc
// 200
{ "global": { "capacity": 8, "used": 5, "queued": 3 },
  "modes_share_capacity": true,            // 两模式共享，不可通过切 mode 突破
  "workers": [
    { "worker_id": "gpu-node-07", "status": "HEALTHY",
      "last_heartbeat_age_ms": 8000,
      "processes": [
        { "process_instance_id": "gpu-node-07:9f3c...",
          "status": "HEALTHY",
          "supported_modes": ["coding_to_video", "blockout_3d"],
          "active_sessions": 3, "max_sessions": 8,
          "running_jobs": 2, "max_concurrent_jobs": 2,
          "queued_jobs": 1 } ] } ],
  "server_time": "..." }
```

普通用户只得到 `global` 部分；`workers` 细节**仅管理员可见**。

---

## 8. 内部 Worker / Scheduler API ★后端重点★

> **鉴权**：`X-Internal-Token` 或 mTLS。仅内网可达。
> 以下接口由 **Gateway 实现，后端 Worker 调用**。

### 8.1 `POST /internal/processes/register`

Worker 进程启动时注册。

```jsonc
// 请求
{ "worker_id": "gpu-node-07",
  "host": "10.20.30.7", "port": 18080,
  "process_instance_id": "gpu-node-07:9f3c1a8e-4b2d-4f71-9c3e-...",
  "os_pid": 48213,
  "supported_modes": ["coding_to_video", "blockout_3d"],
  "max_sessions": 8,
  "max_concurrent_jobs": 2,
  "version": "agent-1.4.2",
  "started_at": "2026-10-23T06:00:00.000Z" }
// 200
{ "accepted": true,
  "config": { "heartbeat_interval_seconds": 12,
              "job_heartbeat_interval_seconds": 20,
              "lease_ttl_seconds": 120,
              "cancel_grace_seconds": 60 },
  "server_time": "..." }
```

**硬要求**（任务 5 / 10.4）：

- `process_instance_id` **必须全局唯一，进程每次重启都必须变更**
- **不得**使用 OS PID 作为进程身份（PID 会复用）
- 推荐格式 `{worker_id}:{uuid-v4-生成于进程启动时}`

### 8.2 `POST /internal/processes/heartbeat` — Worker 心跳（每 10~15s）

```jsonc
// 请求
{ "worker_id": "gpu-node-07",
  "process_instance_id": "gpu-node-07:9f3c...",
  "status": "healthy",                     // healthy|draining
  "active_sessions": 3,
  "running_jobs": 1,
  "running_job_ids": ["job_abc"],          // ★必填★ 用于反向对账
  "max_sessions": 8,
  "max_concurrent_jobs": 2,
  "resources": { "gpu_util": 0.87, "gpu_mem_used_mb": 21400,
                 "gpu_mem_total_mb": 24576, "cpu_load": 6.2,
                 "disk_free_gb": 420 },
  "reported_at": "2026-10-23T08:24:00.000Z" }
// 200
{ "ack": true,
  "server_time": "2026-10-23T08:24:00.050Z",
  "directives": [
    // Gateway 下达的控制指令（Pull 式通道，兜底 push 失败）
    { "type": "cancel_job",      "job_id": "job_xyz", "reason": "user" },
    { "type": "abort_not_owner", "job_id": "job_ghost" },   // DB 不认识这个 Job
    { "type": "drain" }                                      // 请求优雅下线
  ] }
```

| 字段 | 为何必填 |
|---|---|
| `running_job_ids` | Gateway 用它做**反向对账**：若后端在跑 DB 不认识的 Job → 下达 `abort_not_owner`，防止幽灵计算长期占用 GPU（`LONG_RUNNING_JOBS.md` §E.6） |
| `reported_at` | 仅供诊断；**以服务端时间为准**判定新鲜度 |

### 8.3 `POST /internal/jobs/{job_id}/heartbeat` — Job 心跳 / 租约续约（每 15~30s）

```jsonc
// 请求
{ "session_id": "sess_...",
  "worker_id": "gpu-node-07",
  "process_instance_id": "gpu-node-07:9f3c...",
  "lease_token": "lt_7f2a9b...",           // ★必填★ fencing 凭证
  "attempt": 1,
  "phase": "RENDERING",
  "progress_percent": 62,                   // 可选；无法提供则省略或 null
  "last_progress_at": "2026-10-23T08:23:30.000Z",
  "heartbeat_at": "2026-10-23T08:24:00.000Z" }
// 200
{ "lease": { "valid": true, "epoch": 1,
             "expires_at": "2026-10-23T08:26:00.000Z" },
  "control": "continue",
  "server_time": "..." }
```

**`control` 取值 —— Worker 必须响应**（任务 9.1 C 节）：

| 值 | Worker 必须做什么 |
|---|---|
| `continue` | 继续执行 |
| `cancel` | **立即停止**该 Job、杀其进程组、清理临时文件、释放 GPU，然后调 §8.6 |
| `abort_stale_lease` | 租约已失效（已被撤销/抢占）→ 立即停止，**不得提交任何结果** |
| `abort_max_runtime` | 已超最大运行时间 → 同 `cancel` |
| `abort_not_owner` | 当前进程已非该 Job 所有者 → 立即停止，不提交结果 |

错误响应：

| HTTP | code | Worker 应做 |
|---|---|---|
| 409 | `LEASE_INVALID` | 立即停止，放弃结果（等同 `abort_stale_lease`） |
| 404 | `NOT_FOUND` | Job 不存在 → 停止并清理 |
| 401 | `INTERNAL_AUTH_FAILED` | 检查配置；**不停止计算**，退避重试 |
| 5xx / 网络错误 | — | **不停止计算**，指数退避重试（1s/2s/4s…）。连续失败超 `lease_ttl×3` 才自保停止（`LONG_RUNNING_JOBS.md` §C.6） |

> ★ 关键要求（任务 9.2）：**心跳必须跑在独立控制线程 / Supervisor / 独立进程中**，
> 不得被长时间阻塞的渲染或编码函数挡住，否则会被误判失联。

### 8.4 `POST /internal/jobs/{job_id}/progress` — 阶段与进度上报

```jsonc
// 请求
{ "lease_token": "lt_7f2a...",
  "phase": "RENDERING",                    // PREPARING|GENERATING|RENDERING|FINALIZING
  "phase_changed": true,                   // 是否为阶段切换（用于 phase_started_at）
  "progress_percent": 62,                  // 可选
  "detail": { "frames_done": 186, "frames_total": 300 },   // 可选，仅展示
  "reported_at": "..." }
// 200  { "accepted": true, "seq": 44, "control": "continue", "server_time": "..." }
```

校验失败 → `409 LEASE_INVALID`，Gateway **丢弃该上报且不改变 Job 状态**（fencing，任务 9.3）。

### 8.5 `POST /internal/jobs/{job_id}/complete` — 完成上报

```jsonc
// 请求
{ "lease_token": "lt_7f2a...",
  "asset": {
    "kind": "video",
    "storage_path": "/mnt/shared/cvw/outputs/job_abc/final.mp4",   // 共享存储绝对路径
    "completion_marker": "/mnt/shared/cvw/outputs/job_abc/.done",  // 完成标记 (B-5)
    "mime_type": "video/mp4",
    "size_bytes": 19293696,
    "duration_ms": 10200,
    "width": 1920, "height": 1080,
    "frame_rate": 24,
    "checksum": "sha256:7f2a...",          // 强烈建议提供
    "derived_from_asset_id": null          // 旧视频修改时指向被改的 Asset
  },
  "finished_at": "2026-10-23T08:54:00.000Z" }
// 200
{ "accepted": true, "job_status": "COMPLETED", "asset_id": "asset_...",
  "server_time": "..." }
```

**Gateway 的校验顺序（全部通过才置 COMPLETED）**：

```text
1. lease_token 有效 ∧ lease_epoch 为当前值 ∧ revoked_at IS NULL
      → 否则 409 LEASE_INVALID，丢弃结果           (任务 9.3)
2. Job 当前非终态
      → 若已 COMPLETED 且 asset 相同 → 200 幂等返回
      → 若已 CANCELLED/FAILED → 409 JOB_ALREADY_TERMINAL
3. 若 Job 处于 CANCEL_REQUESTED/CANCELLING → 进入竞争裁决（完成优先）  (任务 11.7)
4. 产物完整性校验：完成标记存在 ∧ 文件可读 ∧ size>0 ∧ 实际大小匹配
   ∧ (有 checksum 则校验) ∧ 可探测时长/分辨率
      → 通过 → Asset VERIFYING → READY
      → 失败 → Asset CORRUPT, Job FAILED(ASSET_VERIFICATION_FAILED)   (任务 13.1)
5. Job=COMPLETED, finished_at, result_asset_id
6. 释放全局槽 + 进程槽；租约 released
7. 写 job_events(job.completed) 并广播
```

> ⚠️ 任务 13.1 原文：「不能因为共享目录中出现文件就立刻宣布完成。」
> → 因此 `completion_marker` 或等效的原子提交机制是**必需**的（阻塞项 **B-5**，需后端确认约定）。

### 8.6 `POST /internal/jobs/{job_id}/cancel-ack` — 取消确认

```jsonc
// 请求
{ "lease_token": "lt_7f2a...",
  "stopped": true,
  "stop_method": "sigterm",                // sigterm|sigkill|cooperative
  "resources_released": true,
  "released": { "gpu": true, "subprocesses": true, "temp_files": true },
  "partial_artifacts": [                   // 可选，默认不对外暴露
    { "storage_path": "/mnt/shared/.../partial.mp4", "size_bytes": 8123456 } ],
  "stopped_at": "2026-10-23T08:31:12.000Z" }
// 200
{ "accepted": true, "job_status": "CANCELLED", "server_time": "..." }
```

若 Worker 发现**取消到达时任务已完成** → 不调本接口，改调 §8.5 并在 `asset` 中照常上报；
Gateway 按「完成优先」裁决（任务 11.7）。

### 8.7 `POST /internal/jobs/{job_id}/fail` — 失败上报

```jsonc
// 请求
{ "lease_token": "lt_7f2a...",
  "failure": { "code": "E_RENDER_OOM",
               "message": "渲染阶段显存不足",
               "phase": "RENDERING",
               "retryable": false },
  "partial_artifacts": [],
  "failed_at": "..." }
// 200 { "accepted": true, "job_status": "FAILED", "server_time": "..." }
```

### 8.8 `GET /internal/jobs/{job_id}/truth` — 对账查询（**Gateway 调用后端**，见 §9）

此方向相反：Gateway 在 Job 进入 `UNKNOWN` 时向后端查询真实状态。协议见 §9.4。

---

## 9. Gateway → 后端的出向调用 ★全部 TO_CONFIRM，请后端填写★

> **已知前提（用户已确认）**：后端为远程机器，通过 **IP + Port** 访问；
> 产物通过**共享存储绝对路径 + 状态标记**交付。
> 下表是 Gateway 所需的**能力清单**，路径与报文形态可由后端决定——
> 请后端在 `required?` 为「是」的每一项上填写实际协议，或说明当前不支持。

| # | 能力 | Gateway 调用时机 | 必需 | 状态 |
|---|---|---|---|---|
| 9.1 | 初始化会话（绑定进程、创建上下文、按 mode 选 Skill） | 创建 Session | 是 | `TO_CONFIRM` |
| 9.2 | 发送用户消息并返回**结构化意图** | 用户发消息 | 是 | `TO_CONFIRM` |
| 9.3 | Prompt 增强 / 按修改意见再增强 | 意图为生成类 | 是 | `TO_CONFIRM` |
| 9.4 | 启动生成 Job（接收 `lease_token`） | Dispatcher 出队 | 是 | `TO_CONFIRM` |
| 9.5 | **取消单个 Job**（不杀共享进程） | 用户/系统取消 | **是（P0）** | `TO_CONFIRM` ⚠️ |
| 9.6 | 查询单个 Job 真实状态（对账） | Job 进入 `UNKNOWN` | 是 | `TO_CONFIRM` |
| 9.7 | 探测进程存活 | Worker 心跳缺失 | 是 | `TO_CONFIRM` |
| 9.8 | 产物完成标记的具体约定 | 完成校验 | **是（P0）** | `TO_CONFIRM` ⚠️ |

### 9.1 候选形态（供后端参考，非强制）

```jsonc
// Gateway → http://{worker_host}:{worker_port}/sessions
// 9.1 初始化会话
POST /sessions
{ "session_id": "sess_...", "mode": "coding_to_video",
  "process_instance_id": "gpu-node-07:9f3c...", "user_ref": "usr_..." }
→ 200 { "backend_session_ref": "bsess_...", "accepted": true }

// 9.2 发送消息 + 意图识别
POST /sessions/{backend_session_ref}/messages
{ "text": "...", "base_asset_id": null }
→ 200 { "intent": "new_generation",        // new_generation|edit_generation|
                                           // prompt_revision|video_discussion|out_of_scope
         "reply_text": null,               // video_discussion 时为对话回复
         "notice": null,                   // out_of_scope 时为结构化提示
         "enhanced_prompt": "...",         // 生成类意图时直接给增强结果
         "backend_meta": { } }

// 9.4 启动 Job
POST /jobs
{ "job_id": "job_...", "session_ref": "bsess_...",
  "mode": "coding_to_video",
  "prompt": "<已确认的增强 Prompt>",
  "base_asset_path": null,                 // 旧视频修改时给共享存储路径
  "lease_token": "lt_7f2a...",             // Worker 回调时必须带回
  "callback_base_url": "http://gateway:9999/internal",
  "max_runtime_seconds": 10800 }
→ 202 { "accepted": true, "backend_job_ref": "bjob_..." }

// 9.5 取消 Job  ★P0★
POST /jobs/{backend_job_ref}/cancel
{ "reason": "user", "grace_seconds": 60 }
→ 202 { "acked": true }
   // 后端随后完成实际停止并调 Gateway 的 §8.6 cancel-ack

// 9.6 对账查询
GET /jobs/{backend_job_ref}
→ 200 { "status": "running|completed|failed|not_found",
         "phase": "RENDERING",
         "asset": { "storage_path": "...", "completion_marker": "..." },  // completed 时
         "failure": { "code": "...", "message": "..." } }                  // failed 时

// 9.7 进程探活
GET /health
→ 200 { "process_instance_id": "gpu-node-07:9f3c...", "status": "healthy",
         "running_job_refs": ["bjob_..."] }
```

### 9.2 请后端明确回复的问题清单

| ID | 问题 | 为何重要 |
|---|---|---|
| **B-1** | 上述调用的**实际路径、请求体、鉴权方式**是什么？ | Gateway 的 `BackendAdapter` 需要据此实现 |
| **B-2** | 能否**只停止一个 Job**而不影响同进程的其他 Session/Job？若不能，改造工作量多大？ | **P0**。若不支持，取消功能无法真正实现（任务 9.6） |
| **B-3** | 能否上报真实进度百分比与阶段？若只能给阶段，有哪些阶段？ | 决定 UI 是显示进度条还是仅显示耗时（**绝不伪造**） |
| **B-4** | `process_instance_id` 由谁生成？重启是否必然变更？是否会复用 OS PID？ | Session 固定进程的正确性基础 |
| **B-5** | 产物完成标记的**具体约定**是什么？（`.done` 文件 / 原子 rename / manifest / checksum？） | **P0**。决定何时可宣布 `asset.ready`（任务 13.1） |
| **B-6** | `mode=blockout_3d` 在后端如何切换 Skill？是请求参数还是不同端点？ | 权限校验与路由 |
| **B-8** | 单次生成的真实耗时分布（P50/P95/P99）？各阶段最长无进度间隔？ | 心跳 / 超时 / 停滞阈值定档（任务 9.2 要求实测而非写死） |
| **B-9** | 后端机器清单：IP:Port、各进程支持的 mode、`max_concurrent_jobs`？ | 调度器配置与全局并发上限 |
| **B-11** | 心跳是否能跑在独立线程/Supervisor？渲染阻塞时会不会断心跳？ | 决定 `lease_ttl` 取值，防误判失联 |
| **B-12** | 能否把每个 Job 放入独立 **Process Group**（`setsid`）以便整树终止？ | 取消能否真正杀干净子进程（任务 9.6） |
| **B-13** | Agent 调用链是否已有 **Cancel Token / 协作式取消检查点**？ | 同上 |
| **B-14** | 同一 Session 在生成期间能否并发处理其他对话消息？ | 决定 UX 是禁用输入框还是允许排队（任务 11.4） |

---

## 10. 管理员 API

> 全部要求 `role=admin`，全部写入 `audit_logs`。

| 接口 | 说明 |
|---|---|
| `GET /api/admin/invites?status=&cursor=` | 列表。**只返回 `code_prefix`，不返回完整码** |
| `POST /api/admin/invites` | `{max_uses=1, expires_in_days=7, grants_blockout_3d=false, note?}` → **201，响应中一次性返回完整 `code`**，之后永不可查（仅存哈希） |
| `POST /api/admin/invites/{id}/revoke` | 置 `revoked_at`。幂等 |
| `GET /api/admin/users?cursor=` | 用户列表 + 各自运行中任务数 |
| `PATCH /api/admin/users/{id}` | `{status:'active'|'disabled'}` |
| `PATCH /api/admin/users/{id}/permissions` | `{can_use_blockout_3d:boolean}`。**仅影响后续新建/提交；已运行 Job 继续执行**（任务 4.3）。响应回传 `{running_jobs_kept:[...]}` 供 UI 提示 |
| `POST /api/admin/users/{id}/reset-password` | 生成一次性临时密码（响应中返回一次），强制下次登录修改。**不影响运行中 Job** |
| `GET /api/admin/jobs?status=&worker_id=` | 全局任务列表 |
| `POST /api/admin/jobs/{id}/terminate` | 管理员显式终止（`reason='admin'`），走正常取消流程。**这是撤权之外的独立操作**（任务 4.3） |
| `PATCH /api/admin/processes/{id}/drain` | 请求进程优雅下线（不杀在跑任务） |

**权限变更与任务取消严格分离**（任务 4.3 原文）：
`PATCH …/permissions` **绝不**隐式取消任何 Job；要终止必须另调 `POST …/jobs/{id}/terminate`。

---

## 11. 不会出现在本协议中的接口（显式声明）

为保证与其他文档一致（任务 19），以下**不存在**：

| 不存在的接口/行为 | 原因 |
|---|---|
| 任何 Reference 上传接口（`POST /api/uploads` 等） | V1 不支持图片/视频/音频 Reference（任务 3.1） |
| 任何「浏览器心跳」接口，或以浏览器 presence 为依据的取消 | 任务 9：明令禁止（Browser Presence 若实现，纯属 UI 优化，无服务端语义） |
| `beforeunload` 触发的取消请求 | 任务 8.1：关闭页面不得取消任务 |
| 把生成结果**只**放在最后一条 SSE 消息中的设计 | 任务 13.4：必须有可查询的 Asset 记录 |
| Session 迁移/重绑定接口（`POST /api/sessions/{id}/rebind`） | 任务 5：Session 不切换进程 |
| 同步生成接口（阻塞直到视频完成） | 任务 7.1：禁止 |
| 任何响应中包含 `storage_path` 的公开接口 | 任务 13.3：不暴露共享文件系统路径 |
| 自动重试昂贵 Job 的接口或内部逻辑 | 任务 9.3：不盲目自动重跑 |

---

## 12. 一致性自查表

| 要求（任务 19） | 本协议的对应 |
|---|---|
| 不得设计「页面关闭自动取消」 | §11 显式声明无此路径；取消仅 §6.4 |
| 不得假定 Session 可自动迁移进程 | §11 无 rebind 接口；§5.2 `PROCESS_LOST` 为终态 |
| 不得要求 V1 实现 Reference 上传 | §5.3 明示无 `attachments`，出现即 400 |
| 不得显示后端无法提供的假进度 | §1.3 + §6.1：`progress_percent` 可为 `null`，前端不得补 |
| 无后端 Cancel 支持时不得宣称取消完成 | §9.2 的 B-2 标为 P0 待确认；§6.4 返回 `CANCEL_REQUESTED` 而非 `CANCELLED` |
| 长任务不得假设浏览器缓存存在 | §7.1 `active-context` 为纯服务端兜底 |
| 权限必须与实际 API 检查一致 | §5.1 / §5.3 / §6.2 / §6.4 四个校验点，一律以 DB 中 session.mode 为准 |
