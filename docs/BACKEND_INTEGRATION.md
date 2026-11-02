# BACKEND_INTEGRATION — 后端对接与能力调查

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
> 本文档记录**已确认的事实**与**待确认的未知项**，并给出 Gateway 侧的隔离方案。
> 原则（任务 1.2）：设计文档可以记录未知项，但不能为了补齐信息而擅自扩大权限。

---

## 1. 调查范围与边界

### 1.1 授权范围内实际可见的内容

| 项 | 结果 |
|---|---|
| 授权工作区 | `/mnt/afs_toolcall/codevideo/workspace` |
| 工作区原有内容 | 仅 `task.txt`（任务书），**无既有工程、无 Git 仓库** |
| 后端代码 | **不在授权范围内**，未访问、未读取 |
| 后端配置/密钥 | 未访问 |
| 其他用户目录 | 未访问（`/mnt/afs_toolcall/` 下 136 个目录按任务 1.2 条回避） |

### 1.2 后端信息的来源

本文档中标记为 `CONFIRMED` 的后端事实，**全部来自用户口头答复**，而非代码审阅。
标记为 `TO_CONFIRM` 的项，需后端团队书面回复后才能升级。

> 这是本文档最重要的声明：**我们尚未读过后端一行代码**。
> 任何「后端应该这样实现」的推测都已明确标注，不得被当作已验证的事实。

---

## 2. 已确认的后端事实（用户答复）

| ID | 事实 | 来源 | 状态 |
|---|---|---|---|
| F-1 | 后端是**远程机器**，通过 **IP + Port** 访问 | 用户答复 | `CONFIRMED` |
| F-2 | 存在**共享存储**，所有 Worker 与 Gateway 可见 | 用户答复 | `CONFIRMED` |
| F-3 | 文件通过**绝对路径 + 状态**传送读取；状态用于避免读写时机不正常 | 用户答复 | `CONFIRMED` |
| F-4 | 可在协议中先用**远端机器 IP+Port 配置多台后端机器** | 用户答复 | `CONFIRMED` |
| F-5 | 命令与传输可用**局域网内的技术协议** | 用户答复 | `CONFIRMED` |
| F-6 | 两个模式通过 `mode` 切换 **Skill**，共用同一后端 | 任务书 §0 | `CONFIRMED` |
| F-7 | Session **固定** Worker / Process，不切换机器与进程 | 任务书 §5 | `CONFIRMED` |
| F-8 | 单次生成任务可能运行 **1~2 小时甚至更长** | 任务书 §0 | `CONFIRMED` |
| F-9 | 存在**多台**后端机器 | 任务书 §10 | `CONFIRMED` |
| F-10 | 两个模式**共享生成并发** | 任务书 §10 | `CONFIRMED` |

### 2.1 F-3 的重要推论

用户答复中的「**状态是为了避免读取写入时机不正常**」，正是任务 13.1 所要求的
「不能因为共享目录中出现文件就立刻宣布完成」的后端侧对应机制。

这意味着后端**已经有**某种完成标记机制。我们需要的是它的**具体约定**（阻塞项 B-5）：

- 是独立的 `.done` 标记文件？
- 是临时名 → 最终名的原子 `rename`？
- 是 manifest / JSON 元数据文件？
- 是否包含 checksum？
- 状态值有哪些（writing / done / failed）？

在约定明确前，Gateway 的产物校验按「**双重校验**」设计（见 §5.3），
既兼容标记文件也兼容原子 rename。

---

## 3. 平台侧已确认的环境事实（本机实测）

| 项 | 结果 | 验证方式 |
|---|---|---|
| Node.js | 系统默认 `v16.20.2`（过旧）；`~/.nvm/versions/node/v22.23.4` 可用 | `nvm use 22 && node -v` |
| npm | 10.9.9（Node 22 下）；registry = `registry.npmmirror.com` | `npm -v` |
| PostgreSQL | **用户确认可用**；本机 5432 未监听，需远端连接串 | `/dev/tcp` 探测 + 用户答复 |
| Redis | **用户确认可用**；本机 6379 未监听，需远端连接串 | 同上 |
| Gateway 形态 | **独立 Node 服务**，Next.js 只做前端 | 用户答复 |
| 调试端口 | **9999**（已申请，留给 Phase 2 前端调试） | 用户答复 |
| 网络出口 | HTTP 代理 `http://10.120.0.246:7890`，需 `--proxytunnel` | curl 实测 |
| 系统权限 | **无 root、无 sudo**，`apt` 被 dpkg 锁拒绝（uid 10207） | `apt-get install` 实测 |
| 编译工具 | gcc 11.4 / g++ / make / cmake 可用 | `which` |
| 缺失二进制 | `psql` / `redis-cli` / `docker` / `ffmpeg` 均无 | `which` |
| 主机资源 | 128 vCPU / 2015 GB RAM（仅跑 Web+Gateway，生成在远端） | `nproc` / `free` |

