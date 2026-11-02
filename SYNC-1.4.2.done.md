# 1.4.1 → 1.4.2 同步清单

线上现在是 **1.4.1**（2026-10-28 已同步），dev 是 **1.4.2**。
本文件只列「要动什么」，不含任何对线上的操作。
1.4.0 → 1.4.1 那份清单已归档为 `SYNC-1.4.1.done.md`。

---

## 0. 本版只有一件事

修掉线上缺陷报告 `BUG-cancelling-stuck-forever.md` 里那个
**「取消后永久卡在 CANCELLING」**。

修的是取消那个缺陷；发版过程中又顺手修了版本号管线（见第 1.2 节）。
我按文件逐个 diff 过线上与 dev，**运行时代码差异就这三个文件**：

```
apps/gateway/src/watchdog.mjs     差 153 行   ← 取消缺陷修复
apps/web/next.config.mjs          差  34 行   ← 构建期注入版本号与环境角标
apps/web/app/_workspace.tsx       差  15 行   ← 两个写死的常量改成读注入值
```

> ✅ 三个文件都**可以整文件覆盖**。
> 我查过：`watchdog.mjs` 零 dev 专用串；另两个文件里出现的「开发环境」
> **只在注释里**（讲这个坑的来历），没有任何行为上的 dev 依赖。
>
> ⚠️ 这是**上一版的陷阱已被拆掉**：1.4.1 时 `_workspace.tsx` 里写死
> `const ENV_LABEL = '开发环境'`，所以那次只能挑行同步、不能整文件覆盖。
> 现在它从 `config/backend.json` 的 `environment.display` 派生
> （线上该字段是 `null` → 角标不显示），两个环境的源码就一致了。

---

## 1. 必须同步

### 1.1 取消缺陷（本版主体）

| 文件 | 说明 |
|---|---|
| `apps/gateway/src/watchdog.mjs` | 整文件覆盖 |
| `VERSION` | → `1.4.2` |
| `CHANGELOG.md` | 1.4.2 段整体带过去 |

**只动 Gateway 就能让缺陷修复生效**：

```
svc-restart.sh gateway
```

### 1.2 版本号管线（建议一起带，否则角标会停在 1.4.1）

| 文件 | 说明 |
|---|---|
| `apps/web/next.config.mjs` | 构建期从 `VERSION` 与 `config/backend.json` 注入 |
| `apps/web/app/_workspace.tsx` | `APP_VERSION` / `ENV_LABEL` 改为读注入值 |
| `scripts/release-check.sh` | 新增「构建产物含本版版本号」判据（见第 4.1 节一起改） |

为什么顺手修这个：`_workspace.tsx` 里原来是 `const APP_VERSION = '1.4.1';`
—— 发版要手工改，**本次就忘了**：`VERSION` 和 Gateway 都已是 1.4.2，页面角标还是
v1.4.1；而 `release-check.sh` 的「前后端版本一致」比的是 VERSION 文件 vs Gateway，
**前端那一侧根本没查**，所以它还是绿的。

带上这部分就要**重新 build 前端**（`start-frontend.sh build` 然后重启）。
不带也行，缺陷修复不受影响，只是线上角标会一直停在 1.4.1，
并且下次仍要手工改那个常量。

### 改了什么（三层）

1. **主改**：取消宽限超时后重发时，**消费 Bridge 的回复**。
   `already_gone`（Bridge 内存里已无此 job）或 `stopped`（本次真停了）
   任一为真就落 `CANCELLED`。
   原来是 `.catch(() => {})` 连返回值都不接，而唯一能 settle 的 `else`
   分支要求「进程失联」—— Bridge 健康时永远走不到，于是死锁。
2. **兜底一**：重发 2 次仍无定论 → `probeJob` 读磁盘终态标记
   （`.cancelled` / `.done` / `.failed`）。
   读到 `completed` 则**按完成处理并保留产物**（取消来晚了，成片已经出来了）。
3. **兜底二**：重发上限 5 次，到顶落 `FAILED / CANCEL_UNCONFIRMED`，
   不再无限刷日志。

新增两个同文件内的方法 `settleCancelled` / `settleCancelByProbe`，
没有新增跨模块 API，`store.*` 与 `this.releaseSlot` 都是现成的。

---

## 2. 上线后会自动发生的事

报告里那两个卡住的任务，**下一个 watchdog tick 就会自动落终态，不需要手工改数据**。
dev 上已实测：把一条已收尾的 job 改回 `CANCELLING`（`requested_at` 设成 30 分钟前），
watchdog 第一个 tick 就救回：

```
[watchdog] job_6576b2fd… 取消宽限超时，重发取消（第 1 次）
[watchdog] job_6576b2fd… 取消已确认（Bridge 内存中已无此任务）→ CANCELLED
```

- `job_c9297c91`（你的测试任务）：会变成 `CANCELLED`。
- `job_7ef40155`（真实用户 syssy，卡了 24 小时+）：
  **请先确认它的 `.cancelled` 标记在不在**。
  在 → 同一个病，会变 `CANCELLED`；
  不在 → 是另一回事（进程真的失联），会走 `FAILED / CANCEL_UNCONFIRMED`，
  也算有了定论，不会再悬着。

