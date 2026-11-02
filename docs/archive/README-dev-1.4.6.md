# SenseNova Coding Video & 3D Blockout — 在线试用平台

把 Coding Video Agent 包装成可供外部用户使用的 Web 平台。**前后端均由本项目实现。**

当前阶段：**V2 前后端联调**。真模型 → opus 增强 → 隔离生产 → 真 mp4 已贯通。

> 需求已在 2026-10-23 变更，见 [`docs/V2_REQUIREMENTS.md`](docs/V2_REQUIREMENTS.md)。
> `docs/` 下其余文档的冲突处以它为准。

---

## 架构

```
浏览器 ──REST + SSE──► Gateway (9999)  ──HTTP──► Worker Bridge (18080)  ──spawn──► claude CLI
                        调度/队列/租约              进程组管理/心跳/取消          │
                        Watchdog/事件/认证          产物校验/会话持久化           ▼
                              │                            │              模型代理 (8000)
                              ▼                            ▼
                      runtime/gateway/            runtime/sessions/
                      (Job 权威状态)              (会话轨迹 + 产物)
```

**生产数据通路是 HTTP**（Gateway ↔ Bridge）。**SSH 只用于部署与调试**，前端上线后不走 SSH。

**Gateway 独立于 Next.js**：Web 发版/重启不影响调度与心跳，1~2 小时的任务不绑在短生命周期的 Web Handler 上。

---

## 快速开始

```bash
# Node 必须 ≥20（系统默认 v16 过旧）
export NVM_DIR=/mnt/afs_toolcall/codevideo/.nvm && . $NVM_DIR/nvm.sh && nvm use 22
export NO_PROXY=localhost,127.0.0.1,.svc.cluster.local   # 集群内服务必须绕代理

T=$(openssl rand -hex 32)

# 1) Gateway
CVW_INTERNAL_TOKEN=$T CVW_SESSION_SECRET=$(openssl rand -base64 32) \
  node apps/gateway/src/server.mjs

# 2) Worker Bridge（在后端机器上，或本机联调）
CVW_WORKER_ID=cvw-232 CVW_GATEWAY_BASE_URL=http://127.0.0.1:9999 \
CVW_INTERNAL_TOKEN=$T CVW_MODEL_API_KEY=sk-local-proxy \
  node apps/worker-bridge/src/server.mjs
```

全栈联调（真 claude + 真模型，须在后端机器执行）：

```bash
./tests/integration/run-fullstack.sh
```

---

## 后端机器

| | 10.120.2.32 (`cvw-232`) | 10.120.2.53 (`cvw-253`) |
|---|---|---|
| SSH | 8888 / `codevideo` / `~/.ssh/id_rsa` | 同 |
| claude | 2.1.304 | 同 |
| node | v22.23.3 | 同 |
| ffmpeg/ffprobe | ✅ | 同 |
| GPU | H800 ×3 | 同 |
| 并发 | 4（全局上限 8） | 4 |
| uid / 共享存储 | 10207，`/mnt/afs_toolcall` 可读写 | 同 |

uid 与共享存储一致 ⇒ **Bridge 代码无需部署**，改完即生效。

```bash
./scripts/probe-remote.sh            # 探测环境（二进制路径、模型可达性）
./scripts/start-bridge.sh            # 在后端机器启动 Bridge
./scripts/start-web.sh dev           # 启动前端
```

### 运行时依赖（装在共享目录，两台共用一份）

| 项 | 路径 | 版本 | 用途 |
|---|---|---|---|
| Chrome for Testing | `runtime/browser/chrome-linux64/chrome` | 138.0.7204.168 | whitebox 3D 逐帧渲染 |
| three + puppeteer-core | `runtime/previs-deps/node_modules` | 0.178.0 / 24.15.0 | 同上 |

```bash
./scripts/install-chrome.sh          # 可重复执行，支持断点续传
./scripts/install-previs-deps.sh
```

