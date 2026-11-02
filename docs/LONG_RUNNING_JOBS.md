# LONG_RUNNING_JOBS — 超长后台任务设计

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


> 版本 v1.0 / 2026-10-23 / Phase 1 **P0** 交付物
> 适用对象：单次生成 **1~2 小时甚至更长** 的视频 / 白模预演任务。
> 配套：`STATE_MACHINE.md`（状态定义）、`API_CONTRACT.md`（接口）、`BACKEND_REQUIREMENTS.md`（后端改造项）

---

## 0. 一句话原则

**浏览器只是显示器与遥控器，不是任务的生命支持系统。**

Job 的存活完全由「DB 中的持久化状态 + 后端 Worker 的实际执行 + Gateway 的租约管理」三者决定。
任何浏览器侧信号（页面关闭、SSE 断开、Presence 消失、标签页切换、电脑休眠）**都不是**停止计算的依据。

---

## A. 长任务架构

### A.1 前端与后台 Job 的分离边界

```text
┌─────────── 浏览器可以做的 ───────────┐   ┌──────── 浏览器不能做的 ────────┐
│ · 提交创建 Job 的请求 (秒级返回)       │   │ ✗ 持有 Job 状态的权威副本       │
│ · 订阅进度事件 (SSE)                  │   │ ✗ 用连接存活证明 Job 存活       │
│ · 轮询权威状态快照                    │   │ ✗ 断开连接即终止任务            │
│ · 发送取消「意图」                    │   │ ✗ 自行判定任务失败              │
│ · 播放 / 下载已就绪产物               │   │ ✗ 自造进度百分比                │
└──────────────────────────────────────┘   └────────────────────────────────┘
```

**提交路径必须在 1 秒内返回**（任务 7.1）：

```text
POST /api/workflows/{id}/approve
  ├─ 事务: workflow→APPROVED, INSERT jobs(QUEUED), INSERT job_events(seq=1,'job.queued')
  ├─ Redis: LPUSH 亲和性就绪队列 (仅索引, 可从 DB 重建)
  └─ 202 Accepted {job_id, status:'QUEUED', created_at, poll_url, events_url}
                   ↑ HTTP 请求在此结束，与后续 2 小时无任何关系
```

Dispatcher 在**独立的常驻 Gateway 进程**中异步出队、分配、调用后端。
Web 层（Next.js）不参与执行推进，因此 Web 发版、扩缩容、OOM 重启都不影响任务。

### A.2 持久化分层

| 层 | 内容 | 丢失后果 | 可否重建 |
|---|---|---|---|
| **PostgreSQL（权威）** | `generation_jobs` / `job_events` / `job_leases` / `generated_assets` / `sessions` / `session_bindings` | 业务数据丢失，不可接受 | ❌ 必须备份 |
| **Redis（加速）** | 亲和性就绪队列、全局与进程级并发信号量、幂等键短期缓存、SSE 跨实例扇出 | 短暂抖动 | ✅ 由 Gateway 启动时从 DB 全量重建 |
| **共享存储** | 视频产物文件 + 完成标记 | 产物丢失 | ❌ |
| **浏览器 localStorage** | `{user_scope, session_id, job_id, mode, last_seen_at}` | **零影响**，走服务端兜底恢复 | ✅ |

**Redis 重建算法**（Gateway 启动时执行，幂等）：

```text
1. 清空本服务命名空间下的队列与信号量键
2. SELECT * FROM generation_jobs WHERE status='QUEUED' ORDER BY queued_at
   → 按 process_instance_id 重建各亲和性队列
3. SELECT process_instance_id, count(*) FROM generation_jobs
   WHERE status IN ('ASSIGNED','RUNNING','CANCELLING') GROUP BY 1
   → 重建进程级并发占用计数（注意：不是从 0 开始！）
4. 全局占用 = 上述计数之和 → 重建全局信号量
5. 对 ASSIGNED/RUNNING/CANCELLING 的 Job 逐一进入「对账」而非「重启」(见 E.2)
```

第 3~5 步是测试 J（Scheduler 重启）的通过条件：**绝不重复启动已在运行的生成任务**。

### A.3 两小时任务的正常生命周期

```text
T+0s      用户确认 Prompt → Job QUEUED, 事件 seq=1
T+0.3s    HTTP 202 返回, 前端显示「已排队」, localStorage 记下 job_id
T+2s      Dispatcher 取得全局槽 + 进程槽 → ASSIGNED, 创建 lease(epoch=1, ttl=120s)
T+3s      Adapter.startJob(process, job, lease_token) → 后端 ack
T+5s      Worker 回报 → RUNNING, phase=PREPARING
T+20s     Worker 心跳 #1 (lease 续约, expires_at 推后)
T+45s     phase=GENERATING, last_progress_at 更新
...
T+32min   phase=GENERATING, 后端上报 progress=38% (若后端支持)
T+33min   心跳正常, 但 25 分钟无新进度
          → Watchdog 判定「健康但停滞」→ 事件 job.heartbeat_status{stalled:true}
          → UI:「后端仍在正常执行，当前阶段暂无新进度（最后状态更新于 25 分钟前）」
          → ⚠️ 绝不取消 (任务 9.4 明确禁止)
T+78min   phase=RENDERING
T+112min  phase=FINALIZING, 产物写入共享存储
T+114min  Worker 写完成标记 → POST /internal/jobs/{id}/complete{lease_token, asset}
T+114min  Gateway: 校验 lease_epoch=1 ✓ → Asset VERIFYING → 校验大小/时长/标记 ✓ → READY
          → Job COMPLETED, finished_at, 释放全局槽+进程槽, lease released
          → 事件 job.completed (持久化, 不止推 SSE)
T+114min  前端(若在线) SSE 收到 → 渲染播放器
          前端(若离线) 下次访问 /api/me/active-context 即得到结果
```

