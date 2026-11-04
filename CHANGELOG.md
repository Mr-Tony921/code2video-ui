# 更新日志

版本号在仓库根的 `VERSION`，前后端共用一个号，便于回溯。
前端在页面右下角显示，后端在 `/healthz` 与 Bridge `/health` 返回。

格式：`新增` / `修复` / `变更` / `安全`。

> 当前为 Codex 独立副本，源为 dev 1.4.6；历史记录中的部署状态只代表当时状态。
> 自 1.5.0 起使用常规语义版本号；版本发布指本独立开发环境。

## Unreleased

- 修复历史会话较多时滚动更新注册超时：会话改绑复用一次任务索引，并重新读取对应任务的最新状态，避免逐会话扫描全部历史任务。

- 实验模式新增服务端配置的 Anatomy 可选 skill，默认关闭，可与 Coding to Video 组合；完整资源固定版本留存、同名冲突提示，支持配置更新和停用。
- 子进程浏览器环境同时提供 CHROME_PATH 与 CHROME_BIN，兼容 Anatomy 检查脚本。

- 实验模式增加内网自部署模型选项，通过 `source: primary` 引用普通模式的模型配置和环境变量，支持完全不加载 skill，保留原有 API 渠道及旧会话模型绑定。
- 热更新检查改为从实际存储根读取运行任务索引，适配复用 dev 数据路径，并核验正在执行的任务继续存活。

- 修复实验 skill 设置占用额外布局行，挤压对话区、错误放大输入框并干扰过程区拖拽的问题；设置改为输入栏内的独立弹窗。
- 过程区高度按实际可用空间限制，恢复超大旧偏好及缩放视口时为对话区保留空间；收起时释放高度，拖拽把手跟随指针并处理取消事件。
- 增加浏览器布局回归，覆盖多种视口、设置弹窗、双向拖拽、收起和普通模式；热更新仅重启 dev 前端。

## 1.5.2 — 2026-11-02

- 新增仅 dev 开放的实验模式，需管理员在用户页显式授予权限；模型通过服务端配置，支持 key、endpoint、模型名称与独立上下文/输出参数。
- 实验对话绑定模型配置版本；配置变更要求新建对话，单独轮换 key 不改变模型归属。原始 prompt 直接执行，主模型与子任务统一选定模型，不继承内网模型限制。
- 内置 skill 可选择完全关闭，支持粘贴 SKILL.md 和上传含脚本、资源的 ZIP；按轮次保留不可变 skill 版本，仅追加 output/final.mp4 的最小交付约定。
- 所有模式新增完整会话 ZIP 导出，保留原始执行日志、原生 CLI 会话及子任务、源码和轮次记录，覆盖不透明推理签名；修复轨迹导出遗漏当前 workspace 布局的问题，并保留增强环节原始日志。


- 修复取消时间缺失或无效时任务永久停在 CANCELLING 的问题；覆盖 CANCEL_REQUESTED，恢复有限重试与磁盘终态对账。
- 同一任务的状态、元数据和租约写入改为串行读改写，防止并发覆盖取消意图、回退状态或恢复已撤销的租约；迁移失败不再发送取消成功事件。
- 新增取消完整性回归，使用隔离临时数据验证空时间戳、失联对账、重试上限与并发租约。

- 恢复原 dev 用户、183 个历史会话和 156 个任务；直接复用原控制面与 session-dev 工作区，保留密码和权限，未复制历史工作区。
- 清理未完成的大目录暂存复制；仅保留小体积控制面回滚备份。

- 接管原 cc dev 的 30543 → 8000 入口、9998 Gateway 与两台 18080 Bridge；保留 cc 的代码和数据。
- UI、Gateway、Bridge 改用专用 tmux 会话常驻监护，异常退出自动恢复；精确停止仍按目录、角色和启动时间限定。
- 端口复用只接受本地记录的已授权 cc dev 拓扑，继续拒绝生产环境；增加控制命令退出后存活、自动重启及隔离校验回归。

## 1.5.0 — 2026-11-02

- 将完成第一轮精简重构的独立开发环境定为 1.5.0；应用包、前端显示、Gateway 和 Bridge 版本统一。
- 建立 Git 管理：保留重构基线标签 `v1.4.6-codex.1`，以 `main` 管理当前代码，发布标签为 `v1.5.0`。
- 本地实际配置、密钥、账号、任务数据、视频、运行依赖和构建产物不进入 Git；提交脱敏配置模板。
- 增加 Git 日常开发、发布和配置恢复说明；保留既有 2D、3D、续改、取消与任务恢复功能。

---

## 1.4.6-codex.1

- 在 afs_if 建立独立前后端、两台 worker、私有存储与 Cookie；用普通 test/test-peer 验证。
- 提取 HTTP/鉴权公共模块；保留现有调度、续改、取消、视频下发和故障恢复语义。
- 集中启停逻辑，以 cwd/角色/启动时间限定目标，增加主机、端口、Node 版本与构建校验。
- 清理未使用函数、退役技能副本与失效测试，统一活动技能路径和隔离测试 fixtures。
- 补充真实生成、素材、播放、续改、取消、worker 认领及模块行为验证；细节见 docs/TAKEOVER.md 和 runtime/validation。

---

## 1.4.6

起因是线上 1.4.5 的排查报告：管理页显示「并发 3/20」而实际只有 18，
以及持续反馈「整个网络卡顿」。报告的数据我逐条核过**全部属实**，
而且 dev 比线上更严重（active-context **652 KB / 124 条**，线上是 185 KB / 21 条）。
**但报告里三条方案核查后不能照搬**，见下面各处的「★ 与报告的分歧」。

### 修复：轮询把出口占满（这部分是我们的，收益最大）

`/api/me/active-context` **每页每 20 秒全量轮询**，线上实测把前端出口填到
**88.9 KB/s**，而入口下行只有 **43~71 KB/s** —— 我们在要 1.3~2 倍于管子能给的量，
超额部分变成排队，视频、首屏、SSE 全堵在后面。

根因很简单：那个定时器的**唯一目的**是看「别的会话在跑的任务」
（`_workspace.tsx` 的注释写明），而 `running_jobs` 实测只有 **2 B**；
它却把**整个已完成历史连同完整 prompt 重发一遍** —— 那些数据根本不会变。
单条里 `original_prompt` 与 `enhanced_prompt` 各 14250 B 且**一字不差**。

- 服务端：`active-context` 支持 `?brief=1`，省略 `recent_completed_jobs`
  （**键直接不存在**，不是空数组），并跳过 124 次 `publicJob` 与 652 KB 序列化。默认行为不变。
- 前端：新增 `refreshRunning()`，只打这一个 brief 请求 —— **不调 `me`、不调 `getSession`**，
  且**绝不触碰 `recentJobs`**（用空数组覆盖会让侧栏「已完成」整列消失）。
- **保住的回归点**：别的会话里的任务完成时「已完成」要能更新。brief 响应没有历史，
  所以靠「running 集合变小」发现：有 id 消失 ⇒ 补**一次**完整 reload，
  即每次完成最多多打一趟全量，而不是每 20 秒都打。

实测：**649,278 B → 857 B，758 倍**。

> ⚠️ 实现时踩到一个真实的 React 陷阱：最初把「有任务消失」写成在 `setState` 的
> updater 里给闭包变量赋值、然后同步检查它。React 18 的 updater 是**延后执行**的
> （StrictMode 下还会跑两次），同步读到的永远是初始值 —— **那条回归保护等于没接上**。
> 改成用 ref 镜像 `state.runningJobs` 来同步比较。

### 修复：gzip 加在**代理层**，不是 Gateway

**★ 与报告的分歧（最重要一条）**：报告建议「Gateway 对 JSON 响应加 gzip」，
核查后这个位置**是错的，加了也救不到堵的那一跳**：

- `route.ts` 的 `SKIP_REQ` 原来**不含** `accept-encoding` ⇒ 浏览器的 gzip 请求头
  原样透传到上游 ⇒ Node 的 fetch(undici) 拿到 gzip 响应**会自动解压**；
- `SKIP_RES` **含** `content-encoding` ⇒ 这个头又被剥掉。

净效果：只压了 **Gateway↔前端的局域网**那一跳（实测 204 MB/s，根本不缺带宽），
而真正堵的 **浏览器↔前端**（过入口，43~71 KB/s）照旧是未压缩的全量。

所以压缩收到代理层：向上游显式要 `accept-encoding: identity`（绕开 undici 自动解压），
再按浏览器的 `accept-encoding` 自己压；设 `vary: accept-encoding`；小于 1 KB 不压。
**SSE 与视频流直接透传，既不缓冲也不压缩**（SSE 压缩会因缓冲破坏实时性，
视频本来就是压缩过的）。

实测：全量 **649,278 B → 144,372 B（4.5 倍）**，响应头确实带 `content-encoding: gzip`；
SSE 与视频的 `content-encoding` 均为 0 处，视频 Range 仍回 206、`Content-Range` 正确。

### 修复：会话分配不看单机并发上限（会真实影响排队体感）

`worker-pool.mjs` 的 `pickForSession` 按 `active_sessions` / `running_jobs` 均衡，
**完全不看 `max_concurrent_jobs`**。而「会话固定进程」意味着会话一旦落盘就永不迁移：
线上 cvw-700 的 `max_sessions` 仍是 8（和其他四台一样），`max_concurrent_jobs` 却只有 2，
于是它照常分到约 1/5 的会话，却只能同时跑 2 个 ——
**那台上第 3 个会话提交时就要排队，哪怕集群还有 15 个空槽**。

改成按**并发容量归一**的负载排序（`active_sessions / max_concurrent_jobs`，
tie-break 同样归一），并排除容量为 0 的进程；`max_sessions` 硬上限、`HEALTHY`、
`supported_modes` 过滤全部保留。dev 配置同时把 `cvw-dev-360` 的 `max_sessions`
从 8 降到 4，与它的并发 2 对齐（和另一台的 8:4 同比例）。

实测 12 次连续分配：cap=4 的机器拿到 8 个、cap=2 的拿到 4 个，正好 2:1。

> 顺带记一笔**未改的既有限制**：`active_sessions` 只靠 Bridge 心跳更新，
> 派发侧没有像任务槽那样的「预留」。所以短时间内连续建会话可能都落到同一台，
> 之后由心跳纠正。会话由人工点「新建对话」产生，突发少见，本轮不动。

### 变更：并发显示报「实际可用」而不是配置声明值

`capacitySnapshot` 报的是 `global_max_concurrent_jobs`（线上 20），
而各机实际上限之和只有 18 —— 管理页多报了 2 个不存在的槽。
改为 `capacity: Math.min(globalMax, Σ HEALTHY 机器上限)`，并保留
`declared_capacity` 便于排查两者差异。

核查确认 `capacity` **只用于显示**（管理页角标与 utilization 百分比），
不参与任何准入判断，所以改它是安全的。一台失联时分母会自动变小 —— 这是对的。

### 修复：已完成任务上的空 `failure` 空壳

来源是建档模板（每个 job 一出生就带 `{code:null,message:null}`），不是"成功时写上去的"。
在 **API 边界**收口：`publicJob` 在没有真实失败时下发 `null`，
不动存储结构、也不碰 job-store 的 `{...j.failure, ...patch.failure}` 合并逻辑。

### 文档：明示 `finished_at` 是唯一权威的终态时间

**★ 与报告的分歧**：报告建议「`completed_at` 没写，建议统一写上」——
这个字段**在 schema 里根本不存在**（全代码零命中），三种终态一直都写 `finished_at`。
不新增字段，改为在 `docs/API_CONTRACT.md` 的 job 结构里写明，
并点出「按 `completed_at` 统计会得到 0」这个坑。

### 新增测试，以及一个潜伏已久的测试缺陷

- `tests/risk/capacity-dispatch.mjs`（18 项，行为测试）：此前 `tests/risk/`
  对 capacity 与 pickForSession 是**零覆盖**。
- `tests/risk/poll-payload.mjs`（25 项）：brief 不带历史、定时器不再调 reload、
  `refreshRunning` 不碰 `recentJobs`、用 ref 判消失、SSE/视频不压缩……
- **★ 修掉 7 个测试共用的 `strip()` 的顺序错误**：它先去块注释再去行注释，
  于是**整行注释里出现 `/api/*` 这类字样时会被当成块注释开头**，一路吞到下一个 `*/`。
  `route.ts` 第 92 行正好有一条这样的注释，导致它后面约 20 行
  （含 `headers` 构造与 `accept-encoding` 设置）在断言里**凭空消失** ——
  这类"看起来在测、其实没测到"是最危险的。改成先去行注释再去块注释。

### 明确**不做**的（报告建议但核查后不合适）

| 报告建议 | 不做的理由 |
|---|---|
| 「历史不下发完整 prompt，只给 `prompt_summary`」 | **会造成功能退化**：`HistoryPanel.tsx` 的复制/复用 prompt 与 `_workspace.tsx` 的 `PromptBubble` 展开**都直接取 `original_prompt`**，只给 300 字摘要会让「复用 prompt」粘出截断版。brief 之后这些字段已不参与轮询，收益已拿到；真要再瘦身应改为「点开时按需拉 `/api/jobs/:id`」。 |
| `recent_completed_limit` 200 → 30 | brief 之后轮询不再携带历史，200 只影响首屏（gzip 后 144 KB）。砍它会退回 1.3.12 修过的「用户找不到自己的成片」。 |
| 轮询 20s → 60s | brief 之后每次 857 B，没必要牺牲「进行中」的实时性。 |
| Gateway 侧 gzip | 位置不对，见上。 |


## 1.4.5

本版三件事：**修测试的环境可移植性**（线上同步 1.4.4 时暴露的）、
**冒烟任务一律关扩写**、**把"切模型"固化成脚本**。
产品代码只动了配置与脚本，运行时逻辑未改。

> dev 的模型端点已切到 `app-ca2663…:8000`（`Qwen3.8-27B-video-generation-v23`），
> 属实验性质，线上仍是 v4 那条。

### 修复：测试写死 dev 专有的东西，拿到线上整文件崩（第四次同类）

线上拿 1.4.4 原样跑风险回归是 **21 通过 / 7 失败**，7 个**全不是产品缺陷**，
而是"测试只在 dev 成立"。这类问题的真正危害不是误报，而是**让人习惯性忽略整个测试套件**。

