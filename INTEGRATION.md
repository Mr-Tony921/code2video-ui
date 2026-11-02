# v1.3.8 集成到线上

隔离环境：`/mnt/afs_if/codevideo/workspace/code2video-dev`（本目录）
线上环境：`/mnt/afs_if/codevideo/workspace/coding-video-web`（**注意也在 afs_if**；
`afs_toolcall` 下那份 1.2.0 已停用）

线上当前版本 **1.3.6** → 本次升到 **1.3.8**（含 1.3.7 的前端修复）。
本次是在 1.3.4 基础上的增量修复，**只动了下面三个文件 + 四个 SKILL.md**，
配置不需要改（1.3.4 已经加过 `maintenance` / `shared_caches` / `limits`）。

---

## ⚠️ 最容易出事的一步

**不要整份拷贝 `config/backend.json`。** 它的每一项都是隔离值，
直接覆盖会把线上指向开发用的后端机器与存储目录。

本版对该文件的**代码相关改动有三处新增节点**（见下「配置新增」），
其余差异全是环境配置，线上应保留原值。

| 字段 | 线上应保持 |
|---|---|
| `storage.root` | `.../coding-video-web/runtime` |
| `storage.sessions_root` | `/mnt/afs_if/codevideo/workspace/session` |
| `session_store.root` | `.../coding-video-web/runtime/sessions` |
| `session_store.index_file` | `.../coding-video-web/runtime/session-index.jsonl` |
| `workers[].bridge.host` | `10.120.0.161` / `10.120.0.175` |
| `deployment.web.host` | `10.120.6.11` |
| `deployment.web.base_path` | `/sensechat-vision/signpost/v0/prod-sensenova-codevideo-v0-1` |
| `deployment.web.public_url` | `https://api-gai-volc-internal.sensetime.com/sensechat-vision/...` |
| `deployment.gateway.host` | `10.120.0.161` |
| `runtime_binaries.chrome_bin_host` | `.../coding-video-web/runtime/browser/...` |
| `runtime_binaries.previs_dependency_root_host` | `.../coding-video-web/runtime/previs-deps` |
| `isolation.bind_paths[].src` | 指向 `coding-video-web/runtime/...` |
| `environment.name` | `prod`（1.2.0 已加，保持不变） |

### 配置新增（这三节要加到线上）

```json
"limits": {
  "early_harvest_idle_ms": 600000,
  "early_harvest_agent_silent_ms": 900000
},
"shared_caches": {
  "npm_config_cache": "/var/tmp/cvw-cache/npm",
  "UV_CACHE_DIR":     "/var/tmp/cvw-cache/uv",
  "MPLCONFIGDIR":     "/var/tmp/cvw-cache/mpl"
}
```

`model` 节增加 `max_output_tokens: 64000`、`auto_detect_context: true`，
并把 `max_context_tokens` 从 `262144` 改成 `524288`。

`claude_cli` 节增加 `env` 子节（8 个变量，含 `${model.*}` 占位符）——
**这节可以整体照抄**，里面没有环境相关路径，只有 `HF_HOME=/opt/videokit/hf`
（线上机器同样预置了这个 605MB 缓存，已确认存在）。

> **前置动作**：线上两台后端机要先建缓存目录，否则这三条会被自动跳过
> （不影响启动，只是缓存不共享）：
> ```bash
> mkdir -p /var/tmp/cvw-cache/{npm,uv,mpl}
> ```
> 注意不要往 `/opt/videokit` 下建 —— 它是 root 只读的。

---

## 代码改动（可直接合并）

### 后端
- `apps/worker-bridge/src/job-runner.mjs` — 三处：
  - **提前收尾判据改了**（核心修复）：原来只看「成品文件多久没变」就杀 cc，
    而这衡量的不是 agent 还在不在干活。改为**成品静置 + agent 静默**两个阈值
    同时满足（`EARLY_HARVEST_IDLE_MS` / `EARLY_HARVEST_AGENT_SILENT_MS`，入 config）。
  - `findArtifact` **不再按文件体积排序**，改按交付语义（排除 build/work/chunks，
    output 优先，final/deliver 加权，test/draft/preview 降权，最后比时间）。
  - 新增 `resolveClaudeEnv()`：读 `config.claude_cli.env`，替换 `${model.*}` 占位符；
    `buildChildEnv` 末尾合并 `config.shared_caches`（路径不存在的条目自动跳过）。
