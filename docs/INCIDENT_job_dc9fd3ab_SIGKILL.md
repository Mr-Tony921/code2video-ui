# 事故分析：鹈鹕骑车任务 SIGKILL 自杀

**结论先行：这不是 API 层问题，也不是我们基础设施杀的 —— 是 agent 自己把自己杀了。**
触发条件是我们这边造成的（prompt 进了命令行），已根治，不需要兜底。

| | |
|---|---|
| 现象 | 前端提示「制作引擎异常退出 code=null signal=SIGKILL」 |
| 用户看到的时间 | 2026-10-26 00:28:13（UTC+8） |
| 服务端时间 | 2026-10-25 16:28:13 UTC（服务端按 UTC 记录，差 8 小时） |
| 影响 | 单个任务失败，无产物；同机其它任务未受影响 |
| 根因 | prompt 原样进 cc 命令行 → agent 的 `pgrep -f` 清理命中自己 → `kill -9` 自杀 |
| 状态 | 已修（v1.3.5），已加回归测试 |

---

## 1. 现场位置

**会话（线上）**
```
/mnt/afs_if/codevideo/workspace/session/sessions/sess_eacb339b-f3e9-43a7-a736-6f8419fc20be
```

**任务工作区**
```
.../jobs/job_dc9fd3ab-2c4b-4f26-921f-85df967c9fc2/
  ├── prompt.md        ← 本次 prompt（含 "chrome-linux64/chrome"，是关键证据）
  ├── claude.jsonl     ← 4564 行轨迹，最后一条就是那句自杀命令
  ├── claude.stderr    ← 只有一行 unrecognized_model 警告，无报错
  └── output/          ← 空
```

**Gateway 记录**
```
/mnt/afs_if/codevideo/workspace/coding-video-web/runtime/gateway/jobs/job_dc9fd3ab-2c4b-4f26-921f-85df967c9fc2.json
```
```
created : 2026-10-25T16:28:13.407Z
started : 2026-10-25T16:29:20.290Z
finished: 2026-10-25T16:39:33.375Z
worker  : cvw-700
failure : E_CLAUDE_EXIT | 制作引擎异常退出 code=null signal=SIGKILL
```

> 注意：**用户提到的 `sess_dd9bb0ad-…` 不是这一次**。那个会话里唯一的任务
> `job_cb98f4a3` 在 17:48 **成功**产出了 23MB 视频。同名任务（鹈鹕骑车）跑过多次，
> 失败的是上面这个 `sess_eacb339b-…`，按截图时间戳 00:28 对回 UTC 16:28 才定位到。

---

## 2. 怎么诊断的

**① 先排除 API 层。** 轨迹里 `result.is_error` 事件 **0 个**；
`claude.stderr` 全文只有一行 `[claude-code:unrecognized_model]` 警告（无害，模型名不在 cc 的已知列表里）。
用 `rate_limit|429|5xx|timeout|overloaded` 搜到 75 处命中，逐条看过 —— **全是 agent 自己写的
JS 代码文本和 UUID**，没有一处是真的 API 失败。**API 层干净。**

**② 看死法。** `code=null signal=SIGKILL` 意味着进程被 SIGKILL 强杀，不是自己退出的。
SIGKILL 不可捕获，所以没有任何清理痕迹。

**③ 排除我们杀的。** 三个可能的凶手都查了：
- Bridge 日志里**没有**「提前收尾」记录（1.3.2 的两阈值逻辑没触发）；
- `kill-leftovers.sh` 只杀归属本工作区的进程（按 `CVW_JOB_TOKEN` / cwd / 命令行三重匹配），杀不到别的任务；
- watchdog 的取消/判死都会留日志，日志里没有。

**④ 看轨迹最后一条。** 这是决定性的一步：

