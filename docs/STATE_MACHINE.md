# STATE_MACHINE — 数据模型与状态机

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
> 核心不变式：**Job 不得同时处于 COMPLETED 与 CANCELLED**；状态由 DB 事务保证唯一。

---

## 1. 数据模型（PostgreSQL / Drizzle）

### 1.1 users

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | uuid | PK | |
| `username` | varchar(64) | UNIQUE NOT NULL | 登录名 |
| `email` | varchar(255) | UNIQUE NULL | 可选 |
| `password_hash` | text | NOT NULL | Argon2id |
| `role` | enum | NOT NULL DEFAULT `'user'` | `admin` / `user` |
| `can_use_blockout_3d` | boolean | NOT NULL DEFAULT `false` | 白模权限，**与 role 独立** |
| `status` | enum | NOT NULL DEFAULT `'active'` | `active` / `disabled` |
| `invite_code_id` | uuid | FK NULL | 注册所用邀请码 |
| `password_changed_at` | timestamptz | NOT NULL | 用于失效旧会话 |
| `created_at` / `updated_at` | timestamptz | NOT NULL | |

> 业务用户 ≠ 管理员（任务 4.2）：`role='user' ∧ can_use_blockout_3d=true` 是合法且常见的组合。

### 1.2 invite_codes

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | uuid | PK | |
| `code_hash` | text | UNIQUE NOT NULL | **只存哈希**；明文仅创建时返回一次 |
| `code_prefix` | varchar(8) | NOT NULL | 列表页展示用（如 `SNV-3F2A…`） |
| `created_by` | uuid | FK users NOT NULL | 必须是 admin |
| `max_uses` | int | NOT NULL DEFAULT 1 CHECK > 0 | 默认单次 |
| `used_count` | int | NOT NULL DEFAULT 0 CHECK ≥ 0 | |
| `expires_at` | timestamptz | NOT NULL | 默认 created_at + 7d |
| `grants_blockout_3d` | boolean | NOT NULL DEFAULT false | 注册即授予白模权限 |
| `revoked_at` | timestamptz | NULL | |
| CHECK | | `used_count <= max_uses` | 原子扣减的护栏 |

**有效性判定**（注册时在同一事务内）：
`revoked_at IS NULL ∧ expires_at > now() ∧ used_count < max_uses`，
扣减语句 `UPDATE … SET used_count = used_count + 1 WHERE id=? AND used_count < max_uses AND revoked_at IS NULL AND expires_at > now()`，
受影响行数为 0 则注册失败（防并发超用）。

### 1.3 backend_workers / backend_processes

**backend_workers**

| 字段 | 类型 | 说明 |
|---|---|---|
| `worker_id` | varchar(64) PK | 机器标识 |
| `host` | varchar(255) NOT NULL | IP 或主机名 |
| `port` | int NOT NULL | |
| `status` | enum NOT NULL | 见 §2.5 |
| `last_heartbeat_at` | timestamptz NULL | |
| `registered_at` | timestamptz NOT NULL | |
| `labels` | jsonb | 机型 / 可用区等 |

**backend_processes**

| 字段 | 类型 | 说明 |
|---|---|---|
| `process_instance_id` | varchar(128) PK | **进程实例唯一标识，重启必变**（非 OS PID） |
| `worker_id` | varchar(64) FK NOT NULL | |
| `os_pid` | int NULL | 仅诊断用，**不可作为身份** |
| `supported_modes` | text[] NOT NULL | `{coding_to_video}` / `{coding_to_video,blockout_3d}` |
| `max_sessions` | int NOT NULL | 会话承载上限 |
| `max_concurrent_jobs` | int NOT NULL | 本进程生成并发上限 |
| `active_sessions` / `running_jobs` | int NOT NULL DEFAULT 0 | 心跳校正 |
| `status` | enum NOT NULL | 见 §2.5 |
| `last_heartbeat_at` | timestamptz NULL | |
| `started_at` | timestamptz NOT NULL | |
| `drain_requested_at` | timestamptz NULL | 优雅下线标记 |

