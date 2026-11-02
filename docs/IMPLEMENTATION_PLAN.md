# IMPLEMENTATION_PLAN — 开发计划

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
> **Phase 1 已完成并在此暂停，等待确认后才进入 Phase 2。**

---

## 1. 阶段划分

| 阶段 | 内容 | 状态 |
|---|---|---|
| **Phase 1** | 方案与接口对齐（文档） | ✅ **已完成，等待确认** |
| **Phase 2** | 工程开发（前端 + Gateway + Mock 后端） | ⏸ 未开始 |
| **Phase 3** | 真实后端联调与部署 | ⏸ 未开始 |

---

## 2. Phase 1 交付清单

| # | 文件 | 行数 | 内容 |
|---|---|---|---|
| 1 | `docs/ARCHITECTURE.md` | 298 | 系统全景、技术选型、模块划分、安全、部署、后端隔离 |
| 2 | `docs/PRODUCT_UX.md` | 483 | 页面布局、测试站点提示、Prompt Review、任务卡片各状态、边界交互、视觉规范 |
| 3 | `docs/API_CONTRACT.md` | 1003 | 公开 API + 内部 Worker API + 待后端确认的出向调用清单 |
| 4 | `docs/BACKEND_INTEGRATION.md` | 325 | 已确认事实 vs 待确认项、Adapter 隔离、能力映射、联调计划 |
| 5 | `docs/BACKEND_REQUIREMENTS.md` | 923 | 可交付后端 Agent 的实现说明 + P0/P1 Checklist |
| 6 | `docs/LONG_RUNNING_JOBS.md` | 806 | 长任务架构、浏览器恢复、心跳、取消、异常恢复、参数、7 个时序图 |
| 7 | `docs/STATE_MACHINE.md` | 557 | 13 张表 + 6 个状态机 + 10 条跨状态机不变式 |
| 8 | `docs/IMPLEMENTATION_PLAN.md` | 本文件 | 开发计划与测试矩阵 |
| 9 | `openapi/openapi.yaml` | 1744 | OpenAPI 3.1，39 路径 / 40 操作 / 32 Schema，已通过解析与 $ref 完整性校验 |
| 10 | `TASK_PLAN.md` | — | 进度与阻塞项，供 Agent 中断后恢复 |

---

## 3. Phase 2 开发计划

### 3.1 前置条件（阻塞项，必须先解决）

| ID | 阻塞内容 | 阻塞范围 | 责任方 |
|---|---|---|---|
| **B-7** | 远端 `DATABASE_URL` / `REDIS_URL` | **整个 Phase 2 无法启动** | 用户 |
| **B-18** | 共享存储在 Gateway 机器的挂载点与读权限 | 产物校验、播放、下载 | 用户 |
| **B-19** | 内部 API 鉴权方式（mTLS vs 共享密钥） | 内部 API 实现 | 用户/后端 |
| **B-10** | 是否授权 `git init` | 版本管理 | 用户 |
| B-1 | 后端实际调用协议 | `HttpBackendAdapter`（Mock 可先行） | 后端 |
| B-5 | 产物完成标记约定 | 产物校验（有兜底方案） | 后端 |
| B-9 | 后端机器清单 | 调度器配置（Mock 可先行） | 后端 |

> **Phase 2 的 M1~M5 可在 Mock 后端下先行**，只需解决 B-7、B-18、B-19、B-10。
> B-1/B-5/B-9 是 Phase 3 联调的前置。

### 3.2 里程碑

#### M0 — 工程骨架（1~2 天）

```text
□ nvm 固化 Node 22（.nvmrc），pnpm workspace
□ monorepo 骨架: apps/web, apps/gateway, packages/contracts, packages/db, mocks/
□ TypeScript strict / ESLint / Prettier / Vitest / Playwright 配置
□ packages/contracts: 由 Zod 定义全部 Schema，生成 TS 类型与 OpenAPI
□ apps/gateway: Fastify 骨架 + config 模块（Zod 校验环境变量，不合规拒绝启动）
□ .env.example（不含任何真实密钥）
□ 【先行验证】重新 clone vercel/ai-chatbot，核对组件文件结构（Phase 1 未核实项）
```

**产出**：`pnpm dev` 可同时起 Web(3000) 与 Gateway(9999)；`pnpm test` 通过空测试。

#### M1 — 数据层与认证（2~3 天）