> ⚠️ Chrome 的 zip **不保留 Unix 权限位** —— 解压后必须从 zip 元数据恢复可执行权限，
> 否则 `chrome_crashpad_handler` 无执行权，chrome 能报版本但一渲染就崩
> （`posix_spawn ... Permission denied (13)` + `Received signal 6`）。
> 安装脚本已包含这一步。容器内还必须加 `--no-sandbox --disable-dev-shm-usage`。

---

## 配置

**全部集中在 `config/`**，代码中无硬编码地址 —— 详见 [`config/README.md`](config/README.md)。

| 文件 | 内容 |
|---|---|
| `config/backend.json` | 后端机器、模型地址与 key、辅助模型、并发、存储、skill 映射、运行时路径、skill 外部依赖、session 存储 |
| `config/video_settings.json` | claude CLI 的 settings（`claude --settings` 直接读） |

**模型地址会变**，改两处：`backend.json` 的 `model.base_url` + `video_settings.json` 的 `env.ANTHROPIC_BASE_URL`。
历史地址记在 `model.$history`。

当前（实测 PROBE_OK）：`app-e6e20e71bb8a47d396c65a15b33464c8…:8000` / `Qwen3.8-27B-video-generation-v4`

> `[claude-code:unrecognized_model]` 是 CLI 的模型名白名单告警，**不影响推理**，可忽略。

---

## 白模权限（物理隔离）

```
coding_to_video → assets/skills/code-video-base       16 文件，无 whitebox
blockout_3d     → assets/skills/code-video-whitebox   30 文件，base + whitebox 合并
```

Bridge 按 session 的 mode 挂对应那套到工作区的 `.claude/skills/code-video`。
**无白模权限的用户，工作区里根本没有 whitebox 文件** ⇒ 权限由文件系统保证，不靠关键词过滤。
skill 内部路由仍由模型按语义自选（符合 addon README 设计）。

服务端四个校验点：建会话 / 发消息 / 执行 workflow / 提交 Job，一律以 **DB 中 session.mode** 为准，忽略请求体。

验证：`GET /sessions/:id/isolation?mode=...`

---

## Session 持久化与轨迹导出

```
runtime/sessions/<session_id>/
  meta.json         user_id / mode / 绑定进程 / 状态 / 活动时间
  messages.jsonl    轨迹（追加写）
  jobs/<job_id>/    PROMPT.md · claude.log · output/ · .done|.cancelled|.failed
runtime/session-index.jsonl   索引：session_id ↔ user_id
```

**文件存储即权威记录** —— 没有 DB 也完整可用，联调无需等 `DATABASE_URL`。

| 接口 | 用途 |
|---|---|
| `GET /sessions/:id/trace` | 会话元信息 + 轨迹 + Job 列表（按用户恢复） |
| `GET /users/:id/sessions` | 按用户列会话（localStorage 丢失时兜底） |
| `GET /users/:id/export?logs=1` | 导出用户完整轨迹 |

⚠️ 导出含用户 Prompt 原文，对外分享前需脱敏。

---

## 长任务保障

| 要求 | 实现 |
|---|---|
| 1~2 小时任务 | 异步 Job；提交立即返回，HTTP 不承载生成 |
| 关页面不中断 | 浏览器无任何代码路径能停止计算 |
| 单任务取消 | 每 Job 独立 process group，SIGTERM→宽限→SIGKILL；**不影响同进程其他 Job** |
| 心跳不被阻塞 | Supervisor 独立定时器，生成在子进程 |
| 停滞 ≠ 失败 | 心跳正常但无进度 → 仅告警，**绝不取消** |
| 失联不误杀 | HEALTHY ⇄ SUSPECTED（可逆）→ 对账 → 定论 |
| 过期结果拦截 | lease epoch + token fencing，失效写入返回 409 并丢弃 |
| 完成/取消竞争 | 单点裁决，产物完整则**完成优先**；绝不同时 COMPLETED + CANCELLED |
| 产物完整性 | `.done` 标记 + 大小两次采样；「目录里有文件」不算完成 |
| Session 不迁移 | 进程失联 → DEGRADED（终态），恢复路径只有新建会话 |