- `apps/worker-bridge/src/config.mjs` — 新增 `maxOutputTokens` / `autoDetectContext` /
  `claudeCli.env`，以及 `detectModelContext()`：启动时从 `/v1/models` 读
  `max_model_len` 覆盖静态值，拉取失败静默降级。
- `apps/worker-bridge/src/server.mjs` — 注册前调用 `await detectModelContext(console)`。
- `apps/gateway/src/server.mjs` —
  - `result_asset` **只在终态下发**（`store.isTerminal(j.status)`）：
    任务跑着的时候工作区里已经有可播放 mp4，下发出去用户会当成品。
  - 扩写失败**降级而非失败**：原来 `E_ENHANCEMENT_FAILED` 直接杀掉整个 job
    （线上 `job_01582c52` 的 prompt 完全正常却被杀）。改为带原始 prompt 转 QUEUED，
    标记 `enhancement.skipped=true, reason=enhance_failed`。
  - 新增示例 prompt 路由：`GET /api/examples`、`POST /api/examples/:id/use`、
    `GET|POST /api/admin/examples`、`PATCH|DELETE /api/admin/examples/:id`。
  - `runEnhancement` 接受 `skipEnhance`（用户关闭扩写时跳过）。
- `apps/gateway/src/enhancer.mjs` — `enhance({...skipRequested})` 直接返回原 prompt。
- `apps/gateway/src/examples.mjs` — **新文件**，示例 prompt 的 CRUD（原子写 + 使用计数）。

### 前端
- `apps/web/app/_workspace.tsx` — `APP_VERSION`；`enhance` / `examples` 状态；
  **新建对话与切换模式时把 `enhance` 重置为 true**；`submit` 依赖补 `enhance`。
- `apps/web/components/ExampleList.tsx` — **新文件**，左栏示例列表（点击填入 + 关扩写）。
- `apps/web/components/ExamplesTab.tsx` — **新文件**，管理后台示例维护页。
- `apps/web/components/Composer.tsx` — 「智能扩写」勾选行。
- `apps/web/lib/types.ts` / `lib/api.ts` — `ExamplePrompt` 类型与示例接口。

### 脚本 / 文档
- `scripts/smoke.sh` — 管理员密码默认值改为**按 `environment.name` 判断**
  （原来硬编码线上密码，dev 跑会 7 项 401 误报）。线上行为不变。
- `scripts/guard-isolation.sh` — **仅隔离环境需要，线上可不带**。
- `docs/BENCH_RUNNER_DIFF.md` — **新文件**，与同事 bench_runner 启动配置的逐项对比。
- 其余 `scripts/*.sh` 的差异只是路径/IP，线上保持原值。

### 版本
- `VERSION` → `1.3.8`
- `apps/web/app/_workspace.tsx` 的 `APP_VERSION` → `1.3.8`
- `CHANGELOG.md` → 新增 1.3.7 / 1.3.8 条目
- 后续小版本从第三位递增（1.3.9 / 1.3.10 …）

---

## ★ 1.3.8 的改动：会话名额 + 排队响应 + 会话 ID

**① 会话名额只增不减（严重，影响用户体验）。**
`activeSessions` 原本是只有 `add` 没有 `delete` 的 Set，名额只能靠重启 Bridge 清零；
满了之后新建会话报 `503 PROCESS_UNAVAILABLE`，**而任务槽往往是空的**。
线上核查过：DB 里 73 个 ACTIVE 会话、每台 13~17 个（远超 `max_sessions=8`），
只因五台 Bridge 近期都重启过才没出故障。

释放判据**复用「对话结束才展示视频」那一套** `store.isTerminal(status)`，
挂在 `complete` / `fail` / `cancel-ack` 三个终结回调 —— 成功/失败/用户停止统一处理。
**只还名额，不删工作区**；用户回来继续用会自动重新计入。
**新建会话不是释放条件**（多 session 并行是产品能力）。
兜底：`sessionIdleTtlMs`（默认 30 分钟，`CVW_SESSION_IDLE_TTL_MS` 可调）。

**配置可选加**（不加走默认 30 分钟）：Bridge 的 `timing.sessionIdleTtlMs`。