```text
□ packages/db: Drizzle schema 实现 STATE_MACHINE.md 的 13 张表
□ 迁移脚本 + 全部 CHECK 约束与 UNIQUE 索引
□ 种子脚本 + pnpm admin:bootstrap（CLI 创建管理员，密码从环境变量/交互读取，不硬编码）
□ 邀请码: 生成/哈希存储/原子扣减/撤销/过期
□ 注册 / 登录 / 登出 / me / 改密（next-auth v5 + 服务端 Session Cookie）
□ 权限模型: role + can_use_blockout_3d
□ 管理后台 API: 邀请码、用户、权限、重置密码
```

**测试**：测试 N（邀请码）、测试 M 的权限部分。
**验收**：无有效邀请码不能注册；白模权限必须管理员单独授予。

#### M2 — Mock 后端与 Session（2~3 天）

```text
□ mocks/mock-worker: 可配置 Worker，支持
    · 任意时长（含加速时钟：2h 压缩为 2min）
    · 阶段序列与进度上报开关
    · 全部故障注入项（见 BACKEND_INTEGRATION.md §5.2）
□ BackendAdapter 接口 + MockBackendAdapter 实现
□ 启动期 BACKEND_MODE 决定实现，运行期不可切换；Mock 模式 UI 水印
□ Session 创建 + 进程选择 + 绑定持久化
□ Session 快照接口 GET /api/sessions/{id}
□ 四个 mode 权限校验点
□ 会话级 SSE
```

**测试**：测试 M（伪造 mode 越权）。
**验收**：`mode` 以 DB 中 session 值为准，请求体篡改无效。

#### M3 — Prompt Workflow（2 天）

```text
□ 意图识别接入（Mock 先行）
□ Workflow 状态机 + Revision 版本管理
□ revise / approve 接口，含 REVISION_STALE 守卫
□ 幂等机制: idempotency_records + (user_id,key) UNIQUE + workflow_id UNIQUE
□ 前端 Prompt Review Card（含 ENHANCING/FAILED/REVISING 各态）
□ 幂等键在卡片首次渲染时生成并缓存（防双击产生两个 Key）
```

**验收**：双击确认、多标签页同时确认、断线重试均只产生一个 Job。

#### M4 — Job 调度与长任务核心（4~5 天）★最关键★

```text
□ Dispatcher: Postgres SKIP LOCKED 亲和性出队 + 全局/进程双层并发信号量
□ Lease: lease_epoch fencing、续约、撤销
□ Watchdog: 心跳扫描、C.5 判定矩阵、停滞检测、对账
□ 内部 API: register / processes-heartbeat / job-heartbeat / progress / complete / fail / cancel-ack
□ 产物校验: 双重兼容方案（completion_marker 优先，大小两次采样兜底）
□ 事件持久化 + seq 单调 + SSE 扇出 + Last-Event-ID 回放
□ Gateway 重启恢复: 从 DB 重建队列与并发计数（含在跑 Job 占用）、对账而非重启
□ 取消编排: 持久化意图 → 撤租约 → 下达 → 宽限 → 终态；完成优先裁决
□ 前端: useJobStream(SSE + 轮询兜底)、任务卡片全状态、耗时展示
```

**测试**：测试 A/E/F/G/H/I/J/L。
**验收**：
- 加速时钟下 2 小时任务全程状态可查
- 心跳正常但无进度时**不取消**
- Gateway 重启**不重复启动**已在运行的 Job
- 取消与完成竞争只产生唯一终态

#### M5 — 恢复、产物、UI 完善（3~4 天）

```text
□ GET /api/me/active-context + /api/me/jobs
□ localStorage 恢复（仅存非敏感标识）+ 服务端兜底
□ 多标签页 BroadcastChannel 同步
□ Asset 状态机 + playback / download（Range 流式，不暴露路径）
□ HTML5 播放器 + 下载 + 继续修改（版本链）
□ 新建 Session 确认框（旧 Job 继续提示）
□ 左栏「进行中的任务 / 最近结果」
□ 测试站点提示三处 + 首次使用弹窗
□ 管理后台 UI
□ 响应式 + 无障碍
```

**测试**：测试 B/C/D/K/O。
**验收**：清空 localStorage 后仍能从账号找回运行中任务与结果。

#### M6 — 测试与加固（3~4 天）

