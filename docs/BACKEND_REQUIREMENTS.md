# BACKEND_REQUIREMENTS — 后端开发需求说明

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
> **本文档可直接交给后端 Coding Agent 作为实现依据。**
> 配套：`API_CONTRACT.md`（完整接口定义）、`LONG_RUNNING_JOBS.md`（长任务语义）、`STATE_MACHINE.md`（状态定义）
> 机器可读协议：`openapi/openapi.yaml`

---

## 0. 给后端 Coding Agent 的执行摘要

### 0.1 你要做什么

把现有 Coding Video Agent 改造成**可被 Gateway 调度的 Worker**，需要新增/改造：

1. **进程注册与心跳**：向 Gateway 注册进程实例，周期上报 Worker 心跳与 Job 心跳
2. **租约响应**：每次回调携带 `lease_token`，并响应 Gateway 下发的控制指令
3. **单 Job 取消**：能够只停止一个生成任务，不影响同进程其他 Session/Job ⚠️ **最高风险项**
4. **产物完成协议**：明确「视频已完整写入」的判定约定
5. **结构化意图与 Prompt 增强**：返回 5 类意图枚举与可多轮修订的增强 Prompt
6. **Job 状态对账接口**：供 Gateway 在状态未知时查询真实情况

### 0.2 五条铁律

```text
① 生成任务可运行 1~2 小时以上。
   绝不能因为「HTTP 超时」「浏览器断开」「SSE 断连」「30 分钟没进度」而停止计算。

② 心跳必须跑在独立线程 / Supervisor / 独立进程中。
   长时间阻塞的渲染或编码函数挡住心跳，会导致任务被误判失联。

③ 取消一个 Job，绝不能杀掉承载多个 Session/Job 的共享服务进程。
   每个 Job 必须在独立 Process Group 中，可整树终止。

④ 共享目录里出现文件 ≠ 任务完成。
   必须有明确的完成标记或原子提交，Gateway 据此判定 asset.ready。

⑤ 收到 lease 失效信号后，立即停止并且不得提交任何结果。
   旧执行实例把过期结果写成有效结果，是本系统最严重的数据正确性事故。
```

### 0.3 名词对照

| 名词 | 含义 |
|---|---|
| **Gateway** | 我方的独立 Node 调度服务，默认端口 9999。所有回调发给它 |
| **Worker** | 一台后端机器 |
| **Process Instance** | 一个后端 Agent 进程实例。**重启后必须换新 ID** |
| **Session** | 一轮对话会话，**固定绑定**到某个 Process Instance，永不迁移 |
| **Job** | 一次生成任务。一个 Session 可以有多个 Job |
| **Lease** | Job 的执行权租约。持有有效租约才能提交结果 |
| **Asset** | 生成产物（视频文件 + 元数据） |

---

## 1. 能力状态总表

每项标注：`CONFIRMED`（已确认具备）/ `NEEDS_CHANGE`（已有但需改造）/ `MISSING`（需新开发）/ `TO_CONFIRM`（待后端回复）

> **重要说明**：Phase 1 期间我方**未读过后端任何代码**（后端不在授权范围内）。
> 下表的 `CONFIRMED` 仅来自用户口头答复；`MISSING` 为合理推测而非验证结论。
> **请后端逐项修正本表**，这是本文档最需要 review 的部分。

> **ID 约定**：本表行号用 `A-n`(Session) / `IP-n`(意图与 Prompt) / `C-n`(Job) / `D-n`(Queue) /
> `E-n`(心跳) / `F-n`(取消) / `G-n`(长任务) / `H-n`(产物) / `I-n`(安全)。
> 文中形如 **`B-n`（阻塞项）** 的编号是**另一套**，指 `BACKEND_INTEGRATION.md` §4 的待确认问题清单，两者不要混淆。

### A. Session / Process

| # | 需求 | 状态 | 说明 |
|---|---|---|---|
| A-1 | 远程机器 IP+Port 可访问 | `CONFIRMED` | 用户答复 |
| A-2 | Session 固定路由到某进程，不迁移 | `CONFIRMED` | 任务书 §5 |
| A-3 | **进程实例标识**：重启必变，不用 OS PID | `TO_CONFIRM` | 见 §2.1 要求 |
| A-4 | Session 创建与上下文维护 | `TO_CONFIRM` | 需确认接口形态 |
| A-5 | 按 `mode` 切换 Skill | `TO_CONFIRM` | 请求参数还是不同端点？ |
| A-6 | Worker 进程不可用时的处理：不假装可迁移 | `MISSING` | Gateway 主导，后端需配合探活 |

### B. 意图与 Prompt

| # | 需求 | 状态 | 说明 |
|---|---|---|---|
| IP-1 | 返回 5 类结构化意图枚举 | `MISSING`（推测） | 见 §3.1 |
| IP-2 | 超范围输入返回结构化提示（非前端关键词判断） | `MISSING`（推测） | 任务 2.2 明确要求后端判定 |
| IP-3 | Prompt 增强 | `TO_CONFIRM` | 可能已有 |
| IP-4 | 按修改意见多轮再增强 | `TO_CONFIRM` | |
| IP-5 | 视频相关普通对话 | `TO_CONFIRM` | |
| IP-6 | 人工确认后才启动生成 | `MISSING` | Gateway 控制，后端只接收已确认 Prompt |

### C. Job

| # | 需求 | 状态 | 说明 |
|---|---|---|---|
| C-1 | 异步创建（立即返回，不阻塞） | `TO_CONFIRM` | 见 §4.1 |
| C-2 | Job 状态持久化 | — | **Gateway 职责**，后端无需实现 |
| C-3 | Idempotency Key | — | **Gateway 职责** |
| C-4 | 状态查询（对账用） | `MISSING`（推测） | 见 §4.4 |
| C-5 | 执行时间记录 | `MISSING` | 随心跳上报 |
| C-6 | 失败与终态上报 | `MISSING`（推测） | 见 §4.3 |