**关键**：第 T+114min 的完成结果写入了 `generated_assets` 表。
即使那一刻没有任何浏览器连接、SSE 早已断开，结果依然可查（任务 13.4）。

---

## B. 浏览器恢复

### B.1 localStorage 存什么、不存什么

```ts
// 键名含用户作用域哈希，避免共用设备串号
const key = `cvw:ctx:${userScopeHash}`;

type LocalContext = {
  v: 1;                        // schema 版本，便于升级
  sessionId: string | null;
  mode: 'coding_to_video' | 'blockout_3d';
  jobId: string | null;        // 最近一个关注的 Job
  lastSeenAt: string;          // ISO，仅用于 UI 文案
  lastEventSeq?: number;       // SSE 断点续传提示（非权威）
};
```

**禁止存入**（任务 8.2）：密码、登录 Token、后端密钥、完整敏感 Prompt、视频文件或大型数据、**任何权限信息**。

> `mode` 存在本地仅用于恢复 UI 初始态；**权限永远在服务端重新校验**。
> 用户改掉 localStorage 里的 `mode` 不会获得白模权限——Session 的 mode 以 DB 为准。

认证使用 **HttpOnly + Secure + SameSite=Lax** 的服务端 Session Cookie，JS 读不到。

### B.2 服务端保存的权威数据

| 数据 | 用途 |
|---|---|
| `sessions` + `session_bindings` | 恢复会话与其固定进程 |
| `messages`（含 `seq`） | 恢复完整对话流 |
| `prompt_workflows` + `prompt_revisions` | 恢复 Prompt Review Card 的真实状态 |
| `generation_jobs` | 恢复任务状态、耗时、阶段、心跳新鲜度 |
| `job_events`（含 `seq`） | SSE 断点续传与事件回放 |
| `generated_assets` | 恢复可播放/可下载产物 |

### B.3 重新打开网页的恢复流程

```text
1. 页面加载 → GET /api/auth/me
     ├─ 401 → 跳登录（登录后继续第 2 步，Job 不受影响）
     └─ 200 {user, permissions}
2. 读 localStorage → 得到候选 sessionId / jobId（可能为空或过期）
3. GET /api/me/active-context          ← 服务端兜底，这一步是关键
     返回 {
       active_session: {...} | null,
       running_jobs: [...],             // 该用户所有未终态 Job
       recent_completed_jobs: [...]     // 限量
     }
4. 决策：
     ├─ localStorage 的 sessionId 仍属于该用户且未 CLOSED → 恢复该会话
     ├─ 否则用 active-context 的 active_session
     └─ 都没有 → 显示欢迎页 + 「进行中的任务」入口（若有运行 Job）
5. GET /api/sessions/{id}  → 一次性拿到消息、workflow、job 快照
6. 渲染：对话流 / Prompt Review Card / 任务卡片（按真实状态）
7. 若有非终态 Job → 建立 SSE 订阅（见 B.6 断点续传）
8. 若 Job 已 COMPLETED → 直接渲染播放器（即使关页面前是 RUNNING）
9. 若 FAILED / CANCELLED → 显示真实原因与后续操作
10. 若 binding.status=PROCESS_LOST → 明示「该会话后端进程已失联，请新建会话；
    已完成产物仍可访问」，⚠️ 不假装恢复成功（任务 8.3 第 10 条）
```

**核心规则**（任务 8.3）：**永不相信浏览器关闭前缓存的状态**。
localStorage 只提供「候选 ID」，所有状态一律以服务端快照为准。
关页面前是 `RUNNING`、回来已 `COMPLETED` → 立即展示最终视频。

### B.4 缓存丢失 / 隐私模式 / 换浏览器

localStorage 为空时，第 3 步的 `GET /api/me/active-context` 独立完成恢复：

```text
用户清缓存 / 隐私窗口 / 换设备 / 浏览器自动清理
  → localStorage 无数据
  → active-context 按 user_id 查 DB
  → 返回运行中 Job + 最近完成 Job
  → UI 顶部出现「进行中的任务 (2)」入口
  → 用户点击 → 看到状态、耗时、结果、下载、失败原因
```

**账号即恢复凭据**：只要能登录，就能找回自己正在运行的任务（任务 8.4 / 测试 C）。

### B.5 最小任务恢复入口（V1 范围）

左侧栏的「进行中的任务 / 最近结果」面板，数据来自 `GET /api/me/jobs?status=active|recent`：

| 提供 | 不提供（V1 明确不做） |
|---|---|
| 任务是否仍在排队 / 生成 | ❌ 完整历史 Session 列表 |
| 运行状态与各阶段耗时 | ❌ 对话搜索 |
| 生成结果预览与播放 | ❌ 收藏 / 归档 / 标签 |
| 视频下载 | ❌ 任意历史 Session 自由切换 |
| 回到仍有任务的 Session（原进程有效时） | ❌ 跨 Session 上下文合并 |
| 失败原因 | |

> 任务 8.5 明确：这不是完整历史系统，但**必须保证算完的产物用户拿得到**。

### B.6 SSE 断点续传

```text
前端重连:
  1. 先 GET /api/jobs/{id}  ← 永远先取权威快照（任务 12.1）
  2. 若非终态 → GET /api/jobs/{id}/events, 携带 Last-Event-ID: <已收到的最大 seq>
  3. Gateway: SELECT * FROM job_events WHERE job_id=? AND seq > :last ORDER BY seq
     → 先回放历史事件，再接入实时流
  4. 前端按 seq 去重（Map<seq, event>）并排序，容忍乱序与重复（任务 12.1）
```