> 无 root 意味着本地若需 Postgres/Redis 实例做开发，只能走**用户态方案**
> （npm 的 `embedded-postgres` 已验证可装出 PostgreSQL 18.4 真实二进制）。
> 但生产应使用用户提供的远端实例（阻塞项 B-7）。

---

## 4. 待确认的后端能力（给后端团队的问题清单）

> 下表每一项都会影响 Gateway 的具体实现。请后端逐项回复。
> `API_CONTRACT.md` §9.2 有同一份清单的接口视角版本。

### 4.1 P0 — 不回复则无法开发

| ID | 问题 | 为何是 P0 | 状态 |
|---|---|---|---|
| **B-1** | Gateway → 后端的**实际调用协议**：路径、请求体、响应体、鉴权方式？是 HTTP/REST、gRPC 还是消息队列？ | `BackendAdapter` 的全部实现依赖于此 | `TO_CONFIRM` |
| **B-2** | 能否**只停止一个 Job** 而不影响同进程的其他 Session/Job？当前实现是否做得到？若不能，改造量多大？ | 任务 9.6 明确：不能为停一个 Job 杀掉承载多 Session 的共享进程。**若不支持，取消功能无法真正实现** | `TO_CONFIRM` ⚠️ |
| **B-5** | 产物完成标记的**具体约定**？（`.done` / 原子 rename / manifest / checksum / 状态值枚举） | 任务 13.1：决定何时可宣布 `asset.ready`；错误判定会让用户下载到半写入文件 | `TO_CONFIRM` ⚠️ |
| **B-7** | 远端 `DATABASE_URL` 与 `REDIS_URL` | Phase 2 无法启动 | `TO_CONFIRM` |
| **B-9** | 后端机器清单：IP:Port、各进程支持的 mode、`max_concurrent_jobs`、`max_sessions` | 调度器配置与全局并发上限 | `TO_CONFIRM` |

### 4.2 P1 — 影响设计质量但可先用保守默认值

| ID | 问题 | 影响 | 保守默认 | 状态 |
|---|---|---|---|---|
| **B-3** | 能否上报真实进度百分比？若只能给阶段，阶段枚举是什么？ | UI 显示进度条 vs 仅显示耗时 | 假设**不能**，UI 只显示耗时与阶段，不伪造百分比 | `TO_CONFIRM` |
| **B-4** | `process_instance_id` 由谁生成？重启是否必变？是否可能复用 OS PID？ | Session 固定进程的正确性 | 要求 Worker 启动时生成 `{worker_id}:{uuid}` | `TO_CONFIRM` |
| **B-6** | `mode=blockout_3d` 在后端如何切 Skill？请求参数还是不同端点？ | 权限校验点与路由 | 假设为请求参数 | `TO_CONFIRM` |
| **B-8** | 单次生成真实耗时分布（P50/P95/P99）？各阶段最长无进度间隔？ | 心跳/超时/停滞阈值定档 | `max_runtime=3h`，`stall_warn=10min`（**必须压测后调整**） | `TO_CONFIRM` |
| **B-11** | 心跳能否跑在独立线程/Supervisor？渲染阻塞时会断心跳吗？ | `lease_ttl` 取值；防误判失联 | `lease_ttl=120s`（≥4× 心跳间隔） | `TO_CONFIRM` |
| **B-12** | 能否把每个 Job 放入独立 **Process Group**（`setsid`）？ | 取消能否杀干净子进程树 | 列为后端 P0 改造项 | `TO_CONFIRM` |
| **B-13** | Agent 调用链是否已有 **Cancel Token / 协作式取消检查点**？ | 同上 | 列为后端 P0 改造项 | `TO_CONFIRM` |
| **B-14** | 同一 Session 生成期间能否并发处理其他对话消息？ | UX 是禁用输入框还是允许排队 | **保守**：禁用输入框（`SESSION_BUSY`） | `TO_CONFIRM` |
| **B-15** | 意图识别（5 类）是否已由后端提供？还是需要新开发？ | Prompt 工作流能否落地 | 假设需新增 | `TO_CONFIRM` |
| **B-16** | Prompt 增强与多轮修订是否已有能力？ | 同上 | 假设需新增 | `TO_CONFIRM` |
| **B-17** | 旧视频修改（基于 Asset A 生成 B）后端如何接收基准视频？共享存储路径？ | 任务 3.2 的实现方式 | 假设传共享存储绝对路径 | `TO_CONFIRM` |

