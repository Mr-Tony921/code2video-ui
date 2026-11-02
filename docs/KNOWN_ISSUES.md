# 已知问题登记簿（已确认、暂不处理）

这里只放**已经查清根因、但决定暂时不动**的问题。登记的目的有两个：
一是避免下次再花时间重新诊断一遍，二是把"不处理"这个决定连同理由一起留痕 ——
没写理由的"已知问题"下次会被人当成新 bug 重查。

修掉之后不要删条目，在标题上标 **已修** 并写明版本（参照
[`SESSION_SLOT_RISK.md`](SESSION_SLOT_RISK.md) 的做法）。

| # | 问题 | 严重度 | 状态 |
|---|---|---|---|
| 1 | skill 自带的 `capture.mjs` 不传 `executablePath`，隔离里起不了浏览器 | 中（不致失败，但每次浪费十几分钟） | **1.4.4 已修** |
| 2 | 同一脚本的 favicon 404 把抓帧循环 break 掉，整段视频只剩第 1 帧 | 高（静默产出错误结果） | **1.4.4 已修**（修 1 时实测发现） |

---

## 1. `code-video-core/scripts/capture.mjs` 在隔离环境里必定启动失败（**1.4.4 已修**）

发现于 2026-10-28 排查 dev 任务 `job_43c9b259`（会话 `sess_358f7876`）。
**不是 1.4.x 引入，线上现有版本同样存在**，且自 1.2.0 起这个文件一个字节没变过。

### 现象

agent 按 skill 说明书去调我们自带的采集脚本，必定失败：

```
$ node .claude/skills/code-video-core/scripts/capture.mjs src --page test.html --out work/test.mp4
    at /workspace/.claude/skills/code-video-core/scripts/capture.mjs:37:32 {
  log: [],
  name: 'Error'
}
```

报错形状有误导性：Playwright 的异常对象带 `log: []`，agent 用 `tail -3` 截出来只剩
`at capture.mjs:37:32 { log: [], name: 'Error' }`，**看着像模块解析失败**。
实测 agent 因此去改 `createRequire(...)`，白费了 4 分钟 —— 诊断时别跟着跑偏。

完整报错（本地复现拿到的）：

```
browserType.launch: Executable doesn't exist at
  <HOME>/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell
╔ Looks like Playwright was just installed or updated.
║ Please run the following command to download new browsers: npx playwright install
```

### 根因

`assets/skillsets/*/code-video-core/scripts/capture.mjs:37`：

```js
browser = await lib.chromium.launch({ args: glArgs });   // ← 没有 executablePath
```

不传 `executablePath` 时，Playwright 去找**它自己下载的**浏览器，默认位置是
`$HOME/.cache/ms-playwright/`。而隔离环境里：

- `HOME=/workspace/.home`，**每个会话新建**，里面只有 `fontconfig`，没有 `ms-playwright`
- `/mnt` 被 tmpfs 遮蔽（实测 `/proc/<pid>/root/mnt` 是 0 个条目），宿主上的缓存也看不到
- 隔离内没有外网，`npx playwright install` 下不动

讽刺的是 **chrome 本来就在手边**：`CHROME_BIN=/srv/chrome-linux64/chrome`，
在命名空间**内部确实存在**（从 `/proc/<pid>/root/srv/...` 核过；
注意在隔离**外面**看这个路径是不存在的，只在外面查会误判成"CHROME_BIN 配错了"）。
而且 `job-workspace.mjs:90` 的 output contract 明确告诉了 agent
「把 CHROME_BIN 作为 executablePath 传进去」—— **偏偏我们自己发给它的脚本没照着做。**

### 这是 skill 的文件，不是后端代码