### D. Queue

| # | 需求 | 状态 | 说明 |
|---|---|---|---|
| D-1 | 固定进程亲和性排队 | — | **Gateway 职责** |
| D-2 | 两模式共享容量 | — | **Gateway 职责** |
| D-3 | 后端上报 `max_concurrent_jobs` | `TO_CONFIRM` | 注册时提供 |
| D-4 | Job 租约 | `MISSING` | 见 §5 |
| D-5 | 防重复执行 | — | Gateway 幂等 + 后端拒绝重复 `job_id` |

### E. Heartbeat / Watchdog

| # | 需求 | 状态 | 说明 |
|---|---|---|---|
| E-1 | Worker / Process Heartbeat | `MISSING` | 见 §2.2 |
| E-2 | Job Heartbeat | `MISSING` | 见 §2.3 |
| E-3 | **心跳不被计算阻塞**（独立线程/Supervisor） | `TO_CONFIRM` ⚠️ | 见 §2.4 |
| E-4 | Lease 续约 | `MISSING` | 见 §5 |
| E-5 | 响应失效执行识别（`abort_stale_lease`） | `MISSING` | 见 §5.3 |
| E-6 | 孤儿 Job 处理：上报 `running_job_ids` 供反向对账 | `MISSING` | 见 §2.2 |
| E-7 | 任务所有权保护（fencing） | `MISSING` | 见 §5.2 |

### F. 取消

| # | 需求 | 状态 | 说明 |
|---|---|---|---|
| F-1 | **单 Job 取消，不杀共享进程** | `TO_CONFIRM` ⚠️⚠️ | 见 §6，**最高风险** |
| F-2 | Agent Cancel Token / 协作式取消检查点 | `TO_CONFIRM` | 见 §6.2 |
| F-3 | Subagent / 子进程树终止 | `TO_CONFIRM` | 见 §6.3 |
| F-4 | 渲染任务（FFmpeg/GPU）终止 | `TO_CONFIRM` | 见 §6.3 |
| F-5 | 资源清理（GPU 显存、临时文件、外部 API） | `TO_CONFIRM` | 见 §6.4 |
| F-6 | 取消结果确认回调 | `MISSING` | 见 §6.5 |
| F-7 | 已取消 Job 不得写入最终 Asset | `MISSING` | 租约 + 本地 flag 双保险 |

### G. 长任务

| # | 需求 | 状态 | 说明 |
|---|---|---|---|
| G-1 | 两小时以上正常执行 | `CONFIRMED` | 任务书 §0 |
| G-2 | 与浏览器断线无关 | `MISSING` | 后端不得感知浏览器状态 |
| G-3 | Worker 重启：实例 ID 变更 | `TO_CONFIRM` | 见 §2.1 |
| G-4 | Session 不迁移 | `CONFIRMED` | |
| G-5 | 运行状态可恢复（对账） | `MISSING` | 见 §4.4 |
| G-6 | 无法恢复任务的处理 | `MISSING` | 明确返回 `not_found` 而非沉默 |
| G-7 | Graceful Shutdown / Drain | `MISSING` | 见 §8 |

### H. 视频产物

| # | 需求 | 状态 | 说明 |
|---|---|---|---|
| H-1 | 共享存储所有 Worker 可见 | `CONFIRMED` | 用户答复 |
| H-2 | **绝对路径 + 状态标记**交付 | `CONFIRMED`（有机制），**约定待定** | 见 §7.1 |
| H-3 | Asset 元数据（时长/分辨率/大小/checksum） | `TO_CONFIRM` | 见 §7.2 |
| H-4 | 文件完成判定协议 | `TO_CONFIRM` ⚠️ | 见 §7.1 |
| H-5 | 结果持久化（不只在最后一条消息里） | `MISSING` | Gateway 落库，后端需在 complete 中给全元数据 |
| H-6 | 旧视频修改：基于 Asset A 生成 B，不覆盖 A | `TO_CONFIRM` | 见 §7.3 |

### I. 安全

| # | 需求 | 状态 | 说明 |
|---|---|---|---|
| I-1 | 内部身份认证（Worker ↔ Gateway） | `MISSING` | 见 §9.1 |
| I-2 | 用户权限校验 | — | **Gateway 职责**，后端不做用户鉴权 |
| I-3 | 白模 Skill 权限 | — | **Gateway 校验 4 点**，后端只按传入 mode 执行 |
| I-4 | 文件权限 | `TO_CONFIRM` | 共享存储目录权限 |
| I-5 | Job 归属校验 | — | **Gateway 职责** |

**统计**：`CONFIRMED` 8 项 · `NEEDS_CHANGE` 0 项 · `MISSING` 20 项（推测）· `TO_CONFIRM` 21 项 · Gateway 职责 11 项。

---

## 2. 进程注册与心跳

### 2.1 Process Instance ID（A-3）

**硬要求**：

```text
✅ 全局唯一
✅ 进程每次重启都必须产生新值
✅ 推荐格式  {worker_id}:{uuid-v4}        例: gpu-node-07:9f3c1a8e-4b2d-4f71-9c3e-...
❌ 绝对不得使用 OS PID 作为身份（PID 会被操作系统复用）
❌ 不得使用 hostname 等重启后不变的值
```

**为什么**：Session 固定绑定到 Process Instance。若重启后 ID 不变，
Gateway 会把 Session 路由到一个**上下文已丢失**的新进程，用户会看到「会话莫名其妙失忆」。
ID 变更后，Gateway 会把旧 Session 标记为 `PROCESS_LOST` 并提示用户新建会话——这是正确行为。