前端维护 `maxSeenSeq`，任何 `seq <= maxSeenSeq` 的事件直接丢弃。
事件设计为**幂等且可乱序**：每个事件携带完整状态快照字段，而非增量 diff。

### B.7 多标签页同步（任务 8.7）

| 场景 | 处理 |
|---|---|
| 两个标签页看同一 Job | 各自独立 SSE 订阅；服务端是唯一真相，天然一致 |
| 一个标签页取消，另一个要及时更新 | 取消产生 `job.cancel_requested` 事件 → 两个订阅都收到；另加 `BroadcastChannel('cvw')` 在同源标签间即时广播，纯 UI 优化 |
| 一个标签页新建 Session，不应让其他标签页切换后端进程 | Session 绑定写在 DB，**与标签页无关**；其他标签页继续用自己的 `sessionId`，互不影响 |
| 两个标签页同时确认同一 Workflow | `workflow_id` UNIQUE + `(user_id, idempotency_key)` UNIQUE → 第二个请求返回**同一** `job_id`，不重复提交（任务 8.7 / 11.1） |

`BroadcastChannel` 仅用于加速 UI，**不是**状态来源；它不可用时（旧浏览器）功能不降级。

### B.8 登录失效的恢复（任务 11.8）

```text
Job 运行中 → 用户 Cookie 过期
  → 前端任何 API 收到 401
  → ⚠️ 不发任何取消请求（这是最容易写错的地方）
  → 显示重新登录，保留本地 job_id
  → 用户重新登录 → 重走 B.3 → 找回同一 Job（状态可能已变 COMPLETED）
```

**后端生成任务的存活与浏览器 Cookie 有效期完全无关**。
Job 的授权在**创建时**完成，执行期不再依赖用户会话。

---

## C. 心跳机制

### C.1 三类心跳对照（务必区分）

| | **A. Browser Presence** | **B. Worker/Process Heartbeat** | **C. Job Heartbeat / Lease** |
|---|---|---|---|
| 必需性 | 可选 | **必须** | **必须** |
| 方向 | 浏览器 → Web | Worker → Gateway | Worker → Gateway |
| 周期 | 30s（页面可见时） | 10~15s | 15~30s |
| 用途 | 优化订阅、恢复界面 | 判定机器/进程可用性 | 判定**单个任务**仍在执行、维持执行权 |
| **能否用于停止生成** | **❌ 绝对不可** | ❌ 不可直接停止，只能触发对账 | ⚠️ 仅在租约失效 + 核实 + 宽限后 |
| 载体 | Page Visibility API + 轻量 ping | `POST /internal/processes/heartbeat` | `POST /internal/jobs/{id}/heartbeat` |

> 任务 9 原文：**「不要使用『浏览器没心跳了，所以取消视频』的方案」**。
> 本设计中 Browser Presence 与 Job 生命周期之间**不存在任何代码路径**。
> 且浏览器会暂停后台定时器，`beforeunload`/`unload` 也不可靠，故 Presence 缺失不携带任何语义。

### C.2 Worker / Process Heartbeat

```jsonc
// POST /internal/processes/heartbeat   每 10~15s
{
  "worker_id": "gpu-node-07",
  "process_instance_id": "gpu-node-07:9f3c1a8e-...",   // 重启必变，非 OS PID
  "os_pid": 48213,                                      // 仅诊断
  "status": "healthy",
  "supported_modes": ["coding_to_video", "blockout_3d"],
  "active_sessions": 3,
  "running_jobs": 1,
  "max_sessions": 8,
  "max_concurrent_jobs": 2,
  "resources": { "gpu_util": 0.87, "gpu_mem_used_mb": 21400, "cpu_load": 6.2 },
  "running_job_ids": ["<uuid>"],                        // 用于对账
  "reported_at": "2026-10-23T06:12:03.411Z"             // 服务端时间戳为准
}
```

缺失 3 次（≈45s）→ `SUSPECTED_UNAVAILABLE`：

```text
✅ 停止向其分配新 Session 与新 Job
✅ 检查其上已有 Job 的实际状态（主动 probe）
✅ 进入故障确认流程
❌ 不立即标记其 Job 失败
❌ 不把正在执行的 Job 分配到另一台机器（任务 9.1 明令禁止）
```

### C.3 Job Heartbeat / Lease

```jsonc
// POST /internal/jobs/{job_id}/heartbeat   每 15~30s
// 请求
{
  "job_id": "<uuid>", "session_id": "<uuid>",
  "worker_id": "gpu-node-07",
  "process_instance_id": "gpu-node-07:9f3c1a8e-...",
  "lease_token": "lt_7f2a...",        // fencing 凭证
  "attempt": 1,
  "phase": "RENDERING",
  "progress_percent": 62,              // 可选，后端能提供才给
  "last_progress_at": "2026-10-23T07:41:55Z",
  "heartbeat_at": "2026-10-23T07:42:10Z"
}

// 响应：Gateway 在心跳响应中回带控制指令（Pull 式取消通道）
{
  "lease": { "valid": true, "epoch": 1, "expires_at": "2026-10-23T07:44:10Z" },
  "control": "continue"
  // 其他可能值：
  // "cancel"            → Job 已被取消, 请立即停止并清理
  // "abort_stale_lease" → 你的租约已失效(已被抢占), 立即停止, 不得提交结果
  // "abort_max_runtime" → 已超最大运行时间
  // "abort_not_owner"   → 当前进程已非该 Job 所有者
}
```

Worker **必须**响应这些控制指令（任务 9.1 C 节）。
这同时给出了取消的**兜底通道**：即使 Gateway 主动 push 取消失败（网络抖动），
Worker 在下一次心跳（≤30s）也会得知自己该停止。

### C.4 心跳不得被计算阻塞（任务 9.2 重点）

