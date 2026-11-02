# 1.4.5 → 1.4.6 同步清单

线上现在是 **1.4.5**，dev 是 **1.4.6**。上一版清单已归档为 `SYNC-1.4.5.done.md`。
本文件只列「要动什么」，**线上一律由你执行**。

> dev 的模型端点是实验配置，`config/backend.json` **绝不要同步**。

---

## 0. 本版解决什么（对应你那份排查报告）

| 报告里的问题 | 处理 | 实测 |
|---|---|---|
| 轮询把出口占满（88.9 KB/s vs 入口 43~71 KB/s） | `active-context?brief=1` + 定时器只取增量 | **649,278 B → 857 B（758×）** |
| 全链路没有 gzip | **加在代理层，不是 Gateway**（报告那个位置是错的） | 全量 649,278 → 144,372 B（4.5×），头里确实带 `content-encoding: gzip` |
| 并发显示 20 vs 实际 18 | `capacity` 改报实际可用，另给 `declared_capacity` | dev 显示 `capacity=6 / declared=8`（2+4 两台） |
| 会话分配不看单机并发上限 | `pickForSession` 按并发容量归一 | 12 次分配：cap=4 拿 8 个、cap=2 拿 4 个（正好 2:1） |
| 已完成任务上的空 `failure` 空壳 | 在 `publicJob` 边界收口为 `null` | — |
| `completed_at` 没写 | **不新增字段**，文档明示 `finished_at` 权威 | — |

---

## 1. 整文件覆盖（dev → 线上）

```
apps/gateway/src/server.mjs            active-context 支持 brief；publicJob 的 failure 收口
apps/gateway/src/worker-pool.mjs       capacity 报实际可用；pickForSession 按容量归一
apps/web/app/api/[...path]/route.ts    ★ 代理层 gzip（SSE/视频流直通不压缩）
apps/web/lib/api.ts                    activeContext(brief)；recent_completed_jobs 改可选
apps/web/features/useSession.ts        新增 refreshRunning（含 ref 判"任务消失"）
apps/web/app/_workspace.tsx            20 秒定时器改调 refreshRunning
docs/API_CONTRACT.md                   明示 finished_at 权威、无 completed_at
tests/risk/capacity-dispatch.mjs       【新增，18 项】
tests/risk/poll-payload.mjs            【新增，25 项】
tests/risk/run-all.sh                  登记两个新测试（共 31 项）
tests/risk/{asset-delivery,asset-preview,assistant-text,example-video,argv-safety,stale-artifact}.mjs
                                       ★ 修 strip() 顺序（见第 3 节，**值得优先看**）
VERSION  CHANGELOG.md
```

生效条件：
- `server.mjs` / `worker-pool.mjs` → **重启 Gateway**（`capacity` 与 `pickForSession` 即时生效）
- `route.ts` / `api.ts` / `useSession.ts` / `_workspace.tsx` → **前端必须重新 build** 再 start

---

## 2. 线上配置手改一处（建议，不是必须）

```diff
  workers[] 里 worker_id = "cvw-700" 那条（它同机跑 Gateway，并发已是 2）：
-    "max_sessions": 8
+    "max_sessions": 4      ← 与并发 2 对齐（其余四台是 8 配 4，同样的 2:1）
```

`pickForSession` 改成按容量归一之后，**这条不再是必须的** ——
分配比例已经自动对齐了。但 `max_sessions=8` 仍允许 8 个会话堆在一台只能跑 2 个的机器上
（它们只是排队，不会失败）。改成 4 相当于加一道硬上限，和 dev 保持同比例。

---

## 3. ★ 一个潜伏已久的测试缺陷，建议优先看

7 个测试共用的 `strip()`（去注释后再做正则断言）**顺序是错的**：
先去块注释、再去行注释。于是**整行注释里出现 `/api/*` 这类字样时，
`/*` 会被当成块注释开头，一路吞到下一个 `*/`**。

`route.ts` 第 92 行正好有这么一条注释（`// Gateway 永远只认根路径的 /api/*…`），
导致它后面约 20 行——**包含 `headers` 构造与 `accept-encoding` 设置**——
在断言里凭空消失。我这次加断言时就被它误报了一次红。

危险之处不在误报，而在**反过来的情况**：被吞掉的区域里如果有该被断言的代码，
断言会"因为找不到"而静默失败或静默通过，取决于写法 ——
和 1.4.0 那次「md5 断言看起来一直在通过、其实从来没跑过」同类。

改法就是交换两个 replace 的顺序（先行注释、后块注释）。dev 修完 31/31。

