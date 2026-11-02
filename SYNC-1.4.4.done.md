# 1.4.3 → 1.4.4 同步清单

线上现在是 **1.4.3**，dev 是 **1.4.4**。
上一版清单已归档为 `SYNC-1.4.3.done.md`。
本文件只列「要动什么」，**线上一律由你执行**，我一行未碰。

---

## 0. 本版解决什么

| 症状 | 结论 |
|---|---|
| 上传示例片「无法解析」 | **我们的**：Gateway 搬到前端机后没有 ffmpeg/ffprobe → 搬回后端机解决 |
| 两个任务 `fetch is not defined` | **我们的**：前端机 PATH 落到 node 16 → 搬回后端机 + 守卫 |
| 视频句柄泄漏（141 个） | **我们的**：代理不传断开 + Gateway 不销毁读流 → 两边都修 |
| 播放/下载/示例片**慢** | **不是我们的**：公网入口吞吐约 27~64 KB/s，直连容器 41.6 MB/s。你去问平台 |

---

## 1. 整文件覆盖（dev → 线上）

都已逐个 grep 过，无 dev 专用串：

```
apps/gateway/src/asset-preview.mjs                                 【新增】网页播放降采样预览片
apps/gateway/src/worker-pool.mjs                                   单机上限取三者最小值
apps/gateway/src/server.mjs                                        pipeWithCleanup（4 处下发）
apps/web/app/api/[...path]/route.ts                                upstreamSignal（传客户端断开）
apps/web/components/JobCard.tsx                                    下载原片按钮 + 降采样说明 + 慢速提示
apps/web/components/HistoryPanel.tsx                               下载链接改成「原片」
apps/web/lib/types.ts                                              Asset 增加 preview 字段
assets/skillsets/coding_to_video/code-video-core/scripts/capture.mjs   CHROME_BIN + favicon 204
assets/skillsets/blockout_3d/code-video-core/scripts/capture.mjs       同上（两份独立拷贝，都要）
tests/risk/concurrency-cap.mjs                                     新增
tests/risk/stream-leak.mjs                                         新增
tests/risk/asset-preview.mjs                                       新增（36 项，守多轮/白模/不碰生成）
tests/risk/asset-delivery.mjs                                      旧断言改成更强的两条
tests/risk/run-all.sh                                              登记两个新测试（27 项）
VERSION  CHANGELOG.md  docs/KNOWN_ISSUES.md
```

`scripts/node-guard.sh` 是 dev 侧补齐用的（线上已有 `svc-run-gateway.sh` 做同样的事），
**不需要**同步，除非你想统一成一个 helper。

生效条件：
- `asset-preview.mjs` / `worker-pool.mjs` / `server.mjs` → **重启 Gateway**
- `route.ts` → **前端必须重新 build**（`bash scripts/start-frontend.sh build` 再 start）
- 两个 `capture.mjs` → **下一轮任务自动生效**（每轮重刷 `.claude/skills/`），不影响在跑的任务

---

## 2. 线上配置要手改（dev 与线上的 config 不同，不能覆盖）

`config/backend.json`：

```diff
   "deployment": { "gateway": {
-    "host": "10.120.6.11",        ← 前端机：没有 ffmpeg、PATH 会落到 node 16
+    "host": "10.120.7.0",         ← 搬回 cvw-700 那台后端机（有 /usr/bin/ffmpeg，实测）
   } }

   workers[] 里 worker_id = "cvw-700" 那条：
-    "max_concurrent_jobs": 4
+    "max_concurrent_jobs": 2      ← 这台同时跑 Gateway，压到 2；其余 4 台保持 4
```

选 `10.120.7.0` 的理由：它是迁移前 Gateway 的老位置、是 worker 机（`/usr/bin/ffmpeg`
与 `ffprobe` 都实测在），前端机到它的连通性 10-28 之前一直是通的。
换成别的 worker 机也行，**但记得把那台的 `max_concurrent_jobs` 改成 2、并把这条改回 4**。

容量影响：全局天花板仍是 20，实际可用从 5×4=20 变成 2+4×4=18。

再加一段 `preview`（dev 的那段可以整段抄过去，和线上无关的只有注释里的数字）：