> `process_instance_id` 推荐 `{worker_id}:{boot_uuid}`，由 Worker 启动时生成（阻塞项 B-4）。

### 1.4 sessions / session_bindings

**sessions**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK NOT NULL | |
| `mode` | enum NOT NULL | `coding_to_video` / `blockout_3d`，**创建后不可变** |
| `status` | enum NOT NULL | 见 §2.1 |
| `title` | text NULL | 自动摘要 |
| `created_at` / `last_activity_at` | timestamptz NOT NULL | |
| `closed_at` | timestamptz NULL | |

**session_bindings**（与 sessions 一对一，独立表以便记录绑定生命周期）

| 字段 | 类型 | 说明 |
|---|---|---|
| `session_id` | uuid PK FK | |
| `worker_id` | varchar(64) NOT NULL | |
| `process_instance_id` | varchar(128) NOT NULL | **固定不迁移** |
| `backend_session_ref` | text NULL | 后端自有会话句柄 |
| `status` | enum NOT NULL | 见 §2.2 |
| `bound_at` | timestamptz NOT NULL | |
| `lost_at` | timestamptz NULL | |

### 1.5 messages

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `session_id` | uuid FK NOT NULL | |
| `role` | enum NOT NULL | `user` / `assistant` / `system` |
| `kind` | enum NOT NULL | `text` / `prompt_review` / `job_card` / `notice` |
| `content` | jsonb NOT NULL | 结构化内容 |
| `intent` | enum NULL | 见 §2.3 |
| `workflow_id` / `job_id` | uuid NULL | 关联卡片 |
| `seq` | bigint NOT NULL | 会话内单调序号，用于恢复与去重 |
| `created_at` | timestamptz NOT NULL | |
| UNIQUE | | `(session_id, seq)` | |

> V1 **无 attachments 字段的上传实现**。Schema 预留 `content.attachments`（始终为空数组），
> 仅为后续版本留扩展位，不开发任何上传能力（任务 3.1）。

### 1.6 prompt_workflows / prompt_revisions

**prompt_workflows**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `session_id` | uuid FK NOT NULL | |
| `user_id` | uuid FK NOT NULL | |
| `mode` | enum NOT NULL | 从 session 冗余，便于权限校验 |
| `intent` | enum NOT NULL | `new_generation` / `edit_generation` |
| `status` | enum NOT NULL | 见 §2.3 |
| `base_asset_id` | uuid NULL | `edit_generation` 时指向被修改的旧视频 |
| `latest_revision_id` | uuid NULL | 当前有效版本 |
| `approved_revision_id` | uuid NULL | 用户确认的版本 |
| `job_id` | uuid NULL UNIQUE | 确认后产生的 Job（一对一，防重复提交） |
| `created_at` / `updated_at` | timestamptz NOT NULL | |

**prompt_revisions**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `workflow_id` | uuid FK NOT NULL | |
| `revision_no` | int NOT NULL | 从 1 递增 |
| `enhanced_prompt` | text NOT NULL | |
| `user_note` | text NULL | 本轮用户修改意见 |
| `backend_meta` | jsonb NULL | 后端结构化参数 |
| `is_stale` | boolean NOT NULL DEFAULT false | 新版本产生即置旧版本为 true |
| `created_at` | timestamptz NOT NULL | |
| UNIQUE | | `(workflow_id, revision_no)` | |

### 1.7 generation_jobs（核心表）