1. **6 个测试在 import 阶段就崩**（`adopt-unit` / `crash-test` / `isolate-test` /
   `round-isolation` / `resume-guards` / `adopt-token`）。它们都写着
   `process.env.CVW_WORKER_ID ??= 'cvw-dev-360'` —— 兜底值是 dev 的 worker_id，
   而 `config.mjs` 对找不到的 worker **直接抛异常**，于是整个文件一条断言都跑不到。
   改法：**在 `run-all.sh` 里统一按配置取第一台 enabled 的 worker**（一处顶六处），
   6 个测试文件保持与线上逐字节一致，不再产生分叉。外部已指定时不覆盖。
2. **`stream-leak.mjs` 硬读 dev 专有脚本**（`restart-service.sh` / `start-backend.sh`），
   线上没有这两个文件 → `readFileSync` **抛异常**（不是返回空），
   把前面已经通过的 7 条流泄漏断言一起带走。
   启动脚本两边名字就是不一样：dev 用 `restart-service.sh`/`start-backend.sh`，
   线上用 tmux 常驻的 `svc-run-gateway.sh`/`svc-run-bridge.sh`。
   改法：**按"实际存在的启动脚本"断言**，判据不放松（凡存在的都必须过守卫），
   并补一条 **「至少检查到一个」** —— 否则四个名字哪天全被改掉，循环一次都不执行、
   `ok`/`no` 都不调用，就会**静默通过**（1.4.0 那次 md5 断言"从来没跑过"的同一个陷阱）。
3. **`start-backend.sh` 的默认 worker 写死了**（dev 是 `cvw-dev-360`，线上是早已不存在的
   `cvw-161`），不带环境变量跑必然起不来。改成按配置取。

### 变更：冒烟任务一律关闭智能扩写

`smoke.sh` 提交时加 `"enhance": false`（`e2e-checklist.sh` 本来就是 `False`，统一过来）。

两个理由，都让带扩写的冒烟失去意义：

- **太慢。** 扩写把 21 个汉字扩成 4000+ 字符、带像素级验收标准的规格书
  （"抽帧测蓝点质心、误差 ±2px"）。实测扩写后跑了 **15 分 14 秒**，
  打满 `max_runtime=900s` 被杀，而片子其实早就做出来了 —— 时间花在满足验收项上。
- **不可比。** 扩写是现跑的 agent 调用、**不确定**：同一句 prompt 两次扩写
  一次 4104 字符、一次 4471 字符。也就是说两次跑的**不是同一个任务**，
  拿它做模型/版本对比会得出错误结论（v4 vs v23 那次对比就是这么失效的，已撤回结论）。

### 修复：5 份 `capture.mjs` 统一到同一版本（1.4.4 只改了 2 份）

1.4.4 的报告里我写"三份拷贝 md5 一致"——**数错了**。dev 与线上各有 **5 份**：

```
assets/skillsets/coding_to_video/code-video-core/scripts/capture.mjs   ← 真正发给 agent
assets/skillsets/blockout_3d/code-video-core/scripts/capture.mjs       ← 真正发给 agent
assets/skills/code-video-base/scripts/capture.mjs
assets/skills/code-video-whitebox/scripts/capture.mjs
assets/skills-v2/code-video-core/scripts/capture.mjs
```

1.4.4 只修了前两份，**另外三份留着旧版** —— 旧版正是「把视频截成 1 帧还照样打印
`wrote`」的那个版本，等于埋在仓库里的地雷：谁从那儿拷一份就把 bug 带回来。
本版把 5 份统一成同一个文件（`md5 7a9cb348`，`find assets -name capture.mjs` 只有一个 md5）。

**⚠️ `assets/skills/` 不是死目录，不能删。** 线上报告建议"直接删掉这两个遗留目录"，
我照着删了一次，`argv-safety.mjs` 立刻在 import 阶段崩掉 —— 已恢复。
它实际被 **5 处**引用：

| 引用方 | 用它什么 |
|---|---|
| `scripts/install-previs-deps.sh:7` | `code-video-whitebox/scripts/whitebox-previs/package.json`（**功能依赖**） |
| `tests/integration/run-whitebox-render.sh:5` | 跑 `whitebox-previs/runtime.mjs`、`render.mjs` |
| `tests/integration/run-whitebox-e2e.sh:4` | 同上 |
| `tests/risk/argv-safety.mjs:101-102` | 读两份 `SKILL.md` |
| `config/backend.json:263` | `"$use": "assets/skills/*/requirements.txt"` |

"只有 `skillsets_root` 被引用"这个判断**只在 `apps/` 范围内成立** ——
脚本与测试里还有一堆。（我第一次查漏了，因为 grep 里写了
`grep -v '.*assets/skills'`，把正要找的行自己过滤掉了。）

### 新增：`tests/risk/skill-scripts.mjs` —— 份数以后自己管住自己

不靠"记得有几份"：**递归扫出 `assets/` 下所有 `capture.mjs`**，逐份校验
（显式 `executablePath`、favicon 回 204、没有残留裸 `launch({args})`），
并要求**所有份数完全一致（只有一个 md5）**——不一致就说明有人只改了一部分。
另有「至少找到一份」防空跑、以及「`assets/skills/` 下被引用的三个文件仍在」防误删。
dev 实测 22/22（找到 5 份）。

### 新增：`scripts/switch-model.sh` —— 切模型不再靠手记

```bash
bash scripts/switch-model.sh --check              # 只核对配置与端点是否一致
bash scripts/switch-model.sh http://<host>:8000   # 切换
```

把这次手工切 v4→v23 踩到的四件事固化下来：

1. **地址必须带端口** —— 新端点只在 `:8000` 上通，不带端口 curl 返回 000。
2. **模型名必须跟着改，而端点不会告诉你。** 实测这个 Anthropic 兼容代理
   **不校验模型名**：传 v4 回 v4、传 v23 回 v23，而 `/v1/models` 里只有 v23。
   名字写错**请求照样 200**，但 healthz、页面、job 记录、cc 轨迹全记成错的模型；
   又因为响应原样回显，**从返回里看不出不一致**。所以名字一律从 `/v1/models` 取。
3. **要从每台 worker 机器探** —— 真正调模型的是 bridge 机上的 cc，不是前端机；
   只在一台上探通不代表另一台通。各机器看到的模型不一致就拒绝修改。
4. **`max_model_len` 变了就要改 `max_context_tokens`**（配小白浪费上下文，配大模型直接拒绝）。

端点列出多个模型时**拒绝自动猜**（那种情况模型名就是路由依据）。
脚本**不会自动重启任何服务** —— 有任务在跑时重启 bridge 会打断它，
改完只把需要执行的命令和核对方法打印出来。

### 顺带确认（不用改）

- 老会话的 `video_settings.json` 里仍是旧模型名，但**没有任何代码读它**
  （`settingsPath` 只被返回、从未用于启动 cc）；cc 的模型来自
  `buildChildEnv` 的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL`，取自 **live config**。
  所以**切模型后继续旧对话也会走新模型**，不必新建会话。


## 1.4.4

起因是线上反馈「已完成视频播放/下载很慢、示例视频也很慢、上传示例片报无法解析」。
排查结论分成两半：**慢不是我们的代码**（见文末），**上传失败和两个隐患是我们的**。

### 新增：网页播放降采样（原片单独下载）

用户反馈：示例片已经压缩过了，但对话区的成片还是原片，在受限网络下打不开。
线上实测 71 个产物，码率中位数 1302kbps，最大的几个是
**98.6MB / 19702kbps（42 秒）**、89.6MB / 75106kbps（10 秒）、81.3MB / 13633kbps，
而对话区的 `<video>` 是 `width:100%`（约 700px 宽）—— 1080p 的像素根本显示不出来。

**两条路分开：**

| 入口 | 给什么 |
|---|---|
| 网页播放 `/api/assets/:id/playback` | **降采样预览片** |
| 「下载原片」按钮 `/api/assets/:id/download` | **原片**，一个字节不改 |
| 视频插件自带的下载按钮 | 压缩片（它下的是 `currentSrc`，天然就是预览片） |

**上限是绝对值，不按百分比一刀切**（`config.preview`，可配置）：
`max_height 540` / `max_kbps 600` / `audio_kbps 96`。
**只按码率触发** —— 低于上限的片子一个字节都不动（不重编码、不掉画质、不耗 CPU），
分辨率上限只在确实要重编码时顺带生效。这条在 1.4.3 示例片那边踩过一次：
最初写成「超 720p 或超码率」，把一个 299kbps 的小片也重编了一遍，纯属白掉画质。

实测（dev，一个 60 秒的成片）：

```
原片      32,164,164 B  1920x1080  4289 kbps
预览片     2,422,945 B   960x540    323 kbps   ← 13.3 倍小，生成耗时 3.4 秒
第二次播放 0.02 秒（命中已生成的）
下载原片  32,164,164 B  ← 仍是原片
```

323kbps 意味着约 40KB/s 就能流畅播，正好对得上当前受限链路。

**用户点名的三条风险，逐条处理：**

1. **多轮续跑不能串片。** agent 工作区 `sessions/<sid>/workspace/` 各轮共用，
   `output/final.mp4` 第 2 轮就被覆盖；能按轮回放靠的是每轮钉住的
   `rounds/<jid>/final.mp4`。所以预览片**按 job_id 落在会话目录之外**
   （`runtime/gateway/asset-previews/<jobId>.mp4`）——
   落在原片旁边或从工作区路径派生都会被第 2 轮覆盖。
   实测线上 130 个产物路径、被多个 job 共用的 **0 个**，job_id 本身每轮唯一；
   dev 实测两轮各自记录独立指纹（54884 / 59251）。
2. **不影响视频生成逻辑。** 只读原片、只写 Gateway 自己的目录，不碰会话目录与
   agent 工作区；完成钩子是 `void` 异步，绝不阻塞 `/complete`
   （它一卡，Bridge 收不到回复会重试、任务状态会悬着）；失败只告警。
   产物 inode/md5 的既有断言不受影响 —— 我们只新增旁路文件。
3. **白模同理。** 白模 previs 本来就是低码率，实测 `640x360 / 59kbps` →
   判定 `mode:'none'`，**一个字节都不动**，直接播原片。

**陈旧判定**：指纹记录原片的 `size` + `mtime` + **当前上限值**。
原片被重写过（比如 1.4.2 的 faststart 重封装会改字节数）或**上限被调整**，
下次播放自动重做 —— 否则调 `config.preview` 等于没用：
已经判过「达标、直接播原片」的记录会永远新鲜，删文件也救不回来（那条记录没有文件）。
上限调高后用不上的旧预览片会顺手删掉，不留孤儿。

**任何失败都退化成播原片**：ffmpeg 不在、转码超时、产物校验不过，统统继续播原片，
绝不让播放失败。⚠️ 也就是说 **Gateway 所在机器必须有 ffmpeg** ——
这正是本版把 Gateway 从前端机搬回后端机的原因之一；不搬的话这个功能会静默失效。

前端会明确告知「网页播放已降采样至 540p，原片未改动」，
并在下载原片按钮下标注「受网络策略限制，速度较慢，请耐心等待」——
不说的话用户会以为成片质量就这样。

### 变更：Gateway 不再放前端机，跑它的那台机器并发压到 2

线上 2026-10-28 把 Gateway 从 `10.120.7.0` 迁到了前端机 `10.120.6.11`，连带踩了两个坑：

1. **前端机没有 ffmpeg/ffprobe**（实测全盘搜索为空，而 worker 机 `/usr/bin/` 下都有）。
   1.4.1 起示例片上传要做 `ffprobe` 读元信息 + `ffmpeg -f null -` 解码校验，
   1.4.3 又加了预览化转码 —— 全部依赖这两个二进制。
   于是**每一次示例片上传都必定失败**，用户看到的就是代码里那句
   `无法解析为视频：spawn ffprobe ENOENT`。
   当时代码注释还写着「gateway 所在机器自带 /usr/bin/ffprobe，实测可用」——
   那是在**旧机器**上实测的，搬家把这个前提搬没了。
2. **前端机的 PATH 会落到 nvm 的 node v16**（无全局 fetch），
   Gateway 起来了、healthz 也通，但每一次派发都失败：
   `[dispatcher] ... E_BRIDGE_START_FAILED fetch is not defined`。
   用户 `timmy_demo` 的两个任务（`job_617ea4f0` / `job_d910e31d`）就这么没了，
   11:04 换成 v22 重启才恢复。

所以 Gateway 回到**后端机器**（dev 本来就在 `10.120.3.60`）。
代价是那台机器既跑 Gateway 又跑 cc，所以**它的单机并发从 4 压到 2**：
Gateway 要处理所有 SSE、视频 Range 下发、增强与派发，和 4 个 cc 抢 CPU/内存时它一卡，
所有在跑任务的过程框和视频都跟着卡 —— 宁可这台少跑两个。

- 配置：`workers[].max_concurrent_jobs`，跑 Gateway 的那台写 2，其余保持 4。
- `worker-pool.mjs` 的单机上限改成取**三者最小值**：Bridge 自报、配置里这台机器的声明、
  全局天花板 `per_machine_max_concurrent_jobs`。
  原来只信 Bridge 自报 —— 配置里的声明对 Gateway 等于作废，改一次必须重启那台 Bridge，
  而且 Bridge 侧 `CVW_MAX_CONCURRENT_JOBS` 一覆盖就能悄悄抬回去。
  取最小值后**只能调低不能抬高**，且**改配置只需重启 Gateway**。
  实测：只重启 Gateway、两个 Bridge 都还自报 4 时，`cvw-dev-360` 已按 2 执行。

### 修复：视频流句柄泄漏（线上 16 小时攒了 141 个）

线上实测：Gateway 开着 **141 个 `final.mp4` 句柄，其中 78 个压在同一个文件上**
（同一个视频被播了 78 次，78 个读流一个都没关）；代理↔网关 **153 条 ESTABLISHED**；
前端 next-server **RSS 1.9GB 且仍在涨**。

两处缺陷叠成的：

- 代理（`route.ts`）**从来没把客户端断开传给上游** —— `signal` 只有「120 秒超时」
  或 `undefined`，没传过 `req.signal`。浏览器 seek/暂停/关页后，到 Gateway 的请求没人取消。
- Gateway 用 `rs.pipe(res)`，而 **pipe 在 res 提前关闭时不会销毁 rs**，句柄就一直挂着。

机制是老的，**但 1.4.2 把它从有界变成了无界**：那一版为修「40MB 大片被 120 秒掐断」
给视频流去掉了超时，顺手也去掉了唯一在回收废弃连接的东西。两边都修才闭环：

- `upstreamSignal(req, streaming)`：流式只跟客户端生命周期（仍然不设超时），
  非流式是「客户端断开 + 120 秒兜底」。`AbortSignal.any` 不可用时退回只用超时。
- `pipeWithCleanup(rs, res)`：`res` 一 close 就 `rs.destroy()`；四处下发全部改用它
  （产物 playback/download + 示例视频，各含 Range 与全量）。
- 客户端自己断开不再记成 502 假故障，返回 499。

### 修复：node 版本守卫（dev 侧补齐）

线上已有 `svc-run-gateway.sh` 在挑 ≥18 的 node，dev 这边 `restart-service.sh`
还在用裸 `node`，同一个坑没堵。新增 `scripts/node-guard.sh`（`require_node18`），
`restart-service.sh` 与 `start-backend.sh` 起进程前都过一遍：挑不到 ≥18 就**拒绝启动**
—— 宁可起不来被立刻发现，也不要起一个「看着健康、一派发就崩」的服务。

> ⚠️ 线上 `svc-run-bridge.sh` **还没有**这道守卫，而 Bridge 同样靠全局 fetch
> （`gateway-client.mjs` 调 Gateway、`config.mjs` 探模型 max_model_len）。见同步清单。

### 变更：动了 skill —— `code-video-core/scripts/capture.mjs`

**为什么要改 skill**（这类文件平时尽量不碰，所以把理由写清楚）：

它不是第三方库，是**我们自己写、通过 skill 发给 agent 的脚本**
（`code-video-core` 只有 4 个文件：`SKILL.md` + 3 个 scripts），而且
`SKILL.md:70-71` **主动给出命令行叫 agent 用它**。后端一行都不调用它（`grep` 为 0 处），
所以它的毛病只会在 agent 真的照说明书做的时候暴露 —— 我们的 `risk`/`smoke`/`release-check`
测的全是自己的代码路径，永远测不到它。这也是它从 1.2.0 潜伏到现在的原因
（三份拷贝 md5 一致，一个字没改过）。

两处修复：

1. **不传 `executablePath`** → Playwright 去找它自己下载的浏览器
   （`$HOME/.cache/ms-playwright/`），而隔离沙箱里那儿必然是空的
   （HOME 是每会话新建的 `.home`、`/mnt` 被遮蔽、沙箱内无外网下不动），
   于是 launch 直接报 `Executable doesn't exist at .../chromium_headless_shell-1248/...`。
   环境里本来就装了 chrome（`CHROME_BIN`，任务说明也让 agent 传它），偏偏这脚本自己没传。
   改成 `CHROME_BIN` 存在就传，不存在保持原行为（开发机照旧可用）。