**问题**：一个长时间阻塞的 FFmpeg 调用或 GPU 渲染会让单线程 Worker 无法按时续约 →
Gateway 误判失联 → 误取消一个正常任务。

**要求**（写入 `BACKEND_REQUIREMENTS.md` 的 P0）：心跳必须跑在**独立控制线程 / 轻量 Supervisor / 独立进程**中，与渲染计算解耦。

```text
推荐结构:
  Worker Process
  ├── Supervisor (独立线程/进程)      ← 心跳 + 接收控制指令 + 维护 cancel flag
  │     ├─ 每 20s POST job heartbeat
  │     └─ 收到 control=cancel → 置共享 cancel flag + 向任务进程组发信号
  └── Job Executor (子进程 / 进程组)   ← 实际生成, 在检查点读 cancel flag
```

### C.5 Watchdog 判定矩阵

Watchdog 每 10s 扫描非终态 Job，按下表判定：

| Worker 心跳 | Job 心跳 | 业务进度 | 判定 | 动作 |
|---|---|---|---|---|
| 新鲜 | 新鲜 | 有更新 | **健康运行** | 无 |
| 新鲜 | 新鲜 | 长时间无更新 | **健康但停滞** | 发 `job.heartbeat_status{stalled:true}` 事件；UI 区分展示；**绝不取消**（任务 9.4） |
| 新鲜 | 超时 | — | **Job 心跳异常** | probe 该 Job → 存活则恢复 `RUNNING`；否则 → `UNKNOWN` |
| 超时 | 超时 | — | **进程可疑** | Process → `SUSPECTED`；停止新分配；probe |
| 确认不可用 | — | — | **进程失联** | Job → `UNKNOWN` → `RECOVERING` → 对账定论 |
| — | — | — | 超 `max_runtime_seconds` | 走取消流程 `reason=max_runtime`（**不是**直接 FAILED） |

> 任务 7.5 五分类的落地：健康持续运行 / 健康但无进度 / 心跳异常 / 已确认失败或超时 / 状态无法确认。
> **「不能仅凭缺少一条进度消息就直接取消一个昂贵任务」** —— 对应上表第 2 行。

### C.6 网络暂时故障

| 现象 | 处理 |
|---|---|
| 单次心跳 HTTP 失败 | Worker 本地指数退避重试（1s/2s/4s），**不停止计算** |
| 连续失败 < lease TTL | 续约仍在有效期内，Job 不受影响 |
| 连续失败 ≥ lease TTL | Worker 应**主动进入自保**：暂停产出最终 Asset，继续尝试联系 Gateway；超过「自杀阈值」（建议 TTL×3）则主动停止并清理，避免成为孤儿（见 E.6） |
| Gateway 侧看到心跳缺失 | 走 C.5 矩阵，先 probe 再定论，不直接判死 |

---

## D. 任务取消

### D.1 完整取消链路

```text
① 用户点「停止生成」
   POST /api/jobs/{id}/cancel  {idempotency_key}
   ├─ 校验登录 + job.user_id == me          → 否则 404（不泄露存在性）
   ├─ 校验 Job 可取消（非终态）             → 终态则 409 + 返回真实状态
   ├─ 【持久化取消意图】UPDATE jobs SET status='CANCEL_REQUESTED',
   │     cancel_requested_at=now(), cancel_requested_by=me, cancel_reason='user'
   │     + INSERT job_cancel_requests(...)   ← 先落库，再做任何外部调用
   ├─ 事件 job.cancel_requested
   └─ 202 {status:'CANCEL_REQUESTED'}        ← ⚠️ 不是 'CANCELLED'

② Cancel Broker (异步)
   ├─ 撤销租约: UPDATE job_leases SET revoked_at=now()   ← 立刻阻止旧执行者提交结果
   ├─ Adapter.cancelJob(process, job_id, reason)
   │    ├─ 成功 ack → status='CANCELLING', 事件 job.cancelling
   │    └─ 失败 → 标记 UNDELIVERED，依赖心跳响应兜底下达（C.3）
   └─ 启动宽限计时器 (cancel_grace_seconds)

③ 后端实际停止 (见 D.3)
   └─ POST /internal/jobs/{id}/cancel-ack
        {stopped:true, resources_released:true, partial_artifacts:[...]}

④ Gateway 收尾
   ├─ status='CANCELLED', finished_at, cancel_acked_at, cancel_effective=true,
   │  resources_released_at
   ├─ 释放全局槽 + 进程槽
   ├─ 未完成 Asset → ABANDONED
   └─ 事件 job.cancelled

⑤ 宽限超时未 ack
   ├─ 进程健康 → 重发取消 + 升级（见 D.3）
   └─ 进程失联 → status='FAILED', failure_code='CANCEL_UNCONFIRMED'
        UI 明示「已请求停止，但后端进程失联，无法确认计算是否已终止」
        ⚠️ 不谎称已取消成功
```

**前端绝不在点击后假装成功**（任务 9.5）：必须按 `CANCEL_REQUESTED → CANCELLING → CANCELLED` 逐步展示。

### D.2 幂等与竞争

| 场景 | 行为 | 出处 |
|---|---|---|
| 重复点击停止 | 仅插入审计记录，不重复触发副作用；返回当前状态 | 11.6 |
| Job 已 `COMPLETED` 时点停止 | `409 JOB_ALREADY_TERMINAL` + 真实状态；**不改状态** | 11.7 |
| 取消与完成同时到达 | 单事务 `FOR UPDATE` 裁决，**完成优先**（产物 READY 时）；取消请求标 `SUPERSEDED_BY_COMPLETION` | 11.7 / 测试 I |
| `QUEUED` 态取消 | 直接出队 → `CANCELLED`，无需联系后端 | — |
| 取消送达但执行进程已失联 | `FAILED(CANCEL_UNCONFIRMED)`，人工介入清理 | 11.11 |