```text
□ 单元测试: 状态机迁移表（含全部禁止迁移）、幂等、租约 fencing、并发信号量
□ 集成测试: 完整 happy path + 全部故障注入场景
□ E2E (Playwright): 测试 A~P 的可自动化部分
□ 不变式断言 I-1 ~ I-10
□ 文档一致性检查（§6）
□ 安全检查: 内部 API 隔离、越权、路径泄露、localStorage 内容
```

**Phase 2 总计约 17~23 个工作日**（单人，不含等待阻塞项）。

---

## 4. Phase 3 联调计划

| 阶段 | 内容 | 前置 |
|---|---|---|
| I-1 | 实现 `HttpBackendAdapter`，替换 Mock | B-1, B-5, B-9 |
| I-2 | 单机单进程打通短任务全链路 | I-1 |
| I-3 | 心跳联调：注册、Worker 心跳、Job 心跳、租约续约 | I-2, 后端 P0-1~P0-8 |
| I-4 | **真实 1~2 小时长任务验证** | I-3, B-8 |
| I-5 | **取消联调**：GPU 停止、子进程清理、槽位释放、无残留 | I-3, 后端 P0-9~P0-14 ⚠️ |
| I-6 | 多机并发：多 Worker、亲和性队列、全局上限 | I-3, B-9 |
| I-7 | 故障演练：Worker crash、Scheduler 重启、网络分区、取消竞争 | I-6 |
| I-8 | 参数定档：按实测调整心跳/超时/停滞/最大运行时间 | I-4, I-7, B-8 |
| I-9 | 部署：Nginx + Web×N + Gateway×1 + Drain 流程 | I-8 |

> **I-5 是风险最高的环节。** 若后端回复「当前不支持单 Job 取消」，
> 取消功能需后端排期改造；在改造完成并通过 T-4/T-5 之前，
> **本计划中取消功能不得标记为完成**（任务 19 一致性要求）。

---

## 5. 测试矩阵

### 5.1 任务书要求的 16 项测试

| ID | 测试 | 方法 | 自动化 | 通过标准 |
|---|---|---|---|---|
| **A** | 两小时生成 | Mock 加速时钟 + 真实长任务 | ✅ Mock / ❌ 真实 | 状态持续可查；心跳正常；不受 HTTP 超时影响；关页面不停止 |
| **B** | 关闭网页后恢复 | 提交 → 关浏览器 → 重登录 | ✅ Playwright | 找回同一 Job；**不重复提交** |
| **C** | 缓存丢失 | 清 localStorage → 重登录 | ✅ | 从服务端找回运行任务与最近结果 |
| **D** | New Session | 旧 Job 运行中新建会话 | ✅ | 旧 Job 继续原进程；可通过任务入口找回结果 |
| **E** | 心跳与进度分离 | 注入「心跳正常但无进度」 | ✅ | **不取消**；UI 显示停滞但健康 |
| **F** | Worker 失联 | 停止 Worker 心跳 | ✅ | 识别异常；停止新分配；对账；**不跨进程重跑** |
| **G** | 主动取消 | 点击停止 | ⚠️ 半自动 | 后端实际停止；子进程清理；槽位释放；无残留计算 |
| **H** | 重复取消 | 连点 3 次 | ✅ | 幂等；无错误状态转换 |
| **I** | 取消与完成竞争 | 完成瞬间取消 | ✅ 注入 | 唯一一致终态；**绝不同时 COMPLETED + CANCELLED** |
| **J** | Scheduler 重启 | 重启 Gateway | ✅ | 恢复状态；**不重复启动已运行 Job** |
| **K** | 登录过期 | 使 Cookie 失效 | ✅ | Job 继续运行；重登录后恢复结果 |
| **L** | 多模式资源竞争 | 两模式同时占满 | ✅ | 共享并发；满载排队；不可切 mode 突破 |
| **M** | 权限 | 伪造 mode / 越权访问他人任务 | ✅ | 403 / 404；审计留痕 |
| **N** | 邀请码 | 无码注册 / 并发用同一码 | ✅ | 拒绝；原子扣减无超用 |
| **O** | Reference 范围 | 检查 UI 与 API | ✅ | **无任何可用上传能力**；请求带 attachments 返回 400 |
| **P** | 故障残留 | 异常中止后逐项核查 | ⚠️ 半自动 | GPU/子进程/槽位/临时文件/Job 状态/Asset 状态全部干净 |

> G 与 P 依赖真实后端与 GPU 环境，Mock 下只能验证协议层；
> **真实资源回收必须在 Phase 3 的 I-5 人工核查**（任务 9.7：不能只看 UI 显示 CANCELLED）。