| 字段 | 类型 | 说明 | 需求出处 |
|---|---|---|---|
| `id` | uuid PK | | |
| `user_id` | uuid FK NOT NULL | 归属校验 | 7.3 |
| `session_id` | uuid FK NOT NULL | | 7.3 |
| `workflow_id` | uuid FK NOT NULL | | |
| `prompt_revision_id` | uuid FK NOT NULL | 实际执行的 Prompt 版本 | 7.3 |
| `mode` | enum NOT NULL | | 7.3 |
| `base_asset_id` | uuid NULL | 旧视频修改链路 | 3.2 |
| `worker_id` | varchar(64) NULL | 分配后写入 | 7.3 |
| `process_instance_id` | varchar(128) NULL | 分配后写入 | 7.3 |
| `status` | enum NOT NULL | 见 §2.4 | 7.2 |
| `phase` | varchar(64) NULL | 后端上报的业务阶段 | 7.4 |
| `progress_percent` | smallint NULL | **仅后端提供时才有值；前端禁止自造** | 7.4 |
| `idempotency_key` | varchar(128) NOT NULL | | 6 / 11.1 |
| `attempt` | int NOT NULL DEFAULT 0 | 执行尝试次数 | 7.3 |
| `created_at` | timestamptz NOT NULL | | 7.3 |
| `queued_at` | timestamptz NULL | | 7.3 |
| `assigned_at` | timestamptz NULL | | |
| `started_at` | timestamptz NULL | | 7.3 |
| `last_heartbeat_at` | timestamptz NULL | Job 心跳 | 7.3 |
| `last_progress_at` | timestamptz NULL | **与心跳分离**，用于停滞判定 | 7.3 / 11.10 |
| `finished_at` | timestamptz NULL | | 7.3 |
| `cancel_requested_at` | timestamptz NULL | | 7.3 |
| `cancel_requested_by` | uuid NULL | 谁发起取消 | 17 |
| `cancel_reason` | enum NULL | `user` / `admin` / `max_runtime` / `lease_lost` / `duplicate` / `backend_unrecoverable` | 9.4 |
| `cancel_acked_at` | timestamptz NULL | 后端确认停止时间 | 17 |
| `cancel_effective` | boolean NULL | 是否真正停止成功 | 17 |
| `resources_released_at` | timestamptz NULL | 资源是否已释放 | 17 |
| `failure_code` / `failure_message` | varchar/text NULL | | 7.3 |
| `result_asset_id` | uuid NULL | | 7.3 |
| `max_runtime_seconds` | int NOT NULL | 按 mode 配置，**不沿用 HTTP 超时** | 7.5 |
| UNIQUE | | `(user_id, idempotency_key)` | 幂等 | 11.1 |
| UNIQUE | | `(workflow_id)` | 一个 workflow 最多一个 Job | 11.1 |
| CHECK | | `NOT (status='COMPLETED' AND cancel_effective IS TRUE)` | 终态互斥 | 11.7 |
| CHECK | | `status IN 终态 → finished_at IS NOT NULL` | | |
| CHECK | | `status='COMPLETED' → result_asset_id IS NOT NULL` | | |

索引：`(status)`、`(process_instance_id, status)`（亲和性出队）、`(user_id, created_at DESC)`、`(status, last_heartbeat_at)`（Watchdog 扫描）。

### 1.8 job_leases

| 字段 | 类型 | 说明 |
|---|---|---|
| `job_id` | uuid PK FK | 一个 Job 当前只有一份有效租约 |
| `lease_epoch` | bigint NOT NULL | **单调递增 fencing token**，续约不变、重新分配才 +1 |
| `lease_token` | varchar(128) NOT NULL | 下发给 Worker 的不透明凭证 |
| `holder_process_instance_id` | varchar(128) NOT NULL | 当前持有者 |
| `acquired_at` | timestamptz NOT NULL | |
| `renewed_at` | timestamptz NOT NULL | |
| `expires_at` | timestamptz NOT NULL | `renewed_at + lease_ttl` |
| `released_at` | timestamptz NULL | |
| `revoked_at` | timestamptz NULL | 取消或抢占时写入 |

**Fencing 规则**：Worker 任何写操作（progress / complete / fail）必须携带 `lease_token`；
Gateway 校验 `lease_token` 匹配且 `revoked_at IS NULL` 且 `lease_epoch` 为当前值，否则返回 `409 LEASE_INVALID` 并**丢弃该结果**，
从而阻止「短暂失联的旧执行实例把过期结果写成有效结果」（任务 9.3）。