**实现**：

```python
# 进程启动时生成一次，常驻内存
import uuid
PROCESS_INSTANCE_ID = f"{WORKER_ID}:{uuid.uuid4()}"
```

### 2.2 注册与 Worker 心跳（E-1, E-6）

**启动时注册一次**：

```http
POST http://{gateway}:9999/internal/processes/register
X-Internal-Token: <shared-secret>
Content-Type: application/json

{
  "worker_id": "gpu-node-07",
  "host": "10.20.30.7",
  "port": 18080,
  "process_instance_id": "gpu-node-07:9f3c1a8e-...",
  "os_pid": 48213,
  "supported_modes": ["coding_to_video", "blockout_3d"],
  "max_sessions": 8,
  "max_concurrent_jobs": 2,
  "version": "agent-1.4.2",
  "started_at": "2026-10-23T06:00:00.000Z"
}
```

响应返回心跳配置，**以服务端下发为准**，不要在 Worker 里写死：

```json
{ "accepted": true,
  "config": { "heartbeat_interval_seconds": 12,
              "job_heartbeat_interval_seconds": 20,
              "lease_ttl_seconds": 120,
              "cancel_grace_seconds": 60 },
  "server_time": "2026-10-23T06:00:00.050Z" }
```

**之后每 10~15 秒心跳一次**：

```http
POST /internal/processes/heartbeat
{
  "worker_id": "gpu-node-07",
  "process_instance_id": "gpu-node-07:9f3c...",
  "status": "healthy",
  "active_sessions": 3,
  "running_jobs": 1,
  "running_job_ids": ["job_abc"],        ★必填★
  "max_sessions": 8,
  "max_concurrent_jobs": 2,
  "resources": { "gpu_util": 0.87, "gpu_mem_used_mb": 21400,
                 "gpu_mem_total_mb": 24576, "cpu_load": 6.2, "disk_free_gb": 420 },
  "reported_at": "2026-10-23T08:24:00.000Z"
}
```

**`running_job_ids` 为什么必填**：Gateway 用它做**反向对账**。
若后端在跑一个 Gateway 数据库里不存在的 Job（例如 Gateway 曾崩溃导致记录丢失，或旧实例残留），
Gateway 会在响应中下发 `abort_not_owner`，让你停掉这个幽灵任务。
**没有这个字段，幽灵计算会长期占用 GPU 且无人知晓。**

**响应中的控制指令必须处理**：

```json
{ "ack": true, "server_time": "...",
  "directives": [
    { "type": "cancel_job",      "job_id": "job_xyz", "reason": "user" },
    { "type": "abort_not_owner", "job_id": "job_ghost" },
    { "type": "drain" }
  ] }
```

| directive | 你必须做什么 |
|---|---|
| `cancel_job` | 对该 Job 执行完整取消流程（§6），完成后回调 `cancel-ack` |
| `abort_not_owner` | 立即停止该 Job 并清理，**不要回调任何结果** |
| `abort_stale_lease` | 同上 |
| `drain` | 停止接受新 Session/Job，现有 Job 跑完后退出（§8） |

### 2.3 Job 心跳 / 租约续约（E-2, E-4）

**每个运行中的 Job，每 15~30 秒一次**：

```http
POST /internal/jobs/{job_id}/heartbeat
{
  "session_id": "sess_...",
  "worker_id": "gpu-node-07",
  "process_instance_id": "gpu-node-07:9f3c...",
  "lease_token": "lt_7f2a9b...",          ★必填★
  "attempt": 1,
  "phase": "RENDERING",
  "progress_percent": 62,                  // 能提供才给；不能则省略或 null
  "last_progress_at": "2026-10-23T08:23:30.000Z",
  "heartbeat_at": "2026-10-23T08:24:00.000Z"
}
```

响应：

```json
{ "lease": { "valid": true, "epoch": 1, "expires_at": "2026-10-23T08:26:00.000Z" },
  "control": "continue",
  "server_time": "..." }
```

**`control` 的处理是强制要求**：

| 值 | 你必须做什么 |
|---|---|
| `continue` | 继续执行 |
| `cancel` | 立即进入取消流程（§6），完成后回调 `cancel-ack` |
| `abort_stale_lease` | 租约已失效 → **立即停止，不得提交任何结果** |
| `abort_max_runtime` | 超出最大运行时间 → 同 `cancel` |
| `abort_not_owner` | 已非该 Job 所有者 → 立即停止，不提交结果 |

**错误处理（这段决定了会不会误杀任务）**：

| 响应 | 你必须做什么 |
|---|---|
| `409 LEASE_INVALID` | **立即停止，放弃结果**（等同 `abort_stale_lease`） |
| `404 NOT_FOUND` | Job 不存在 → 停止并清理 |
| `401 INTERNAL_AUTH_FAILED` | 检查配置；**不要停止计算**，退避重试 |
| `5xx` / 连接错误 / 超时 | **绝对不要停止计算**。指数退避重试（1s→2s→4s→8s，上限 30s） |

**网络中断时的自保策略**：

```text
连续心跳失败时长 < lease_ttl        → 继续计算，继续重试心跳
连续心跳失败时长 ≥ lease_ttl        → 继续计算，但【暂缓提交最终 Asset】
                                      （因为租约可能已被 Gateway 撤销）
连续心跳失败时长 ≥ lease_ttl × 3    → 主动停止并清理，避免成为孤儿进程
```

### 2.4 ⚠️ 心跳不得被计算阻塞（E-3）

**这是最容易出事的地方。**

一个阻塞 20 分钟的 FFmpeg 调用或 GPU 渲染，会让单线程 Worker 无法按时续约，
Gateway 误判失联 → 一个正常运行了 1 小时的昂贵任务被误杀。