### D.3 后端实际终止（这部分需要后端实质开发，见 B-2）

生成管线涉及：Agent 主进程 → Subagent → 代码生成 → 外部命令 → Python 脚本 → FFmpeg → 浏览器渲染 → GPU/CPU 密集任务 → 视频编码 → 共享存储写入。
取消信号必须**穿透整条链**：

```text
推荐实现（协作式取消 + 进程组管理）:

1. 每个 Job 在独立 **Process Group** 中启动
   Python: os.setsid() / start_new_session=True
   Node:   spawn(cmd, {detached: true})
   → 使得可以 killpg 整个子进程树，而非只杀最上层

2. Cancel Token 贯穿 Agent 调用链
   每个阶段入口与循环内部设置检查点:
     for frame in frames:
         if cancel_token.is_set(): raise Cancelled()   ← 检查点
         render(frame)

3. 外部进程 (FFmpeg / 渲染器) 由 Supervisor 持有句柄
   取消时: killpg(pgid, SIGTERM) → 等待 grace (建议 15~30s) → killpg(pgid, SIGKILL)

4. ⚠️ 绝对禁止: 为停止一个 Job 而杀死承载多个 Session/Job 的共享后端服务进程
   （任务 9.6 原文）→ 这正是为什么每个 Job 必须有自己的进程组

5. 清理:
   · 删除临时目录 / 中间帧 / 临时音轨
   · 释放 GPU 上下文与显存
   · 取消在途的外部 API 调用
   · 部分产物: 默认不对外暴露（Asset → ABANDONED）；
     如需保留调试，仅管理员可见，且绝不写成 final asset

6. 不变式: 已取消的 Job **永不**写入最终 Asset
   双保险 = 租约已 revoke（写入被 409 拒绝）+ Worker 侧 cancel flag 检查
```

**若当前后端实现无法停止单个生成任务**，必须在 `BACKEND_REQUIREMENTS.md` 中列为 **P0 后端改造项**（任务 9.6 原文要求）。

### D.4 取消后的资源泄漏验证（任务 9.7 / 测试 G、P）

UI 显示 `CANCELLED` **不等于**取消成功。验收须逐项核查：

| 检查项 | 方法 |
|---|---|
| GPU 计算真的停止 | `nvidia-smi` 中该 Job 的进程消失，显存回落 |
| 渲染进程结束 | `pgrep -g <pgid>` 为空 |
| Subagent / 子进程无残留 | 进程树检查，无孤儿（PPID=1 且属该 Job） |
| 队列槽位释放 | `/api/system/capacity` 的 `used` 下降；DB 计数与 Redis 一致 |
| 临时文件清理 | Job 临时目录已删除 |
| 无僵尸任务 | DB 中无「终态但租约未释放」的记录 |
| 外部 API 停止计费 | 调用日志终止 |
| 已取消 Job 不能提交完成事件 | 构造过期 `lease_token` 调 complete → 必须 `409 LEASE_INVALID` |

---

## E. 异常与恢复

### E.1 Worker Crash

```text
Worker 进程崩溃
 → Worker 心跳 + Job 心跳同时停止
 → 45s: Process → SUSPECTED_UNAVAILABLE, 停止新分配
 → Watchdog probe 进程端口: 无响应
 → 120s: Process → UNAVAILABLE
 → 其上 Job → UNKNOWN → RECOVERING
 → 对账:
     ├─ 共享存储已有完整产物 + 完成标记 → 补判 COMPLETED（弥补完成事件丢失）
     ├─ 无产物 → FAILED(WORKER_CRASHED), 允许用户手动重试（创建新 Job）
     └─ ⚠️ 绝不自动跨进程重跑（任务 9.3 / 测试 F）
 → 其上 Session → binding=PROCESS_LOST → Session=DEGRADED
```

### E.2 Scheduler / Gateway Restart（测试 J）

```text
Gateway 启动
 1. 从 DB 重建 Redis 队列与并发计数（见 A.2，含在跑 Job 的占用！）
 2. 对每个 ASSIGNED/RUNNING/CANCELLING 的 Job：
      ├─ 租约未过期 + probe 确认在跑 → 保持原状态，恢复监控  ← 不重启任务
      ├─ 租约已过期 → UNKNOWN → 对账
      └─ CANCELLING 且租约已 revoke → 重发取消 + 重启宽限计时
 3. 恢复 SSE 扇出（事件已持久化，客户端用 Last-Event-ID 补齐）
 4. 开始正常出队
```

**不变式**：Gateway 重启**不产生**任何新的生成执行（I-9 / 测试 J）。

### E.3 Network Partition（旧执行者仍在跑）

这是最危险的场景：Gateway 认为 Worker 失效，但 Worker 实际仍在计算。

```text
防护 = Lease Epoch (Fencing Token):
  · Worker 的每次 progress/complete/fail 都带 lease_token
  · Gateway 校验 lease_epoch == 当前值 ∧ revoked_at IS NULL
  · 若 Gateway 已把租约 revoke 或 epoch 递增 → 旧执行者的写入全部 409 LEASE_INVALID 并丢弃
  · 旧执行者在下次心跳收到 control='abort_stale_lease' → 自行停止清理
  → 过期结果永远无法变成有效结果（任务 9.3 原文要求）
```

因 Session 固定进程，**V1 不实现跨进程自动恢复**（任务 9.3）；
`epoch` 递增只发生在同进程重试或管理员显式介入。

### E.4 Stalled Job

心跳正常但长时间无业务进度：