### 1.9 job_events

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `job_id` | uuid FK NOT NULL | |
| `seq` | bigint NOT NULL | Job 内单调递增，SSE `id:` 字段 |
| `type` | varchar(48) NOT NULL | `job.queued` / `job.assigned` / `job.phase` / `job.progress` / `job.heartbeat_status` / `job.cancel_requested` / `job.cancelling` / `job.cancelled` / `job.completed` / `job.failed` / `job.state_unknown` / `job.recovering` |
| `payload` | jsonb NOT NULL | |
| `created_at` | timestamptz NOT NULL | |
| UNIQUE | | `(job_id, seq)` |

保留策略：终态后保留 30 天，供断线恢复与排障。SSE 以 `Last-Event-ID` 回放 `seq > N` 的事件（任务 12.1）。

### 1.10 generated_assets

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | 对外**唯一**标识 |
| `job_id` | uuid FK NOT NULL | |
| `user_id` | uuid FK NOT NULL | 归属校验 |
| `session_id` | uuid FK NOT NULL | |
| `kind` | enum NOT NULL | `video` / `preview_image` / `blockout_video` |
| `storage_path` | text NOT NULL | 共享存储绝对路径，**绝不出现在浏览器响应中** |
| `state` | enum NOT NULL | 见 §2.7 |
| `mime_type` | varchar(64) NULL | |
| `size_bytes` | bigint NULL | |
| `duration_ms` | int NULL | |
| `width` / `height` | int NULL | |
| `checksum` | varchar(128) NULL | 完整性校验 |
| `playable` | boolean NOT NULL DEFAULT false | |
| `derived_from_asset_id` | uuid NULL | **旧视频修改链**：B 指向 A，不覆盖原文件（任务 3.2） |
| `created_at` / `ready_at` | timestamptz | |

### 1.11 辅助表

- **`job_cancel_requests`**：记录每一次取消请求（`job_id, requested_by, requested_at, source(user|admin|system), reason, ack_at, result`），支持幂等重复点击的审计（任务 11.6）。
- **`idempotency_records`**：`(user_id, scope, key) → response_snapshot, created_at`，TTL 24h，用于「后端提交成功但 HTTP 响应丢失」时返回同一结果（任务 11.11）。
- **`audit_logs`**：管理员操作（发码 / 撤码 / 改权限 / 重置密码 / 终止任务）全量留痕。

---

## 2. 状态机

### 2.1 Session 状态机

```text
                   ┌──────────────┐
        create ───►│    ACTIVE    │
                   └──┬────┬──────┘
         绑定进程失联   │    │ 用户新建/关闭会话
                      ▼    ▼
              ┌──────────┐  ┌──────────┐
              │ DEGRADED │  │  CLOSED  │
              └────┬─────┘  └──────────┘
                   │ 用户主动关闭
                   ▼
              ┌──────────┐
              │  CLOSED  │
              └──────────┘
```

| 状态 | 含义 | 允许操作 |
|---|---|---|
| `ACTIVE` | 绑定进程健康 | 发消息、增强、提交 Job |
| `DEGRADED` | 绑定进程失联/下线 | **只读**：查看历史、查看/下载已完成产物；禁止发消息与新 Job |
| `CLOSED` | 已关闭 | 只读 |

**不变式**：`DEGRADED` **绝不**自动迁移到其他进程（C-3 / 任务 5）。恢复路径只有「新建 Session」。
Session 进入 `DEGRADED` **不影响**其下已运行 Job 的取消流程与产物访问。

### 2.2 Session Binding 状态机

```text
  BOUND ──进程心跳超阈值──► SUSPECTED ──对账确认不可用──► PROCESS_LOST
    ▲                          │                              │
    └────── 对账确认存活 ────────┘                              ▼
                                                         (终态, 不迁移)
  BOUND ──进程 drain 完成──► RELEASED (终态)
```

| 状态 | 触发 | 对 Session 的影响 |
|---|---|---|
| `BOUND` | 创建时 | `ACTIVE` |
| `SUSPECTED` | Worker/Process 心跳缺失达阈值 | Session 仍 `ACTIVE`，但**暂停受理新 Job**，UI 提示「正在确认后端状态」 |
| `PROCESS_LOST` | 对账确认进程不可用 | Session → `DEGRADED` |
| `RELEASED` | 进程优雅下线且无在跑 Job | Session → `DEGRADED` |