```
16:39:30.196Z  最后一条工具调用 Bash：
  for p in $(pgrep -f "chrome-linux64"); do kill -9 $p 2>/dev/null; done; sleep 1; \
  cd /workspace/src/film && timeout 100 node /workspace/scripts/capture.mjs ...
16:39:33       任务被判 E_CLAUDE_EXIT
```
**这条命令之后，轨迹 0 行。** 发完命令 3 秒就死了。

**⑤ 验证机制。** agent 想清理残留的 headless Chromium，用了 `pgrep -f "chrome-linux64"`。
`pgrep -f` 匹配的是**整条命令行**。而我们起 cc 的方式是：

```
claude -p "<整段 prompt 全文>" --output-format stream-json ...
```

这次的 prompt 里恰好写了浏览器路径 `runtime/browser/chrome-linux64/chrome`
（`prompt.md` 里出现 1 次）—— 于是 **cc 自己的命令行里就含有 `chrome-linux64`**，
`pgrep -f` 把它匹配出来，`kill -9` 当场把自己杀掉。

**线上实测抓到了证据**（在 dev 用同样 prompt 复现）：
```
pgrep -f chrome-linux64 命中 3 个:
  pid=371152  claude -p Create a 2-second MP4 at output/final.mp4 using the browser at runtime/browser/chrome-linux64/chrome
```
第一个命中的就是 cc 本体。

---

## 3. 为什么以前没炸

需要三个条件同时满足，所以是偶发：
1. prompt 里出现了某个进程名/路径关键词（这次是 `chrome-linux64`）；
2. agent 恰好决定用「按模式杀进程」来清理（而不是杀自己记录的 pid）；
3. 模式刚好匹配到 cc 自己的命令行。

SKILL.md 里**原本就警告过** `pkill -f <pattern>` 会杀到自己，
但 agent 这次用的是 `pgrep -f ... | kill -9` —— 换了个写法就绕过了那条警告。

---

## 4. 修复（v1.3.5，不是兜底，是根治）

**① prompt 改走 stdin，不进命令行。**
```js
// 之前：claude -p "<整段 prompt>"
// 现在：claude -p   （prompt 从 stdin 送入）
stdio: ['pipe', outFh.fd, errFh.fd],
child.stdin.end(fullPrompt, 'utf8');
```
命令行里不再有 prompt，**任何 `pgrep -f` 模式都不可能再匹配到 cc 本体**。
修复后实测 cc 的 cmdline 只剩：
```
claude -p --permission-mode bypassPermissions --output-format stream-json --verbose --disallowedTools WebSearch
```

这是根治而不是兜底：不是"检测到自杀再重试"，而是让这个匹配**在物理上不可能发生**。

**② SKILL.md 把禁令写死**（4 个文件）。
原文只提了 `pkill -f`，现在明确禁止一切按名字/模式杀进程，
并把本次事故作为例子写进去 —— 让 agent 知道为什么。

> 补充：隔离没有开 `--pid` 命名空间（进程视图是全局的），
> 所以模式匹配不仅会误杀自己，还会**误杀同机其它用户的渲染进程**。
> 禁令同时堵住了这个风险。

**③ 回归测试** `tests/risk/argv-safety.mjs`（9 项）守住这两条，防止以后改回去。

---

## 5. 不做什么

- **不加自杀检测/自动重试。** 根因已消除，兜底只会掩盖问题、浪费一次重跑。
- **不改 `kill-leftovers.sh`。** 它的归属判定是对的，本次与它无关。
- **不碰提前收尾阈值。** 本次不是它触发的。

---

## 6. 复现与验证

```bash
# 复现（会看到 pgrep 命中 cc 自己）
pgrep -f "chrome-linux64"

# 验证修复：跑一轮真任务，确认 cc 的 cmdline 里没有 prompt
bash scripts/e2e-checklist.sh      # 生成 2 秒视频 + 微调一轮，并断言全程无 SIGKILL
node tests/risk/argv-safety.mjs    # 静态守卫：prompt 不进 argv + SKILL 禁令
```
