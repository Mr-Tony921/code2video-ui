# 1.4.4 → 1.4.5 同步清单

线上现在是 **1.4.4**，dev 是 **1.4.5**。上一版清单已归档为 `SYNC-1.4.4.done.md`。
本文件只列「要动什么」，**线上一律由你执行**。

> dev 的模型端点已切到 `app-ca2663…:8000`（`Qwen3.8-27B-video-generation-v23`），
> 属**实验性质**。`config/backend.json` **绝不要同步**。

---

## 0. ⚠️ 先看这条：`assets/skills/` 不能删

你在 1.4.4 报告的「附带发现 B」里写：

> 建议直接删掉这两个遗留目录 —— 留着的唯一作用就是让人下次改 skill 时数错份数。

**这条是错的，请不要执行；如果已经删了，请先恢复。** 我在 dev 照着删了一次，
`tests/risk/argv-safety.mjs` 当场在 import 阶段崩掉（`readFileSync` 对不存在的文件抛异常）。

`assets/skills/` 实际被 **5 处**引用：

| 引用方 | 用它什么 | 删掉的后果 |
|---|---|---|
| `scripts/install-previs-deps.sh:7` | `code-video-whitebox/scripts/whitebox-previs/package.json` | **装白模依赖直接失败** |
| `tests/integration/run-whitebox-render.sh:5` | 跑 `whitebox-previs/runtime.mjs` / `render.mjs` | 白模集成测试跑不了 |
| `tests/integration/run-whitebox-e2e.sh:4` | 同上 | 同上 |
| `tests/risk/argv-safety.mjs:101-102` | 读两份 `SKILL.md` | **整个测试文件崩** |
| `config/backend.json:263` | `"$use": "assets/skills/*/requirements.txt"` | 文档键，无运行时影响 |

「只有 `skillsets_root` 被引用」这个判断**只在 `apps/` 范围内成立** ——
脚本与测试里还有一堆。（我第一次查也漏了：grep 里写了 `grep -v '.*assets/skills'`，
把正要找的行自己过滤掉了。）

`assets/skills-v2/` 确实零引用（全仓库 grep 只命中我自己的 CHANGELOG），
但本版**也没删它** —— 见下面的做法。

### 代替删除的做法：把 5 份统一，并让份数自己管住自己

1.4.4 只改了 `skillsets/` 下那 2 份，**另外 3 份还是旧版**（会把视频截成 1 帧还照样
打印 `wrote` 的那个版本）。本版把 5 份统一成同一个文件：

```
7a9cb348a099  assets/skillsets/coding_to_video/code-video-core/scripts/capture.mjs
7a9cb348a099  assets/skillsets/blockout_3d/code-video-core/scripts/capture.mjs
7a9cb348a099  assets/skills/code-video-base/scripts/capture.mjs
7a9cb348a099  assets/skills/code-video-whitebox/scripts/capture.mjs
7a9cb348a099  assets/skills-v2/code-video-core/scripts/capture.mjs
```

并新增 `tests/risk/skill-scripts.mjs`：**递归扫出 `assets/` 下所有 `capture.mjs`**，
逐份校验（显式 `executablePath`、favicon 回 204、无残留裸 `launch({args})`），
且要求**所有份数只有一个 md5**。这样"有几份"不再是需要人记的信息 ——
线上跑它会按线上实际份数自动校验。

---

## 1. 整文件覆盖（dev → 线上）

```
tests/risk/stream-leak.mjs       按「实际存在的启动脚本」断言 + existsSync + 「至少一个」
tests/risk/skill-scripts.mjs     【新增】
scripts/switch-model.sh          【新增】切/核对模型端点，纯按配置工作，无 dev 专用串
assets/skills/code-video-base/scripts/capture.mjs          ← 统一到已修版本
assets/skills/code-video-whitebox/scripts/capture.mjs      ← 同上
assets/skills-v2/code-video-core/scripts/capture.mjs       ← 同上
VERSION  CHANGELOG.md
```

`tests/risk/run-all.sh`：你线上**已经自己修过**同一处（CVW_WORKER_ID 按配置取）。
dev 这份逻辑一致、另加了注释与 `_R` 变量。**先 diff 再决定**，不要盲覆盖：

```bash
diff <(grep -A14 'CVW_WORKER_ID' /线上/tests/risk/run-all.sh) \
     <(grep -A14 'CVW_WORKER_ID' /dev/tests/risk/run-all.sh)
```

---

## 2. 手工改一行（这两个脚本线上要保留自己的版本）

两边各自带着自己的仓库根默认值与管理员口令，**不能整文件覆盖**：

```diff
# scripts/smoke.sh —— 冒烟一律关扩写
- -d '{"prompt":"冒烟测试：…","max_runtime_seconds":900}'
+ -d '{"prompt":"冒烟测试：…","max_runtime_seconds":900,"enhance":false}'
```

```diff
# scripts/start-backend.sh —— 默认 worker 按配置取（你线上已改过，核对一下即可）
- WORKER="${CVW_WORKER_ID:-cvw-161}"
+ WORKER="${CVW_WORKER_ID:-$(python3 -c "…取第一台 enabled 的 worker…")}"
```

**为什么冒烟要关扩写**：扩写把 21 个汉字扩成 4000+ 字符、带「抽帧测质心误差 ±2px」
这类验收项的规格书，实测跑满 `max_runtime=900s` 被杀（片子其实早做出来了）；
而且扩写**不确定**（同一句话两次扩写 4104 / 4471 字符），
拿它做版本或模型对比会得出错误结论。`e2e-checklist.sh` 本来就是 `enhance:False`。

---

## 3. 勿反向覆盖（线上版本更新，dev 版会把已修的问题带回去）

```
scripts/svc.sh  svc-run-gateway.sh  svc-run-bridge.sh      线上专有
scripts/hot-update.sh  smoke.sh  release-check.sh  e2e-checklist.sh
config/backend.json    ← 线上独有（gateway.host、cvw-700 并发 2、preview 段）
                          且 dev 现在是实验模型 v23，覆盖会把线上模型换掉
```

---

## 4. 验收

```bash
bash tests/risk/run-all.sh          # 期望 29/29（线上份数不同，skill-scripts 条数会多）
bash scripts/switch-model.sh --check # 期望「模型名与端点一致」「max_context 与 max_model_len 一致」
bash scripts/release-check.sh
bash scripts/smoke.sh               # 现在不扩写，应当明显快于上一版
```

本版未改任何运行时逻辑（只动配置、脚本、测试与 skill 脚本），
Gateway/Bridge 只需按常规重启一次以让 `healthz` 报 `v1.4.5`。