**必须的结构**：

```text
Worker Process
├── Supervisor（独立线程 / 独立进程）     ← 心跳只跑在这里
│    ├─ 每 12s  POST /internal/processes/heartbeat
│    ├─ 每 20s  POST /internal/jobs/{id}/heartbeat   (每个运行中的 Job)
│    ├─ 维护共享的 cancel_flag / lease_state
│    └─ 收到 control=cancel → 置 flag + 向任务进程组发信号
│
└── Job Executor（独立 Process Group，每个 Job 一个）
     ├─ 实际生成计算（可以长时间阻塞，不影响心跳）
     └─ 在各阶段检查点读取 cancel_flag
```

Python 参考：

```python
import threading, os, signal, subprocess

class JobSupervisor(threading.Thread):
    """心跳独立线程，绝不被渲染阻塞"""
    daemon = True
    def run(self):
        while not self._stop.is_set():
            for job_id, st in list(self.jobs.items()):
                try:
                    r = self.post(f"/internal/jobs/{job_id}/heartbeat", {
                        "lease_token": st.lease_token,
                        "phase": st.phase,
                        "progress_percent": st.progress,     # 没有就别给
                        "last_progress_at": st.last_progress_at,
                        "heartbeat_at": now_iso(),
                        ...
                    }, timeout=10)
                    ctrl = r.json().get("control", "continue")
                    if ctrl != "continue":
                        st.cancel_flag.set()                 # Executor 在检查点读到
                        self.terminate_job_group(job_id, ctrl)
                    st.consecutive_failures = 0
                except RequestFailed as e:
                    if e.status == 409:                      # LEASE_INVALID
                        st.cancel_flag.set()
                        self.terminate_job_group(job_id, "abort_stale_lease")
                    else:
                        st.consecutive_failures += 1
                        # 5xx / 网络错误：绝不停止计算
            self._stop.wait(self.interval)
```

---

## 3. 意图识别与 Prompt 增强

### 3.1 结构化意图（IP-1, IP-2）

用户每条消息都要返回**五选一**的意图枚举：

| intent | 含义 | Gateway 后续动作 |
|---|---|---|
| `new_generation` | 要生成新视频 | 创建 Prompt Workflow，走增强→确认→Job |
| `edit_generation` | 要修改当前视频 | 同上，但带 `base_asset_id` |
| `prompt_revision` | 对增强后 Prompt 提修改意见 | 产生新 Prompt Revision |
| `video_discussion` | 视频相关的普通对话 | 直接回复，不创建 Job |
| `out_of_scope` | 超出业务范围 | 渲染结构化提示卡片 |

**`out_of_scope` 必须返回结构化提示**（任务 2.2：不能由前端关键词判断）：

```json
{ "intent": "out_of_scope",
  "notice": {
    "code": "OUT_OF_SCOPE",
    "title": "该请求超出本平台范围",
    "message": "本站仅支持 AI 视频生成、视频修改及相关创作讨论。",
    "suggestions": ["描述你想生成的视频画面", "对当前视频提出修改意见"]
  } }
```

### 3.2 Prompt 增强与多轮修订（IP-3, IP-4）

```text
用户原始输入
   → 后端增强 → enhanced_prompt (rev 1)
   → 用户提修改意见 note
   → 后端基于 rev1 + note 再增强 → enhanced_prompt (rev 2)
   → 用户确认 rev2
   → Gateway 创建 Job，把 rev2 的 enhanced_prompt 传给后端执行
```

要点：

- 后端**只负责产出增强结果**，不负责判断用户是否确认
- **只有 Gateway 调用 `startJob` 时才真正开始生成**；增强阶段不得启动任何昂贵计算
- 每个 revision 独立返回，Gateway 负责版本管理与过期判定

---

## 4. Job 执行

### 4.1 启动 Job（C-1）

Gateway → 后端（协议待 B-1 确认，以下为候选形态）：

```http
POST http://{worker_host}:{worker_port}/jobs
{
  "job_id": "job_abc",                     // Gateway 生成，后端原样回传
  "session_ref": "bsess_...",              // initSession 时你返回的句柄
  "mode": "coding_to_video",
  "prompt": "<用户已确认的增强 Prompt 全文>",
  "base_asset_path": null,                 // 旧视频修改时给共享存储绝对路径
  "lease_token": "lt_7f2a9b...",           // ★所有回调必须带回★
  "callback_base_url": "http://10.20.30.1:9999/internal",
  "max_runtime_seconds": 10800
}
```

**必须立即返回**（毫秒级），不等待生成：

```json
{ "accepted": true, "backend_job_ref": "bjob_..." }
```

然后在后台启动 Job Executor（独立 Process Group，见 §6.1）。

**重复 `job_id` 的处理**：若该 `job_id` 已在执行 → 返回 `{"accepted": true, "already_running": true}`，
**不要启动第二份计算**（防重复执行，D-5）。

### 4.2 进度上报（C-5）

阶段切换或有新进度时：

```http
POST /internal/jobs/{job_id}/progress
{ "lease_token": "lt_7f2a...",
  "phase": "RENDERING",                    // PREPARING|GENERATING|RENDERING|FINALIZING
  "phase_changed": true,
  "progress_percent": 62,                  // 没有就别给，不要编造
  "detail": { "frames_done": 186, "frames_total": 300 },
  "reported_at": "..." }
```

> **宁可不给 `progress_percent`，也不要给假的。**
> 前端在该字段为 `null` 时会显示不确定进度动画 + 真实耗时，这是可接受的；
> 显示一个与实际不符的百分比会严重损害信任。

### 4.3 失败上报（C-6）