`SUSPECTED` 是**可逆**的中间态——这是「不能仅凭缺一条心跳就判死」的实现点（任务 7.5 / 9.1）。

### 2.3 Prompt Workflow 状态机

```text
                        ┌───────────┐
          用户新需求 ───►│ ENHANCING │
                        └─┬───────┬─┘
                 增强成功  │       │ 增强失败
                          ▼       ▼
          ┌───────────────────┐  ┌──────────────────┐
          │ AWAITING_APPROVAL │  │ ENHANCE_FAILED   │
          └──┬──────┬─────┬───┘  └────┬─────────────┘
    用户修订  │      │     │ 用户放弃        │ 用户重试
             ▼      │     ▼                ▼
        ┌─────────┐ │  ┌───────────┐  (回到 ENHANCING)
        │ REVISING│ │  │ ABANDONED │
        └────┬────┘ │  └───────────┘
   新版本就绪 │      │ 用户确认
             └──────┤
                    ▼
              ┌──────────┐      ┌──────────────┐
              │ APPROVED │─────►│ JOB_CREATED  │ (终态)
              └──────────┘ 同事务└──────────────┘
```

| 迁移 | 守卫条件 | 需求出处 |
|---|---|---|
| `AWAITING_APPROVAL → APPROVED` | 请求的 `revision_id` **必须等于** `latest_revision_id`，否则 `409 REVISION_STALE` | 6（过期 Prompt 版本） |
| `APPROVED → JOB_CREATED` | 与 `INSERT jobs` 同一事务；`workflow_id` 唯一约束阻止第二个 Job | 6 / 11.1（双击确认） |
| `REVISING → AWAITING_APPROVAL` | 重复提交同一修改意见由 `idempotency_key` 去重 | 6（修改意见重复提交） |
| 任意 → `ABANDONED` | 用户显式放弃；**未确认的 Prompt 永不自动进入生成** | 11.3 |

**关闭浏览器恢复**（任务 11.3）：workflow 的 `ENHANCING` / `AWAITING_APPROVAL` / `ENHANCE_FAILED` 全部持久化，
用户回来后 `GET /api/sessions/{id}` 返回当前 workflow 与 latest revision，Prompt Review Card 原样恢复。

### 2.4 Job 状态机（核心）

```text
                    ┌────────┐
       创建 ───────►│ QUEUED │
                    └───┬──┬─┘
          取得并发槽+租约 │  │ 排队中取消
                        ▼  └──────────────────────┐
                 ┌──────────┐                    │
                 │ ASSIGNED │                    │
                 └────┬──┬──┘                    │
      后端确认开始执行  │  │ 启动失败/租约未激活      │
                      ▼  └───────────┐           │
              ┌────────────┐         │           │
              │  RUNNING   │         │           │
              │ phase=     │         │           │
              │ PREPARING/ │         │           │
              │ GENERATING/│         │           │
              │ RENDERING/ │         │           │
              │ FINALIZING │         │           │
              └──┬───┬───┬─┘         │           │
     产物就绪+确认 │   │   │ 执行失败    │           │
                 ▼   │   ▼           ▼           ▼
        ┌───────────┐│ ┌────────┐  ┌────────┐  ┌───────────┐
        │ COMPLETED ││ │ FAILED │  │ FAILED │  │ CANCELLED │
        └───────────┘│ └────────┘  └────────┘  └───────────┘
                     │
      心跳/租约异常    │
                     ▼
              ┌─────────────┐  对账确认存活   ┌──────────┐
              │   UNKNOWN   │──────────────►│ RUNNING  │
              └──┬──────────┘                └──────────┘
                 │ 对账确认不可恢复
                 ▼
          ┌─────────────┐  恢复成功  ┌──────────┐
          │ RECOVERING  │──────────►│ RUNNING  │
          └──┬──────────┘            └──────────┘
             │ 无法恢复
             ▼
        ┌────────┐
        │ FAILED │
        └────────┘

  取消子流程 (可从 QUEUED / ASSIGNED / RUNNING / UNKNOWN 进入):
  ┌──────────────────┐    ┌────────────┐    ┌───────────┐
  │ CANCEL_REQUESTED │───►│ CANCELLING │───►│ CANCELLED │
  └────────┬─────────┘    └──────┬─────┘    └───────────┘
           │                     │ 发现已完成
           │                     ▼
           │              ┌───────────┐
           └─────────────►│ COMPLETED │  (完成优先, 见 §3)
                          └───────────┘
```