### 4.3 平台侧问题（需用户确认）

| ID | 问题 | 状态 |
|---|---|---|
| **B-10** | 是否授权在 workspace 内 `git init` 建立版本管理？ | `TO_CONFIRM` |
| **B-18** | 共享存储在 Gateway 机器上的**挂载点**是什么？Gateway 是否有读权限（用于产物校验与下载服务）？ | `TO_CONFIRM` |
| **B-19** | 内部 API 的鉴权方式选择：mTLS 还是共享密钥 + IP 白名单？ | `TO_CONFIRM` |

---

## 5. Gateway 侧的隔离方案

后端协议未定，因此**全部耦合收敛于一个模块**：`apps/gateway/src/backend/`。

### 5.1 BackendAdapter 接口

```ts
/** 后端协议的唯一耦合点。协议确定后只改这里的实现，不触碰其他模块。 */
export interface BackendAdapter {
  /** 创建会话上下文，按 mode 选择 Skill。对应 B-1 / B-6 */
  initSession(p: ProcessRef, s: SessionInit): Promise<SessionHandle>;

  /** 发送用户消息，返回结构化意图。对应 B-15 */
  sendMessage(p: ProcessRef, s: SessionRef, m: UserMessage): Promise<IntentResult>;

  /** Prompt 增强。对应 B-16 */
  enhancePrompt(p: ProcessRef, s: SessionRef, raw: string): Promise<PromptRevisionDraft>;

  /** 按修改意见再增强。对应 B-16 */
  revisePrompt(p: ProcessRef, s: SessionRef, base: RevisionRef, note: string): Promise<PromptRevisionDraft>;

  /** 启动生成，携带 lease_token。对应 B-1 / B-17 */
  startJob(p: ProcessRef, job: JobSpec, lease: LeaseToken): Promise<StartAck>;

  /** 取消单个 Job，不影响同进程其他任务。对应 B-2 ⚠️P0 */
  cancelJob(p: ProcessRef, jobRef: string, reason: CancelReason, graceSeconds: number): Promise<CancelAck>;

  /** 对账：查询 Job 真实状态。Job 进入 UNKNOWN 时调用 */
  probeJob(p: ProcessRef, jobRef: string): Promise<JobTruth>;

  /** 探活：Worker 心跳缺失时调用 */
  probeProcess(p: ProcessRef): Promise<ProcessHealth>;
}

export type ProcessRef = {
  workerId: string;
  processInstanceId: string;
  host: string;   // 来自配置，不散落在业务代码中
  port: number;
};
```

### 5.2 两份实现

| 实现 | 用途 | 启用方式 |
|---|---|---|
| `HttpBackendAdapter` | 真实后端。按 B-1 的回复填充 | `BACKEND_MODE=real` |
| `MockBackendAdapter` | Phase 2 开发与测试。可配置任意时长、阶段序列、故障注入、取消行为 | `BACKEND_MODE=mock` |

**Mock 与真实数据不混用**（任务 1.3）：

- 由**启动期**环境变量决定，运行期不可切换
- Mock 模式下 UI 显示明显水印条「Mock 后端模式 — 数据非真实」
- Mock 产生的 Asset 带 `is_mock=true` 标记，真实环境启动时拒绝加载 Mock 数据

Mock Worker 必须支持的故障注入（用于 `IMPLEMENTATION_PLAN.md` 的测试矩阵）：

| 注入项 | 对应测试 |
|---|---|
| 可配置总时长（支持「加速时钟」，把 2h 压缩成 2min） | 测试 A |
| 心跳正常但长时间无进度 | 测试 E |
| 心跳突然停止 | 测试 F |
| 取消请求不 ack（宽限超时） | 取消失败路径 |
| 完成与取消同时发生 | 测试 I |
| 完成事件丢失（只写产物不回调） | 11.11 对账补判 |
| 产物写一半退出 | 11.11 / 测试 P |
| 返回过期 `lease_token` | 测试 F / 不变式 I-9 |
| 上报 DB 不认识的 `running_job_ids` | 孤儿 Job 反向对账 |