```http
POST /internal/jobs/{job_id}/fail
{ "lease_token": "lt_7f2a...",
  "failure": { "code": "E_RENDER_OOM", "message": "渲染阶段显存不足",
               "phase": "RENDERING", "retryable": false },
  "partial_artifacts": [],
  "failed_at": "..." }
```

失败码建议枚举（可扩展）：`E_PROMPT_INVALID` / `E_SKILL_UNAVAILABLE` / `E_RENDER_OOM` /
`E_RENDER_CRASH` / `E_ENCODE_FAILED` / `E_STORAGE_FULL` / `E_EXTERNAL_API_FAILED` / `E_INTERNAL`。

### 4.4 状态对账查询（C-4, G-5）

Gateway 在 Job 进入 `UNKNOWN` 时会来查。**这是避免昂贵任务被误判的关键接口。**

```http
GET http://{worker_host}:{worker_port}/jobs/{backend_job_ref}
→ 200
{ "status": "running",                     // running|completed|failed|not_found
  "phase": "RENDERING",
  "started_at": "...",
  "asset": { "storage_path": "...", "completion_marker": "..." },  // completed 时
  "failure": { "code": "...", "message": "..." } }                  // failed 时
```

**要求**：

- 即使进程重启过，也应尽量从本地状态文件恢复已知 Job 的信息
- 确实不知道 → 返回 `"status": "not_found"`，**不要返回 500 或超时**
- Gateway 会据此决定 `COMPLETED` / `FAILED` / 继续等待；**沉默是最坏的回答**

### 4.5 进程探活

```http
GET http://{worker_host}:{worker_port}/health
→ 200
{ "process_instance_id": "gpu-node-07:9f3c...",
  "status": "healthy",
  "running_job_refs": ["bjob_..."],
  "uptime_seconds": 86400 }
```

必须是**轻量**接口，不得被繁忙计算阻塞（同 §2.4 的理由）。

---

## 5. Lease（执行租约）

### 5.1 为什么需要

场景：Worker A 短暂网络中断 → Gateway 判定失联 → 但 A 实际仍在计算 →
A 恢复后提交结果。若无保护，一个已被判死（甚至已被用户取消）的任务会把过期结果写成有效结果。

### 5.2 Fencing 规则（E-7）

```text
Gateway 侧维护:
  job_leases(job_id, lease_epoch, lease_token, holder_process_instance_id,
             expires_at, revoked_at)

  lease_epoch 单调递增：续约不变，重新分配才 +1

Worker 侧:
  startJob 时收到 lease_token，之后【每一次】回调都必须携带它：
    · heartbeat     · progress     · complete     · fail     · cancel-ack

Gateway 校验每一次回调:
  lease_token 匹配 ∧ lease_epoch 为当前值 ∧ revoked_at IS NULL
    → 通过：正常处理
    → 失败：返回 409 LEASE_INVALID，【丢弃该上报，不改变 Job 任何状态】
```

### 5.3 Worker 必须响应的失效信号（E-5）

收到以下任一信号，**立即停止计算并放弃结果**：

| 信号 | 来源 |
|---|---|
| 心跳响应 `control = "abort_stale_lease"` | Job 心跳 |
| 心跳响应 `control = "abort_not_owner"` | Job 心跳 / Worker 心跳 directive |
| 任何回调返回 `409 LEASE_INVALID` | 任意回调 |
| 连续心跳失败 ≥ `lease_ttl × 3` | 本地自保 |

「放弃结果」的含义：

```text
✅ 停止计算，杀掉 Job Process Group
✅ 清理临时文件、释放 GPU
❌ 不要调用 /complete
❌ 不要把临时产物重命名为最终产物
❌ 不要写完成标记
```

---

## 6. ⚠️ 取消（最高风险项）

> 任务 9.6 原文：「如果当前 Agent 实现无法停止某个独立生成任务，
> 应在 `BACKEND_REQUIREMENTS.md` 中将其明确列为 **P0 后端改造项**。」
>
> 由于我方未读后端代码，**在此将 F-1 预先列为 P0 后端改造项**。
> 若后端回复「已支持单 Job 取消」，可降级为联调验证项。

### 6.1 每个 Job 必须有独立 Process Group（F-3）

```python
# Python
proc = subprocess.Popen(
    cmd,
    start_new_session=True,      # 等价于 setsid()，创建新 process group
    stdout=..., stderr=...,
)
pgid = os.getpgid(proc.pid)      # 记录下来，取消时用
```

```js
// Node
const child = spawn(cmd, args, { detached: true });
const pgid = child.pid;          // detached 时 pid 即 pgid
```

**为什么**：生成管线涉及 Agent 主进程 → Subagent → 代码生成 → 外部命令 →
Python 脚本 → FFmpeg → 浏览器渲染 → GPU 任务 → 视频编码。
只杀最上层进程，下面的 FFmpeg 和渲染器会变成孤儿继续吃 GPU。
必须能 `killpg` 整树。

**绝对禁止**：为了停止一个 Job 而杀掉承载多个 Session/Job 的共享后端服务进程。

### 6.2 Cancel Token / 协作式取消（F-2）

在 Agent 调用链的每个阶段入口与长循环内部设置检查点：

```python
class Cancelled(Exception): pass

def render_frames(frames, cancel_flag):
    for i, frame in enumerate(frames):
        if cancel_flag.is_set():          # ← 检查点
            raise Cancelled()
        render(frame)
        if i % 10 == 0:
            report_progress(i, len(frames))
```

检查点应覆盖：

```text
✅ 每个 pipeline 阶段的入口
✅ 帧循环 / 批次循环内部
✅ 每次调用 Subagent 前后
✅ 每次发起外部 API 请求前
✅ 等待外部进程时（用带超时的 wait，循环检查 flag）
```

