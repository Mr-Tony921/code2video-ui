# 上下文长度与压缩率：改哪里

两个值都在 **`config/backend.json`** 的 `model` 节，**改完重启 bridge 即生效，不用改代码**。

> 路径（dev）：`/mnt/afs_if/codevideo/workspace/code2video-dev/config/backend.json`
> 路径（线上）：`/mnt/afs_if/codevideo/workspace/coding-video-web/config/backend.json`

## 要改的两行

| 配置项 | 行号 | 当前值 | 说明 |
|---|---|---|---|
| `model.max_context_tokens` | **63** | `524288` | 上下文长度 = 512K |
| `model.auto_detect_context` | **79** | `false` | **必须保持 false** |
| `model.autocompact_pct` | **84** | `80` | 压缩触发阈值（%） |

```json
// 行 63
"max_context_tokens": 524288,
// 行 79
"auto_detect_context": false,
// 行 84
"autocompact_pct": 80,
```

### 为什么 `auto_detect_context` 必须是 false

开启时 bridge 启动会去 `/v1/models` 读 `max_model_len` 并**覆盖**第 63 行的值
（见 `apps/worker-bridge/src/config.mjs` 的 `detectModelContext`），
实际生效值就不再由配置决定。设成 `false` 后以配置为准，512K 固定。

（顺带：模型当前上报的也是 524288，与配置一致；关掉只是为了"值由我们定"。）

## 这两个值怎么传给 cc

`claude_cli.env` 里用占位符引用，**不要在这里写死数字**：

| 环境变量 | 行号 | 值 |
|---|---|---|
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | **138** | `${model.max_context_tokens}` |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | **139** | `${model.autocompact_pct}` |

压缩阈值 = `max_context_tokens × autocompact_pct%` = 512K × 80% ≈ **419K token** 时开始压缩。

## 调整建议

- **`autocompact_pct` 调大**（如 90）：更晚压缩，单次可用上下文更多，但更贴近上限、
  一旦压缩失败就容易撞 `Prompt is too long`。
- **调小**（如 70）：更早压缩，更安全，但压缩更频繁，长任务会多花时间。
- 80 是折中值。

## 临时覆盖（不改配置）

```bash
export CVW_AUTOCOMPACT_PCT=70     # 只影响本次启动的 bridge
```

## ⚠️ 加新的 `${model.xxx}` 占位符时

占位符是**白名单式**的，在 `apps/worker-bridge/src/job-runner.mjs`
的 `resolveClaudeEnv()`（约 70 行）里登记。
**不登记会被替换成空串，而空串被当作"不设该变量"直接丢掉** ——
配置看着改了却完全没生效，且没有任何报错。加新项时务必同步改那里。

## 改完怎么确认真的生效

```bash
# 1) 重启 bridge
bash scripts/start-backend.sh restart-bridge     # 或你的启动脚本

# 2) 跑一个任务，抓 cc 进程的实际环境变量（这是唯一可信的确认方式）
for p in $(pgrep -x claude); do
  tr '\0' '\n' < /proc/$p/environ \
    | grep -E 'CLAUDE_CODE_MAX_CONTEXT_TOKENS|CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'
done
```
期望输出：
```
CLAUDE_CODE_MAX_CONTEXT_TOKENS=524288
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80
```

> 只看配置文件不算确认 —— 占位符漏登记、探测覆盖这两种情况都会让配置静默失效。