2. **自己起的 http 服务器对 `/favicon.ico` 回 404** → 浏览器打一条 console error，
   而抓帧循环 `if (errors.length) { ...; break; }` 见到任何 console error 就中断 ——
   整段视频**只剩第 1 帧**，脚本却照样打印 `wrote ...`。改成对 favicon 回 204
   （在源头消掉它自己造的 404，**没有**放宽错误判据：真正的页面报错仍然必须中断抓帧）。

第 2 条是修第 1 条时实测发现的，而且**比第 1 条更要紧**：
只修 chrome 路径的话，失败只是从「启动崩」挪到「第 1 帧截断」，工具失败并没有减少。
实测（`--fps 10 --dur 2`，应出 20 帧）：

| 情形 | 帧数 | 时长 |
|---|---|---|
| 修复前（不设 CHROME_BIN） | 启动即失败，无产物 | — |
| 只修 chrome 路径，页面不声明 icon | **1** | 0.1s |
| **两条都修** | **20** | 2.0s |

影响面：只换脚本里的启动参数与一个 404 响应，**agent 读到的提示词一个字没变**，
不涉及 1.3.9 那类「改 skill 提示词把成片质量带下来」的风险。
每轮任务会重刷 `.claude/skills/`，所以改完下一轮自动生效，不影响在跑的任务。

### 排查结论：「慢」不在我们这一层（本版未改，也改不了）

同一个文件、同一台服务器、同一时刻：

| 路径 | 178KB 静态文件 | 吞吐 |
|---|---|---|
| 直连容器 `10.120.6.11:8000` | 0.0044 秒 | **41.6 MB/s** |
| 过公网域名 | 2.8 ~ 6.7 秒 | **27 ~ 64 KB/s** |

差约 1000 倍。按 45KB/s 算，40MB 成片要 15 分钟 —— 播放、下载、示例片全走这条路，
所以三个症状一起出现。后端这一侧全部排除：存储读 865~1673 Mbps、
`/healthz` 1.5ms、代理是流式透传不缓冲、主机 128 核 98% 空闲、内存 9/128GB。

> ⚠️ 这个测量是从集群内的 pod 发起的，和用户所在网络位置不同；
> dev 的内部转发 `10.210.9.14:30543` 从集群内**根本连不通**（pod 内 502/5s、
> 另一台 pod 超时），所以**我们测不到用户那条路**。
> 「同机同文件绕过入口快 1000 倍」这条结论不依赖测量位置，但限速到底发生在哪一跳，
> 需要在用户侧对比「直连容器 vs 过入口」才能定。入口限速由用户去问平台。


## 1.4.3

**只有一件事**：修掉「示例片播放卡顿」。1.4.2 已同步上线，本版在那之上。

### 排查：和对话区那个不是一回事

用户反馈「示例里面的视频加载也很卡，看看是不是和对话是同一个问题」。
**不是**：对话区那个是 `<video loop>`（短片每次回绕一次 seek），
而示例弹框里的 video **本来就没有 loop**。

实测线上唯一那个示例片：**40.33MB / 61s = 5.5 Mbps、1080p**，
而它在弹框里最大只显示 **360px 高**（`ExampleDialog` 的 `maxHeight: 360`）。
用 CDP 分档限速实测它要多少带宽才不卡：

| 带宽 | 卡顿次数 |
|---|---|
| 不限 / 20 / 8 / 5 Mbps | **0** |
| 1.5 Mbps | **3**（每两秒一次） |

也就是说它需要稳定 5~6 Mbps，5 Mbps 时缓冲几乎没有余量 —— 码率太高，就这么简单。

顺带一个次要因素：这个文件 `moov` 在**尾部**，浏览器得先抓文件尾才能拿到元信息
（实测 3 次 Range / 1.32MB，限速 1.5Mbps 下 1802ms）。
注意 **Chrome 并不会因此下载整片** —— 它会 range seek 到尾部，
所以 `moov` 不是"卡"的主因，只拖慢开头。

### 修复

- **★★ 上传时做「预览化」处理**（`examples.optimizeForPreview`）。
  码率高于 **1800kbps** 就重新编码（h264 / crf 24 / maxrate 1800k）并缩到 720p 内；
  码率本来达标的只做 faststart 重封装（`-c copy`，**画质无损**）。
  实测那个示例片：**40.33MB / 5545kbps → 5.97MB / 821kbps**，6.8 倍缩小，转码 4 秒。
  处理后 **1.5 Mbps 与 1 Mbps 都 0 卡顿**，Range 请求 3 → 1，元信息 1802ms → 554ms。
- **★ 只按【码率】触发重编码，分辨率不单独触发**。
  第一版写成「超 720p 或超码率」，结果把一个 **299kbps** 的 1 秒小片也重编了一遍
  （1080p/299kbps → 720p/175kbps）：它本来一点都不卡，重编只是白掉一次画质。
  卡顿的根源是码率，不是分辨率。分辨率上限仍然生效，但只在"确实要重编码"时顺带缩下来
  —— 既然都要重编，就没理由留着弹框根本显示不了的 1080p。
- **★★ 存量示例片在 Gateway 启动后自动优化一遍**（`optimizeExistingVideos`）。
  只改上传路径的话，**已经传上去的片子不会自己变好** —— 线上现在就有一个
  40.33MB / 5.5Mbps 的，用户正卡在它上面。
  放在 `listen` 回调里异步跑，不阻塞启动；**幂等**（处理过的下次直接跳过，
  实测第二次重启「2 个，优化 0 个」）；单条失败只告警、清掉临时文件。
- **★ 管理页显式告知处理结果**。体积和分辨率会和管理员传上来的不一样，
  不说清会被当成上传出错。「示例片」列里显示
  `已压缩：40.3 MB → 6.0 MB`，底部补了一段说明处理规则。
  记录里留 `original_size_bytes` / `optimized` / `optimized_at`。

**安全**：处理失败一律**用原文件**（上传路由里 `applied:false` 就走原片），
宁可存一个偏大的片子，也不能让管理员的上传失败；
元信息取**最终落盘那一份**（重编码后分辨率/大小/时长都变了）；
两个临时文件无论用了哪个都清掉。

### 测试
`tests/risk/example-video.mjs` 扩充到 **42 项**（新增 15 项覆盖预览化处理：
只按码率触发、无损分支、720p 上限、音轨可缺失、失败不抛、产物校验、
上传失败回退原片、元信息取落盘那份、临时文件清理、存量优化、管理页告知）。
风险回归仍 **25 项**。

## 1.4.2

**只有一件事**：修掉「取消后永久卡在 CANCELLING」。
1.4.1 已于 2026-10-28 同步上线，本版是在那之上的单点修复 ——
与线上 1.4.1 的运行时代码差异**只有 `apps/gateway/src/watchdog.mjs` 一个文件**
（已 diff 确认；`_workspace.tsx` 那一行是 `ENV_LABEL` 环境标记，**不属于同步内容**）。

### 修复
来自线上缺陷报告 `BUG-cancelling-stuck-forever.md`。**不是本版引入**：
`watchdog.mjs` 在 1.4.0 / 1.4.1 都没改过，dev 与线上的同名文件**逐字节一致**
（已 diff 确认）。线上 208 个 job 里 **2 个**中招（≈4%），其中一个**真实用户**
的任务卡了 **24 小时以上**。

- **★★ watchdog 把 Bridge 的取消回复整个丢掉，于是 CANCELLING 永久卡住**。
  `watchdog.mjs` 的取消宽限超时分支写成
  `await bridge.cancelJob(...).catch(() => {})` —— **连返回值都不接**；
  而唯一能落终态的 `else` 分支要求「进程失联」，Bridge 健康时永远走不到。
  两件事叠起来就是死锁：界面永远显示「正在停止」，watchdog 每个 tick 重发一次、
  无限刷日志。**不占并发槽**，所以能悄悄卡 24 小时没人发现。
  Bridge 其实每次都明确回答了（`job-runner.cancelJob`）：
  `already_gone: true`（它内存里已经没有这个 job）/ `stopped: true`（本次真停了）。
  dev 上实测直接问 Bridge：`{"acked":true,"stopped":true,"already_gone":true}`。
  现在**消费这个回复**，两者任一为真就落 `CANCELLED`（释放租约 + 还并发槽 + 发事件）。
  **不能只判 `already_gone`** —— 正常路径第一次 cancel 返回的是 `stopped` 而没有它。
- **★ 兜底一：回复丢了（网络抖动 / Bridge 正在重启）就去问真实状态**。
  重发 2 次仍无定论后调 `probeJob`，它在任务不在内存时会读共享存储的终态标记
  （`.cancelled` / `.done` / `.failed`，1.4.0 起已跟随 `rounds/<jid>/` 布局）。
  读到 `cancelled` 落 CANCELLED；读到 `completed` 则**按完成处理并保留产物**
  —— 取消来晚了、成片其实已经出来，丢掉它才是真损失。
  `probeJob` 必须带 `session_id`（Bridge 要靠它定位簿记目录），测试里专门断言了这条。
- **★ 兜底二：重发有上限**（5 次）。到顶仍无定论就落
  `FAILED / CANCEL_UNCONFIRMED` —— 宁可给用户一个明确的失败，也不要让它永远悬着、
  日志永远刷。计数放内存而非写进 job 记录：这是每 tick 都动的值，落盘等于给共享
  存储加写放大；而主判据在**第一次重发**就能落终态，计数只是兜底。
  Gateway 重启后计数归零，但每个 tick 仍会消费回复、仍会 probe，不会因此永久卡住。

验证（dev）：
- **行为测试**（不是正则守卫）：真 Watchdog + 真 job-store（临时沙箱）+ 按剧本
  回答的假 Bridge，7 个场景 14 项全绿；**在修复前的代码上重跑，11 项变红**，
  且 12 个 tick 里重发了 **60 次**（无限循环如实复现）。
- **真任务端到端**：正常取消路径仍在宽限期内由 Bridge 确认（watchdog 不介入）。
- **真实复现卡住态**：把一条已收尾的 job 记录改回 `CANCELLING` 且 `requested_at`
  设为 30 分钟前，watchdog **第一个 tick 就救回**：
  「重发取消（第 1 次）」→「取消已确认（Bridge 内存中已无此任务）→ CANCELLED」。
  这也印证了报告的预言：**线上那两个卡住的任务，修复上线后下一轮自动落终态，
  不需要手工改数据**。
- 并发账目核对：used 0/8、两台 bridge running 0、无残留 CANCELLING。

### 修复（顺带：版本号与环境角标的管线）
发版时发现的，两件都不是功能 bug，但会直接误导人。

- **★ 页面版本角标写死在源码里，发版要手工改**。`_workspace.tsx` 里是
  `const APP_VERSION = '1.4.1';` —— 本次把 `VERSION` 改成 1.4.2、Gateway 也报 1.4.2，
  而页面角标**还是 v1.4.1**。
  改为由 `next.config.mjs` 在构建期从仓库根的 `VERSION` 读取并注入。
- **★★ `release-check.sh` 的「前后端版本一致」是假绿**。它比的是
  `VERSION` 文件 vs Gateway 的 `/healthz` —— **前端那一侧根本没查**，
  所以上面那个"角标还是旧版本"的状态它照样放过。
  现在拆成两项：`VERSION 与 Gateway 一致` + **`构建产物含本版版本号`**
  （直接 grep `.next/static/chunks`），后者能抓到「忘了重新 build」。
  实测：把 VERSION 改成 1.4.9 而不重建，新判据立刻红并打印产物里的实际版本串。
  只在有 `.next` 的机器上查，其余机器打印跳过。