**② 槽位释放后排队任务白等一个 tick（2 秒）。**
三个终结点 + watchdog 的 `releaseSlot`（7 个调用点在这一处收口）现在都会立刻
`dispatcher.tick()` 出队。

**③ 切换对话后会话 ID 不变**，用户报障给的 ID 是错的。
改为显示当前在看的那个任务所属的会话，跨会话时标注「正在查看另一个对话」。

**新增文件**：`apps/worker-bridge` 的 `DELETE /sessions/:id`（只释放名额）。
**改动文件**：`supervisor.mjs`（Set→带 TTL 的 Map）、`config.mjs`、`bridge-client.mjs`、
`gateway/server.mjs`、`watchdog.mjs`、`web/components/Sidebar.tsx`、`web/app/_workspace.tsx`。

**集成后验证**：
```bash
node tests/risk/session-slot.mjs        # 14 项
node tests/risk/session-id-display.mjs  # 7 项
# 跑一个任务，终结后立刻看名额是否降下来：
curl -s <gw>/api/admin/gallery | grep active_sessions
grep session.slot_released runtime/logs/gateway.log
```
dev 实测：任务 COMPLETED 的同一秒名额就释放（2→1）；用户停止同样立即释放（3→2）。

---

## ★ 1.3.7 的改动：修两个线上 bug（**配置不用改**）

**① 切 session 导致前端错乱**（页面来回跳变 / 任务在跑却不滚动 / 显示别的任务的产物）。
三个现象同一个根因：`useJobStream` 的 SSE 订阅竞态 ——
订阅在 `sync()` 的异步回调里才建立，cleanup 却是同步的，
快速切 session 时 cleanup 跑的那一刻 `unsub` 还是 null，**什么也没断掉**。
线上实证：`sse.open` 255 / `close` 139，**净泄漏 116 条**，连接数爬到 55。
改动文件：`apps/web/features/useJobStream.ts`（加 `cancelled` 标志 + 事件归属校验）。

**② 产物可能在对话未结束时被取到。**
`publicJob` 早有门控，但另外三个出口漏了，**其中 `serveAsset()` 是真正吐流的闸门** ——
意味着知道 URL 规则就能直接拉到中间版本。
改动文件：`apps/gateway/src/server.mjs`（gallery / assets 元数据 / serveAsset 三处补 `isTerminal`）。

**集成后验证**：
```bash
node tests/risk/sse-leak.mjs       # 8 项：切 session 不泄漏
node tests/risk/asset-gating.mjs   # 5 项：四个产物出口都按终态门控
# 浏览器：快速来回切 10 次 session，观察界面是否稳定、连接数是否配平
grep -c 'sse.open' runtime/logs/gateway.log; grep -c 'sse.close' runtime/logs/gateway.log
```
修复后 open/close 应**基本配平**（dev 实测 34/27，连接数稳定在 2~3；修复前是单向增长）。

---

## ★ 1.3.6 的改动：增强改为 agent loop

**配置要加一节** `prompt_enhancement.agent`（`config/backend.json`）：

```json
"agent": {
  "enabled": true,
  "bin": "claude",
  "allowed_tools": "ToolSearch,WebSearch,WebFetch",
  "timeout_ms": 420000,
  "sigterm_grace_ms": 5000,
  "max_concurrent": 6
}
```

> `allowed_tools` 里**必须有 `ToolSearch`** —— `WebSearch`/`WebFetch` 在 cc 里是 deferred 工具，
> 模型要先用 `ToolSearch` 加载才能调用。漏掉它会导致永远搜不了（实测 `web_search_requests` 一直是 0）。

`aux_model` 的 `base_url` / `api_key` / `model`（tokenhub + opus 5.5）**沿用现有值，不用改**。
agent 起的 cc 就是用这三个值，与生成用的 codevideo 模型完全隔离。

**新增文件**：`apps/gateway/src/enhance-agent.mjs`。
**改动文件**：`enhancer.mjs`（接 agent loop + 失败降级）、`server.mjs`（healthz 暴露 `enhance_agent`、
publicJob 下发 `via`/`agent_tools`）、`assets/prompt-templates/dense_prompt_template.md`（告知可联网）。

**关于并发**：增强**不占** worker 的生成槽（线上 20 个），它跑在 Gateway 机器上。
`max_concurrent: 6` 只是防高峰压垮 Gateway；超限**直接降级单轮，不排队等待**。