上线后可以这样确认不再有死循环：

```bash
grep -c "取消宽限超时，重发取消" runtime/logs/gateway.log   # 不应持续增长
grep "取消已确认" runtime/logs/gateway.log | tail           # 应该能看到 settle
```

---

## 3. 测试（可选带）

| 文件 | 说明 |
|---|---|
| `tests/risk/cancel-settle.mjs` | **新增**，14 项行为测试 |
| `tests/risk/run-all.sh` | 列表末尾加 `cancel-settle` |

`cancel-settle.mjs` 里有一处 dev 仓库根的兜底（`CVW_REPO_ROOT ??=`），
带去线上改成线上仓库根即可；其余零 dev 专用串。

它是**行为测试**而不是正则守卫：真 Watchdog + 真 job-store（临时沙箱，
会先断言 `storage.root` 真的指向沙箱才继续跑）+ 按剧本回答的假 Bridge。
7 个场景：`already_gone` / 只回 `stopped` / 回复丢失走 probe /
取消来晚已完成 / 重发上限 / 进程失联老路 / 宽限期内不动手。

---

## 4. 两条仍然悬着的脚本建议（与本版无关，你定）

这两条上次就提过，线上那份现在还是旧的。都只影响**部署脚本**，不碰运行时。

### 4.1 `scripts/release-check.sh`：A 段两个 bug + G 段一个假绿

```sh
OTHER=$(( $(pgrep -fc '^next-server' 2>/dev/null || echo 0) - N ))
```

① `pgrep -fc` 计数为 0 时**既打印 "0" 又返回非零退出码**，
于是 `$( ... || echo 0 )` 拼成 `"0\n0"` → **算术展开语法错**。
在没有 next-server 的机器上必现（比如只在 Gateway 机器上跑自检）。

② 这一段按 cwd 查**本机**进程，而线上前端在 `10.120.6.11`、Gateway 在 `10.120.7.0`。
在 Gateway 机器上跑这一项时 `N` 必然是 0 → 永远红，红的是「跑错机器」不是部署。

改法（dev 那份可直接参考）：

```sh
ALL=$(pgrep -fc '^next-server' 2>/dev/null | head -1 || true)
OTHER=$(( ${ALL:-0} - N ))
WEB_HOST=$(j "['deployment']['web']['host']")
MY_IPS=$(hostname -I 2>/dev/null || echo)
case " $MY_IPS " in
  *" $WEB_HOST "*)
    [ "$N" = 1 ] && ok "本工作区前端实例数" "1（其他环境 $OTHER 个，不影响）" \
      || no "本工作区前端实例数异常" "$N（应为 1）" ;;
  *)
    echo "  ·  跳过：前端在 $WEB_HOST，本机不是它（实例数要在那台上查）" ;;
esac
```

读的是 `deployment.web.host`，所以这段代码在线上也直接成立，不用改主机名。

**③ G 段的「前后端版本一致」是假绿**（与第 1.2 节同一件事）：
它只比 `VERSION` 文件和 Gateway 的 `/healthz`，从不检查前端构建产物。
dev 那份已拆成两项，加了这段：

```sh
if [ -d apps/web/.next/static/chunks ]; then
  if grep -rqF "$V" apps/web/.next/static/chunks 2>/dev/null; then
    ok "构建产物含本版版本号" "v$V"
  else
    no "构建产物里没有 v$V（忘了重新 build？）" \
       "产物里的版本串: $(grep -rhoE '1\.[0-9]+\.[0-9]+' apps/web/.next/static/chunks 2>/dev/null | sort -u | tr '\n' ' ')"
  fi
else
  echo "  ·  跳过构建产物版本检查：本机没有 .next（前端不在这台）"
fi
```

实测把 VERSION 改成 1.4.9 而不重建，它立刻红并打印产物里的实际版本串。

### 4.2 `scripts/start-frontend.sh`：僵死的前端会把重启堵住

```sh
alive(){ [ -f "$P" ] && kill -0 "$(cat "$P")" 2>/dev/null; }
start)  alive && { echo "前端已在运行 (pid $(cat "$P"))"; exit 0; }
stop)   alive && { kill "$(cat "$P")" && echo "已停止前端"; }
```

`alive` 只问「进程还在吗」，不问「它还在服务吗」；`stop` 只发 SIGTERM、
不等待、不升级 SIGKILL。

**我在 dev 上真撞到过**：老 `next-server` 卡住（SIGTERM 不走），`alive` 说还在，
`start` 于是直接 exit 0 什么都不做 —— 结果 8000 端口没人服务，
我手工 `kill -9` 才起来。你同步时如果也要重新 build 前端，有概率撞上同一件事。

建议把 `alive` 改成「进程在 **且** `/health` 能应答」，`stop` 改成
SIGTERM → 等几秒 → 仍在就 SIGKILL。

**我没有动它**（dev 和线上的这份脚本都没改）。要我改就说一声，
改完我在 dev 上验一次「僵死进程能被正常接管」。