### 5.3 产物校验的双重兼容设计（B-5 未定前的保守方案）

```text
Gateway 收到 complete{asset} 后，依次尝试：

1. 若 asset.completion_marker 非空
     → 检查该标记文件存在且可读
     → 若标记内含 JSON（size/checksum/duration）则交叉校验

2. 若 completion_marker 为空（后端用原子 rename）
     → 检查 storage_path 文件存在
     → 检查文件大小 == asset.size_bytes（防半写入）
     → 等待 500ms 再测一次大小，两次相同才认为写入已停止

3. 通用校验（两种方式都执行）
     → size_bytes > 0
     → 若提供 checksum → 校验（大文件可抽样或后台异步校验）
     → 探测容器元数据，确认 duration/分辨率与上报一致

全部通过 → Asset VERIFYING → READY → Job COMPLETED
任一失败 → Asset CORRUPT → Job FAILED(ASSET_VERIFICATION_FAILED)
```

> 第 2 步的「两次测大小」是在没有完成标记时的兜底，**不是推荐方案**。
> 强烈建议后端明确 B-5，否则该兜底在慢速共享存储上可能误判。

### 5.4 配置集中管理（任务 1.3）

后端地址**只出现在 Gateway 的配置模块**，前端代码中不存在任何后端 IP/Port：

```ts
// apps/gateway/src/config/index.ts — 启动时 Zod 校验，失败则拒绝启动
export const config = configSchema.parse({
  gateway: { port: env.GATEWAY_PORT ?? 9999, host: env.GATEWAY_HOST ?? '0.0.0.0' },
  db:      { url: env.DATABASE_URL },                    // B-7
  redis:   { url: env.REDIS_URL },                       // B-7
  internalAuth: { token: env.INTERNAL_API_TOKEN },       // 长度 < 32 则拒绝启动
  sharedStorage: { mountPath: env.SHARED_STORAGE_PATH }, // B-18
  backend: {
    mode: env.BACKEND_MODE,                              // 'real' | 'mock'
    workers: JSON.parse(env.BACKEND_WORKERS ?? '[]'),    // B-9
  },
  timeouts: { /* F.1 全部参数，见 LONG_RUNNING_JOBS.md */ },
});
```

`BACKEND_WORKERS` 示例（待 B-9 填真实值）：

```json
[
  { "worker_id": "gpu-node-07", "host": "10.20.30.7", "port": 18080,
    "supported_modes": ["coding_to_video", "blockout_3d"],
    "max_sessions": 8, "max_concurrent_jobs": 2 },
  { "worker_id": "gpu-node-08", "host": "10.20.30.8", "port": 18080,
    "supported_modes": ["coding_to_video"],
    "max_sessions": 8, "max_concurrent_jobs": 2 }
]
```

> 注意：这是**引导配置**。进程的真实状态以 `POST /internal/processes/register`
> 与心跳为准——配置里写了但没注册上来的进程，不参与调度。

---

## 6. 能力映射总表

> 「我们需要的能力」→「后端当前状态」→「谁来做」