```text
→ 发 job.heartbeat_status{stalled:true, last_progress_age_s: 1500}
→ UI: 「后端仍在正常执行，当前阶段暂时没有新增进度。
       Worker 心跳正常（最后 12 秒前），最后进度更新于 25 分钟前。」
→ 超过 stall_warn_seconds: 仅告警，给用户「仍要继续等待 / 主动取消」的选择权
→ ❌ 系统绝不自动取消（任务 9.4 / 测试 E）
```

### E.5 Duplicate Job

三道防线：

1. 前端按钮提交后立即禁用 + 本地 in-flight 标记（仅 UX）
2. `(user_id, idempotency_key)` UNIQUE → 第二个请求返回**同一** `job_id`
3. `workflow_id` UNIQUE → 同一 workflow 永远只能有一个 Job

若已有重复执行且尚未形成独立有效任务 → 保留最早的，对后者走取消流程（`reason=duplicate`，任务 9.4）。

### E.6 Orphan Job

| 类型 | 识别 | 处理 |
|---|---|---|
| DB 有记录，后端无执行 | probe 该 Job 不存在 | `RECOVERING` → `FAILED(ORPHAN_NO_EXECUTOR)` |
| 后端在跑，DB 无记录 | Worker 心跳上报的 `running_job_ids` 中有 DB 未知 ID | Gateway 下达 `abort_not_owner`，Worker 停止该任务 |
| 子进程脱离 Supervisor | Worker 启动时扫描遗留进程组 | 启动期清理（Worker 侧职责） |

反向对账（第 2 行）是防止「幽灵计算长期占用 GPU」的关键，因此 Worker 心跳**必须**上报 `running_job_ids`。

### E.7 Unknown State

```text
进入条件: Job 心跳超时 ∧ 无法确认后端真实状态
处理:
  1. status='UNKNOWN', 事件 job.state_unknown
  2. UI: 「正在确认后端任务状态…」（既不说成功也不说失败）
  3. Watchdog 以退避节奏持续 probe（10s → 30s → 60s，上限 5min）
  4. 并行检查共享存储是否已出现完整产物
  5. 结论:
       ├─ 在跑 → RUNNING
       ├─ 已完成且产物完整 → COMPLETED
       ├─ 明确失败 → FAILED
       └─ 超过 unknown_max_seconds 仍无定论 → FAILED(STATE_UNRESOLVED)
          ⚠️ 不自动重试昂贵任务，重试由用户显式发起（任务 9.3）
```

### E.8 Process Instance Restart

```text
Worker 重启 → 新 process_instance_id（必须变更，B-4）
 → 旧 instance 的 Session → PROCESS_LOST → Session DEGRADED
 → ⚠️ 不假装可无损迁移（任务 10.4 原文）
 → 用户必须新建 Session；旧 Session 的已完成产物仍可访问
 → 旧 instance 的在跑 Job → UNKNOWN → 对账（可能已有完整产物）
```

---

## F. 推荐参数

### F.1 初始配置（全部可配置，**不可写死在前端框架默认值里**）

| 参数 | 初始值 | 建议范围 | 是否需压测定档 | 出处 |
|---|---|---|---|---|
| `http_request_timeout` | 15s | 10~30s | 否 | 7.5 |
| `sse_keepalive_interval` | 15s | 10~30s | 否 | 12 |
| `worker_heartbeat_interval` | 12s | 10~15s | 否 | 9.2 |
| `worker_heartbeat_miss_threshold` | 3 次（≈36s） | 3~5 次 | 否 | 9.2 |
| `worker_suspect_to_unavailable` | 120s | 90~300s | **是** | 9.1 |
| `job_heartbeat_interval` | 20s | 15~30s | 否 | 9.2 |
| `job_lease_ttl` | 120s | ≥ 4× 心跳间隔 | **是** | 9.3 |
| `job_heartbeat_lost_check` | 90s | 60~120s | **是** | 9.2 |
| `stall_warn_seconds` | 600s（10min） | **按阶段分别配置** | **是（强依赖管线）** | 7.5 |
| `stall_alert_seconds` | 1800s（30min） | 仅告警，不取消 | **是** | 9.4 |
| `job_max_runtime_seconds` | **10800s（3h）** | 按 mode 分别配置 | **是（P0 必须压测）** | 7.5 |
| `cancel_grace_seconds` | 60s | 30~120s | **是** | 9.5 |
| `cancel_sigterm_to_sigkill` | 20s | 10~30s | **是** | 9.6 |
| `unknown_max_seconds` | 1800s | 900~3600s | **是** | 7.2 |
| `poll_interval_visible` | 5s | 3~10s | 否 | 12.2 |
| `poll_interval_hidden` | 60s | 30~120s | 否 | 12.2 |
| `browser_presence_interval` | 30s | 仅页面可见时 | 否 | 9.1 |
| `global_max_concurrent_jobs` | 按机器数×进程并发求和 | — | **是** | 10.3 |

### F.2 必须压测定档的参数（不可凭空写死）

> 任务 9.2 原文：「这些数字只是方案讨论的起点，不是未经测量就必须写死的产品参数。」

| 参数 | 测量方法 | 风险 |
|---|---|---|
| `job_max_runtime_seconds` | 统计真实生成耗时的 P50/P95/P99，取 **P99 × 1.5~2** | 偏小 → 误杀昂贵任务（最严重）；偏大 → 故障任务长期占槽 |
| `stall_warn_seconds`（按阶段） | 统计各 phase 的最长无进度间隔 | 偏小 → 误报；偏大 → 真故障发现太晚 |
| `job_lease_ttl` | 测量心跳在最重计算负载下的最大延迟 | 偏小 → 误判失联 |
| `cancel_grace_seconds` | 测量 FFmpeg/渲染收到 SIGTERM 到退出的耗时 | 偏小 → 强杀导致文件残留 |
| `global_max_concurrent_jobs` | 压测 GPU 显存与吞吐 | 偏大 → OOM |