**关于"不能堵住排队"**（这是本功能最要紧的约束）：
超时先 SIGTERM、5 秒宽限后 SIGKILL、按进程组整树终止；
且**名额在 `finally` 里释放，不依赖进程是否真死**。
实测：一个 `trap "" TERM` 忽略 SIGTERM 的进程 2.4 秒被 SIGKILL 清掉，调用正常返回。
回归测试：`node tests/risk/enhance-no-block.mjs`（12 项）。

**集成后验证**：
```bash
curl -s <gateway>/healthz | python3 -m json.tool | grep -A4 enhance_agent
# 提交一个不关增强的任务，确认日志出现 "[enhancer] agent loop 完成"
```

---

## ★ 1.3.5 的改动（在 1.3.4 基础上的增量）

**配置不用改。** 只有代码和 skill：

| 文件 | 改了什么 |
|---|---|
| `apps/worker-bridge/src/job-runner.mjs` | **prompt 改走 stdin，不再进命令行**（修 SIGKILL 自杀）；新增 `resolvePreviousJobDir()` 找微调基线 |
| `apps/worker-bridge/src/job-workspace.mjs` | 微调轮继承上一轮 `src/` + `previous/成片` + `SPEC.prev.md`，并在 prompt 里说明「这是修改」 |
| `apps/gateway/src/store/job-store.mjs` | `createJob` 落 `is_revision` |
| `apps/gateway/src/server.mjs` / `dispatcher.mjs` / `worker-bridge/src/server.mjs` | 把 `is_revision` 一路传到 Bridge |
| `assets/skills/*/SKILL.md`、`assets/skillsets/*/*/SKILL.md`（4 个） | 明确禁止按名字/模式杀进程 |
| `apps/web/components/Composer.tsx` | 回车不再发送，只换行 |
| `apps/web/components/PromptBubble.tsx`（新） | 长 prompt 可展开 |

**两个修复的背景**（详见 `docs/INCIDENT_job_dc9fd3ab_SIGKILL.md`）：
1. 线上「鹈鹕骑车」报 `code=null signal=SIGKILL` —— prompt 进了 argv，
   agent 的 `pgrep -f "chrome-linux64" | kill -9` 把自己匹配上了。改走 stdin 根治。
2. 多轮微调等于从零重做 —— 微调轮工作区是空的，agent 看不到上一版。改为继承。

**集成后务必跑**（这两个问题 smoke/release-check 查不出来）：
```bash
bash scripts/e2e-checklist.sh     # 真跑一轮生成 + 微调，约 10 分钟
node tests/risk/argv-safety.mjs   # 静态守卫：prompt 不进 argv
```

---

## ★ 热更新（1.3.4 新增，本次部署请读完这节）

**本次部署仍会中断正在运行的任务。** 线上现在跑的是 1.2.0 的 Bridge，
它的 cc 子进程挂在管道上，父进程一退出就被 SIGPIPE 杀掉 ——
这正是 1.3.4 要修的东西，但修好的代码要先装上去才生效。
**本版装上之后，下一次更新才是真正的热更新。**

所以本次建议：`bash scripts/hot-update.sh begin` 先置维护态（挡住新提交、前端显示横幅），
等在跑的任务自然跑完（或与用户约定时间），再重启。

### 配置要加的一节

```json
"maintenance": {
  "max_window_seconds": 900,
  "poll_interval_seconds": 10
}
```

维护标记落 `<storage.root>/gateway/maintenance.json`，Gateway 与 Bridge 共读。
**线上两台后端机的 `storage.root` 必须一致可达**，否则 Bridge 读不到标记，
Gateway 重启超过 6 分钟就会触发自保停止、杀掉在跑任务。

### 以后怎么热更新

```bash
bash scripts/hot-update.sh status   # 看当前版本、在跑任务、认领能力
bash scripts/hot-update.sh run      # 置维护态 → 逐台重启 Bridge → 重启 Gateway → 清维护态 → 自检
```

顺序是**先 Bridge、后 Gateway**，不能颠倒：Gateway 在线时重启 Bridge，
新实例注册的那一刻就把认领到的任务改绑过去，赶在第一次心跳的归属校验之前。
脚本每台重启后会**断言 cc 子进程仍然存活**，不活就立即中止、不动第二台；
`trap` 保证异常退出也会清掉维护态（标记本身还有 15 分钟过期兜底）。