- **★★ 环境角标也改成从配置派生，顺手拆掉一个同步陷阱**。
  `ENV_LABEL` 原来在 dev 写死「开发环境」，于是 `_workspace.tsx` 在 dev 与线上
  **永远差一行**，每次同步都得人工记住「这行不要带过去」——
  带错一次线上就显示「开发环境」。
  现在从 `config/backend.json` 的 `environment.display` 派生
  （dev 是「开发环境」、线上是 `null`）。那个字段的 `$note` 本来就写着
  「前端显示角标」，只是一直没接到前端。
  **于是这个文件在两个环境完全一致，可以整文件覆盖同步。**

### 测试
新增 `tests/risk/cancel-settle.mjs`（14 项**行为测试**）。风险回归 24 → **25 项**。

## 1.4.1

静态检查 1.4.0 的多轮/多进程路径，发现并修掉 5 处问题。其中第 1 条是会立刻影响
线上存量对话的回归。

### 修复
- **★ 续写 1.3.x 老对话等于从零重做（回归，比 1.3.x 更差）**。
  老会话只有 `jobs/<旧jid>/`、没有 `workspace/`；提交新一轮时
  `resolveJobPaths` 查的是 `jobs/<【新】jid>` —— 那个当然不存在，于是判定走新布局、
  给出一个**全新的空工作区**。而 1.4.0 已删掉拷贝继承，结果既不 resume
  也看不到上一轮的 `src/`。dev 上有 **77 个**这样的会话，线上刚同步 1.4.0，存量全中。
  现在首次走 1.4.0 时做一次性迁移：把最近一轮（优先有 `.done` 的）的 `src/` 与 `.home`
  搬进共享工作区，并回退读它记录的 cc 会话 id —— 老对话连「记得上一轮聊过什么」都恢复了。
  迁移任一步失败只降级，不让本轮启动失败。
- **★ 创作历史里点任务仍可能串台**。`onPick` 只传 `jobId`，调用方要去
  `[boot.jobs, runningJobs, recentJobs]` 里找 session；而该面板的数据来自
  `/api/me/history`（用户**全部**任务，含失败/取消的），`recentJobs` 只有 COMPLETED
  且上限 200 —— 找不到就走兜底「只改聚焦不切会话」，1.4.0 修的串台从这条路又回来了。
  改为直接传整个 `Job`，兜底分支整段删除。
- **★ 同会话并发会双写**。`startJob` 只按 `jobId` 去重。1.4.0 起各轮共用工作区并
  `--resume` 同一个 cc 会话，两个进程并存的后果从「各写各的目录」变成
  同一份 cc 会话 jsonl 与同一个 `output/final.mp4` 被双写。Gateway 侧有
  `allow_steering_during_job=false` 挡着，但它依赖内存里的在跑视图 ——
  Gateway 重启或「认领的任务叠加新派发」时会漏。bridge 侧补一道按 `sessionId` 的拒绝，
  不依赖任何内存状态。
- **上一轮上下文耗尽时不再 resume**。把一个已溢出的上下文接回来，新一轮只会立刻
  再爆（`E_TASK_TOO_COMPLEX`），用户反复重试都出不来且看不出原因。
  现在检测最近结束轮的 `.failed` 码，是上下文耗尽就放弃 resume 从干净上下文重开
  —— 文件仍在原位，不是从零重做。
- **轮次显示错**（用户实测：第一次修改却显示「第 3 轮」，会话 `sess_eed1b7a6` 足球进球门）。
  `boot.jobs.length + 1` 把**正在跑的那一轮自己**也数进去了。改为已结束轮数 + 1。
- **续写时「智能扩写」仍勾着**（用户实测）。后端对续写是**一律跳过**扩写
  （`enhancer.mjs` 的 `isRevision && skipForRevision`，配置默认 true）——
  实测故意送 `enhance=true` 也返回 `{skipped:true, reason:"revision"}`。
  勾选框还显示勾着就是在骗用户。现在续写轮强制未勾选 + 禁用 + 说明原因。
  同时把轮次、摘要、锁定与提交的 `is_revision` 统一到一个 `continuation` 判据 ——
  原来 `basedOn` 要 `result_asset.playable` 而 `is_revision` 只看 `COMPLETED`，两套条件迟早分叉。

### 测试脚本（线上 `BUG-e2e-checklist-test-fixes.md` 反馈，五条全部属实）
- **`e2e-checklist.sh` 三条断言排在 `wait_job` 之前**：`.done` 必然还不存在 → 永久误报；
  更危险的是 `final.mp4` 也不存在，md5 对比被 `if` **静默跳过** ——
  守「硬链导致静默数据损坏」的关键断言**从来没真正执行过**。
  已搬到 `wait_job` 之后、补 `else` 分支（缺成片要报失败）、并按建议新增 **inode 断言**
  （md5 相同只说明内容一样，硬链要靠 inode 才抓得到）。
- `e2e-checklist.sh` 硬依赖 `guard-isolation.sh`：线上没这个文件，脚本在第 13 行就退出。
  改为「有才跑」；guard 存在但不通过时仍然拒绝。
- `e2e-checklist.sh` 的 SIGKILL 检查统计**全部历史**：历史上出过一次就永久红，
  红的原因还与本次无关。改为测试前后的计数差。
- `pool-verify.mjs` 写死 `cvw-dev-360`/`10.120.3.60` → 改为读配置第一台。
- `isolate-test/crash-test` 的 fixture 路径写死 worker_id 而环境变量另写一遍 →
  改为路径跟随 `CVW_WORKER_ID`；`adopt-unit`/`round-isolation` 也加环境变量兜底。
- **`argv-safety.mjs` 的函数体截取把参数解构的花括号当成起点**，
  导致「argv 里没有 prompt/chrome」几条是**空洞通过**。已修并加入自检断言。
  该文件之前还**没被 `run-all.sh` 跑过**，一并补入。

### 从线上选择性拉回（与环境无关的修复）
- `hot-update.sh`：① guard 有才跑 ② **pid 扫描限定本台 worker** —— 原来扫
  `runtime/bridge/*`（所有 worker）的 pid 却在当前机器上查 `/proc/<pid>`，
  别台机器的 pid 当然不存在 → 误报「cc 进程已消失」并中止整次热更新；
  dev 两台 worker 同样会触发 ③ ssh 加 `</dev/null`（否则吞掉 while 循环的 stdin）。
- `smoke.sh`：公网（Kong 保留前缀）与内网直连（按根路径跑）语义相反，原来只处理一种。
- **未拉回**：`svc-restart` 系列（dev 没有这些脚本）、同机 bridge 补起、仓库根默认值。
  `release-check.sh` 的 4 行差异只有仓库根与一句提示文案，无需拉回。

### 用户反馈的三件（续 1.4.1）
- **两轮视频「完全一样」**（线上 yaotiankuo）：**是 1.3.x 的 bug，不是 1.4.0**。
  证据是路径 —— 续写轮的 `result_asset` 指向 **`previous/final.mp4`**，
  即上一轮成片的拷贝（`job_0ff42e58` size 39720546、`job_4bd2a122` size 38211741，
  与各自上一轮一模一样）。1.3.x 的 `findArtifact` 兜底会扫整个 job 目录**包括
  `previous/`**，续写轮没产出自己的成片时就把那份当成了交付物。
  1.4.0 删掉 `previous/` 已结构性修掉（同会话 1.4.0 两轮 size 3573746 / 3652398 不同）。
  **但共用工作区把同样的风险从另一个方向带回来了**：上一轮的 `output/final.mp4`
  还在原地，本轮没覆盖它就会被当成本轮交付。现在 `findArtifact` **只认本轮产出**
  （mtime 不早于本轮启动，留 5s 容差），采用不了旧产物时有告警、不静默。
- **「两轮反过来了」（dev）**：实测播放接口**逐轮返回正确的片子**
  （md5 `044e4224` / `6e524589` 与磁盘一致），后端没错。真实原因是**界面分不清**：
  已完成列表是新的在上、没有选中态、没有时间 —— 点完不知道在看哪一轮。
- **选中没有标注**（用户明确要求）：已完成/进行中列表加**选中高亮框**
  （左侧高亮条 + 描边 + 轻底色，不改布局以免点一下整列跳动）、
  已完成项补**完成时间**与「· 正在查看」。不自造「第 N 轮」——
  那里只有已完成的轮次，数出来会和输入框那个（按已结束轮数算）对不上，两个数字打架更糟。
- **切 session 卡、跳来跳去**：一次切换原本发 **5 个串行请求**
  （`getSession` → `me` → 再 `me` → `activeContext` → 再 `getSession`，两个是重复的）。
  现在 `me` 与 `active-context` 并行、`switchSession` 把已取到的快照交给 `reload` 复用、
  去掉重复的 `me()` —— 降到 **1 + 1 个往返**。
  「跳来跳去」的另一半是 `setFocusJobId` 排在 5 个请求**之后**：那段时间界面是
  「新会话数据 + 旧聚焦任务」的错配态，先跳错再跳对。改为**先设聚焦再切会话**，
  失败则回退聚焦（绝不停留在「看 A 提交进 B」）。

### 新增（同版本第二批：体验与示例重构）
用户要求「为解决跳变和加载慢的问题」而做的三项，稳定性相关路径一行不改
（排队/派发、认领恢复、`procAlive` token、presence、热更新、产物门禁均未触碰，
并在验证里专门回归）。

- **切换对话时默认不加载执行过程**。根因是切换时 `useJobStream` 把 `maxSeq` 重置为 0、
  SSE 带 `last_event_id=0` → **整条轨迹重放**（品牌片任务 99975 行轨迹、2335 个事件），
  所以问题不在"渲染慢"而在"每次都从头拉"。
  `useJobStream` 新增 `subscribe` 入参：为 false 时**完全不建 SSE**，
  只保留原有的 job 轮询（状态/阶段/产物仍实时）。过程框默认折叠，
  点开才订阅并显示加载进度（`loadingEvents`）。
  **自己刚提交的那一轮保持展开**（用户选定的语义），手动开合记在 localStorage
  作为下次切换后的默认。`subscribe` 切换复用同一个 effect，
  `cancelled`/`unsub` 的竞态处理原样保留 —— 那段守的是线上泄漏 116 条 SSE 连接的事故。
- **制作助手与轨迹加载解耦**。原来它的内容是前端订阅整条 SSE 自己攒出来的，
  所以"默认不加载轨迹"会让这张卡片变空白。`last_assistant_text` 此前只活在
  bridge 内存与 `.done` 标记里，**从未进入 gateway 的 job 记录**；
  现在 `stream-pump` 在已有的 `assistant_text` 分支里顺手 `patchJob` 存一份
  （**仅在文本变化时**写 —— 事件泵是热路径，每事件打盘会拖慢所有在跑任务的过程框；
  写失败只告警，绝不影响事件推送），`/internal/jobs/:id/complete` 不再丢弃入参里的同名字段，
  `publicJob` 下发它。前端优先用快照里的值，**零额外请求**。
- **侧栏分区可折叠**（新 `components/Collapsible.tsx`）。「进行中 / 已完成 / 示例参考 /
  参考素材」四块都带 `▾/▸` 符号，整行可点，默认打开，状态存 localStorage。
  折叠时**仍显示数量角标** —— 否则把「进行中」收起来就看不出有没有任务在跑。
  本地偏好在 `useEffect` 里读而非 `useState` 初值，避免 hydration mismatch；
  读写一律 try/catch（隐私模式下 localStorage 会抛）。
- **示例 prompt 重构为弹框**（新 `components/ExampleDialog.tsx`）。
  点示例**不再直接塞进输入框**（上万字会把用户正在写的内容冲掉，而且他还没看清是什么），
  改为弹框展示标题、备注、**完整 prompt** 与示例片，并固定说明
  「模型有随机性，同一段 prompt 不会还原出完全相同的视频」。
  主按钮「新建对话并导入」才真正建会话并填入 prompt，同时**取消勾选扩写**。
  顺序是**先建会话成功、再改输入框与开关** —— 反过来写的话建会话失败会留下
  「prompt 已填好、扩写已关、但还在上一个对话里」的状态，点发送就提交到错误的会话，
  正是 1.4.0 修过的串台那类问题。维护期禁用主按钮并说明原因（否则点了必然 503）。
- **管理员可为示例上传示例片**（可选）。`POST /api/admin/examples/:id/video`，
  上限 **200MB**、只收 `.mp4`、必须有 h264 视频流且时长与宽高 > 0；
  播放走 `GET /api/examples/:id/video`（Range 流式，沿用产物那套，
  **不下发磁盘路径**，白模示例沿用白模权限）。
  管理页带上传进度（用 XHR 而非 fetch —— fetch 拿不到上传进度，
  200MB 没有进度条管理员会以为卡死然后重复上传）。
  视频与 json 分目录存放（`gateway/example-assets/`），便于单独清理。

### 修复（★ 线上 1.4.0 已带此缺陷，优先级最高）
- **★★ 每次 bridge 重启都会把在跑任务误判为失败（1.4.0 引入，线上现存）**。
  `isSidecarProcessAlive()` 从边车重建状态时**漏传 `jobToken`**，于是
  `procAlive` 退回拿 `job_dir`（`rounds/<jid>`）去比对进程里的 `CVW_JOB_TOKEN`
  —— 而 1.4.0 已把 token 改成 `<工作区>#<jobId>`（各轮共用工作区后，光靠路径
  分不出轮次）。两者永远不等 ⇒ **活着的 cc 一律被判死**。
  后果是整条恢复链反向：bridge 一重启（**每次热更新都会**），adopter 走
  「进程没了 → 补收尾」，把在跑任务标成 `FAILED / E_CLAUDE_EXIT code=null
  signal=null`，而 cc 继续跑完、产物无人认领，用户白等一两小时。
  边车本身写了 `job_token`，`adoptJob` 与 `settleDeadJob` 也都读了 ——
  **只有决定「接管还是收尾」的那道闸门漏了**，所以静态看代码很难发现。
  实测复现与验证（dev，真任务 + `kill -9` bridge）：
  修复前 `cc pid=828891` 明明还在，日志却是「进程（pid=828891）已不在，补收尾」，
  新 bridge `running_jobs=0`，任务 FAILED；修复后 `running_jobs=1`（成功接管），
  任务 COMPLETED、成片 150824 字节可播、`attempt=1` 未重试。