**关键原则**：`job_max_runtime_seconds` 由真实视频管线能力决定，与 HTTP 超时、Nginx 超时、框架默认值**毫无关系**（任务 7.5）。

### F.3 失联恢复策略矩阵

| 失联时长 | Worker 状态 | 新分配 | 在跑 Job | 用户看到 |
|---|---|---|---|---|
| 0~36s | HEALTHY | ✅ | 运行 | 正常 |
| 36~120s | SUSPECTED | ❌ | **保持运行** + probe | 「正在确认后端状态」 |
| > 120s（probe 失败） | UNAVAILABLE | ❌ | UNKNOWN → 对账 | 「正在与后端核对任务状态」 |
| 对账有定论 | — | — | COMPLETED / FAILED | 真实结果 |
| > `unknown_max_seconds` 无定论 | — | — | FAILED(STATE_UNRESOLVED) | 「状态无法确认」+ 手动重试入口 |

---

## G. 端到端时序图

### G.1 正常生成完成

```text
浏览器        Web        Gateway         DB       Worker    共享存储
  │ approve   │            │             │          │          │
  ├──────────►├───────────►│  tx: APPROVED+QUEUED   │          │
  │           │            ├────────────►│          │          │
  │ 202 QUEUED│◄───────────┤             │          │          │
  │◄──────────┤            │             │          │          │
  │  SSE 订阅 │            │             │          │          │
  ├───────────┼───────────►│             │          │          │
  │           │   Dispatcher: 取槽 → ASSIGNED, lease(epoch=1)   │
  │           │            ├────────────►│          │          │
  │           │            ├─ startJob ─────────────►│          │
  │ job.assigned (SSE)     │◄─ ack ──────────────────┤          │
  │◄───────────────────────┤             │          │          │
  │           │            │◄─ hb/progress ─────────┤          │
  │ job.phase/progress     ├────────────►│ (seq++)  │          │
  │◄───────────────────────┤             │          │          │
  │     … 约 114 分钟，心跳每 20s，阶段推进 …          │          │
  │           │            │             │  写产物  ├─────────►│
  │           │            │             │  写完成标记         │
  │           │            │◄─ complete{lease_token}┤          │
  │           │            ├─ 校验 epoch ✓ 校验产物 ─────────────►│
  │           │            ├─ Asset READY, Job COMPLETED, 释放槽 │
  │           │            ├────────────►│          │          │
  │ job.completed (SSE)    │             │          │          │
  │◄───────────────────────┤             │          │          │
  │ 渲染播放器              │             │          │          │
```

### G.2 用户关闭浏览器，1 小时后返回（测试 B）

```text
T+0     浏览器: approve → Job QUEUED → RUNNING, SSE 连接中
T+5min  用户关闭整个浏览器
        ├─ SSE 连接断开
        ├─ Browser Presence 停止
        └─ ⚠️ Gateway 侧零动作，Worker 侧零动作   ← 关键不变式 I-4
T+5~65min  Worker 继续计算，Job 心跳正常续约，事件持续写入 job_events
T+62min Worker complete → Asset READY → Job COMPLETED（此刻无任何浏览器在线）
        └─ 结果写入 generated_assets，可查
T+65min 用户重新打开浏览器（甚至换了设备）
        ├─ GET /api/auth/me → 200（或先登录）
        ├─ localStorage 有 job_id（或为空 → 走 active-context 兜底）
        ├─ GET /api/me/active-context
        │    → running_jobs: [], recent_completed_jobs: [{job_id, asset_id}]
        ├─ GET /api/sessions/{id} → 消息流 + job 快照(COMPLETED)
        ├─ UI 直接渲染播放器（关闭前是 RUNNING，现在是 COMPLETED → 展示最终视频）
        └─ ⚠️ 不重复提交生成（idempotency_key 已存在 → 同一 job_id）
```

### G.3 用户主动取消（测试 G）

```text
浏览器        Gateway          DB         Worker           GPU/子进程
  │ 点击停止    │               │            │                  │
  ├───────────►│ tx: CANCEL_REQUESTED        │                  │
  │            ├──────────────►│            │                  │
  │ 202 CANCEL_REQUESTED       │            │                  │
  │◄───────────┤  「正在请求停止…」           │                  │
  │            ├─ revoke lease ►│            │                  │
  │            ├─ cancelJob ────────────────►│                  │
  │            │◄─ ack ─────────────────────┤                  │
  │            ├─ CANCELLING ──►│            ├─ 置 cancel flag  │
  │ job.cancelling  「正在停止，回收资源中…」   ├─ killpg SIGTERM ►│
  │◄───────────┤               │            │   等待 grace 20s  │
  │            │               │            ├─ 仍存活? SIGKILL ►│
  │            │               │            ├─ 清理临时文件     │
  │            │               │            ├─ 释放 GPU 显存    │
  │            │◄─ cancel-ack{stopped, resources_released} ──────┤
  │            ├─ CANCELLED, finished_at, cancel_effective=true  │
  │            ├─ 释放全局槽+进程槽, Asset→ABANDONED             │
  │ job.cancelled 「已取消」    │            │                  │
  │◄───────────┤               │            │                  │
```

### G.4 Worker 心跳丢失（测试 F）