| 事实 | 核实方式 |
|---|---|
| 它是我们仓库的文件 | `assets/skillsets/{coding_to_video,blockout_3d}/code-video-core/scripts/capture.mjs`，4506 B |
| 它是 `code-video-core` 这个 skill 的一部分 | 该 skill 只有 4 个文件：`SKILL.md` + 3 个 scripts |
| **说明书主动叫 agent 用它** | `SKILL.md:70-71` 给出了完整命令行 |
| 每轮投递给 agent | `job-workspace.mjs:248-250` 先 `rm -rf` 再整组 `cp` 进 `<ws>/.claude/skills/` |
| **后端从不执行它** | `grep -rn 'capture\.mjs' apps/ scripts/` → **0 处**，只有 agent 会调 |
| 两个 skillset 各一份独立拷贝 | inode 不同、链接数均为 1 —— **改要改两处** |

### 为什么所有测试都没发现

`tests/risk/`、`smoke.sh`、`release-check.sh` 测的都是**我们自己的代码路径**，
而这个文件从不在那些路径上（后端 0 处引用）。它要等一个 agent 真的决定用它才会暴露，
而 agent 多数时候自己写采集代码 —— 所以能潜伏到现在。

### 实际影响（已量化）

以 `job_43c9b259` 为例：

```
11:21:33  第一次调 capture.mjs → launch 失败
11:26:19  再试一次            → 同样失败
11:28:45  误判为模块解析问题，开始改 createRequire（走偏）
11:32:17  仍失败
11:34:03  自己写调试脚本、手动传 executablePath → 通了
11:34     work/t1.mp4 产出
```

- **约 13 分钟**、42 次工具调用里的 **10 次**耗在这上面
- **不会导致任务失败**：agent 最终自己抄了一份 `src/tools/capture.mjs`
  并加上 `executablePath: process.env.CHROME_BIN`，等于**每个任务都把这个 bug 自己修一遍**
- 该任务后续正常推进（RUNNING → GENERATING，成片产出正常）

### 同仓库里就有正确写法

```
blockout_3d/whitebox-previs/scripts/render.mjs:43
  const executablePath = process.env.CHROME_BIN;
  if (!executablePath) throw Error('Set CHROME_BIN to the sandbox Chromium executable');
  → puppeteer.launch({ executablePath, ... })          ✅ 对
*/code-video-core/scripts/capture.mjs:37
  lib.chromium.launch({ args: glArgs })                ❌ 两个 skillset 都错
```

白模（3D blockout）那条路径是对的，**主力的 2D 视频路径是错的**。

### 建议解决方案

改 `capture.mjs:37`（以及 `:41` 的 puppeteer 分支），**两个 skillset 各一份都要改**：

```js
const exe = process.env.CHROME_BIN;
browser = await lib.chromium.launch({ args: glArgs, ...(exe ? { executablePath: exe } : {}) });
```

`exe ?` 这个条件是必要的：本地装了真 Playwright 浏览器的环境（开发机）保持原行为不变，
不要写成无条件依赖 `CHROME_BIN`。

顺带建议给 `code-video-core/SKILL.md` 补一句「自己起浏览器时必须传
`executablePath: process.env.CHROME_BIN`」—— agent 手写采集代码时也能少踩。

### 已排除的另一条路（别再试）

**不要**去 `config.shared_caches` 里钉 `PLAYWRIGHT_BROWSERS_PATH`。实测：

```
.50 上 /root/.cache/ms-playwright        不存在
      /var/tmp/ms-playwright             不存在
      /opt/videokit/.cache/ms-playwright 不存在
```

**ms-playwright 的浏览器一份都没下载过**，隔离内又没有外网。钉路径只会从
"找不到"变成"指着一个空目录找不到"。要走这条路，得先在镜像或 `/var/tmp` 里
预下载一套浏览器（几百 MB），没必要 —— 系统 chrome 已经在 `/srv/chrome-linux64/chrome`，
agent 实测用它出片正常。

### 为什么暂不处理

1. **不是阻断性故障。** agent 每次都能自己绕过去，成片质量不受影响。
   代价是每个用到它的任务浪费十几分钟和一些 token —— 是效率问题，不是正确性问题。
2. **改动面落在 `assets/skillsets/`，dev 与线上共用。** 一改就必须同步线上，
   而 1.4.3 刚同步完（2026-10-28）。线上用户多，为一个"agent 能自愈"的效率问题
   再推一次同步，收益和风险不划算。