### 修复（第三批：用户实测反馈）
- **★★ 展开执行过程时对话区仍在跳变 —— 其实没完全解耦**。
  「制作助手」取的是 `assistantText ?? job?.last_assistant_text`，**顺序反了**：
  SSE 从 seq=0 回放时会把历史上**每一条** assistant_text 依次推来，
  逐条 `setAssistantText` 就是让那张卡片把历史回复挨个闪一遍、每条长度还不同
  —— 对话区于是反复重排。改为**快照优先**（`job?.last_assistant_text ?? assistantText`）；
  `useJobStream` 再加第二道：**回放期间只缓冲最后一条**，安静期到了才提交一次。
  浏览器实测（492s、134 条轨迹的任务）：展开全程「制作助手」文本
  **变化 0 次、卡片位移 0 次**。
- **★ 进度条一闪就没，列表却继续边到边涨**。`loadingEvents` 原来在
  【首批事件到达】时就置 false —— 可第一条到得很快、后面还有成百上千条在路上。
  改为**安静期判定**：每来一条事件就把计时器往后推，连续 600ms 没有新事件才算
  回放结束；一条都不来时 2.5s 了结（队列中的任务本来就没有轨迹）。
- **★ 加载完成前不再渲染事件列表**（用户要求「未加载完成前不要展示或者影响上面的对话框」）。
  加载期间过程框只显示**不定长进度条**（总条数未知，不装成百分比）+ 已收到条数，
  头部的「N 条」与底部统计一并隐藏 —— 那些数字会从 0 一路往上跳，和进度条打架。
  列表用 `display:none` 藏而不卸载：`boxRef` 指着它，卸载后自动滚底的 effect 拿不到节点。
- **★ 执行过程的开合不再记忆，一律默认收起**（用户明确要求）。
  记忆反而有害：用户某次展开过，之后每次打开页面、每次切换任务都要重新付一次
  整条轨迹的回放代价，而他当时只是想看一眼。`cvw:procOpen` 已移除。
  自己刚提交的那一轮仍然展开。
- **★ 管理员新增示例时可直接上传示例片**（用户反馈「新增示例里面没有上传 video 的按钮」）。
  上传接口需要已存在的示例 id，所以**必然是两步**（先建示例、再传视频），
  于是存在「示例建好了、视频没传上」的半成功状态 —— 这种情况**单独一条黄色提示**
  说明示例已创建并引导去表格里补传，**不能笼统报「操作失败」**：
  那会让管理员按失败重试、建出第二条重复示例。
  选中文件用 `formatBytes` 显示大小（原来固定 MB，几十 KB 的小片显示成「0.0MB」，
  实测连 0 字节的空文件也显示 0.0MB，差点把夹具丢失误判成上传坏了）。
  历史表格里的上传/替换/删除保持不变，两边都能传。

### 修复（第四批：回放与实时没分清 —— 「阶段又走一遍」的真因）
用户实测：点开**已完成**任务的执行过程，条数从 0 跳到几百，旁边的
`GENERATING / FINALIZING` 跟着变，对话框也跟着跳。查出来是**两个**独立原因。

- **★★ 历史事件的 status/phase 被当成当前状态合进了界面**。
  SSE 从 `seq=0` 回放时，每条历史事件都带着**当时**的 `status` 与 `phase`，
  `onEvent` 逐条合并 ⇒ JobCard 把整个任务生命周期重演一遍：
  「生成完成」闪回「正在生成」、「阶段：」那一整块出现又消失，
  卡片高度一变上面的对话区就重排。
  更糟的是原来每条 `job.phase` / `job.heartbeat_status` 都 `void sync()`
  —— 回放时就是一串 HTTP，**实测 4.8 秒里发了 19 次**；正是这串 sync
  不停把状态纠正回去，才让短轨迹的任务看起来"没问题"，长轨迹上就压不住了。
  现在**回放期间一律不合并状态、也不 sync**，回放结束时统一 `sync()` 一次对齐
  （19 次 → **2 次**）。
- **★★ 后端新增回放结束哨兵 `job.replay_done`**（`GET /api/jobs/:id/events`）。
  前端必须能分清「这条是历史」还是「这是刚发生的」，而**靠时间猜不可靠**：
  轨迹几千条时事件一阵一阵来，中间的空档会让前端提前以为放完了
  —— 用户看到的「条数 0 → 几百 一路往上跳」就是这么来的（原来用 600ms 安静期）。
  哨兵发在回放循环之后、订阅实时流之前，**不带 `id:`**（否则污染 Last-Event-ID、
  断线重连会从一个假 seq 续传）。
  终态任务走另一条确定路径：回放里命中终态事件后端就 `finish()` 关连接，
  哨兵发不出来 —— 前端据「回放里出现终态」与「连接关闭」判定，同样确定。
  安静期降级为兜底（600ms → 2500ms），正常情况下根本不会触发。
- **★★ 点「展开」会把当前状态清空、阶段先倒退再追上来**。
  `useJobStream` 的依赖里有 `subscribe`，展开/收起也会让 effect 重跑，
  而里面不分情况地 `setJob(null)` —— 界面于是退回 `_workspace` 的
  `boot.jobs` 兜底快照（来自侧栏列表，比实时状态旧）。
  实测点开一个 RENDERING 的任务，阶段先闪回「生成中」再回到「渲染中」。
  改为**只在真的换了任务时才清空**（用 `lastJobId` ref 判断）。
  顺带一个好处：收起再展开时 `maxSeq` 得以保留，SSE 从上次位置续传，
  **不再把整条轨迹重放第二遍**。
- 加载态的验证改用 **CDP 限速 48KB/s**。同机房里 134 条事件的回放在一个突发里
  就放完了（<60ms），进度条确实只闪一下 —— 这种情况本来也不该显示它，
  而采样根本抓不到，于是正常行为被误判成"没实现"（先 `sleep 900ms` 采一次、
  后来 60ms 一次，都抓不到）。限速后回放拉长到几秒，才是用户那种长轨迹的真实体感。

实测（492s、134 条轨迹的已完成任务 + 一个 RUNNING 任务）：
展开全程**状态文案 0 变化、阶段 0 抖动、徽章 0 抖动、JobCard 高度 0 变化、
制作助手文本 0 变化、卡片 0 位移**；`/api/jobs` 请求 19 → 2。
限速下进度条正常出现、事件列表与条数全程隐藏。

### 修复（第五批：成片播放 —— 三件互不相干的事）
用户反馈「对话框的视频加载感觉很慢」「2 秒左右的视频第一次播放中间断了很多次，
不确定是不是内网问题」。排查结果：**跟内网无关**，是三个独立原因。

- **★★ `<video loop>` 让短片每一两秒顿一下**。成片常常只有 1~2 秒，而 `loop`
  每次回绕都是一次 seek：`readyState` 掉到 1 再回 4，浏览器连发
  `seeking → waiting → seeked`，画面跟着顿。
  A/B 实测（同一个 1 秒的片、8 秒观察窗）：
  **loop 开 → waiting 9 次 / seek 8 次；loop 关 → waiting 1 次（只有起播那次）/ seek 0 次**。
  而且**整段播放期间 `/playback` 请求 0 条**（全在浏览器缓存里）——
  这是排除网络的决定性证据。已去掉 `loop`，保留 `controls` 以便重播。
  2 秒成片实测：卡顿 1 次、seek 0 次、1988ms 正常播完。
- **★★ `moov` 原子在文件尾部 ⇒ 浏览器必须下完整片才能出第一帧**。
  `moov` 是索引，ffmpeg 默认写在文件**末尾**。实测 dev 上 8 个成片里 **3 个**如此
  （`['ftyp','free','mdat','moov']`），最大的 40.3MB、`moov` 就在 40.3MB 处 ——
  大片在慢链路上就是长时间黑屏，这才是「加载很慢」。
  现在钉住成片时顺手做一次 `-c copy -movflags +faststart` 重封装：
  **40.3MB 只要 0.09 秒**，视频流 md5 完全一致（画质无损），字节数不变。
  **安全第一**（这是任务收尾路径）：调用方先 `copyFile` 把成片落地钉住，
  重封装只写临时文件、ffprobe 校验通过才 `rename` 覆盖；
  没装 ffmpeg / remux 失败 / 产物异常都只告警并保留原拷贝，退化成改动前的行为。
  真任务验证：故意要求 agent 不加 faststart，它的输出是 `[ftyp,free,mdat,moov]`，
  我们钉住的那份是 `[ftyp,moov,free,mdat]`。
- **★★ 前端代理把成片流也套进了 120s 超时**。
  `AbortSignal.timeout(120_000)` 原来对【除 SSE 以外的一切】生效。
  40MB 的片子在 300KB/s 的链路上要 130 秒 → 120 秒被代理掐断 →
  浏览器拿到截断响应后重试，看起来就是「一直加载不出来 / 播一半断掉」。
  这类请求耗时由文件大小与客户端带宽决定，不是后端卡住，不该用超时兜。
  已把 `/api/assets/:id/{playback,download}` 与 `/api/examples/:id/video` 排除在外；
  其余接口的 120s 兜底保留。
- **★ 顺带补上 `width` / `height` / `duration_ms`**。两条上报路径
  （bridge 的 `onComplete` 与对账补判用的 probe）都是**固定字段列表**，
  job-runner 探到也白探 —— `result_asset` 里这三项**永远是 null**
  （实测 12 个成片无一例外），界面上「分辨率 · 时长」两项因此一直不显示。
  现在钉住后 ffprobe 探一次并沿两条路径带上（条件展开，探不到就不带这个键，
  不用 null 覆盖已有值）。`size_bytes` 也改取**钉住后**文件的实际大小 ——
  重封装会让字节数变化，而 `content-length` 是按磁盘实际大小发的。
  真任务验证：`1920 × 1080 / 2000ms`（之前全是 null）。

### 修复（完整性校验的判据原本是错的）
- **示例片「完整性」不能靠比对 `ffprobe` 的 `format.size`**。原方案这么写，
  **实测无效**：`format.size` 就是 ffprobe `stat` 出来的文件大小，不是容器内部声明值，
  两者**恒等**。把一个 faststart 的 mp4 砍掉一半，它照样报 `size=18701`（实际也是 18701）、
  `duration` 照样 1.0（moov 在前半段里）、streams 齐全 —— 那条判据拦不住任何东西。
  改为**整片解码校验**（`ffmpeg -v error -i <file> -f null -`，120s 超时兜底）：
  截断文件会报 `partial file` / `Invalid NAL unit size` / `Invalid data found`，
  实读 16 帧而非应有的 30 帧。三个样本实测：非视频 400、截断 400、完好 201。

### 测试
新增 `tests/risk/round-count.mjs`（8 项）、`resume-guards.mjs`（15 项）、
`stale-artifact.mjs`（8 项）、`assistant-text.mjs`（16 项）、
`example-video.mjs`（30 项，其中 4 项在真 ffmpeg 上构造截断样本，
**把「大小比对恒成立」这个证据固化下来**，防止判据被改回去）、
`assistant-text.mjs` 另扩充到 **43 项**（覆盖快照优先的顺序、回放缓冲、
安静期判定、加载期不渲染列表、开合不记忆）、
`adopt-token.mjs`（6 项，**功能测试而非 grep**：真起带 `CVW_JOB_TOKEN`
的子进程去问判活，覆盖 1.4.x 边车、别轮次残留、1.3.x 老边车、真死、无 pid；
已验证它在修复前确实变红）。
`asset-delivery.mjs`（28 项，含在真 ffmpeg 上证明「ffmpeg 默认把 moov 写在尾部」
与「faststart 后视频流 md5 不变」）。
风险回归 15 → **24 项**。

### 运维脚本（★ dev 的热更新原来是空转）
- **新增 `scripts/restart-service.sh`**（`bridge <worker_id>` / `gateway`）。
  `hot-update.sh` 原来的两条重启路径**都是坏的**：第一顺位
  `start-bridge.sh "$id"` 的 worker_id 走**环境变量** `CVW_WORKER_ID` 而非 `$1`、
  而且只启不停；第二顺位 `start-backend.sh restart-bridge` 这个**子命令根本不存在**
  （它只有 start|stop|status|logs）。两条都失败后落到
  「⚠️ 请用你的 bridge 启动脚本重启」然后**什么都没重启** ——
  维护态进出、cc 存活断言全都照常打印，服务却还是旧代码。
  新脚本按 **cwd 归属**停旧启新（同机并存线上/实验环境，模糊匹配会杀错），
  并等到 `registered=true` 才算成功；全程不碰 `pgrep -f`（它会匹配到脚本自己那条
  命令行，这个坑踩过三次，见 memory `pgrep-self-match-trap`）。
- `hot-update.sh` 的**自检改在前端所在机器上跑**：`release-check.sh` 的「单实例」
  与「公网入口」两段都只在那台成立（前者查本机进程、后者要能连 NodePort），
  在后端机器上跑必然假红两项。回退**只认 ssh 自身的 255** ——
  原来写成 `ssh … || 本机兜底`，而 release-check 有真失败项时也返回非零，
  于是「检查发现问题」被当成「连不上」，真失败项被兜底的假红噪声埋掉。
- `hot-update.sh` 自检前**先沉淀 8s，红了再重试一次**：顺序是「先 Bridge 后 Gateway」，
  Gateway 刚回来的那几秒各 Bridge 还在重新注册（实测热更新内 12/1、隔十几秒单跑 13/0）。

另外修了两处 `release-check.sh` **自身**的问题（它们会把好的部署判成红）：
- 「单实例」段按 cwd 查**本机**进程，而 dev 的前端在 `web.host`（10.120.6.65）、
  脚本常在后端机器跑 → N 必然是 0、永远红。改为只在前端所在机器上判，其余打印跳过。
- 同段 `$(pgrep -fc … || echo 0)`：`pgrep -fc` 计数为 0 时**既打印 "0" 又返回
  非零退出码**，于是拼成 `"0\n0"` → 算术展开语法错。改为 `| head -1 || true`。

## 1.4.0

