# 1.4.0 → 1.4.1 同步清单

线上现在是 **1.4.0**，dev 是 **1.4.1**（已自检通过）。
本文件只列「要动什么」，不含任何对线上的操作 —— 线上一律由你执行。

---

## 0. 先说一件最要紧的：这不只是功能更新

**线上 1.4.0 带着一个会反复伤到用户的缺陷，1.4.1 修掉了它。**

> `apps/worker-bridge/src/job-runner.mjs` 的 `isSidecarProcessAlive()`
> 从边车重建状态时**漏传 `jobToken`**，`procAlive` 于是退回拿 `job_dir`
> （`rounds/<jid>`）去比对进程里的 `CVW_JOB_TOKEN` —— 而 1.4.0 已把 token
> 改成 `<工作区>#<jobId>`。两者永远不等 ⇒ **活着的 cc 一律被判死**。

后果：**每次 bridge 重启（包含每一次热更新）都会把当时在跑的任务标成
`FAILED / E_CLAUDE_EXIT code=null signal=null`**，而 cc 进程继续跑完、
产物无人认领 —— 用户白等一两小时且看不出原因。

dev 实测复现与验证（真任务 + `kill -9` bridge）：

| | 修复前 | 修复后 |
|---|---|---|
| adopter 日志 | 「进程（pid=828891）已不在，补收尾」**而该 pid 当时还活着** | 正常接管 |
| 新 bridge `running_jobs` | 0 | **1** |
| 任务终态 | FAILED | **COMPLETED**，成片 150824B 可播，`attempt=1` |

带在跑任务走完整 `hot-update.sh run` 也已验证：bridge 重启后 `running=1`、
cc 同 pid 存活、任务 COMPLETED（成片 242826B）、自检 13/0。

**所以这个版本建议尽快上，而且上的时候就能自证** —— 热更新过程中若有任务在跑，
日志里应出现「✅ … 的 cc 进程 … 仍在运行」且重启后 `running` 不为 0。

---

## 1. 必须同步（运行时代码，均不含 dev 专用路径，可整文件覆盖）

### 后端
| 文件 | 内容 |
|---|---|
| `apps/worker-bridge/src/job-runner.mjs` | ★★ 上面那个认领修复 |
| `apps/worker-bridge/src/job-paths.mjs` | `newestLegacyRound` / `recordedCcSessionId` / `lastRoundBlewContext` |
| `apps/worker-bridge/src/job-workspace.mjs` | 1.3.x 老会话一次性迁移（★ 线上存量对话续写回归） |
| `apps/gateway/src/watchdog.mjs` | ★★ 取消后永久卡 CANCELLING 的修复（线上现存缺陷，见 `BUG-cancelling-stuck-forever.md`） |
| `apps/gateway/src/stream-pump.mjs` | `last_assistant_text` 落 job 快照（仅文本变化时写） |
| `apps/gateway/src/server.mjs` | `publicJob` 下发该字段、`complete` 不丢该字段、示例片三个路由 |
| `apps/gateway/src/examples.mjs` | 示例片元信息与落盘 |
| `apps/worker-bridge/src/server.mjs` | ★ 成片元信息（width/height/duration_ms）沿 onComplete 与对账 probe 两条路上报 |

### 前端（**改完必须重新 `npm run build`**）
`apps/web/` 下 15 个文件：

| 文件 | 差异 |
|---|---|
| `app/_workspace.tsx` | 236 行 |
| `app/globals.css` | 19 行（加载进度条样式） |
| `components/Collapsible.tsx` | **新文件** |
| `components/ExampleDialog.tsx` | **新文件** |
| `app/api/[...path]/route.ts` | ★ 成片流不套 120s 超时 |
| `components/JobCard.tsx` | ★ 去掉 `<video loop>` |
| `components/Composer.tsx` | 28 行 |
| `components/ExampleList.tsx` | 40 行 |
| `components/ExamplesTab.tsx` | 207 行 |
| `components/HistoryPanel.tsx` | 11 行 |
| `components/ProcessPanel.tsx` | 57 行 |
| `components/ReferencePicker.tsx` | 6 行 |
| `components/Sidebar.tsx` | 49 行 |
| `features/useJobStream.ts` | 76 行 |
| `features/useSession.ts` | 46 行 |
| `lib/api.ts` | 43 行 |
| `lib/types.ts` | 21 行 |

> ⚠️ `apps/gateway/src/server.mjs` 里新增的 **`job.replay_done` 哨兵**与
> `apps/web/lib/api.ts`（登记事件名）、`features/useJobStream.ts`（消费它）配套。
> 顺序不敏感：前端在没有哨兵时会退回 2.5s 安静期兜底，后端多发一条也不会让
> 旧前端出错（未登记的事件名会被 EventSource 忽略）。但两边都到位才有确定判定。
>
> ⚠️ `_workspace.tsx` / `useJobStream.ts` / `ProcessPanel.tsx` 三个要**一起**带过去。
> 「对话区不跳变」靠它们配合成立：`_workspace` 的 helperText **快照优先**、
> `useJobStream` 回放期间**缓冲** assistant 文本并用安静期判定加载完成、
> `ProcessPanel` 加载期间**不渲染列表**。只带其中一两个会留下半截行为。

> ⚠️ 线上是 Kong 子路径部署，`base_path` 是**构建期产物**。
> 重新 build 前先确认 `config/backend.json` 的 `deployment.web.base_path`
> 仍是 `/sensechat-vision/signpost/v0/prod-sensenova-codevideo-v0-1`
> —— 线上曾两次因丢前缀整站白屏。

### 版本
`VERSION` → `1.4.1`；`CHANGELOG.md` 的 1.4.1 段整体带过去。

---

## 2. 建议同步（脚本，但要**手改**不要整文件覆盖）

