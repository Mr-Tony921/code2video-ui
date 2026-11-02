# V2 需求变更（2026-10-23）

> 相对 Phase 1 设计的**重大变更**。与原 `docs/*.md` 冲突处，**本文档优先**。
> 已确认的决策记在每节「决策」里。

---

## 变更总览

| # | 变更 | 与 V1 的关系 |
|---|---|---|
| 1 | **支持 Reference 附件**（图片/视频/音频，每 session ≤10） | **推翻** V1 的「不做 Reference」（原任务书 §3.1） |
| 2 | **opus 5.5 做 Prompt 增强**（非 skill，独立 API） | 替换「增强在上游 bundle」的待确认状态 |
| 3 | **增强结果不回传用户**，直接投产；生产期禁止 steering | **推翻** V1 的「Prompt Review Card + 用户确认」（原任务书 §6） |
| 4 | **过程窗口**：滚动显示 cc 的工具调用与中间返回 | 新增 |
| 5 | **排队及时释放** + 用户停止选项 + 心跳断 10min 自动停 | **推翻** V1 的「关闭网页不影响生成」（原任务书 §8.1） |
| 6 | **邀请码带时效**，注册过即踢掉 | 细化 |
| 7 | **前端自发的后端监控话术** + cc 回复在正常位置显示 | 新增 |

---

## 1. Reference 附件

**决策：session 固定目录** `runtime/sessions/<sid>/references/`

- 每 session **最多 10 个**附件，前端需明确提示该上限与已用数量
- 类型：图片 / 视频 / 音频
- 文件名保留原名；冲突时加 `-2`、`-3` 后缀
- 路径交付方式：
  - **增强阶段**：把 `references/` 绝对路径 + 文件清单（名称/类型/大小）一并交给 opus，让它据此增强
  - **生产阶段**：把绝对路径写进 prompt，供 skill 自行判断如何使用
- 删除：允许用户在提交前删除；任务已提交后该 session 的附件集合**冻结**

```
runtime/sessions/<sid>/references/
  manifest.json          # 附件清单：原名/存储名/类型/大小/上传时间
  <原文件名>             # 保留原名便于 skill 理解语义
```

### 接口

| 接口 | 说明 |
|---|---|
| `POST /api/sessions/:id/references` | 上传（multipart），返回更新后的清单；超 10 个返回 `REFERENCE_LIMIT_EXCEEDED` |
| `GET /api/sessions/:id/references` | 清单 |
| `DELETE /api/sessions/:id/references/:name` | 删除（任务已提交后拒绝） |

---

## 2. Prompt 增强（opus 5.5）

**决策：我留配置位，用户后填；未填时跳过增强**（但在日志与轨迹中明确标记，不静默）

```json
"prompt_enhancement": {
  "enabled": true,
  "provider": "aux_model",
  "aux_model": {
    "base_url": "",          // 待填
    "api_key": "",           // 待填（或用 CVW_AUX_ENHANCE_API_KEY）
    "model": "",             // 待填，如 claude-opus-5-5
    "api_key_env": "CVW_AUX_ENHANCE_API_KEY",
    "timeout_ms": 120000
  }
}
```

### 增强流程（在 Gateway 侧，生产前）

```
用户提交 prompt
  → ① 调 opus：这是视频生成请求吗？
       是  → ② 检查 session 的 references/
             → ③ 按「有/无 reference」两套策略增强 prompt
             → ④ 增强结果【不回传用户】，直接投给 cc 生产
       否  → 返回结构化提示（out_of_scope），不建 Job
```

**未配置 aux_model 时**：跳过 ①②③，用户原始 prompt 直投生产，
并在 `job.enhancement` 记 `{skipped: true, reason: 'aux_model_not_configured'}`，
轨迹里留 `enhancement_skipped` 事件 —— 便于排查「为什么效果不如预期」。

**prompt 调整（二次生成）无需增强** —— 直接投产（用户明确要求）。

---

## 3. 生产期禁止 steering

| 阶段 | 用户能否发消息 |
|---|---|
| 无任务 | ✅ |
| 增强中 | ❌ 前端禁用输入框 |
| 生产中（cc 运行） | ❌ **禁止任何 steering**，前端禁用 + 后端拒绝 |
| 视频完成后 | ✅ 允许对视频提 prompt 调整 |
| 新视频生成前/中 | ❌ 再次禁用 |