### 6.3 终止序列（F-3, F-4）

```python
def cancel_job(job_id, grace_seconds=60):
    st = jobs[job_id]
    st.cancel_flag.set()                       # 1. 协作式：让检查点自行退出

    deadline = time.time() + min(grace_seconds, 20)
    while time.time() < deadline:              # 2. 等待优雅退出
        if st.proc.poll() is not None: break
        time.sleep(0.5)

    if st.proc.poll() is None:                 # 3. SIGTERM 整个进程组
        os.killpg(st.pgid, signal.SIGTERM)
        deadline = time.time() + 20
        while time.time() < deadline:
            if st.proc.poll() is not None: break
            time.sleep(0.5)

    if st.proc.poll() is None:                 # 4. 升级 SIGKILL
        os.killpg(st.pgid, signal.SIGKILL)
        st.proc.wait(timeout=10)

    cleanup(job_id)                            # 5. 清理（§6.4）
    report_cancel_ack(job_id)                  # 6. 回调（§6.5）
```

### 6.4 资源清理（F-5）

| 项 | 要求 |
|---|---|
| 临时文件 | 删除 Job 临时目录、中间帧、临时音轨 |
| GPU | 释放上下文与显存；确认 `nvidia-smi` 中该进程消失 |
| 子进程 | `pgrep -g <pgid>` 应为空，无孤儿（PPID=1 且属该 Job） |
| 外部 API | 取消在途请求，停止计费 |
| 部分产物 | **默认不对外暴露**。如需保留调试，放独立目录并标记，**绝不写成最终 Asset** |

### 6.5 取消确认回调（F-6）

```http
POST /internal/jobs/{job_id}/cancel-ack
{ "lease_token": "lt_7f2a...",
  "stopped": true,
  "stop_method": "sigterm",                // sigterm|sigkill|cooperative
  "resources_released": true,
  "released": { "gpu": true, "subprocesses": true, "temp_files": true },
  "partial_artifacts": [],
  "stopped_at": "2026-10-23T08:31:12.000Z" }
```

**特殊情况**：若取消到达时任务**已经完成**：

```text
❌ 不要调 cancel-ack
✅ 照常调 /complete 上报产物
   → Gateway 按「完成优先」裁决，用户会看到「任务在取消生效前已完成」+ 视频
```

### 6.6 不得取消的情况（F-1 反向要求）

以下情况后端**绝不能**自行停止任务（任务 9.4）：

```text
❌ 用户关闭网页          ❌ 用户切换标签页
❌ 用户电脑休眠          ❌ 用户暂时没有操作
❌ SSE 连接断开          ❌ 浏览器心跳消失
❌ 用户创建另一个 Session
❌ 某阶段长时间没有新进度，但 Job 心跳仍正常
```

**后端根本不应该知道浏览器的存在。** 取消只能由 Gateway 通过 §6 的协议显式下达。

---

## 7. 视频产物

### 7.1 ⚠️ 完成判定协议（H-2, H-4）

**这是必须由后端明确回答的问题（阻塞项 B-5）。**

用户已确认「文件可以通过绝对路径 + 状态来传送读取，状态是为了避免读取写入时机不正常」，
说明后端**已有**某种机制。我们需要它的**具体约定**：

```text
请后端回答：
  1. 完成标记是什么形式？
     □ 独立的 .done 文件          □ 临时名 → 最终名的原子 rename
     □ manifest / JSON 元数据     □ 数据库/状态服务中的字段
     □ 其他：__________
  2. 状态值有哪些枚举？（writing / done / failed / ...）
  3. 标记文件内是否包含 size / checksum / duration？
  4. 写入顺序是否保证「先写完视频，再写标记」？
  5. 失败时标记如何表达？
```

**Gateway 侧在约定明确前的兼容方案**（`BACKEND_INTEGRATION.md` §5.3）：
优先用 `completion_marker`；为空则回退到「文件大小两次采样相同」的保守判定。
**后者在慢速共享存储上可能误判，所以请务必明确 B-5。**

**铁律**：共享目录里出现文件 ≠ 任务完成。Gateway 绝不会因为看到文件就宣布完成。

### 7.2 完成上报（H-3, H-5）

```http
POST /internal/jobs/{job_id}/complete
{ "lease_token": "lt_7f2a...",
  "asset": {
    "kind": "video",
    "storage_path": "/mnt/shared/cvw/outputs/job_abc/final.mp4",
    "completion_marker": "/mnt/shared/cvw/outputs/job_abc/.done",
    "mime_type": "video/mp4",
    "size_bytes": 19293696,
    "duration_ms": 10200,
    "width": 1920, "height": 1080, "frame_rate": 24,
    "checksum": "sha256:7f2a...",          // 强烈建议提供
    "derived_from_asset_id": null
  },
  "finished_at": "2026-10-23T08:54:00.000Z" }
```

Gateway 会校验：租约有效 → Job 非终态 → 取消竞争裁决 → **产物完整性校验** → 置 `COMPLETED`。
任一失败都不会标记完成；产物校验失败会标为 `FAILED(ASSET_VERIFICATION_FAILED)`。

### 7.3 旧视频修改（H-6）

```text
Session 内已生成视频 A（storage_path_A）
  → 用户提出修改
  → Gateway 调 startJob，带 base_asset_path = storage_path_A
  → 后端基于 A 生成 B，写入【新的】storage_path_B
  → complete 时 derived_from_asset_id 指向 A 的 asset_id
```

**铁律**：**绝不覆盖原文件**。A 与 B 都必须长期可访问（任务 3.2）。

### 7.4 文件权限（I-4）

Gateway 需要**读取**共享存储上的产物（用于完整性校验与下载服务）。
请确认 Gateway 运行用户对输出目录有读权限，并告知挂载点（阻塞项 B-18）。