`scripts/release-check.sh` 的 A 段有两个 bug，**线上那份也有**：

1. 「单实例」按 cwd 统计**本机**进程，而线上前端在 `10.120.6.11`、
   Gateway 在 `10.120.7.0`。在 Gateway 机器上跑这一项必然红（N=0），
   红的是「跑错机器」而不是部署。
   → 改为先读 `deployment.web.host`，只在那台上判，其余机器打印跳过。
2. `OTHER=$(( $(pgrep -fc '^next-server' … || echo 0) - N ))`：
   `pgrep -fc` 计数为 0 时**既打印 "0" 又返回非零退出码**，
   于是拼成 `"0\n0"` → **算术展开语法错**（在没有 next-server 的机器上必现）。
   → 改为 `ALL=$(pgrep -fc '^next-server' 2>/dev/null | head -1 || true)`，
     再 `OTHER=$(( ${ALL:-0} - N ))`。

dev 侧的改法可直接参考 `scripts/release-check.sh`。

---

## 3. **不要**同步（dev 专属）

| 文件 | 原因 |
|---|---|
| `config/backend.json` | 环境配置（主机、路径、base_path、worker 列表）完全不同 |
| `scripts/restart-service.sh` | dev 专用。它补的是 dev 的空缺 —— dev 的 `hot-update.sh` 原来调 `start-backend.sh restart-bridge`（**该子命令不存在**），于是热更新**什么都没重启**。**线上有可用的 `svc-restart.sh`，不需要这个** |
| `scripts/hot-update.sh` | dev 版改的是「接 restart-service / 自检送到前端机器跑」。线上版本走 `svc-restart.sh` 且**已有** sleep 8 + 重试，不要覆盖 |
| `scripts/guard-isolation.sh` | 隔离护栏，只对开发环境有意义 |
| `scripts/{start-*,install-*,probe-remote,verify-deps}.sh` | 路径/主机写死，环境不同 |
| `tests/risk/*.mjs` 里的默认路径与 worker id | 多数文件带 1~2 处 dev 默认值（`CVW_REPO_ROOT` 兜底、`cvw-dev-360`）。要带过去的话按线上值改，或只靠环境变量注入 |
| `.env.example`、`apps/web/tsconfig.tsbuildinfo` | 环境样例 / 构建产物 |

### 新测试里可以无改动带走的两个
`tests/risk/assistant-text.mjs`、`tests/risk/example-video.mjs`
（**零 dev 专用串**，且 `example-video.mjs` 在没有 ffmpeg 的机器上自动跳过实证部分）。
`adopt-token.mjs` 很值得带（它守的就是第 0 节那个缺陷），但要把文件顶部的
`CVW_REPO_ROOT` 兜底路径改成线上仓库根。
别忘了把新测试名字加进 `tests/risk/run-all.sh` 的 `for t in …` 列表。

---

## 4. 上线顺序建议

1. 先只同步 **`job-runner.mjs`**（第 0 节那个修复，单文件、零风险），
   用 `svc-restart.sh` 滚动重启 bridge —— 这一步就能止住「热更新杀在跑任务」。
2. 再同步其余后端文件 + 前端 + 重新 build。
3. `bash scripts/hot-update.sh run`（**在能连前端的那台跑自检**，或自检单独在前端机器跑）。
4. 人工复核：`bash scripts/e2e-checklist.sh`（真跑一轮生成 + 微调）。

---

## 5. dev 上已跑过的验证（全绿）

| 项目 | 结果 |
|---|---|
| `tests/risk/run-all.sh` | **23/23**（15 → 23，本轮新增 3 个） |
| `scripts/guard-isolation.sh` | 7/7 |
| `scripts/release-check.sh`（前端机器） | 13/13 |
| `scripts/smoke.sh` | 20/20 |
| `scripts/e2e-checklist.sh` | 17/17（含两轮成片 inode 不同、`.done` 不互相覆盖） |
| 浏览器实测（新功能） | 32/32 |
| 浏览器实测（刚提交保持展开 + 管理页上传 UI） | 12/12 |
| 浏览器实测（不记忆开合 / 进度条 / 不跳变 / 新增传视频） | 15/15 —— 492s、134 条轨迹的任务，展开全程**制作助手文本变化 0 次、卡片位移 0 次** |
| 浏览器实测（新增示例 + 真文件上传） | 11/11 —— 好片一步带上（44189B/1000ms/1920×1080）；截断文件被拒并提示「示例已创建、视频没传上」 |
| 浏览器实测（2 秒成片播放） | loop 开 waiting 9 次 → 关掉后 **1 次**、seek 0 次；播放期间 `/playback` 请求 0 条（证明与网络无关） |
| 真任务（故意不加 faststart） | 产物自动变 `[ftyp,moov,free,mdat]`；元信息 1920×1080 / 2000ms（原来全 null） |
| 浏览器实测（回放隔离，已完成 + 进行中各一次） | 阶段 0 抖动、徽章 0 抖动、JobCard 高度 0 变化、制作助手 0 变化；`/api/jobs` 19 → 2；限速 48KB/s 下进度条正常出现 |
| 稳定性：同会话并发 | 第二次提交 **409 SESSION_BUSY** |
| 稳定性：三会话派发 | job id 互不相同、跨两台 worker、运行中列表无重复 |
| 稳定性：`kill -9` bridge | cc 存活 → 新 bridge `running=1` → 任务 COMPLETED |
| 取消落终态（行为测试 + 真实复现卡住态） | 14/14；修复前重跑 11 项红、12 tick 重发 60 次。人为造的卡住态被**第一个 tick** 救回 |
| 稳定性：完整热更新（带在跑任务） | cc 同 pid 存活 → 任务 COMPLETED → 自检 13/0 |