### 本版实测结果（dev）

- 一个跑着的任务，`kill -9` 掉它所在机器的 Bridge：**cc 进程存活**，
  且在没有 Bridge 的情况下继续写轨迹（12 秒内新增 125 行）——证明它真在算。
- 重启 Bridge：**自动认领**（日志 `已认领 job ... 事件=91 阶段=RENDERING`），
  Gateway 侧是**改绑**而非 abort，`lease.epoch` 保持为 1，0 个会话转 DEGRADED。
- 全程 `abort_not_owner` / `self_preservation` **0 次**。

---

## 关于存储迁移（本版不强制，但请知悉）

隔离环境本版已整体迁到 `/mnt/afs_if`，原因是 **`/mnt/afs_toolcall` 一度 100% 写满**
（150T 用尽，Avail=0），前端登录直接报 `ENOSPC: no space left on device`。

**线上目前仍在 afs_toolcall**，本次集成不要求一起迁。但要注意：
- 写满期间线上同样会受影响（登录、job 工作区、compact 全部要写盘）；
- 截至交付时 afs_toolcall 恢复到 2.1T 可用，但**用量仍显示 99%**，随时可能再满；
- 迁移本身不难（改 `storage.*` / `session_store.*` 四个路径 + 重建前端 build），
  但要停服务、核对文件数，建议单独排期做，不要和功能上线混在一起。

---

## 集成后必做

```bash
cd /mnt/afs_toolcall/codevideo/workspace/coding-video-web
# 两台后端机先建缓存目录
#   mkdir -p /var/tmp/cvw-cache/{npm,uv,mpl}
bash scripts/start-frontend.sh build    # ★ 不要直接跑 next build，会丢 base_path
bash scripts/start-frontend.sh start
# 后端两台都要重启（job-runner / config / server 都改了）
bash scripts/release-check.sh           # 13 项，失败不要交付
bash scripts/smoke.sh                   # 20 项
```

**重启注意**：按 `readlink /proc/<pid>/cwd` 归属杀进程。
按进程名匹配会出现"重启了但旧进程占着端口、仍跑旧代码"（本次又踩了一次：
kill 模式写成 `"node apps/gateway/..."`，漏掉了不带 `node ` 前缀启动的进程）。

**验证本版关键修复**：
1. 提交任务，**运行中**查 `GET /api/sessions/<sid>`，`result_asset` 应为 `null`，
   即使工作区里已经有 `output/final.mp4`（本版实测验证过这一点）。
   转 COMPLETED 后才出现 `READY / playable=true`。
2. 任务运行中查 cc 进程环境：
   `tr '\0' '\n' < /proc/<pid>/environ | grep -E 'HOME|CONTEXT|OUTPUT|CACHE'`
   应看到 `CLAUDE_CODE_MAX_CONTEXT_TOKENS=524288`、`MAX_OUTPUT_TOKENS=64000`、
   `HOME=/workspace/.home`、三个 `/var/tmp/cvw-cache/*`。
3. Bridge 启动日志应有 `[config] 模型上下文已核对: 524288`。
4. 新建对话后「智能扩写」应是**开启**；点左栏示例后自动关闭。
5. 提交一个超过 200 字符的 prompt，气泡应出现「▸ 展开全文（N 字符）」，
   展开后内容完整（原来被服务端截断到 300 字符，看不到全文）。
6. 重启一台 Bridge 后立刻提交任务，**不应卡在排队**；
   `/api/admin/gallery` 的 `used` 要与实际在跑数一致。

---

## 本版不含（已确认不改）

- `assets/prompt-templates/dense_prompt_template.md` 没有长度约束，
  用户原话 2746 字符会被放大成 20697 字符（7.5 倍）。
  产品主打复杂任务、依靠压缩跑完即可，故本版不动。
- bench_runner 的 40 分钟 `timeout -k`（我们要求 12h）、
  `ANTHROPIC_AUTH_TOKEN=dummy` 鉴权写法、`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE`
  （两台机器都没有触发文件，设了反而指向错误平台）、`QWEN_CLAUDE_CONFIG_DIR`
  （我们的 `CLAUDE_CONFIG_DIR` 已等价）—— 四项确认不采纳，理由见
  `docs/BENCH_RUNNER_DIFF.md`。