---

## 8. 部署与优雅下线（G-7）

| 场景 | 要求 |
|---|---|
| Worker 更新部署 | **Drain**：收到 `drain` 指令后停止接新 Session/Job，等现有 Job 跑完或由管理员显式终止，然后退出 |
| 有运行任务时 | **绝不**直接无差别杀进程 |
| 进程重启 | `process_instance_id` **必须变更**（§2.1） |
| 重启后 | 旧 Session 会被 Gateway 标为 `PROCESS_LOST`，**不要尝试恢复旧 Session 上下文** |
| 重启后的遗留进程 | 启动时扫描并清理属于本 Worker 的遗留 Job Process Group（防孤儿） |
| Gateway 重启 | 对 Worker 透明。心跳会短暂失败 → **按 §2.3 退避重试，不要停止计算** |

---

## 9. 安全

### 9.1 内部认证（I-1）

```text
方式（待 B-19 定）：
  □ mTLS 客户端证书（推荐）
  □ X-Internal-Token 共享密钥 + IP 白名单

要求：
  ✅ /internal/* 仅内网可达，不暴露公网
  ✅ Token 长度 ≥ 32，从环境变量读取，不硬编码
  ✅ Gateway 启动时校验配置，不合规则拒绝启动
  ✅ 普通用户绝对不能调用心跳 / 取消控制接口
```

### 9.2 后端不做的事（I-2, I-3, I-5）

```text
❌ 不做用户鉴权          → Gateway 已校验
❌ 不做白模权限判断      → Gateway 在 4 个点校验，后端按传入 mode 执行即可
❌ 不做 Job 归属校验     → Gateway 已校验
❌ 不直接对浏览器暴露任何接口
❌ 不向浏览器返回共享存储路径
```

---

## 10. 验收标准与测试方法

| ID | 测试 | 方法 | 通过标准 |
|---|---|---|---|
| T-1 | 长任务 | 跑一个真实 1~2 小时 Job | 全程心跳不断；不受任何 HTTP 超时影响；最终正常完成 |
| T-2 | 心跳不被阻塞 | 在最重渲染阶段观察心跳间隔 | 心跳间隔抖动 < `lease_ttl / 2` |
| T-3 | 停滞不误杀 | 构造 30 分钟无进度但心跳正常的阶段 | 任务**不被取消**，Gateway 只发 `stalled` 事件 |
| T-4 | **单 Job 取消** | 同进程跑 2 个 Job，取消其中 1 个 | 被取消的停止；**另一个不受任何影响**；共享服务进程存活 |
| T-5 | 子进程清理 | 取消后检查 | `pgrep -g <pgid>` 为空；`nvidia-smi` 无残留；临时文件已删 |
| T-6 | 重复取消 | 对同一 Job 连发 3 次取消 | 幂等，只有一次实际终止，状态一致 |
| T-7 | 取消与完成竞争 | 在产物写完瞬间下达取消 | 后端给出**唯一一致**的结果（要么 complete 要么 cancel-ack，不能都发） |
| T-8 | 租约 fencing | 用过期 `lease_token` 调 `/complete` | Gateway 返回 409；后端收到后停止且不重试提交 |
| T-9 | 失效信号响应 | 心跳响应注入 `abort_stale_lease` | Worker 在一个心跳周期内停止计算 |
| T-10 | 进程 ID 变更 | 重启 Worker 进程 | `process_instance_id` 与重启前不同 |
| T-11 | 反向对账 | 让 Worker 上报一个 Gateway 不认识的 `job_id` | 收到 `abort_not_owner` 后停止该任务 |
| T-12 | 对账接口 | 对运行中 / 已完成 / 不存在的 Job 分别查询 | 三种情况都能明确返回，无超时、无 500 |
| T-13 | 产物完成判定 | 构造「文件已出现但未写完」的状态 | Gateway 不会判定完成；用户不会下载到半写入文件 |
| T-14 | 不覆盖原文件 | 基于 A 生成 B | A 文件内容不变，B 为新文件 |
| T-15 | Drain | 有 1 个 Job 运行时下发 `drain` | 不接新任务；现有 Job 跑完；然后退出 |
| T-16 | 网络中断自保 | 断开 Worker → Gateway 网络 5 分钟后恢复 | 计算未停止；恢复后心跳重连；若租约已撤销则放弃结果 |
| T-17 | 浏览器无关 | 提交任务后关闭所有浏览器 | 后端毫无感知，任务正常完成 |

---

## 11. Backend Implementation Checklist

> 按 P0 / P1 排列的具体后端开发工作。
> P0 = 不做则 V1 无法上线；P1 = 影响体验但可先用保守方案。

### P0