```text
T+0      Job RUNNING, Worker 心跳正常
T+40min  Worker 机器网络中断
T+40m36s Worker 心跳缺失 3 次 → Process=SUSPECTED_UNAVAILABLE
         ├─ 停止向该进程分配新 Session / 新 Job
         ├─ ⚠️ 在跑 Job 保持 RUNNING（不立即判死）
         └─ UI: 「正在确认后端状态」
T+41m30s Job 心跳超时 90s → Watchdog probe
         ├─ probe 成功（仅心跳链路抖动）→ Process 回 HEALTHY, Job 继续  ← 可逆
         └─ probe 失败 → 继续退避 probe
T+42m    Process → UNAVAILABLE
         ├─ Job → UNKNOWN，事件 job.state_unknown
         ├─ Session binding → PROCESS_LOST，Session → DEGRADED
         └─ ⚠️ 不把该 Job 分配到其他机器（任务 9.1/9.3）
T+42m10s Job → RECOVERING，对账:
         ├─ 查共享存储: 有完整产物+完成标记 → COMPLETED（挽回已付出的算力）
         └─ 无产物 → FAILED(WORKER_UNREACHABLE) + 手动重试入口
         ⚠️ 全程不自动重跑昂贵任务
```

### G.5 Scheduler 重启（测试 J）

```text
T+0      Job-1 RUNNING(Worker A), Job-2 QUEUED, Job-3 CANCELLING
T+50min  Gateway 进程被重启（发版）
         ├─ 停止出队 → 等在途 RPC → 退出（Drain，不取消任何 Job）
         └─ Worker A 的心跳在此期间失败 → Worker 本地退避重试，继续计算 ✅
T+50m20s Gateway 启动:
         1. 从 DB 重建队列: Job-2 回到 Worker A 的亲和性队列
         2. 重建并发计数: Job-1(RUNNING) + Job-3(CANCELLING) 各占 1 槽
            ⚠️ 不是从 0 开始，否则会超发并发
         3. Job-1: 租约未过期 + probe 确认在跑 → 保持 RUNNING，恢复监控
            ⚠️ 不重新 startJob（这是测试 J 的核心断言）
         4. Job-3: 租约已 revoke → 重发 cancelJob + 重启宽限计时
         5. 恢复 SSE 扇出；前端用 Last-Event-ID 补齐断档事件
T+50m25s 正常出队，Job-2 在 Worker A 有空槽时启动
```

### G.6 取消与完成同时发生（测试 I）

```text
T+0.000  Worker 产物写完，发出 complete{lease_token}
T+0.010  用户点击停止，发出 cancel
         ↓ 两个请求几乎同时到达 Gateway

Gateway 对同一 job 行加 FOR UPDATE，串行裁决：

情形 1: complete 先获得行锁
  ├─ 校验 epoch ✓ → 校验产物 READY ✓ → Job=COMPLETED, finished_at
  └─ cancel 随后获锁 → 发现已终态 → 409 JOB_ALREADY_TERMINAL
     返回 {status:'COMPLETED'}，UI 提示「任务已完成，取消未生效」+ 展示视频

情形 2: cancel 先获得行锁
  ├─ Job=CANCEL_REQUESTED, 租约 revoke
  └─ complete 随后获锁，携带**已 revoke** 的 lease_token
     ├─ 产物校验 READY → 【完成优先】Job=COMPLETED,
     │    cancel_request → SUPERSEDED_BY_COMPLETION
     │    UI: 「任务在取消生效前已完成」+ 展示视频
     └─ 产物不完整 → Job=CANCELLED, Asset=ABANDONED

两种情形下的最终结果都是确定且唯一的：
  ✅ 绝不同时存在 COMPLETED 与 CANCELLED（不变式 I-1，DB CHECK 约束兜底）
  ✅ 用户绝不会下载到半写入的文件（Asset 必须 READY）
```

### G.7 新建 Session 时旧任务仍在执行（测试 D）

```text
T+0      Session-A (Process P1) 的 Job-1 已 RUNNING 60 分钟
T+60min  用户点击「New Session」
         ├─ UI 先弹确认框:
         │    「您在当前会话有一个已运行 1 小时 2 分钟的生成任务。
         │      新建会话不会中断它，可随时在『进行中的任务』中查看结果。」
         │    [ 新建会话 ]  [ 取消 ]
         └─ 用户确认 → POST /api/sessions {mode}
T+60m01s Gateway:
         ├─ 新建 Session-B，按健康度与负载重新选进程（可能是 P2）
         ├─ ⚠️ 不触碰 Session-A 的任何记录
         ├─ ⚠️ 不触碰 Job-1（仍在 P1 执行，仍持有 P1 的并发槽）
         └─ 新旧 Session 的后端上下文完全隔离（不同 process / 不同会话句柄）
T+60m02s UI: 切到 Session-B 空白对话；左栏「进行中的任务 (1)」仍显示 Job-1
T+95min  Job-1 在 P1 完成 → 结果写入 generated_assets
         └─ 用户在「进行中的任务」→「最近结果」中播放 / 下载 Job-1 的视频
            （无需回到 Session-A 的完整聊天历史——V1 不做历史 Session 切换，
              但产物必须拿得到：任务 8.6 的核心要求）
```

---

## H. 与其他文档的一致性声明

| 约束 | 本文档的体现 |
|---|---|
| API Contract 不得设计「页面关闭自动取消」 | 不存在该路径；取消仅由 §D.1 的显式 API 触发 |
| 状态机不得假定 Session 可自动迁移进程 | §E.8：`PROCESS_LOST` 是终态，恢复路径只有新建 Session |
| Backend Requirements 不得要求 V1 实现 Reference 上传 | 本文档不含任何上传 / 附件链路 |
| UX 不得显示后端无法提供的假进度 | §C.3 `progress_percent` 标注「后端能提供才给」；§E.4 无进度时只显示耗时与心跳新鲜度 |
| Implementation Plan 不得在无后端 Cancel 支持时宣称取消完成 | §D.3 明确列为后端 P0 改造项（B-2） |
| 长任务文档不得假设浏览器缓存一定存在 | §B.4：localStorage 为空时由 `active-context` 独立完成恢复 |