### 变更
- **续跑改为 `cc --resume`，不再拷贝文件**。同一会话的各轮共用一个工作区，
  上一轮的 `src/`、`build/`、`output/` 原位保留；cc 的会话存储也在这个工作区的
  `.home/.claude/` 下，所以 `--resume` 找得到上一轮的对话，agent 记得自己做过什么。
  - 布局：`<sid>/workspace/`（agent 共享工作区）+ `<sid>/rounds/<jobId>/`（按轮次记录）。
    1.3.x 的老会话（`jobs/<jid>/`）由 `job-paths.resolveJobPaths` 回退处理，历史任务仍可读可播。
  - cc 会话 id **等于**我们的会话 id（取 `sess_<uuid>` 的 uuid 部分）：首轮 `--session-id`，
    后续轮 `--resume`。一个对话一个 cc 会话，排障时一眼对得上。
  - 不用 `--fork-session`：它每轮新建 id 并复制 13~24MB 日志，把一条连续对话切碎。
  - **失败退化**：resume 前先确认会话文件存在（`findCcSessionFile`），不存在就当首轮，
    不会因为带了不存在的 id 让 cc 启动失败、整轮白丢。
  - 实测（GATE 0）：真实 12.3MB / 1600 行会话 resume 成功，输入 282K token、**零压缩**、
    会话文件追加写入、单次调用约 $1.42；小会话 resume 比全新启动还省 token。
    resume **不会**必定触发压缩；压缩来自轮次累积抬高起点（第 2 轮从 ~282K 起步，
    离 420K 阈值还剩 138K），这一点后续看线上数据再决定是否加轮次上限。
  - 进程生命周期不变：`-p` 仍是回答完即退出，resume 是**新起进程读磁盘历史再退出**，
    不常驻、不占名额。已完成任务零 cc 进程残留。

### 修复
- **续跑串台**（线上 `yaotiankuo` 反馈）：基于 A 对话续跑，导入的却是 B（「一线万象」）的 SPEC。
  根因在前端 —— 展示的是 `focusJobId`，提交永远到 `boot.session`，
  而侧栏/创作历史点击只改前者。现在点开别的对话的任务会**一并切换当前对话**
  （`useSession.switchSession`，归属由 `GET /api/sessions/:id` 的 404 保证）。
- **输入框显示「基于哪个对话继续」**：`↻ 基于「…」继续（第 N 轮）`。
  之前续跑起来的会话和新对话长得一样，看不出在改哪一个。
- **跨用户泄露**：客户端传来的 `base_asset_path` 原本被原样用作继承基准（无 user_id、
  无路径校验），任何已登录用户都能继承别人的源码与成片。现在该字段不再参与任何判断，
  不安全的 `resolvePreviousJobDir` 已整段删除。
- **清残留失效**：`CVW_JOB_TOKEN` 改为 `<工作区>#<jobId>` 后，
  `kill-leftovers.sh` 原来那条 `CVW_JOB_TOKEN=$DIR(/|$)` 再也匹配不上，
  Chromium 会一轮轮堆积。脚本改为接收 token 参数并精确匹配；仍然只按归属、
  **绝不按进程名/模式**匹配（当年 `pgrep -f "chrome-linux64"` 把 cc 自己 SIGKILL 的根因）。
- **成片按轮次钉住**：工作区共用后，第 2 轮写 `output/final.mp4` 会覆盖第 1 轮的成片。
  收尾时**拷贝**到 `rounds/<jobId>/final.mp4` 并记为 `storage_path`。
  ⚠️ 必须是拷贝不能用硬链 —— 硬链只是同一 inode 的别名，而覆盖写普遍是 O_TRUNC
  原地截断，第 1 轮"钉住"的内容会跟着变。这是静默的数据损坏，
  由 `tests/risk/round-isolation.mjs` 守住（它就是靠这条测试发现的）。
- `verifyJobIsolation`（权限审计）、`listSessionJobs`（会话导出）、bridge 的轨迹回放与
  终态标记扫描，全部跟随新布局，并兼容 1.3.x 老会话。

### 测试
- 新增 `tests/risk/round-isolation.mjs`：按轮次簿记不互相覆盖、旧成片仍可读、token 每轮唯一。
- `tests/risk/argv-safety.mjs` **补进 `run-all.sh`** —— 它守着线上 `job_dc9fd3ab`
  那次「prompt 进 argv → agent 的 `pgrep -f` 把自己 SIGKILL」的事故，
  之前写了却从没被跑过。同时扩展断言覆盖新增的 `--session-id`/`--resume`
  （值只能是 uuid、不含 prompt/路径/chrome 字样）与清残留的 token 匹配。
  并加了一条**自检**：确认截出的函数体非空 —— 第一版因为把参数解构的花括号
  当成函数体起点，几条关键断言是空洞通过的。
- `scripts/e2e-checklist.sh`：原来断言 `src/` 被拷来、`previous/*.mp4` 存在，
  这两条在新机制下不成立。改为验证「同一工作区复用 + cc 会话 id ≡ 会话 id +
  两轮标记并存 + 两轮成片内容不同」。

## 1.3.12

### 变更
- **前端断连不再自动取消任务**：`config/backend.json` 的 `presence.timeout_seconds`
  从 600s 调到 **43200s（12h）**，与 `production.max_runtime_seconds` 一致。
  presence 的计时从最后一次心跳算起，而最后一次心跳不早于任务提交，
  所以 12h 上限总是先由 watchdog 命中，终态为 `FAILED(E_MAX_RUNTIME_EXCEEDED)`，
  不会再出现 `CANCELLED(presence_lost)`。
  起因：用户重启电脑导致心跳断 624s（阈值 600s，只超 24s），
  一个已跑 188 分钟、取消前 20 秒还在上报进度的健康任务被杀（`job_8addd244`）。
  代价：用户关掉网页后任务仍会跑到结束或 12h，期间占用并发名额并产生成本。

### 修复
- **去掉写死的"10 分钟"**：阈值改过之后，所有硬编码该数字的地方都变成了假话。
  - `apps/web/components/JobCard.tsx`：执行中的提示由"请勿关闭网页（关闭超 10 分钟将自动停止）"
    改为"生成在后端进行，关闭网页不会中断；重新打开本页即可继续查看进度"。
  - `apps/web/components/Dialogs.tsx`：首次使用说明由"请勿关闭网页"改为"可以关闭网页"。
  - `apps/gateway/src/presence.mjs`、`apps/web/features/useJobStream.ts`、
    `docs/DEPLOYMENT.md`：注释与运维说明改为指向配置项，不再复写数字。
  - 未动 `apps/gateway/src/watchdog-prompts.mjs` 里的 10 分钟 —— 那是过程框提示的
    去重窗口，与 presence 无关。

### 已知问题（本版未修）
- `presence.hidden_page_keeps_alive` 这个配置键**没有任何代码读取**，
  服务端从来没有实现"页面隐藏不算断"的豁免；前端的 `visibilitychange` 补偿
  只在用户切回来时才触发，对已经超时的任务无济于事。
  本版靠调大阈值规避，根因未修。
- 更稳妥的修法是让 `presence.mjs` 的 sweep 参考任务自身的心跳/进度新鲜度
  （`last_progress_at` gateway 本来就有），健康就不杀。留待后续版本。

## 1.3.11 — 2026-10-26

### 修复
- **侧栏「已完成」只显示 10 个，跑过的任务找不回来**。
  后端 `active-context` 里硬编码 `slice(0, 10)`，用户跑过十几个任务后
  早先的就不在列表里了（实测一个跑了 2 小时、42MB 的品牌片任务直接消失，
  用户找不到自己的成片）。
  - 上限放开到 **200**，并改为可配置（`production.recent_completed_limit`）。
    仍留上限：不设的话单次响应会随历史无界增长。
  - 侧栏「已完成」与「进行中」都加了**滚动容器**（420px / 300px）。
  - 实测：列表从 10 条变成 67 条，那个品牌片任务能找到了；
    容器 420px / 内容 4641px，滚动正常。

### 新增
- `docs/PERF_job_0820f4fb_brandfilm.md`：那个 137 分钟品牌片任务的耗时分析。
  结论：**Bash 工具占 68%、模型思考仅 25%、ffmpeg 编码只占 0.4%**；
  Bash 里 `sleep` 轮询等待占 63%（59.5 分钟，总时长的 43%）。
  真正的浪费是**分片渲染被反复整段重渲**（c3 渲了 4 次，拖尾约 53 分钟）——
  不过两次重渲都是 agent 自检发现真实画面缺陷后的修正，属质量换时间。
  **机器配额更正**：容器实际是 **16 核 / 64GB**（`cgroup cpu.max`），
  `nproc` 报的 128 是宿主核数；负载 17.4 说明 4 路渲染已满载，
  **并行度不是优化空间**。顺带记录一个待评估的容量风险：
  单任务 4 路就跑满 16 核，而 `per_machine_max_concurrent_jobs = 4`。

## 1.3.10 — 2026-10-26

### 修复
- **未鉴权请求可占用会话名额**（1.3.8 引入，1.3.9 仍在；线上自检报告
  `BUG-session-slot-unauth-touch.md`，已在 dev 复现确认属实）。
  1.3.8 加的统一打点跑在**鉴权之前**，于是任何无 token 的 `/sessions/:id` 请求
  也会创建名额 —— 返回 401，但名额已占掉。
  dev 实测：5 个 401 请求让名额从 0 涨到 5；8 个即可占满一台（`max_sessions=8`），
  真实用户随后新建对话拿 `503 PROCESS_UNAVAILABLE`。
  **正是 1.3.8 要修的那个故障换了个入口回来。**
  - **鉴权上提到分发层最前面**，在任何有副作用的动作之前。
    `GET /health` 走 `PUBLIC_ROUTES` 白名单（监控在用，不能一刀切拦掉）。
  - **`touchSession` 不再凭空创建**，只刷新已存在的会话；
    占名额统一走新增的 `registerSession`，入口收敛为 3 处
    （建会话 / 派任务 / 认领在跑任务）。
  - **`DELETE /sessions/:id` 不再先 touch**：它的语义是释放，
    先 touch 会让 `releaseSession` 永远返回 `true`，`released` 字段失去诊断价值。
    修复后对不存在的 id 正确返回 `false`。
- **顺带修掉两个会造成「超卖」的漏算**（报告未提，是收紧 `touchSession` 时发现的）：
  - `POST /jobs` 原先用 `touchSession`，但 bridge 重启后 `sessionSeen` 是空的，
    老会话来派任务会 touch 失败 ⇒ 名额算不上，实际在用的会话不占名额。改为 `registerSession`。
  - `adoptRunningJobs` 认领在跑任务时没有登记其会话 ⇒ 同样超卖。补上登记。

### 变更
- **上下文长度与压缩率改为显式可配置**（原来上下文是跟着模型上报值走的）。
  - `model.max_context_tokens` 固定 **524288（512K）**，并把
    `model.auto_detect_context` 关掉 —— 开启时 bridge 启动会用 `/v1/models` 的
    `max_model_len` **覆盖**配置值，实际生效值不由我们决定。
    （顺带确认：模型当前上报的也是 524288，与配置一致。）
  - 新增 `model.autocompact_pct = 80` → `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`。
    压缩阈值 = 512K × 80% ≈ 419K token 时开始压缩。
  - 两者对**视频生成与白模生成都生效**（`buildChildEnv` 不分 mode，共用 `claude_cli.env`）。
  - 实测 cc 进程实际拿到：`CLAUDE_CODE_MAX_CONTEXT_TOKENS=524288`、
    `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80`。
  - 改法与行号见 `docs/CONTEXT_COMPACT_CONFIG.md`（给后续手动调参的人）。
  - ⚠️ `${model.xxx}` 占位符是**白名单式**的，在 `job-runner.mjs` 的
    `resolveClaudeEnv()` 里登记；不登记会被替换成空串并被当作"不设该变量"丢掉，
    配置看着改了却静默无效。本次已把 `model.autocompact_pct` 登记进去。

### 新增
- `docs/CONTEXT_COMPACT_CONFIG.md`：上下文长度与压缩率的配置路径、**行号**、
  调参建议、以及"改完怎么确认真的生效"（只看配置文件不算确认）。
- `tests/risk/session-slot.mjs` 扩充到 **22 项**，新增 8 项覆盖本缺陷：
  鉴权必须在打点之前、`/health` 白名单、DELETE 不 touch、
  `touchSession` 不创建、登记入口唯一、派任务与认领都要登记。

## 1.3.9 — 2026-10-26

### 变更
- **移除生成任务 prompt 里的「Context budget (hard limit)」一节**（按用户要求换回原样）。
  它原本是为一个真实事故加的：某任务把 17 张 jpg 读回上下文（单张最大 30 万字符
  ≈10 万 token），57 分钟后以 `Prompt is too long` 失败、产物全丢。
  但实测反馈这段硬约束**把成片质量带下来了** —— 禁止看帧之后 agent 只能靠数值自检，
  画面问题发现不了。用户判断质量优先，宁可承担偶发的上下文耗尽
  （上下文真爆了还有兜底：`HOME` 指向 `.home` 后 claude 的自动压缩是可用的，见 1.2.0）。
  > 说明：这段在 `job-workspace.mjs` 的 output contract 里，只跟着【生成任务】下发；
  > 增强 prompt（dense_prompt_template + agent loop）从来不含它。
  > 以后若要加回来，别再用「Never Read a frame」这种一刀切写法，
  > 建议只限制张数与分辨率（如允许抽检 1~2 张缩略图）。

### 修复
- **切换对话后画面仍来回跳变**（1.3.7 修了连接泄漏，但跳变还有另一半原因）。
  根因是渲染顺序：切换时 `processEvents` 被同步清空，而 `liveJob` 在新数据到达前
  **还是旧任务的**，于是界面连跳三拍 ——
  「旧卡片 + 空过程框」→「新任务的旧快照」→「HTTP 回来后定格」。
  - 切 job 时把旧 job 数据一次性清干净（含 `setJob(null)`）。
  - `job` 取值加 id 校验：`liveJob` 必须 `id === activeId` 才采用，
    挡住 boot 缓存里的错配；并把 `runningJobs`/`recentJobs` 也纳入兜底来源，
    让切换瞬间就有当前任务的数据，不再出现空窗。

## 1.3.8 — 2026-10-26

### 修复
- **会话名额只增不减，机器闲着却建不了新对话**（严重，影响用户体验）。
  `activeSessions` 原本是个只有 `add`、**没有 `delete`** 的 Set ——
  名额只能靠重启 Bridge 清零。满了之后新建会话报 `503 PROCESS_UNAVAILABLE`，
  **而那时任务槽往往是空的**。
  线上核查：DB 里 73 个 ACTIVE 会话、每台 13~17 个（远超 `max_sessions=8`），
  只因五台 Bridge 近期都重启过才没出故障 —— 靠的是重启，不是机制。
  活跃度实测：73 个 ACTIVE 里只有 4 个在 1 小时内有动作。
  - **释放判据复用「对话结束才展示视频」那一套：`store.isTerminal(status)`。**
    会话在不在工作，由它的任务是否终态决定，所以**成功 / 失败 / 用户停止**
    三条路径天然统一，挂在 `complete` / `fail` / `cancel-ack` 三个终结回调上。
  - **只还名额，不删任何东西**：工作区、产物、轨迹全保留；
    用户回来继续微调时 `touchSession` 自动重新计入。
  - **多 session 并行不受影响**：新建会话**不是**释放条件 ——
    产品支持同时开多个会话体验，开几个就该占几个名额。
  - 兜底：用户直接关浏览器没有任何信号，靠 `sessionIdleTtlMs`（默认 30 分钟，
    `CVW_SESSION_IDLE_TTL_MS` 可调）回收。主路径是终态释放，TTL 只兜底。
  - Bridge 新增 `DELETE /sessions/:id`（只释放名额），Gateway 侧 `bridge.releaseSession`。