### 5.2 不变式断言（单元/集成测试强制覆盖）

| ID | 不变式 |
|---|---|
| I-1 | Job 有且仅有一个终态 |
| I-2 | `COMPLETED` ⟹ `result_asset_id` 指向 `state=READY` 的 Asset |
| I-3 | 任何终态 ⟹ 并发槽已释放 ∧ 租约已释放/撤销 |
| I-4 | 浏览器相关事件**不触发**任何 Job 状态迁移 |
| I-5 | 同一 `(user_id, idempotency_key)` 最多一个 Job |
| I-6 | 同一 `workflow_id` 最多一个 Job |
| I-7 | `UNKNOWN` 不得直接转 `FAILED` |
| I-8 | Session 的 `process_instance_id` 一经写入永不变更 |
| I-9 | 过期 `lease_epoch` 的写入一律拒绝且不改变 Job 状态 |
| I-10 | 白模四个校验点全部以 DB 中 `session.mode` 为准 |

### 5.3 长任务测试的加速时钟

两小时用例无法在 CI 里真跑。Mock Worker 支持**时间缩放**：

```text
MOCK_TIME_SCALE=60   → Mock 的 1 秒代表真实 60 秒
                       2 小时任务在 2 分钟内走完全部阶段与心跳

Gateway 侧的超时参数同步注入可配置 Clock（依赖注入，非全局 mock），
使 Watchdog 的判定逻辑在压缩时间轴上行为一致。
```

**注意**：加速时钟验证的是**状态机与协议的正确性**，
真实的 GPU 资源回收、子进程清理、长时间内存稳定性**必须在 Phase 3 真实环境验证**。

---

## 6. 文档一致性自查

> 任务 19 列出的 7 条一致性要求，逐条核查结果：

| # | 要求 | 核查 | 结果 |
|---|---|---|---|
| 1 | API Contract 不得设计页面关闭时自动取消任务 | `API_CONTRACT.md` §11 显式声明无此路径；取消仅 §6.4 的显式 API | ✅ |
| 2 | 状态机不得假定 Session 可自动迁移进程 | `STATE_MACHINE.md` §2.2 `PROCESS_LOST` 为终态；§2.1 恢复路径只有新建会话；API 无 rebind 接口 | ✅ |
| 3 | Backend Requirements 不得要求 V1 实现 Reference 上传 | `BACKEND_REQUIREMENTS.md` §12 显式列为不需实现 | ✅ |
| 4 | UX 不得显示后端无法提供的假进度 | `PRODUCT_UX.md` §5.1 为「无进度」单列卡片形态；§5.2 规定 `progress_percent=null` 时用不确定动画；`API_CONTRACT.md` §1.3 与 OpenAPI 中该字段 nullable | ✅ |
| 5 | Implementation Plan 不得在无后端 Cancel 支持时声称取消完成 | 本文档 §4 的 I-5 明确：T-4/T-5 通过前不得标记完成 | ✅ |
| 6 | 长任务文档不得假设浏览器缓存一定存在 | `LONG_RUNNING_JOBS.md` §B.4 为缓存丢失单列流程；`active-context` 为纯服务端兜底 | ✅ |
| 7 | 所有业务权限必须与实际 API 检查一致 | 四个校验点（创建 Session / 发消息 / 执行 Workflow / 提交 Job）在 `API_CONTRACT.md` §5.1/§5.3/§6.2 与 `STATE_MACHINE.md` §4 一致 | ✅ |

### 6.1 额外交叉核查

| 项 | 核查 | 结果 |
|---|---|---|
| Job 状态枚举 | `STATE_MACHINE.md` §2.4 ↔ `API_CONTRACT.md` §6.1 ↔ `openapi.yaml` `JobStatus` | ✅ 一致（10 个值） |
| `health.assessment` 五分类 | 任务 7.5 ↔ `LONG_RUNNING_JOBS.md` §C.5 ↔ OpenAPI `JobHealth` ↔ `PRODUCT_UX.md` §6.9 | ✅ 一致 |
| `control` 指令五值 | `API_CONTRACT.md` §8.3 ↔ `BACKEND_REQUIREMENTS.md` §2.3 ↔ OpenAPI `JobControl` | ✅ 一致 |
| 取消三阶段 | `STATE_MACHINE.md` §2.6 ↔ `API_CONTRACT.md` §6.4 ↔ `PRODUCT_UX.md` §5.1 | ✅ 一致 |
| Asset 状态五值 | `STATE_MACHINE.md` §2.7 ↔ OpenAPI `AssetState` | ✅ 一致 |
| 阻塞项编号 | `TASK_PLAN.md` ↔ `BACKEND_INTEGRATION.md` §4 ↔ `API_CONTRACT.md` §9.2 | ✅ 一致（B-1~B-19） |
| OpenAPI 可解析 | `yaml.parse` 通过；48 个 `$ref` 全部可解析；39 路径 / 40 操作 / 32 Schema | ✅ 已实测 |