---

## 已验证

| 项 | 结果 |
|---|---|
| coding_to_video 生成 | ✅ h264 320×240 24fps 48帧 2.000s（ffprobe 验证） |
| **blockout_3d 渲染** | ✅ h264 640×360 24fps 72帧 3.000s，完整解码无错误 |
| Chrome headless | ✅ 138.0.7204.168，两台共用一份 |
| 模型 `/v1/messages` | ✅ HTTP 200 / PROBE_OK |
| 全栈链路 | ✅ 登录→权限403→建会话→幂等提交→派发→执行→状态回流 |
| 幂等 | ✅ 同 Idempotency-Key 返回同一 job |
| 白模权限 | ✅ 无权限用户 403；skill 物理隔离 |
| **单任务取消** | ✅ 取消 A 后 A 组清空、**B 组照常运行**、Bridge 存活 |
| 并发控制 | ✅ 单机满 → PROCESS_CAPACITY；全局满 → GLOBAL_CAPACITY |
| 进程重启 | ✅ 旧实例 UNAVAILABLE，会话转 DEGRADED 不迁移 |
| 越权 | ✅ 他人 job 返回 404（不泄露存在性） |

```bash
./tests/integration/run-t4.sh             # 单任务取消隔离
./tests/integration/run-session-store.sh  # 持久化与轨迹导出
./tests/integration/run-fullstack.sh      # 全栈（需后端机器）
```

---

## 工程结构

```
coding-video-web/
├── config/                 ★ 集中配置（机器/模型/并发/存储/skill）
├── apps/
│   ├── gateway/src/        ★ 调度 + 对外 API（9999）
│   │   ├── worker-pool.mjs     进程池、双层并发、健康状态机
│   │   ├── dispatcher.mjs      亲和性出队 → 租约 → 投递
│   │   ├── watchdog.mjs        心跳判定、停滞检测、对账、超时
│   │   ├── store/job-store.mjs Job/Session 权威状态 + 事件 + 租约
│   │   └── server.mjs          /api/* 与 /internal/*
│   └── worker-bridge/src/  ★ 后端机器上的常驻服务（18080）
│       ├── job-runner.mjs      进程组 spawn + 单任务取消 + 产物校验
│       ├── supervisor.mjs      心跳（独立于计算）+ 控制指令
│       ├── session-workspace.mjs  按 mode 挂隔离 skill
│       └── session-store.mjs   会话持久化与轨迹导出
├── assets/skills/          ★ 两套隔离 skill
├── scripts/                probe-remote.sh · start-bridge.sh
├── tests/integration/      假 Gateway/claude + 三个测试脚本
├── docs/                   Phase 1 的 8 份设计文档
├── openapi/openapi.yaml    39 路径 / 40 操作 / 32 Schema
└── runtime/                会话工作区、产物、Gateway 状态
```

---

## 待完成

| # | 项 | 状态 |
|---|---|---|

| 2 | 前端 Next.js | ✅ strict 零错误，冒烟全绿 |
| 3 | 邀请码注册 + next-auth（当前是 dev-login） | 未开始 |
| 4 | Prompt 增强工作流 | **已配置关闭** —— skill 里无实现，上游 bundle 待确认（见 config/README.md） |
| 5 | 产物播放/下载接口 | ✅ Range 流式，不暴露路径 |
| 6 | Redis 多实例扇出（当前进程内订阅） | 未开始 |
| 7 | `docs/` 按新架构修订 | 未开始 |

**阻塞项**：`DATABASE_URL` / `REDIS_URL`（可选 —— 文件存储已能联调）