```json
  "preview": {
    "max_height": 540,
    "max_kbps": 600,
    "audio_kbps": 96,
    "generate_timeout_ms": 25000
  },
```

⚠️ **这两件事是绑在一起的**：降采样要在 Gateway 上跑 ffmpeg，
而前端机**没有 ffmpeg**（本版排查的结论之一）。Gateway 不搬回后端机的话，
降采样会**静默失效**（退化成播原片，不报错也不影响播放，但等于没做这个功能）。
搬完可以这样确认它真的在工作：

```bash
# 播一个大成片后，看预览片有没有生成
ls -la <storage.root>/gateway/asset-previews/ | head
grep '\[preview\]' runtime/logs/gateway.log | tail -3
#   期望类似：[preview] job_xxx 1080p/4289kbps → 540p/323kbps（30.7MB → 2.3MB）
```

磁盘：预览片约为原片的 7~10%。线上 71 个产物里码率超 600kbps 的 49 个、
合计 677MB，全部生成后预览片总量约 50~70MB，按需生成（首次播放时才做），
**不会在重启时集中转码**。

---

## 3. 建议的执行顺序（避免中途不可用）

```bash
# ① 先停前端机上的 Gateway（别让两台同时在跑，否则同一份 runtime 两个写入者）
#    用你现有的 svc 停法
# ② 改 config/backend.json 的两处（上面第 2 节）
# ③ 在 10.120.7.0 上起 Gateway（svc-run-gateway.sh 自带 node≥18 守卫）
# ④ 前端重新 build 并重启 —— 它从 config 读 deployment.gateway.host，
#    不 build 的话 route.ts 的修复不生效；不重启的话仍指向旧网关
# ⑤ 核对
curl -s http://10.120.7.0:9998/healthz | python3 -m json.tool | head -8
#    期望 version=1.4.4、processes=5
#    再看逐机上限：cvw-700 应为 2，其余 4
```

验收点（我在 dev 上实测过的等价项）：
- `/api/system/capacity` 里 `cvw-700` 的 `max_concurrent_jobs` = **2**，其余 = **4**
- 管理员上传一个示例片 → 应当**成功**（ffmpeg 回来了），且显示「已压缩 X → Y」
- 播一个成片后再 seek 几次，然后看 Gateway 的 mp4 句柄数**不再累积**：
  ```bash
  GW=$(pgrep -f 'gateway/src/server.mjs' | head -1)   # 注意别用 pgrep -f 判自己
  ls -l /proc/$GW/fd | grep -c '\.mp4'
  ```

---

## 4. 另一个线上专有的缺口（dev 没这个文件，无法在 dev 验证）

`scripts/svc-run-bridge.sh` **没有 node 版本守卫**，而 Bridge 同样依赖全局 fetch
（`gateway-client.mjs` 调 Gateway、`config.mjs` 探模型 `max_model_len`）。
它的兄弟 `svc-run-gateway.sh` 第 7~35 行那段已经在线上跑了很久，照搬即可：

```bash
# 把 svc-run-gateway.sh 的第 7~35 行（CVW_NODE_BIN 选择 + NODE_MAJ<18 则 exit 1）
# 整段复制到 svc-run-bridge.sh 的 `cd "$R"` 之后，
# 只把日志文件从 runtime/logs/gateway.log 换成该 bridge 的日志。
```

要我改的话说一声 —— 但 dev 没有这个文件，我只能照着线上那份写，无法在 dev 真跑验证。

---

## 5. 不在本版范围

- **公网入口限速**：你去问平台。需要的证据在 CHANGELOG 的 1.4.4 末节
  （同机同文件直连 41.6 MB/s vs 过入口 27~64 KB/s）。
- 建议你在**自己机器上**再做一次对比，这是我在集群内测不到的：
  ```bash
  # 同一个文件，两条路，比吞吐
  curl -o /dev/null -w '过入口 %{speed_download} B/s\n' \
    'https://<公网域名>/<base_path>/_next/static/chunks/framework-acd67e14855de5a2.js'
  curl -o /dev/null -w '直连容器 %{speed_download} B/s\n' \
    'http://10.120.6.11:8000/_next/static/chunks/framework-acd67e14855de5a2.js'
  ```
  两个都快 ⇒ 问题在你到入口这一段；只有前者慢 ⇒ 入口限速，拿这组数去找平台。