- 后端最大限制 **12 小时**；超时未完成 → `FAILED(E_MAX_RUNTIME)`
- 过程中失败要**及时通知**，允许「重做」或「prompt 调整」
- prompt 调整走同一条生产链路，但**跳过增强**

> 这替换了 V1 的 Prompt Review Card 流程：用户不再看增强结果、不再确认。

---

## 4. 过程窗口

**决策：工具调用 + 结果摘要 + thinking 内容（可折叠）；过滤 thinking_tokens**

数据源已实测可用：`claude --output-format stream-json --verbose`

| stream-json 事件 | 去向 |
|---|---|
| `assistant.content[].tool_use`（`name` + `input`） | **过程框**：显示调用了哪个工具、关键参数 |
| `user.content[].tool_result` | **过程框**：结果摘要（截断） |
| `assistant.content[].thinking` | **过程框**：可折叠显示 |
| `assistant.content[].text` | **对话区**（见 §7），不只在过程框 |
| `system.subtype=thinking_tokens` | **丢弃** —— 每秒数条，会洗屏 |
| `system.subtype=init` | 记录 cc 的 session_id 与可用工具，供排障 |
| `result` | 终态、耗时、token 用量 |

**布局**：固定位置（右侧）独立滚动框，**不触发整页滚动**。

---

## 5. 排队、停止与心跳

### 5.1 及时释放
- Job 进终态**立即**释放并发槽并触发出队（已实现：`dispatcher.tick()`）
- 不让用户干等到 12h

### 5.2 用户停止
任务卡片始终提供「停止生成」，走已实现的 `CANCEL_REQUESTED → CANCELLING → CANCELLED`。

### 5.3 前端心跳（**行为变更**）

**决策：按新要求 —— 心跳断 10 分钟自动停止任务**

> ⚠️ 这与 V1「关闭网页不影响生成」（原任务书 §8.1）**相反**，是用户明确要求的变更。

| 情形 | 心跳 | 行为 |
|---|---|---|
| 切换浏览器标签页 / 切到其他应用 | **保持** | 任务继续（用 `visibilitychange` 降频但不停） |
| 页面最小化 | **保持** | 任务继续 |
| 关闭标签页 / 关闭浏览器 | **断** | 10 分钟后自动停止任务 |
| 网络瞬断后恢复 | 恢复 | 任务继续（10min 内重连即可） |

实现要点：
- 心跳间隔 30s，服务端判定阈值 **600s**
- **页面隐藏时不能停心跳** —— 浏览器会节流 `setInterval`，
  改用 `visibilitychange` + 可见时立即补一次 + `navigator.sendBeacon` 兜底
- 关页时**不**主动发停止请求（`beforeunload` 不可靠），纯靠服务端超时判定

---

## 6. 邀请码

- 创建时返回：完整码 + **有效期时间点**（发给用户时一并给出）
- **注册过即踢掉**：`used_count >= max_uses` 时立即失效，默认 `max_uses=1`
- 过期判定：`expires_at < now()` → `INVITE_EXPIRED`
- 列表页展示：前缀、用量、有效期、状态（有效/已用/过期/已撤销）

---

## 7. 前端自发的后端监控话术

**不是用户发的**，是前端在特定条件下自动追问后端。显示在过程框，标记为「系统」。

| 触发条件 | 自发话术 | 目的 |
|---|---|---|
| Job 报完成但找不到成品视频 | 「任务已完成但未找到成品文件，请确认产物路径」 | 要路径 |
| 长时间无新事件（> 5min） | 「当前仍在执行吗？请报告当前阶段」 | 确认健康 |
| 工具连续失败 ≥3 次 | 「检测到工具连续失败，请说明当前阻塞」 | 诊断 |
| 接近 12h 上限（> 11h） | 「即将达到最长执行时间，请优先产出当前可用版本」 | 抢救产物 |

### cc 的正常回复要显示在正常位置

`assistant.text` 不只进过程框，还要在**对话区**显示：
- 输入框下方单独区域显示 cc 的最新回复
- 制作完成的总结也在此显示
- 这样用户不必盯着过程框才能看懂发生了什么

---

## 8. 与原文档的冲突声明