**终态**：`COMPLETED` / `FAILED` / `CANCELLED`。进入终态后 `finished_at` 必须写入，并发槽必须释放。

| 状态 | 语义 | UI 展示要点 |
|---|---|---|
| `QUEUED` | 已入队，等并发槽 | 「排队中，已等待 X」+ 队列位置 |
| `ASSIGNED` | 已分配进程与租约，待后端确认开始 | 「正在启动」 |
| `RUNNING` | 执行中，细分由 `phase` 表达 | 「正在生成，已运行 1 小时 23 分钟」+「最后状态更新于 18 秒前」 |
| `CANCEL_REQUESTED` | 取消意图已持久化，尚未下达/未确认 | 「正在请求停止…」**不得显示为已取消** |
| `CANCELLING` | 后端已收到并在停止 | 「正在停止，回收资源中…」 |
| `CANCELLED` | 已确认停止 | 「已取消」+ 是否释放资源 |
| `COMPLETED` | 产物已完整写入并校验 | 播放器 + 下载 + 继续修改 |
| `FAILED` | 已确认失败 | 真实失败原因 + 重试入口 |
| `UNKNOWN` | 服务端**无法确认**真实执行状态 | 「正在确认后端状态…」**禁止当作失败，禁止自动重试** |
| `RECOVERING` | 正在对账/恢复 | 「正在与后端核对任务状态」 |

> 任务 7.2 明确：`UNKNOWN` / `RECOVERING` 不得被当作普通失败或自动重试信号。
> 本设计中它们**只能**由 Watchdog 对账推动，`RECOVERING → FAILED` 需要后端明确否认或超过最大运行时间。

**合法迁移表**

| From | To | 触发者 | 守卫 |
|---|---|---|---|
| — | `QUEUED` | API（approve） | 事务内与 workflow 同写 |
| `QUEUED` | `ASSIGNED` | Dispatcher | 取得全局槽 ∧ 进程槽 ∧ 进程 HEALTHY；原子 CAS |
| `QUEUED` | `CANCEL_REQUESTED` | 用户/管理员 | 直接出队，无需联系后端 |
| `ASSIGNED` | `RUNNING` | Worker（start ack） | `lease_token` 有效 |
| `ASSIGNED` | `FAILED` | Dispatcher | 启动调用失败且重试耗尽 |
| `ASSIGNED` | `QUEUED` | Watchdog | 后端明确拒绝接单 → 退回队列，`attempt` 不变 |
| `RUNNING` | `RUNNING` | Worker（progress） | 仅更新 `phase` / `progress` / `last_progress_at` |
| `RUNNING` | `COMPLETED` | Worker（complete） | 租约有效 ∧ **产物完整性校验通过** ∧ 未处于取消终态 |
| `RUNNING` | `FAILED` | Worker（fail） | 租约有效 |
| `RUNNING` | `UNKNOWN` | Watchdog | Job 心跳超时 ∧ 进程不可确认 |
| `RUNNING` | `CANCEL_REQUESTED` | 用户/管理员 | Job 非终态 |
| `RUNNING` | `CANCEL_REQUESTED` | Watchdog | 超过 `max_runtime_seconds`（`reason=max_runtime`） |
| `UNKNOWN` | `RUNNING` | Watchdog（probe 存活） | 后端确认仍在执行 |
| `UNKNOWN` | `RECOVERING` | Watchdog | 进入主动对账 |
| `UNKNOWN` | `COMPLETED` | Watchdog | 对账发现后端已完成且产物完整（弥补「完成事件丢失」，任务 11.11） |
| `RECOVERING` | `RUNNING` / `COMPLETED` / `FAILED` | Watchdog | 依对账结论 |
| `CANCEL_REQUESTED` | `CANCELLING` | Cancel Broker | 后端已 ack 收到取消 |
| `CANCEL_REQUESTED` | `CANCELLED` | Cancel Broker | Job 尚未真正开始（QUEUED 态取消） |
| `CANCEL_REQUESTED` | `COMPLETED` | Cancel Broker | **竞争裁决**：发现后端已完成且产物完整 → 完成优先 |
| `CANCELLING` | `CANCELLED` | Worker/Watchdog | 后端确认停止 ∧ 资源已回收 |
| `CANCELLING` | `COMPLETED` | Cancel Broker | 同上竞争裁决 |
| `CANCELLING` | `FAILED` | Watchdog | 取消宽限超时且进程失联 → `failure_code=CANCEL_UNCONFIRMED` |