- **槽位释放后排队任务要白等一个 tick**。原来三个终结点只释放不唤醒，
  排队任务最多干等 2 秒（dispatcher 轮询周期）；高峰期每个任务都多等，
  用户会觉得"明明有人做完了却没动静"。
  现在三个终结点 + watchdog 的 `releaseSlot`（**7 个调用点在这一处收口**）
  都会立刻 `dispatcher.tick()` 出队。

- **切换对话后会话 ID 不变，用户报障时给的 ID 是错的**。
  侧栏那个「复制会话 ID」一直显示 `boot.session.id`，**只有新建对话才变**；
  用户切到别的对话（已完成或进行中）去看，复制到的还是旧 ID，
  报上来的 ID 和他描述的现象对不上 —— 等于定位不了。
  改为显示**当前在看的那个任务所属的会话**（`job.session_id`），切换即跟着变。
  跨会话时额外标注「正在查看另一个对话」，避免 ID 与上方 mode 徽标错配造成困惑。
  实测：侧栏 13 个任务来回切，出现 4 个不同 ID，跨会话标注正常。

### 新增
- `tests/risk/session-slot.mjs`（14 项）：守住名额可增可减、判据复用 `isTerminal`、
  **多 session 并行不被误回收**、槽位释放后立刻出队。
- `tests/risk/session-id-display.mjs`（7 项）：守住侧栏 ID 跟随当前对话。

## 1.3.7 — 2026-10-26

### 修复
- **切换会话导致页面来回跳变 / 任务在跑却不滚动 / 显示别的任务的产物**
  —— 三个现象是**同一个 bug**：`useJobStream` 的 SSE 订阅存在竞态。
  订阅是在 `sync()` 的**异步回调**里才建立的，而 React 的 cleanup 是**同步**执行的。
  用户快速切 session 时：
  `effect(A) → sync(A) 发出 → 切到 B → cleanup(A) 跑（此时 unsub 还是 null，什么也没断）
  → sync(A) 返回 → subscribeJob(A) 建连` ⇒ **这条连接永远没人关**。
  线上实证：`sse.open` 255 次、`sse.close` 仅 139 次，**净泄漏 116 条**，
  并发连接数从 14 一路爬到 55；单个 job 被 open 15 次且每次 `last=0`。
  僵尸连接的 `onEvent` 闭包持有**旧 job 的 setState**，会把别的任务的状态盖到当前界面上。
  - 修法①（根治）：effect 内加 `cancelled` 标志，cleanup 第一件事置位；
    异步回调建连前先判 `cancelled`，已失效就不再订阅。
  - 修法②（第二道防线）：`onEvent` 丢弃 `cancelled` 后的事件，并校验 `e.job_id === jobId`，
    任何残留连接都污染不了当前界面。
- **产物可能在对话未结束时就被取到**。`publicJob` 早已按终态门控，但另外三个出口漏了：
  - `/api/admin/gallery` 的 `playback_url` 只判 `state === 'READY'`；
  - `GET /api/assets/:id` 元数据接口没判终态；
  - **`serveAsset()` —— 真正吐视频流的闸门也没判**，意味着知道 URL 规则就能直接拉到中间版本。
  四个出口现已统一按 `isTerminal(status)` 门控，**对话真正结束才给产物**。

### 新增
- `tests/risk/sse-leak.mjs`（8 项）：守住切 session 不泄漏连接、事件归属校验。
- `tests/risk/asset-gating.mjs`（5 项）：守住四个产物出口的终态门控，防回退。
- `docs/SESSION_SLOT_RISK.md`：**会话槽只增不减**（验证 1.3.7 时发现，非本版引入，
  线上现有版本同样存在，**本版未修**）。`activeSessions` 是个只有 `add`、
  没有 `delete` 的 Set，会话槽只能靠重启 bridge 清零。
  满了之后新建会话报 `503 PROCESS_UNAVAILABLE`，**而那时任务槽可能是空的**。
  线上核查：DB 里 72 个 ACTIVE 会话、每台 13~17 个（超过 `max_sessions=8`），
  但 `PROCESS_UNAVAILABLE` 零命中 —— 靠的是五台 bridge 近期都重启过，不是机制兜底。
- `docs/PUBLIC_EXPOSURE_REVIEW.md`：公网暴露风险调研（只给建议，未改代码）。
  结论：注册必须凭邀请码这道闸是有的，不会被白嫖算力；
  但**完全没有限流**，登录爆破与单用户刷任务是上公网前最该补的两项。

## 1.3.6 — 2026-10-26

### 新增
- **提示词增强改为 agent loop**（原来是单轮一问一答）。
  起一个**独立的 cc 进程**跑增强，它可以 `WebSearch` / `WebFetch` 查真实做法，
  方案比凭记忆写的靠谱。实测该 key 联网可用：API 层单次搜索返回 10 条带 URL 的结果，
  cc agent loop 里也真的调用了 `WebSearch` 并带回引用。
  - **与生成用 cc 完全隔离**：不同 host（tokenhub）、不同 key（opus 5.5）、默认配置，
    显式清掉 `ANTHROPIC_DEFAULT_*` / `CVW_JOB_TOKEN` / `NO_PROXY`，不串用。
  - **不占 worker 的生成并发槽**（它跑在 Gateway 机器上，不经 Bridge）。
    自己有一个 `max_concurrent`（默认 6）只为防高峰压垮 Gateway。
  - **绝不 block 排队**（这是本功能最要紧的约束）：
    超时先 SIGTERM、宽限 5 秒后 SIGKILL，按**进程组**整树终止；
    且**名额在 `finally` 里释放，不依赖进程是否真的死掉** ——
    进程泄漏最多浪费点机器资源，绝不能变成「增强名额耗尽 → 新任务永远卡在 ENHANCING」。
    实测：一个 `trap "" TERM` 忽略 SIGTERM 的进程，2.4 秒被 SIGKILL 清掉，调用正常返回。
  - **任何失败都自动降级**：agent 起不来/超时/报错 → 退回原来的单轮；单轮再失败 → 原始 prompt 直投。
    增强始终是锦上添花，不能让它影响出片。
  - `/healthz` 新增 `enhance_agent`（`inflight` / `max_concurrent`），运维可见。
- **增强模板明确告知可以联网**，并说明 `WebSearch`/`WebFetch` 是 cc 的 **deferred 工具**
  （必须先经 `ToolSearch` 加载才能调用，`allowed_tools` 漏掉 `ToolSearch` 就永远搜不了），
  以及「先搜索、最后才输出 JSON」——否则结尾那句「只返回 JSON」会把工具调用一起压掉。
  实测行为是**按需搜索**（这正是想要的）：
  问韦布望远镜镜片数量/镀金材料/口径 → 不搜，直接写，且 18 片、铍基镀金、6.5 米、
  镀层约 100 纳米全部正确（模型本来就知道，搜了是浪费时间）；
  问「2026 年 10 月这周的 AI 新闻」→ 自动 `ToolSearch → WebSearch ×2 → WebFetch`。

## 1.3.5 — 2026-10-26

### 修复
- **任务自杀：`制作引擎异常退出 code=null signal=SIGKILL`**（线上 `job_dc9fd3ab`「鹈鹕骑车」，
  用户 00:28 截图的那次）。**不是基础设施问题，是 agent 把自己杀了。**
  cc 的 prompt 原样进了命令行（`claude -p <整段 prompt>`），而这次 prompt 里含
  `runtime/browser/chrome-linux64/chrome`；agent 清理残留浏览器时执行
  `for p in $(pgrep -f "chrome-linux64"); do kill -9 $p; done`，
  `pgrep -f` 匹配的是**整条命令行**，于是把 cc 自己匹配上了 —— 当场 SIGKILL。
  实测抓到证据：`pgrep -f chrome-linux64` 命中
  `claude -p Create a 2-second MP4 ... chrome-linux64/chrome`；轨迹正好终止在那条命令。
  **根治：prompt 改走 stdin，不再进 argv** —— 命令行里没有它，任何 `pgrep -f` 模式
  都不可能再误伤 cc 本体。实测修复后 cc 的 cmdline 只剩
  `claude -p --permission-mode ... --disallowedTools WebSearch`。
  同时在 4 个 SKILL.md 里把「不要按名字/模式杀进程」写成明确禁令
  （原文只提了 `pkill -f`，agent 换成 `pgrep -f | kill` 就绕过了）。
- **多轮微调等于从零重做**（同事反馈「没法多轮」）。
  `is_revision` 在前端和增强环节都生效（微调不走增强），但**工作区是全新空目录** ——
  用户说「把球改成绿色」时，agent 既看不到上一版视频也看不到上一版代码，
  只能凭这一句话重做一个，结果当然对不上。
  改为微调轮**继承上一轮的工作区**：`src/`（上一版源码）、
  `previous/final.mp4`（上一版成片）、`SPEC.prev.md`，
  并在 prompt 里明确「这是修改，不是新视频；改最小的地方，其余保持不变」。
  `base_asset_path` 原本只是传来传去从未被使用，现在真正用上了。

### 新增
- `scripts/e2e-checklist.sh`：发版前**真跑一轮**（生成 2 秒动作视频 → 微调一次），
  校验产物可播放、微调确实继承了上一轮、全程无 SIGKILL。
  上面两个问题 smoke/release-check 都查不出来 —— 只有真跑才会暴露。
- `tests/risk/argv-safety.mjs`：守住「prompt 不进命令行」与 SKILL 禁令，防回退。

## 1.3.4 — 2026-10-25

> 热更新机制就位。**本版自身的部署仍会中断正在运行的任务**
> （线上现在跑的是 1.2.0 的 Bridge，cc 子进程挂在管道上，父进程一退出就被杀）。
> **本版装上之后，下一次更新才是真正的热更新。**
>
> 注：开发期曾以 1.3.3 定版，之后又补了认领容错加固与回车禁用，
> 两者均未对外交付，故合并进位为 1.3.4 发布。

### 变更
- **输入框回车不再发送，只换行**。创作型 prompt 常要分几行写，
  回车即发很容易把半截内容提交出去 —— 一次误发就是一个几十分钟的任务和一次排队。
  改为只能点「发送」按钮，placeholder 同步改为「换行请直接回车，写完点右侧「发送」」。
  （登录框、管理后台等单行输入的回车提交不受影响。）

### 新增
- **热更新：更新期间任务不中断，用户可见「正在更新」**。
  - cc 子进程的 stdout/stderr **从管道改为直接写文件**。这是整件事的地基：
    实测管道模式下 Bridge 一退出，cc 立刻被 SIGPIPE 杀掉；改写文件后无限存活。
    （原来 `shutdown()` 里"不杀正在跑的任务"的注释，意图对，但被管道事实上否决了。）
    实时解析改为增量 tail `claude.jsonl`（`log-tailer.mjs`），只推进到最后一个换行，
    残缺行留到下一轮 —— 没有管道可以重发，丢了就永久丢。
    已实测排除块缓冲风险：轨迹跟着事件增量增长（t=8s +319B、t=15s +319B）。
  - **Bridge 重启后自动认领**仍在运行的任务（`job-adopter.mjs`）：
    边车记录 pid/pgid/starttime/lease_token，启动时按 `/proc/<pid>` 的 starttime
    与 `CVW_JOB_TOKEN` 双重校验（防 pid 复用）认领回来，从轨迹末尾续读。
    空窗期里已自行结束的补判终态，死掉又没有标记的补写失败 ——
    不做这一步用户会永远看到「进行中」。
  - **维护标记**落 `runtime/gateway/maintenance.json`，Gateway 与 Bridge 共读。
    带 `expires_at`，过期即失效：部署脚本崩了也不会把输入框永久锁死。
    维护期间**只挡写不挡读**，正在跑的任务照常显示进度。
  - 前端顶部蓝色横幅「系统正在更新，请稍候…」，输入框与新建对话禁用，更新完自动恢复。
  - `scripts/hot-update.sh`：先逐台重启 Bridge、再重启 Gateway
    （Gateway 在线时注册即改绑，赶在第一次心跳的归属校验之前）。
    每台重启后**断言 cc 子进程仍活**，不活立即中止、不动第二台；
    `trap` 保证异常退出也清掉维护态。
- **长 prompt 可展开**（`PromptBubble.tsx`）。接口的 `prompt_summary` 只有 300 字符
  （服务端截断，实测 1140 字符会被从句子中间切断），而完整内容本就在同一份响应的
  `original_prompt` 里 —— 超过 200 字符即折叠，点「展开全文」看全部。纯前端改动。

### 加固（上线前专项压测补的）
- **一条坏边车会让整轮认领中断**（压测发现，已修）。损坏的 JSON / 缺字段的边车
  会让 `adoptRunningJobs` 抛出，虽然外层 try 保证 Bridge 仍能启动，
  但**同批其它健康任务会全部漏掉认领** —— 漏掉就没人看着，也就永远写不出 `.done`。
  改为逐条隔离：字段白名单校验 + 每条独立兜底 + `hooksFor` 自身异常也接住。
  实测：2 条坏记录 + 1 条健康记录 → 坏的跳过，健康的照常认领。
- **维护标记无 `expires_at` 时可能永久锁死**。`begin()` 总会写过期时间，
  但手工置位/旧格式不会。补了绝对上限（按 `started_at` + `max_window_seconds`），
  Gateway 与 Bridge 两侧都加。维护标记卡住 = 全站只读，比漏一次维护严重得多。
- 新增 `tests/risk/`：**失效模式**回归（正常路径由 smoke 覆盖，这里专测"坏掉会怎样"）。
  覆盖并发账本、tail 解析、认领边界、损坏数据、故障隔离、自愈边界、维护标记 fail-open，
  共 8 组。改 `job-runner` / `worker-pool` / `maintenance` 后必跑。