| 原文档 | 原内容 | V2 变更 |
|---|---|---|
| 任务书 §3.1 / `PRODUCT_UX.md` §2.5 | V1 不支持 Reference，不留附件入口 | **支持**，每 session ≤10 |
| 任务书 §6 / `API_CONTRACT.md` §6.2 | Prompt Review Card + 用户确认后才建 Job | **增强不回传，直接投产** |
| 任务书 §8.1 / `LONG_RUNNING_JOBS.md` §B | 关闭网页不影响生成 | **心跳断 10min 自动停** |
| 任务书 §11.4 | 生成期间并发对话按后端能力决定 | **一律禁止 steering** |
| `config/backend.json` | `job_max_runtime_seconds: 10800`（3h） | **43200（12h）** |

实施完成后需回头修订 `docs/` 中受影响的章节。


---

## 实施状态（2026-10-23）

| # | 需求 | 状态 | 实现位置 |
|---|---|---|---|
| 0 | skill 改 9+1 独立结构 | ✅ 已验证 claude 识别 | `assets/skillsets/` |
| 1 | Reference 附件（≤10） | ✅ | `worker-bridge/references.mjs` · `gateway` multipart · `web/ReferencePicker.tsx` |
| 2 | opus 5.5 增强 | ✅ **实测 56s 出 8868 字符** | `gateway/enhancer.mjs` + `assets/prompt-templates/` |
| 3 | 增强不回传 + 禁 steering + 12h | ✅ | `gateway/server.mjs` 提交路径 |
| 4 | 过程窗口 | ✅ | `stream-parser.mjs` · `stream-pump.mjs` · `web/ProcessPanel.tsx` |
| 5 | 排队释放 + 停止 + 心跳 10min | ✅ | `gateway/presence.mjs` · `web/usePresence` |
| 6 | 邀请码时效 + 用完即踢 | ✅ 单测通过 | `gateway/invites.mjs` |
| 7 | 自发监控话术 + cc 回复显示 | ✅ | `gateway/watchdog-prompts.mjs` · `web/page.tsx` 对话区 |

### 采纳同事 bench_runner 的做法

读了 `/mnt/afs_toolcall/wupenghao/workspace/video_agent/bench_runner`，其方案比我原先的更成熟，已采纳：

| 我的问题 | 同事的解法 | 我的实现 |
|---|---|---|
| claude 跑 `find /` 卡 7 分钟 | 挂载命名空间遮蔽 AFS | `scripts/isolate.sh`（非 root 版） |
| 残留 Chromium / 脱离进程 | `VB_TASK_TOKEN`+cwd+cmdline 三重匹配 | `scripts/kill-leftovers.sh` |
| `/tmp` 共享冲突 | 每题 `/tmp` → 本题 `.tmp/` | 同 |
| 靠 stdout 正则认阶段（滞后 250s） | `--output-format stream-json` | `stream-parser.mjs` |
| Chromium socket 路径超 108 字节 | 隔离后用短 `/tmp` | 同 |

**比同事更进一步**：他们是 root 能逐个 bind，我们非 root 只能遮蔽，反而逼出更干净的做法 ——
工作区 bind 到**浅路径** `/workspace` + 整个遮蔽 `/mnt`，实测 `find /` 从 **7 分钟 → 676ms**。

### 环境核实（无需安装）

后端 `/opt/videokit` 已齐备：three 0.186.1 · gsap 3.15 · roughjs 4.6.6 · p5 2.3.4 ·
@napi-rs/canvas 1.0.13 · playwright 1.64.1 · puppeteer 25.15.0；
venv 含 manim/numpy/scipy/cv2/matplotlib/soundfile/librosa/edge_tts/faster_whisper。
唯一缺 Chromium —— 复用我们装的 Chrome 138.0.7204.168（实测两个库都能用 `executablePath` 指向它）。

### 过程中修的真实 bug

1. **反向对账误杀运行中任务**：`writeJob` 非原子 → `getJob` 读到半个 JSON → `catch{return null}`
   把读失败伪装成"不存在" → 对账下发 `abort_not_owner` 杀掉自己刚投的任务。
   修：原子写（tmp+rename）、读失败抛错不返回 null、对账三重保护。
   回归测试 `run-reconcile-guard.sh` 并发 400 次读写零误判。
2. **隔离后产物找不到**：contract 写宿主路径 `/mnt/...`，但隔离内被遮蔽，claude 转而乱探查文件系统。
   修：contract 必须用 agent 视图里的路径（`agentWsPath`）。
3. **SSE TDZ**：回放阶段命中终态事件时 `clearInterval(ka)` 撞 `const` 的 TDZ。修为可空变量 + `finish()`。