**禁止的迁移**（显式列出以便测试断言）：

- 任何终态 → 任何其他状态（终态不可变）
- `COMPLETED` → `CANCELLED`（任务 11.7）
- `CANCELLED` → `COMPLETED`
- `UNKNOWN` → `FAILED`（不经 `RECOVERING` 对账）
- 浏览器断连 / SSE 断开 / 页面关闭 → **任何**状态变化（C-2，不存在这条边）

### 2.5 Worker / Process 健康状态机

```text
  REGISTERED ──首次心跳──► HEALTHY
                            │  ▲
          心跳缺失 N 次       │  │ 心跳恢复
                            ▼  │
                  ┌──────────────────────┐
                  │ SUSPECTED_UNAVAILABLE│  ← 停止分配新 Session/Job
                  └────┬─────────────────┘
       对账确认不可用     │
                       ▼
                  ┌─────────────┐
                  │ UNAVAILABLE │  ← 其上 Session → DEGRADED
                  └─────────────┘
  HEALTHY ──管理员请求下线──► DRAINING ──在跑 Job 清空──► OFFLINE
```

| 状态 | 可分配新 Session | 可分配新 Job | 在跑 Job |
|---|---|---|---|
| `HEALTHY` | ✅ | ✅ | 正常 |
| `SUSPECTED_UNAVAILABLE` | ❌ | ❌ | **保持运行，进入对账**（任务 9.1） |
| `UNAVAILABLE` | ❌ | ❌ | 其 Job 转 `UNKNOWN` → 对账；**不跨进程自动重跑**（任务 9.3） |
| `DRAINING` | ❌ | ❌ | 允许跑完 |
| `OFFLINE` | ❌ | ❌ | 应为空 |

### 2.6 Job Cancellation 状态机（独立追踪）

```text
  REQUESTED ──下达后端成功──► ACKED ──后端确认停止──► STOPPED
      │                        │                       │
      │ 下达失败/进程失联         │ 宽限超时                ▼
      ▼                        ▼                   ┌────────────┐
  UNDELIVERED              GRACE_EXPIRED           │ RESOURCES_ │
      │                        │                   │ RELEASED   │
      │                        ▼                   └────────────┘
      │                 (升级停止: SIGTERM→宽限→强制)
      │
      └──► 若发现 Job 已完成 ──► SUPERSEDED_BY_COMPLETION
```

记录于 `job_cancel_requests`，满足任务 17 的四项追溯要求：谁发起、何时发起、后端何时确认、最终是否真正停止、资源是否释放。
**幂等**（任务 11.6）：同一 Job 的重复取消请求只插入审计记录，不重复触发副作用；已处于终态的 Job 返回当前真实状态而非报错。

### 2.7 Asset 状态机

```text
  PENDING ──后端声明写入完成──► VERIFYING ──校验通过──► READY
                                   │
                                   │ 校验失败 (大小/时长/标记缺失)
                                   ▼
                               CORRUPT
  PENDING ──Job 取消/失败──► ABANDONED
```

