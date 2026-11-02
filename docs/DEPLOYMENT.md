# DEPLOYMENT — 部署与运维

> 2026-10-23 / 当前拓扑：网页 8000（本机 10.120.6.11），Gateway 9998 与 Bridge 18080 在后端机器 10.120.0.161 / 10.120.0.175。
> 会话数据落 /mnt/afs_if/codevideo/workspace/session（存储充足）；用户与邀请码仍在 runtime/gateway。

---

## 端口拓扑

```
                       用户浏览器
                           │
                           ▼ http://10.120.6.11:8000
       ┌───────────────────────────────────────────┐
       │  前端机器（我们这台 codevideo 容器）        │
       │  10.120.6.11                              │
       │  ┌─────────────────────────────────────┐  │
       │  │ Next.js (8000, 0.0.0.0)             │  │
       │  │ /api/* → Route Handler 运行时转发    │  │
       │  └──────────────┬──────────────────────┘  │
       └─────────────────┼─────────────────────────┘
                         │ 内网 http://10.120.0.161:9998
       ┌─────────────────▼─────────────────────────┐
       │  后端机器 10.120.0.161（另一台 10.120.0.175）         │
       │  ┌─────────────────────────────────────┐  │
       │  │ Gateway (9998, 0.0.0.0)             │  │
       │  │ 调度/队列/租约/增强/认证/产物         │  │
       │  │ /internal/* 限 10.120.0.0/16 + token │  │
       │  └──────────────┬──────────────────────┘  │
       │  ┌──────────────▼──────────────────────┐  │
       │  │ Worker Bridge (18080)               │  │
       │  │ 隔离 workspace + spawn claude        │  │
       │  └─────────────────────────────────────┘  │
       └───────────────────────────────────────────┘
```

**职责划分**：后端机器只跑 Gateway 与生产，**不跑网页**；前端在我们这台容器。

**为什么 Gateway 绑 0.0.0.0**：前端在另一台机器，必须跨机访问。
浏览器仍不直连 Gateway（`/api/*` 经前端转发）；`/internal/*` 的心跳、取消、产物回调
由 **网段白名单 + 共享 token 双重** 限制（`deployment.internal_allowed_cidrs`）。
实测从前端机器调 `/internal/*` 无 token 返回 401。

**为什么不用 next.config 的 rewrites**：它在 **build 时**固化目标地址 ——
构建时写 `127.0.0.1:9998`，部署后仍连本机，实测 `ECONNREFUSED`。
改用 `app/api/[...path]/route.ts` 在**运行时**读 `CVW_GATEWAY_BASE_URL`，
前后端分机部署才成立。该 Handler 同时处理 SSE 透传（不设超时）与 multipart 流式上传。

---

## 启停

### 后端机器（Gateway + Bridge）

```bash
ssh -p 8888 -i ~/.ssh/id_rsa codevideo@10.120.0.161
cd /mnt/afs_toolcall/codevideo/workspace/coding-video-web
bash scripts/start-backend.sh start|stop|status|logs
```

### 本机（前端）

```bash
cd /mnt/afs_toolcall/codevideo/workspace/coding-video-web
bash scripts/start-frontend.sh build      # 首次或改了前端代码
bash scripts/start-frontend.sh start|stop|status|logs
```

访问 **http://10.120.6.11:8000**

密钥（内部 token、会话签名）在后端机器首次启动时生成到 `runtime/.secrets`（600，已 gitignore），
重启复用。**前端不需要这个 token** —— 它只调 `/api/*`。

### 第二台 worker（cvw-175）

```bash
ssh -p 8888 -i ~/.ssh/id_rsa codevideo@10.120.0.175
cd /mnt/afs_toolcall/codevideo/workspace/coding-video-web
CVW_WORKER_ID=cvw-175 CVW_GATEWAY_BASE_URL=http://10.120.0.161:9998   bash scripts/start-backend.sh start
```

> 它会复用共享存储上同一份 `runtime/.secrets`，token 自动一致。

---

## 依赖核查（保存镜像快照前必跑）

```bash
bash scripts/verify-deps.sh              # 查两台
bash scripts/verify-deps.sh 10.120.0.161  # 查单台
```

2026-10-23 实测：**两台各 51 项全通过，0 失败**。

| 类别 | 状态 |
|---|---|
| claude 2.1.304 · node v22.23.3 · ffmpeg 4.4.2 · python3 · latex · 30 个 Noto CJK | ✅ 系统已装 |
| `/opt/videokit/node_modules`：three 0.186.1 · gsap 3.15 · roughjs 4.6.6 · p5 2.3.4 · @napi-rs/canvas 1.0.13 · playwright 1.64.1 · puppeteer 25.15.0 | ✅ 本地盘，快照会带 |
| `/opt/videokit/venv`（py3.11.17）：manim · numpy · scipy · cv2 · matplotlib · soundfile · librosa · edge_tts · faster_whisper · PIL | ✅ 本地盘，快照会带 |
| Chrome 138.0.7204.168 | ⚠️ 在**共享存储** `runtime/browser/`，快照**不含** |
| previs-deps（three 0.178 + puppeteer-core 24.15） | ⚠️ 在共享存储 `runtime/previs-deps/`，快照**不含** |
| `unshare --user --map-root-user --mount` | ✅ 可用（非 root 隔离） |

