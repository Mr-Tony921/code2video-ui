# 与同事 bench_runner 启动配置的逐项对比

> **状态：2026-10-25 已确认，按本文方案执行。**
> 采纳 5 项环境变量；40 分钟 timeout / `ANTHROPIC_AUTH_TOKEN=dummy` /
> `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE` / `QWEN_CLAUDE_CONFIG_DIR` 四项不采纳。

来源：`/mnt/afs_toolcall/wupenghao/workspace/video_agent/bench_runner`（只读参考，未拷贝任何代码）。
对比对象：我们的 `config/backend.json → claude_cli.env` + `apps/worker-bridge/src/job-runner.mjs`。
结论分三类：**已采纳** / **不采纳（附理由）** / **待你判断**。

---

## 一、已采纳（v1.3.2 已生效，线上实测确认）

| 变量 | 值 | 为什么要 |
|---|---|---|
| `CLAUDE_CODE_SUBAGENT_MODEL` | `${model.model}` | 子 agent 不设会去找默认模型，我们的代理没有那个模型名，子 agent 直接失败。 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | `64000` | cc 对本模型默认只给 32000，且 thinking 也算在内；长脚本会被截断。 |
| `CLAUDE_CODE_TMPDIR` | `/tmp` | 隔离内 `/tmp` 已 bind 成本 job 的 `.tmp`，落本地盘且随 job 清理。另外 Chromium 的 Unix socket 路径有 ~108 字节上限，深路径会起不来。 |
| `HF_HOME` | `/opt/videokit/hf` | **这条是我自己的 HOME 修复带出来的坑**：我把 HOME 改成每任务新建的 `.home` 之后，whisper 缓存就落到空目录了，等于每个任务重下 605MB 模型；隔离内无外网会直接卡死。两台机器实测 `/opt/videokit/hf` 都是 605M，已就位。 |
| `HF_HUB_OFFLINE` | `1` | 配合上一条，禁止任何联网回退，失败要快不要挂。 |
| `PYTHONDONTWRITEBYTECODE` | `1` | 不往 skill 目录写 `.pyc`。 |

---

## 二、不采纳（我判断不该照搬，列出理由供你复核）

### 1. `timeout -k 30s "$TIMEOUT"` —— 同事默认 40 分钟
- 同事是 benchmark，要的是「卡住就砍掉换下一题」。
- 我们是线上出片，你明确要求 **12 小时**。我们现在 `max_runtime_seconds: 43200`（= 12h）由 supervisor 侧控制，**不采纳**他们的硬 timeout。
- 已确认我们这侧没有残留的短超时。

### 2. `ANTHROPIC_AUTH_TOKEN=dummy` + `unset ANTHROPIC_API_KEY` 的写法
- 他们用这个绕过 cc 的鉴权分支。
- 我们走 `video_settings.json` 配真实 base_url + api_key，路径不同，**换过去反而会打断现有鉴权**。不动。

### 3. `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE`
- 他们是 `[ -f /opt/videokit/playwright_platform ] && export ...`，由 `setup_node.sh` 在"本 OS 不在 Playwright 支持列表"时写出这个文件。
- **我实测两台后端机（10.120.3.60 / 10.120.3.50）都没有这个文件** → 说明我们的 OS 在支持列表内，设了反而会强行指向错误平台的构建。不采纳。

### 4. `QWEN_CLAUDE_CONFIG_DIR` 每任务新建 config
- 我们已经用 `CLAUDE_CONFIG_DIR=$HOME/.claude`（HOME 本身就是每 job 新建的 `.home`），**效果等价**，不需要再加一个变量。

---

## 三、已确认保持现状（原「待判断」项）

### A. `--disallowedTools WebSearch`
- 同事禁掉了 WebSearch。我们**也已经禁**（`job-runner.mjs:136`），这条一致，无需动作。

### B. 隔离的 unshare 降级策略
- 同事：拿不到 mount namespace 就**打警告继续裸跑**。
- 我们：`fallback_to_soft` 为真时降级到软隔离（独立 TMPDIR + 进程组 + 清残留），为假时直接报错。
- 我们的更严，**建议保持**。只是提醒你知道这个差异。

### C. 他们隐藏 `/mnt/afs_toolcall` 整个目录
- 我们隔离里也遮蔽 `/mnt`，这正是当初 HOME=ENOSPC 事故的根因（已修）。现在 HOME 指向工作区内 `.home`，不受影响。
- **但要留意**：以后任何"默认落在 `$HOME` 下"的新工具（新的模型缓存、npm cache 等）都会遇到同一类问题。遇到新工具先确认它的缓存目录。