---

## 7. 风险登记

| ID | 风险 | 影响 | 概率 | 缓解 |
|---|---|---|---|---|
| **R-1** | 后端不支持单 Job 取消 | 取消功能无法实现，V1 核心能力缺失 | **中** | 已列为后端 P0-11；尽早确认 B-2；必要时 V1 降级为「仅排队中可取消」并明确告知用户 |
| **R-2** | 后端心跳被渲染阻塞 | 正常任务被误判失联、误杀 | **中高** | 后端 P0-5 要求独立 Supervisor；`lease_ttl` 取保守值；Watchdog 先 probe 再定论 |
| **R-3** | 产物完成判定不可靠 | 用户下载到半写入文件 | 中 | B-5 必须明确；Gateway 双重校验兜底；只有 `READY` 才可下载 |
| **R-4** | `max_runtime` 设置过小 | 误杀昂贵任务（最严重的用户体验事故） | 中 | 初始设 3h；按 B-8 的 P99×1.5~2 定档；超时走取消流程而非直接 FAILED |
| **R-5** | `process_instance_id` 重启后不变 | Session 路由到失忆进程 | 中 | 后端 P0-1；Gateway 可检测 `started_at` 变化作为辅助判据 |
| **R-6** | Node 16 环境误用 | 构建失败 | 低 | `.nvmrc` 固定 22 + `engines` 字段 + CI 校验 |
| **R-7** | 远端 DB/Redis 迟迟不到位 | Phase 2 无法启动 | 中 | B-7 已列为头号阻塞；本机可用 npm `embedded-postgres` 临时开发（已验证可装出 PG 18.4） |
| **R-8** | GitHub 不稳定影响依赖安装 | 开发受阻 | 低 | npm 走 `registry.npmmirror.com`（实测稳定）；GitHub 仅用于参考代码，需 `--proxytunnel` |
| **R-9** | 上游组件结构与预期不符 | M0 返工 | 低 | M0 第一步即重新 clone 核对（Phase 1 未核实项） |
| **R-10** | 两小时任务的内存/句柄泄漏 | 长时间运行后 Worker 不稳定 | 中 | Phase 3 的 I-4 需连续跑多轮并监控；非加速时钟可发现 |

---

## 8. Phase 1 结论与待确认事项

### 8.1 本轮已完成

```text
✅ 环境勘察（Node/网络/DB/权限/资源）
✅ 上游仓库许可证与依赖核实（Apache-2.0 / MIT，经代理实测拉取）
✅ 产品交互设计
✅ 技术架构与选型
✅ 完整 API 协议 + OpenAPI 3.1（已通过解析与 $ref 校验）
✅ 6 个状态机 + 13 张表 + 10 条不变式
✅ 长任务、心跳、Lease、取消、恢复、故障处理设计（含 7 个时序图）
✅ 可交付后端 Coding Agent 的需求文档（28 项 P0 + 8 项 P1 Checklist）
✅ 文档一致性自查（任务 19 的 7 条逐条核查）
```

### 8.2 等待确认后才进行

```text
⏸ Phase 2 工程开发 —— 按任务书要求在此暂停
```

### 8.3 需要回复的阻塞项

**用户侧**：B-7（DB/Redis 连接串）、B-18（共享存储挂载点）、B-19（内部鉴权方式）、B-10（git init 授权）

**后端侧**：B-1（调用协议）、**B-2（单 Job 取消能力）⚠️**、B-3（进度上报）、B-4（进程 ID 语义）、
**B-5（完成标记约定）⚠️**、B-6（Skill 切换）、B-8（耗时分布）、B-9（机器清单）、
B-11（心跳是否被阻塞）、B-12（Process Group）、B-13（Cancel Token）、B-14（并发对话）、
B-15（意图识别）、B-16（Prompt 增强）、B-17（旧视频修改）