### 换机器或换存储位置后

共享存储上的两项要重装（本地盘的 videokit 不用动）：

```bash
bash scripts/install-chrome.sh         # 可重复执行，支持断点续传
bash scripts/install-previs-deps.sh
```

> ⚠️ Chrome 的 zip **不保留 Unix 权限位** —— 解压后必须从 zip 元数据恢复可执行权限，
> 否则 `chrome_crashpad_handler` 无执行权，chrome 能报版本但一渲染就崩
> （`posix_spawn ... Permission denied (13)` + `Received signal 6`）。安装脚本已含这步。

---

## 换部署目录

用户后续会换 folder。所有路径都收敛在配置里，代码无硬编码：

| 配置项 | 含义 |
|---|---|
| `storage.root` | session 工作区、产物、Gateway 状态、日志、密钥 |
| `runtime_binaries.chrome_bin` | Chrome 路径 |
| `runtime_binaries.previs_dependency_root` | whitebox 渲染的 node_modules |
| `runtime_binaries.videokit_*` | `/opt/videokit`（本地盘，一般不变） |
| `skills.skillsets_root` | 两组 skill |
| `isolation.workspace_mount` | 隔离内的挂载点（**必须是浅路径**，见下） |
| `deployment.*` | 端口与绑定地址 |

环境变量可临时覆盖（`CVW_STORAGE_ROOT`、`CVW_GATEWAY_PORT` 等），见 `config/README.md`。

### 隔离的路径要求

工作区在命名空间内 bind 到 **`/workspace`**（浅路径），且整个 `/mnt` 被遮蔽。
原因：若挂回 `/mnt/afs_toolcall/.../jobs/<id>` 这种深路径，`find /` 仍要穿过它 ——
实测 `maxdepth 7` 要 40 秒，无深度限制时 7 分钟以上，会让 claude 卡死。
挂到浅路径后实测降到 **676ms**。

另外 output contract 里的交付路径必须用 **agent 视图里的路径**（即 `/workspace/output/final.mp4`），
不能写宿主路径 —— 隔离内 `/mnt` 被遮蔽，写宿主路径会让 claude 找不到目录转而乱探查文件系统。

---

## 日志与排障

```
runtime/logs/gateway.log           调度、增强、对账
runtime/logs/bridge-cvw-161.log    job 启动、心跳、隔离状态、清残留
runtime/logs/web.log               Next.js
runtime/sessions/<sid>/jobs/<jid>/
  claude.jsonl      ★ 结构化轨迹（过程框的数据源，排障首选）
  claude.stderr
  prompt.md         增强后的 dense prompt + output contract
  .cc-session       claude 的 session_id（终态后仍可读）
  .done | .failed | .cancelled | .aborted    终态标记
runtime/sessions/<sid>/messages.jsonl        会话轨迹
runtime/session-index.jsonl                  user_id ↔ session_id 索引
```

### 常见问题

| 现象 | 查 | 说明 |
|---|---|---|
| 提交后一直 ENHANCING | `gateway.log` 搜 `增强` | opus 要 33~56 秒，正常；失败会转 FAILED 并给原因 |
| 任务报 `E_NO_ARTIFACT` | `claude.jsonl` 看它往哪写了 | 大概率 contract 路径与 agent 视图不一致 |
| 过程框没内容 | `bridge-*.log` 看 `isolated=` | stream-json 解析失败或 Bridge 未拉到 |
| 残留 Chromium | `bash apps/worker-bridge/scripts/kill-leftovers.sh <job_dir>` | 按 token/cwd/cmdline 三重匹配 |
| 心跳断任务被停 | 搜 `presence` | 阈值见 `config/backend.json` 的 `presence.timeout_seconds`；2026-10-27 起为 43200s（12h），等于不再因关页而自动停 |

---

## 发版注意

| 组件 | 重启影响 |
|---|---|
| 网页（8000） | 无影响，随时可重启 |
| Gateway（9998） | **Drain**：停止派发与监测后退出，**不取消任何任务**；启动时从磁盘重建队列与并发计数，对运行中的 job 先对账而非重启 |
| Bridge（18080） | 收到 SIGTERM 后不杀在跑的 job；产物与 `.done` 落共享存储，Gateway 可对账补判 |

`storage.root` 下的状态是权威来源，三端都可独立重启。