### 修复
- **排队卡死：只有 2 个任务却在排队**（同事反馈的线上现象）。三个独立缺陷：
  1. Bridge 每次重启都换 `process_instance_id`，而改绑只改了会话、**没改任务自己的**
     `process_instance_id` ⇒ `canAdmit` 永远回 `PROCESS_UNKNOWN`，
     这些任务**永远排队，机器却是空的**。新增 `rebindJobsToNewProcess()`，
     并在 dispatcher 里加自愈：发现绑定实例消失而同机有健康实例就自动改绑。
  2. 派发后的"乐观 +1"会被 Bridge 真心跳（12s 一次）覆盖清零，**同一个槽重复发放**。
     改为并发计数以心跳为唯一真相 + 带 TTL 的派发预留覆盖启动空窗。
  3. 局部心跳把 `running_job_ids` 写成 `?? []`，**清空了反向对账的依据**。
     改为仅在字段存在时覆盖。
- **热更新期间两条会"把救回来的任务亲手杀掉"的路径**（改之前确认真实存在）：
  - 心跳的归属校验对任何实例不一致都下 `abort_not_owner`，**12 秒内就会杀掉**
    刚认领的任务。改为同一 worker 的新实例 ⇒ 改绑，绝不 abort。
  - Bridge 在心跳连续失败 `lease_ttl×3`（**6 分钟**）后"自保停止"，
    Gateway 重启超过 6 分钟就会杀光所有任务。维护期跳过该分支，维护结束自动恢复。
- **Gateway 重启后任务闪「状态不明」**：watchdog 加 90 秒启动宽限；
  `bridgeUrlFor` 找不到实例时按 worker_id 回退到配置地址，
  不再因为拿不到地址就走「进程不存在 ⇒ 判死」分支。
- **认领来的任务没有退出码**：`settle()` 原本按 `code===0` 判成功，会把认领到的
  成功任务全判失败。改为以轨迹里的 `result.is_error` 为准，无则回退退出码。

## 1.3.2 — 2026-10-25

> 在隔离环境（`code2video-dev`）开发验证，经 v1.3.0-dev.0 / dev.1 / dev.2 三个开发版，
> 合并为本正式版本同步线上。
> 本版隔离环境已整体迁至 `/mnt/afs_if`（见「运维」），**线上迁移由集成方另行决定**。

### 修复
- **任务「跑一半结束」的真正原因**（线上 `job_fc8e0e14` 鹈鹕骑车）。
  之前归因为「阈值太短」只对了一半 —— **判据本身就是错的**：
  提前收尾只看「成品文件多久没变」，而这衡量的不是 agent 还在不在干活。
  cc 产出一版后通常继续写代码、调参、重渲，期间根本不碰成品文件。
  实测轨迹：`final.mp4` 07:01 落盘，cc 随后仍在调试
  （末尾是 `noise() takes seconds, I passed sample counts` 加三条 Bash 调试命令，
  它正要修一个物理参数 bug），90 秒后被 SIGKILL，97 秒后写 `.done`。
  用户看到的就是「跑一半结束」，且交付的是没修完的那一版。
  改为**两个阈值同时满足**才收尾：成品静置 10 分钟 **且** agent 静默 15 分钟
  （`st.lastProgressAt` 由 stream-json 事件 / stderr / 工作区 mtime 共同刷新）。
  真卡死仍兜得住，正常迭代不再被误杀。两个阈值都入 `config.limits`。
- **新建对话后「智能扩写」保持关闭**。点过示例会把扩写关掉（设计如此），
  但新建对话 / 切换模式时没有重置，用户新开一轮仍是关的，与「默认打开」不符。
  两处会话重建点都已重置为开启。
- **`enhance` 开关可能按旧值提交**：`submit` 回调读了 `enhance` 却没把它列入依赖，
  闭包捕获旧值 —— 用户改完开关立即发送会按上一次的设置走。已补依赖。

- **呈现的是中间版本而非成片**（线上 `sess_09d06d8f`）。两处原因：
  1. 产物挑选按「文件体积最大」—— 中间渲染常比成片还大
     （实测 `build/video_v1.mp4` 21.5MB vs `output/final_v1.mp4` 22.3MB，仅差 3%）。
     改为按交付语义：排除 `build`/`work`/`chunks` 等中间目录，
     `output/` 优先，文件名含 final/deliver 加权、含 test/draft/preview 降权，
     最后才比时间，**不再比体积**。
  2. 任务未结束时就下发 `result_asset`，用户把中间产物当成品。
     改为**只在终态（成功或失败）才下发**；执行过程照常实时显示。
- **模型上下文配置只有实际的一半**：配 262144，而 `/v1/models` 返回
  `max_model_len=524288`。复杂任务因此提前触发压缩甚至失败。
  已改为 524288，并支持**启动时自动探测**（`model.auto_detect_context`），
  探测失败沿用静态值，不影响启动。

### 新增
- **发送处可关闭「智能扩写」**（默认开启）。关闭后用户 prompt 直接投产，不做改写。
- **管理员可维护示例 prompt**（管理后台「示例」页签）：标题/模式/备注/内容，
  可隐藏、删除、查看使用次数。所有用户在左栏看到对应模式的示例，
  **点击即填入并自动关闭扩写** —— 示例本身已是扩写后的完整方案。
  无白模权限的用户看不到白模示例。
- **cc 启动参数改为配置项**（`claude_cli.env`），支持 `${model.*}` 占位符：
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS=524288`、`CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000`。
  调参不再需要改代码。

### 变更
- bench_runner 对比方案经确认后采纳：5 项环境变量保留，
  40 分钟 timeout / `ANTHROPIC_AUTH_TOKEN=dummy` / `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE`
  / `QWEN_CLAUDE_CONFIG_DIR` 四项确认不采纳（理由见 `docs/BENCH_RUNNER_DIFF.md`）。

- **缓存落点显式化**（`config.shared_caches`）。遮蔽 `/mnt` 是必须的
  （实测不遮蔽时 `find / -maxdepth 6` 要 120 秒以上，maxdepth 5 也要 28 秒），
  代价是任何默认落在 `$HOME` 下的缓存在每任务新建的 `.home` 里都是空的 ——
  已经踩过两次（HOME 本身 ENOSPC、whisper 模型 HF_HOME）。
  现在把已知大缓存（npm / uv / matplotlib）统一钉到 `/var/tmp/cvw-cache`
  （本地 overlayfs，跨任务共享，不在遮蔽范围内；`/opt/videokit` 是 root 只读的）。
  路径不存在的条目自动跳过。**新增带缓存的依赖时按同样方式加一条。**

### 运维
- **整个 dev 环境迁到 `/mnt/afs_if`**。`/mnt/afs_toolcall` 已 **100% 写满**
  （150T 用尽，Avail=0），登录直接报
  `ENOSPC: no space left on device` —— 这不是我们的用量问题
  （dev 全量仅 1.1G），是整个共享盘被占满。
  新根目录：`/mnt/afs_if/codevideo/workspace/code2video-dev`（10T，用量 18%）。
  已迁代码 / 配置 / runtime 数据 / 运行时依赖，14697 个文件逐一核对，
  关键文件 md5 全部一致；配置与脚本里 12 个文件的旧绝对路径已改写。
  **线上未做任何处理**（仍在 afs_toolcall，由集成对话决定何时迁）。

### 文档
- `docs/BENCH_RUNNER_DIFF.md`：与同事 `bench_runner` 启动配置的逐项对比，
  含采纳/不采纳的完整理由，方案已确认。
- `INTEGRATION.md`：集成指引。**`config/backend.json` 不可整体覆盖线上** ——
  其中路径、worker、`environment` 等 12 处为隔离环境专用值。

## 1.2.0 — 2026-10-24

> 在隔离环境（`code2video-dev`）开发验证，经 v1.1.0-dev.0 / dev.1 两个开发版，
> 合并为本正式版本同步线上。

### 修复
- **复杂任务跑到一半失败、产物全丢**（线上 `sess_6b2e76dc` / `job_356f7a34`，47 分钟白跑）。
  表面报「内容过于复杂」，日志实证是
  `Prompt is too long · automatic compaction failed: ENOSPC: no space left on device`。
  claude 本可自动压缩上下文继续跑，但 `HOME=/mnt/afs_toolcall/codevideo` 落在
  被任务隔离遮蔽的 `/mnt` 里 —— 压缩时写不了会话文件 → 报 ENOSPC → 整个任务失败。
  **磁盘其实是空的**（两个卷都有 TB 级余量），写不进去的是被遮蔽的路径。
  修复：`HOME` / `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` / `CLAUDE_CONFIG_DIR`
  改指向任务工作区内的 `.home`（命名空间内可见可写、随 job 清理），并预建目录。
  实测：`.home/.claude/projects/*.jsonl`（压缩读写的 transcript）可正常写入 530KB；
  历史数据显示峰值 >6M token 的任务此前全部失败、<2M 的全部成功 —— 压缩是跨过该线的关键。
- **同时跑 2 个任务时对话历史显示错乱**。`active_session` 只按 `last_activity_at`
  取最新 ACTIVE 会话，用户新建对话后，正在跑任务的旧会话被挤掉，看起来像「任务不见了」。
  改为**有任务在跑的会话优先**。

### 新增
- **排队可见性**：任务卡与侧栏显示「排队第 N/M 位，前面还有 K 个」。
  位置用与 dispatcher 相同的 `queued_at` 排序计算，保证与实际出队顺序一致。
- **管理员实时压力面板**（画廊页顶部）：并发用量、排队数、理解需求数、负载率、
  各 worker 槽位与健康状态，以及正在执行 / 排队等待的任务明细
  （用户、模式、阶段、已跑/已等时长、prompt）。
- `/healthz` 增加 `environment` 字段（dev/prod），前端显示环境角标，避免误把开发当线上。

### 已知问题（不在本版修复）
- `dense_prompt_template.md` 没有长度约束：用户原话 2746 字符会被放大成 20697 字符
  （7.5 倍）。历史数据：成功任务增强长度中位 5990、最大 13356；失败任务中位 7862、
  最大 20697。属 skill 模板范畴，经确认**本版不改** —— 产品主打复杂任务，
  依靠上下文压缩跑完即可。若后续出现压缩也追不上的任务，需再评估。

---

## 1.1.0-dev.0 — 2026-10-24

### 变更
- 从线上 v1.1.0 拷贝建立隔离开发环境，起点与线上一致。
- 全部落盘路径与后端地址改为隔离资源：
  - 控制面 `code2video-dev/runtime`（线上为 `coding-video-web/runtime`）
  - 会话数据 `afs_if/.../session-dev`（线上为 `afs_if/.../session`）
  - 后端 `10.120.3.60` / `10.120.3.50`（线上为 `10.120.0.161` / `10.120.0.175`）
  - 前端 `10.120.6.65:8000`，公网 NodePort `10.210.9.14:30543`
- `base_path` 置空（本环境经 NodePort 直连根路径）。
  **机制保留**：线上经 Kong 子路径转发，集成时须填回前缀并重新 build。
- 新增 `scripts/guard-isolation.sh`（8 项隔离校验），并接入 `start-frontend.sh` /
  `start-backend.sh` —— **校验不过拒绝启动**。开发机与线上共享存储且对线上目录可写，
  隔离只能靠"配置里没有任何一条指向线上"，不能靠权限。
- `/healthz` 增加 `environment` 字段（dev/prod），避免把开发环境误当线上。

---

## 1.1.0 — 2026-10-24

### 修复
- **会话心跳只覆盖当前对话，导致旧对话的任务被误杀**（线上事故，连续影响 3 个会话）。
  用户新建对话或切走后，原会话不再收到心跳，10 分钟后被 `presence_lost` 停止，
  表现为"任务跑一半没了"。改为对**所有仍有任务在跑的会话**同时发心跳。
- **侧栏「进行中」不显示其他对话的任务**。缺少定时刷新，只有操作当前对话才会更新。
  改为 20 秒轮询一次全局快照。
- 任务过重导致上下文耗尽时，错误码与文案不可理解（见 1.0.1）。

### 新增
- 模型对外命名 **SenseNova 6.8 Code2Video**，前端统一显示该名称。
- **提交后可停止并改写**：误发时不必新建对话，停止当前任务即可编辑重投。
- **切换模式自动开新对话**（仅在无任务运行时允许），不再提示"新模式将在新建会话时生效"。
- **增强后的 prompt 可查看**：对话区单独保存，专业用户可参考与复用。
- **会话历史**：按时间排列，分「进行中 / 已完成 / 已放弃」，可回看视频、复制 prompt 复现。
- **管理员画廊**：查看全部用户的任务、prompt、耗时、是否成功出片，以及活跃度统计。

### 变更
- 引入版本管理：根目录 `VERSION` + 本 CHANGELOG，前后端同号。
- 新增 `scripts/release-check.sh`（14 项发布检查）。**发布前必跑，失败不交付。**
  `start-frontend.sh start` 启动前校验构建 basePath，与配置不一致直接拒绝启动 ——
  公网整站打不开已发生两次，根因都是构建丢了子路径前缀。

---

## 1.0.1 — 2026-10-23（上线后热修，未单独发版）

### 修复
- 白模任务找不到 Chrome：`hide_paths` 遮蔽 `/mnt`，而 Chrome 装在其下。
  改为 bind 到命名空间内浅路径，不再每任务自行下载 250MB。
- 并发提交可绕过幂等，一次点击产生多个昂贵任务（实测 10 次并发 → 10 个任务）。加 per-key 串行锁。
- 并发写损坏 job 记录：临时文件名只精确到毫秒，同毫秒互相截断。加序号与随机后缀。
- 一台 worker 失联会占满全局并发，健康机器接不到任务。
- 孤儿任务永久卡 RUNNING：进程消失时对账无限退避。超时后判 `ORPHAN_NO_EXECUTOR`。
- 12 小时超时显示为"已取消"，改为失败 `E_MAX_RUNTIME_EXCEEDED`。
- `processes` 计数只增不减。

### 安全
- **前端屏蔽技术栈关键词**：错误码、失败原因、执行过程、模型名统一脱敏；
  API 不再下发 `enhancement.model`。后端日志保留真名以便排障。
- 上下文预算约束写入输出契约，禁止把渲染图读回上下文（事故主因）。

---

## 1.0.0 — 2026-10-23

首个对外试用版本。Coding to Video 与 3D Blockout 两种模式、
邀请码注册与权限、参考素材上传、执行过程实时展示、产物播放与下载、
队列与并发控制、会话恢复、管理后台。