3. **改 skill 的风险不在代码层，在模型行为层。** 有先例：1.3.9 砍掉 output contract 里的
   「Context budget」一节，就是因为那段硬约束把成片质量带下来了（见
   `job-workspace.mjs:102-112` 的注释）。动 skill 要配质量回归，不能只看"脚本跑通了"。
4. **验证成本不低。** 要真跑任务确认 `capture.mjs` 能直接出片，
   且 `coding_to_video` 和 `blockout_3d` 两个 skillset 都要测，一轮十几分钟起。
5. **当前没人被它挡住。** 真实影响面是"用了这个脚本的任务慢十几分钟"，
   目前没有因它失败的任务记录。

### 什么时候应该回来修

出现下面任一情况，就不该再拖：

- 有任务**因为它真的失败**（agent 没能绕过去，比如上下文不够重写脚本了）
- 下次本来就要同步 `assets/skillsets/`（顺带改，边际成本接近零）
- 开始统计任务耗时、要压缩 P50 时长（13 分钟是实打实的浪费）
- 新增别的用 Playwright 的 skill 脚本（同一个坑会复制一遍，应该先把正确写法立住）

### 复现方法

```bash
# 在任一 bridge 机器上（10.120.3.50 / .60），模拟隔离里的空 HOME
FAKE=$(mktemp -d); cd /opt/videokit
HOME=$FAKE XDG_CACHE_HOME=$FAKE/.cache node -e "
require('playwright').chromium.launch({args:['--no-sandbox']})
  .then(b=>{console.log('launch 成功');return b.close()})
  .catch(e=>console.log('失败:', e.message.split('\n')[0]))"
# 预期：Executable doesn't exist at <FAKE>/.cache/ms-playwright/...
rm -rf $FAKE
```

注意**要在 `/opt/videokit` 下执行**（`playwright` 要从那里的 `node_modules` 解析）；
在别的目录跑会先报 `Cannot find package 'playwright'`，那是另一个错，别混淆。

### 1.4.4 的处理与一个连带发现

2026-10-29 按用户要求修掉了（两个 skillset 各一份）：

```js
const exe = process.env.CHROME_BIN;
const launchOpts = { args: glArgs, ...(exe ? { executablePath: exe } : {}) };
```

**原先"暂不处理"的第 3 条理由（改 skill 风险在模型行为层）在这里不成立** ——
那条针对的是改 skill 的**提示词**（1.3.9 砍 Context budget 导致质量下降）。
这次改的是脚本里的启动参数，agent 读到的内容一个字没变，不涉及模型行为。

---

## 2. 抓帧循环被 favicon 404 打断，整段视频只剩 1 帧（**1.4.4 已修**）

修第 1 条时实测发现的，**比第 1 条更严重**：它会静默产出错误结果。

`capture.mjs` 的抓帧循环里有一条：

```js
if (errors.length) { console.error('page error at frame', i, errors); break; }
```

而 `errors` 收的是**所有 console error**。浏览器总会自己请求一次 `/favicon.ico`，
这个脚本**自己起的那个 http 服务器**对它回 404 → 浏览器打一条 console error →
循环在第 1 帧就 break，但脚本照样打印 `wrote <out>`。

实测（`--fps 10 --dur 2`，应出 20 帧）：

| 页面 | 帧数 | 时长 |
|---|---|---|
| 不声明 icon（常态） | **1** | 0.1s |
| 加 `<link rel="icon" href="data:,">` | 20 | 2.0s |
| **修复后**，不声明 icon | **20** | 2.0s |

修法是让服务器对 favicon 回 204（是它自己造的 404，就在源头消掉），
**没有去放宽错误判据** —— 真正的页面报错仍然必须中断抓帧。

> ⚠️ 这条的意义：只修第 1 条（chrome 路径）其实**不能降低工具失败**，
> 只是把失败点从"启动崩"挪到"第 1 帧截断"。两条一起修，脚本才真的可用。