| # | 工作项 | 对应需求 | 验收 |
|---|---|---|---|
| **P0-1** | 实现 `process_instance_id` 生成：启动时 `{worker_id}:{uuid4}`，重启必变，不用 PID | A-3 | T-10 |
| **P0-2** | 实现进程注册 `POST /internal/processes/register`，接收并应用 Gateway 下发的心跳配置 | E-1 | 注册成功，配置生效 |
| **P0-3** | 实现 Worker 心跳（每 10~15s），**必含 `running_job_ids`** | E-1, E-6 | T-11 |
| **P0-4** | 实现 Job 心跳（每 15~30s），携带 `lease_token`、`phase`、`last_progress_at` | E-2 | T-1 |
| **P0-5** | **心跳移入独立 Supervisor 线程/进程**，与渲染计算解耦 | E-3 | T-2 |
| **P0-6** | 实现心跳响应的 5 种 `control` 指令处理 | E-5 | T-9 |
| **P0-7** | 实现心跳错误处理：409 停止 / 5xx 与网络错误**绝不停止**、指数退避 | E-5 | T-16 |
| **P0-8** | 实现连续失败 ≥ `lease_ttl×3` 的自保停止 | E-5 | T-16 |
| **P0-9** | **每个 Job 独立 Process Group**（`setsid` / `detached`），记录 pgid | F-3 | T-5 |
| **P0-10** | **Agent 调用链植入 Cancel Token 与各阶段检查点** | F-2 | T-4 |
| **P0-11** | **实现单 Job 取消**：协作式 → SIGTERM 进程组 → 宽限 → SIGKILL | F-1 ⚠️ | **T-4** |
| **P0-12** | 取消后资源清理：GPU、子进程、临时文件、外部 API | F-5 | T-5 |
| **P0-13** | 实现取消确认回调 `cancel-ack`，含 `resources_released` 明细 | F-6 | T-6 |
| **P0-14** | 实现「已取消 Job 不得提交最终 Asset」的本地防护 | F-7 | T-8 |
| **P0-15** | 实现 `startJob`：立即返回，后台启动；重复 `job_id` 不重复执行 | C-1, D-5 | 幂等验证 |
| **P0-16** | 实现 `complete` 回调，含完整 Asset 元数据与 `completion_marker` | H-3, H-5 | T-13 |
| **P0-17** | 实现 `fail` 回调，含结构化 `failure.code` | C-6 | 错误可追溯 |
| **P0-18** | **明确并文档化产物完成判定协议**（回答 B-5 的 5 个问题） | H-4 ⚠️ | T-13 |
| **P0-19** | 实现 Job 状态对账查询接口 | C-4, G-5 | T-12 |
| **P0-20** | 实现轻量 `/health` 探活接口，不被计算阻塞 | — | 繁忙时仍秒回 |
| **P0-21** | 实现结构化意图识别（5 类枚举 + `out_of_scope` 结构化提示） | IP-1, IP-2 | 分类准确率人工评估 |
| **P0-22** | 实现 Prompt 增强与基于修改意见的多轮再增强 | IP-3, IP-4 | 多轮修订可用 |
| **P0-23** | 实现按 `mode` 切换 Skill 的会话创建 | A-5 | 两模式均可用 |
| **P0-24** | 实现内部认证（mTLS 或共享密钥），`/internal` 不暴露公网 | I-1 | 安全评审 |
| **P0-25** | 实现 Drain 优雅下线 | G-7 | T-15 |
| **P0-26** | 启动时清理本 Worker 的遗留 Job Process Group | G-7 | 无孤儿 |
| **P0-27** | 提供后端机器清单：IP:Port、支持 mode、并发容量（回答 B-9） | D-3 | 配置可用 |
| **P0-28** | 提供真实耗时分布 P50/P95/P99 与各阶段最长无进度间隔（回答 B-8） | — | 参数可定档 |

### P1

| # | 工作项 | 对应需求 | 说明 |
|---|---|---|---|
| **P1-1** | 上报真实 `progress_percent` | B-3（阻塞项）/ 任务 7.4 | 不能提供则省略，**不要编造** |
| **P1-2** | 细化 `phase` 枚举并上报阶段切换 | C-5 | 无进度百分比时，阶段是主要信息源 |
| **P1-3** | 产物 `checksum` 计算与上报 | H-3 | 提升完整性校验可靠性 |
| **P1-4** | 支持基于 Asset 的旧视频修改 | H-6 | T-14 |
| **P1-5** | 支持同 Session 生成期间的并发对话（若可行） | B-14 | 不支持则 UI 禁用输入框 |
| **P1-6** | 上报 GPU/CPU/磁盘资源指标 | E-1 | 用于调度决策与容量展示 |
| **P1-7** | 部分产物保留策略（调试用，隔离目录） | F-5 | 绝不写成最终 Asset |
| **P1-8** | 本地 Job 状态文件持久化，提升重启后对账能力 | G-5 | 减少 `UNKNOWN` 停留时间 |

### 开发顺序建议

```text
第 1 批（打通基础链路）: P0-1, P0-2, P0-3, P0-20, P0-24, P0-27
第 2 批（Job 执行）     : P0-15, P0-16, P0-17, P0-18, P0-21, P0-22, P0-23
第 3 批（心跳与租约）   : P0-4, P0-5, P0-6, P0-7, P0-8, P0-19
第 4 批（取消, 最难）   : P0-9, P0-10, P0-11, P0-12, P0-13, P0-14
第 5 批（运维）         : P0-25, P0-26, P0-28
第 6 批                 : P1-*
```

> 第 4 批是**风险最高**的部分，建议尽早评估 P0-10 与 P0-11 的改造量。
> 若现有 Agent 架构无法支持单 Job 取消，请尽早反馈，以便调整 V1 范围或排期。

---

## 12. 明确不需要后端实现的功能

为避免误解（任务 19 一致性要求），以下**不在后端范围**：

| 项 | 原因 |
|---|---|
| **Reference 上传**（图片/视频/音频） | V1 不支持（任务 3.1）。后续版本再议 |
| 用户 / 邀请码 / 权限系统 | Gateway + Web 职责 |
| Job 状态持久化与幂等 | Gateway 职责 |
| 亲和性队列与并发控制 | Gateway 职责 |
| SSE / 事件推送给浏览器 | Gateway 职责 |
| 浏览器 Presence / localStorage 恢复 | 前端职责，**后端不应知道浏览器的存在** |
| 跨进程自动恢复运行中的 Job | V1 不做（任务 9.3：Session 固定进程） |
| 自动重试昂贵任务 | 任务 9.3 禁止；重试由用户显式发起 |
| 向浏览器直接暴露接口或共享存储路径 | 架构禁止 |