| 状态 | 可播放 | 可下载 |
|---|---|---|
| `PENDING` | ❌ | ❌ |
| `VERIFYING` | ❌ | ❌ |
| `READY` | ✅ | ✅ |
| `CORRUPT` | ❌ | ❌（展示失败原因） |
| `ABANDONED` | ❌ | ❌ |

**只有 `READY` 才允许 `Job → COMPLETED`**（任务 13.1）。
「共享目录里出现文件」**不构成**完成依据，必须有完成标记 + 元数据校验（阻塞项 B-5）。
用户**不可能**下载到尚未完整写入的文件（任务 11.7）。

---

## 3. 跨状态机不变式（必须有测试断言）

| ID | 不变式 | 对应测试 |
|---|---|---|
| I-1 | 一个 Job 有且仅有一个终态 | 测试 I（取消与完成竞争） |
| I-2 | `COMPLETED` ⟹ `result_asset_id` 指向 `state=READY` 的 asset | 测试 P |
| I-3 | 任何终态 ⟹ 并发槽已释放 ∧ 租约已 `released_at`/`revoked_at` | 测试 G |
| I-4 | 浏览器相关事件（关闭/断网/SSE 断开/Presence 丢失）不触发任何 Job 状态迁移 | 测试 B / E |
| I-5 | 同一 `(user_id, idempotency_key)` 最多一个 Job | 测试 B / 11.1 |
| I-6 | 同一 `workflow_id` 最多一个 Job | 双击确认 |
| I-7 | `UNKNOWN` 不得直接转 `FAILED` | 测试 F |
| I-8 | Session 的 `process_instance_id` 一经写入永不变更 | 测试 D / F |
| I-9 | 过期 `lease_epoch` 的写入一律拒绝且不改变 Job 状态 | 测试 F / J |
| I-10 | `blockout_3d` 的四个校验点全部以 DB 中 session.mode 为准 | 测试 M |

### 竞争裁决规则：取消 vs 完成（任务 11.7 / 测试 I）

在单个 DB 事务中以 `SELECT … FOR UPDATE` 锁定 Job 行后裁决：

1. 若 Job 已是终态 → 返回当前状态，不做任何迁移。
2. 若收到 `complete` 且 Job 处于 `CANCEL_REQUESTED` / `CANCELLING`：
   - 产物校验 `READY` 且租约有效 → **完成优先**，Job → `COMPLETED`，
     取消请求标记 `SUPERSEDED_BY_COMPLETION`，返回给用户「任务在取消生效前已完成」。
   - 产物不完整 → Job → `CANCELLED`，产物 → `ABANDONED`。
3. 若收到 `cancel` 而 Job 已 `COMPLETED` → 返回 `409 JOB_ALREADY_TERMINAL` + 真实状态，不改状态。

> 选择「完成优先」的理由：产物已完整生成，计算成本已付出，丢弃它对用户是净损失；
> 且该规则是确定性的，两个并发请求无论到达顺序如何都得到同一结果。

---

## 4. 权限变更对运行中 Job 的策略（任务 4.3 / 11.9）

| 事件 | 新建白模 Session | 新提交白模 Job | **已运行 Job** | 已完成产物访问 |
|---|---|---|---|---|
| 撤销 `can_use_blockout_3d` | ❌ 拒绝 | ❌ 拒绝 | **继续执行至完成**，除非管理员另行显式终止 | ✅ 保留 |
| 用户 `status=disabled` | ❌ | ❌ | 继续执行；但用户无法登录查看 | ⛔ 账号恢复后可访问 |
| 管理员重置密码 | — | — | **不受影响** | ✅ |
| 登录过期 | — | — | **不受影响**（任务 11.8） | 重新登录后 ✅ |
| 管理员显式终止任务 | — | — | 走正常取消流程，`reason=admin` | 部分产物按策略保留 |

**权限管理与任务取消严格分离**（任务 4.3 原文）：撤权是一个授权事件，不是取消事件；
系统中不存在「撤权 → 自动 cancel」这条边，必须由管理员另外执行终止操作。