| 能力 | 需求出处 | 后端状态 | 谁实现 | 优先级 |
|---|---|---|---|---|
| 按 mode 切 Skill 创建会话 | 任务 5 | `TO_CONFIRM` (B-6) | 后端 | P0 |
| Session 固定进程路由 | 任务 5 | `CONFIRMED` (F-7) | 后端已有 + Gateway 记录绑定 | P0 |
| 结构化意图识别（5 类） | 任务 6 | `TO_CONFIRM` (B-15) | 后端 | P0 |
| Prompt 增强 | 任务 6 | `TO_CONFIRM` (B-16) | 后端 | P0 |
| Prompt 多轮修订 | 任务 6 | `TO_CONFIRM` (B-16) | 后端 | P0 |
| 异步启动生成 Job | 任务 7.1 | `TO_CONFIRM` (B-1) | 后端 | P0 |
| Job 状态持久化 | 任务 7.3 | — | **Gateway** | P0 |
| Idempotency Key | 任务 11.1 | — | **Gateway** | P0 |
| Worker/Process 心跳 | 任务 9.1 | `MISSING`（推测需新增） | 后端 | P0 |
| Job 心跳 / Lease 续约 | 任务 9.1 | `MISSING`（推测需新增） | 后端 | P0 |
| 心跳不被计算阻塞 | 任务 9.2 | `TO_CONFIRM` (B-11) | 后端 | P0 |
| **单 Job 取消** | 任务 9.6 | `TO_CONFIRM` (B-2) ⚠️ | 后端 | **P0** |
| 独立 Process Group | 任务 9.6 | `TO_CONFIRM` (B-12) | 后端 | P0 |
| Cancel Token / 检查点 | 任务 9.6 | `TO_CONFIRM` (B-13) | 后端 | P0 |
| 子进程树终止 + 资源清理 | 任务 9.6 / 9.7 | `TO_CONFIRM` (B-12) | 后端 | P0 |
| Job 状态对账查询 | 任务 9.3 | `MISSING`（推测需新增） | 后端 | P0 |
| 进程探活 | 任务 9.1 | `TO_CONFIRM` (B-1) | 后端 | P0 |
| 产物完成标记 | 任务 13.1 | `CONFIRMED` 有机制 (F-3)，**约定待定** (B-5) | 后端说明 + Gateway 校验 | **P0** |
| 共享存储产物读取 | 任务 13 | `CONFIRMED` (F-2) | Gateway（需挂载，B-18） | P0 |
| 亲和性队列 + 并发控制 | 任务 10 | — | **Gateway** | P0 |
| Watchdog / 故障检测 | 任务 9 | — | **Gateway** | P0 |
| 事件持久化 + SSE | 任务 12 | — | **Gateway** | P0 |
| 用户/邀请码/权限 | 任务 4 | — | **Gateway + Web** | P0 |
| 真实进度百分比 | 任务 7.4 | `TO_CONFIRM` (B-3) | 后端 | P1 |
| 会话期并发对话 | 任务 11.4 | `TO_CONFIRM` (B-14) | 后端 | P1 |
| 旧视频修改（基于 Asset） | 任务 3.2 | `TO_CONFIRM` (B-17) | 后端 | P1 |
| Reference 上传 | — | **V1 不做**（任务 3.1） | — | 不做 |

**统计**：P0 能力 23 项中，**后端侧 13 项**（其中 5 项推测为 `MISSING` 需新开发），**Gateway 侧 10 项**。

---

## 7. 联调计划（Phase 3 预备）

| 阶段 | 内容 | 前置 |
|---|---|---|
| I-1 | 后端回复 B-1/B-5/B-9，Gateway 实现 `HttpBackendAdapter` | B-1, B-5, B-9 |
| I-2 | 单机单进程打通：创建 Session → 发消息 → 增强 → 确认 → 短任务完成 | I-1 |
| I-3 | 心跳联调：Worker 注册、Worker 心跳、Job 心跳、租约续约 | I-2, B-11 |
| I-4 | 长任务验证：真实 1~2 小时任务全程状态可查、不受 HTTP 超时影响 | I-3, B-8 |
| I-5 | 取消联调：验证 GPU 停止、子进程清理、槽位释放、无残留 | I-3, **B-2/B-12/B-13** |
| I-6 | 多机并发：多 Worker 注册、亲和性队列、全局并发上限 | I-3, B-9 |
| I-7 | 故障演练：Worker crash、Scheduler 重启、网络分区、取消竞争 | I-6 |
| I-8 | 参数定档：按实测调整心跳/超时/停滞/最大运行时间 | I-4, I-7, B-8 |

> I-5 是**风险最高**的环节。若 B-2 回复为「当前不支持单 Job 取消」，
> 则取消功能需后端排期改造，`IMPLEMENTATION_PLAN.md` 中该项不得标记为完成
> （任务 19 一致性要求）。

---

## 8. 本文档的诚实性声明

| 声明 | 说明 |
|---|---|
| 未读后端代码 | 本次 Phase 1 未访问任何后端工程，`CONFIRMED` 项均来自用户口头答复 |
| 未访问其他服务器 | 未连接任何后端 IP:Port |
| 未修改任何后端资源 | 无写操作 |
| 推测已标注 | 所有「后端应该如何实现」的内容标为 `TO_CONFIRM` 或「推测」，未冒充事实 |
| 上游仓库已核实 | `vercel/ai-chatbot`(Apache-2.0) 与 `openai/openai-sora-sample-app`(MIT) 的 LICENSE 与 package.json 经代理实测拉取；但 `ai-chatbot` 的组件文件结构**未逐一核实**（main 分支已重构，旧路径 404），Phase 2 开工前需重新 clone 核对 |