> ⚠️ 提醒：修正之后，那些断言**第一次真正看到完整文本**。
> dev 侧全绿，线上 `route.ts` 是同一份文件，预期同样全绿；
> 但如果线上有哪条断言由此转红，那是**它本来就该红**，不是本次改坏的。

---

## 4. 勿反向覆盖（沿用 1.4.5 的清单）

```
scripts/svc.sh  svc-run-gateway.sh  svc-run-bridge.sh      线上专有
scripts/hot-update.sh  smoke.sh  release-check.sh  e2e-checklist.sh
tests/risk/run-all.sh   ← 你在 1.4.4 自己改过 CVW_WORKER_ID 那段；dev 这份逻辑一致
                           且加了两个新测试名，**先 diff 再合**
tests/risk/stream-leak.mjs ← 你在 1.4.4 自己改过；本版未再动它
config/backend.json        ← 线上独有，且 dev 是实验模型
```

---

## 5. 验收

```bash
bash tests/risk/run-all.sh           # 期望 31/31
bash scripts/release-check.sh        # 期望全绿
bash scripts/smoke.sh                # 不扩写，应当很快

# 轮询体积：改前 185 KB（线上），改后应 < 2 KB
curl -s -b ck -H 'accept-encoding: identity' "$WEB/api/me/active-context?brief=1" -o /tmp/b.json
stat -c %s /tmp/b.json

# gzip 是否到了浏览器这一跳（关键：改前带不带 accept-encoding 体积都一样）
for e in identity "gzip"; do
  curl -s -b ck -H "accept-encoding: $e" -o /dev/null -D- "$WEB/api/me/active-context" \
    | grep -iE '^content-encoding|^HTTP'
done

# ★ SSE 与视频流必须【没有】content-encoding（压了会破坏实时性/白耗 CPU）
curl -s -b ck -H 'accept: text/event-stream' -H 'accept-encoding: gzip' -D- -o /dev/null \
  "$WEB/api/jobs/<某个job>/events" | grep -i content-encoding   # 期望：无输出
curl -s -b ck -H 'accept-encoding: gzip' -H 'range: bytes=0-999' -D- -o /dev/null \
  "$WEB/api/assets/<某个job>/playback" | grep -iE 'content-encoding|content-range'
  # 期望：无 content-encoding，有 Content-Range 且 HTTP 206

# 并发口径
curl -s -b ck "$WEB/api/system/capacity" | python3 -m json.tool | head -8
  # 期望 capacity = Σ各HEALTHY机器上限（线上应为 18），declared_capacity = 20
```

**浏览器实测**（dev 已逐条验过，线上建议同样走一遍）：
1. 角标版本正确；侧栏「已完成」有内容；
2. 等一轮 20 秒轮询 —— 断言该轮**只有 brief 请求**且体积 < 2 KB；
3. **★ 轮询后「已完成」没有被清空**（dev 实测 125 → 125）——
   这是本版最危险的回归点，`refreshRunning` 一旦误写 `recentJobs` 就会整列消失；
4. **★ 在另一个会话里跑完一个任务，断言「已完成」会更新**
   （dev 实测 125 → 126，调用序列 `FULL,FULL,brief,brief,FULL,brief`
   —— 任务消失时补了一次全量）；
5. 登录后零客户端异常。

---

## 6. 本版**没做**的（你报告里建议过，核查后不合适）

| 报告建议 | 不做的理由 |
|---|---|
| 历史只给 `prompt_summary`，不下发完整 prompt | **会造成功能退化**：`HistoryPanel.tsx` 的复制/复用 prompt 与 `_workspace.tsx` 的 `PromptBubble` 展开**都直接取 `original_prompt`**，只给 300 字摘要会让「复用 prompt」粘出截断版。brief 之后这些字段已不参与轮询，收益已拿到。真要再瘦身应改为「点开时按需拉 `/api/jobs/:id`」，属下一轮。 |
| `recent_completed_limit` 200 → 30 | brief 之后轮询不再携带历史，200 只影响首屏（gzip 后 144 KB）。砍它会退回 1.3.12 修过的「用户找不到自己的成片」。 |
| 轮询 20s → 60s | brief 之后每次 857 B，没必要牺牲「进行中」的实时性。 |
| Gateway 侧加 gzip | 位置不对 —— 只会压到局域网那一跳（204 MB/s，不缺带宽），面向用户的那一跳照旧全量。详见 CHANGELOG 1.4.6。 |

另记一笔**未改的既有限制**：`active_sessions` 只靠 Bridge 心跳更新，
派发侧没有像任务槽那样的「预留」，所以短时间内连续建会话可能都落到同一台、
之后由心跳纠正。会话由人工点「新建对话」产生，突发少见，本轮不动。
