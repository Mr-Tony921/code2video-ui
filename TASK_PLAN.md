# TASK_PLAN — 持续更新的进度文件

> 供 Agent 上下文压缩/中断后从文件恢复进度。每次会话开始先读本文件。

## 当前阶段

**V2 需求实施中**（需求已变更，见 `docs/V2_REQUIREMENTS.md`）。目标：前后端联调完成后由用户 review。

## 授权边界（硬约束）

- 唯一可写目录：`/mnt/afs_toolcall/codevideo/workspace`
- SSH 仅用于**部署与调试**；生产数据通路是 HTTP
- 正式部署时用户会换 folder → 所有路径收敛到 `config/backend.json`，代码中无硬编码

## 三端与端口

| 组件 | 端口 | 职责 |
|---|---|---|
| Next.js 前端 | 3000 | UI + BFF 转发（`next.config.mjs` rewrites） |
| Gateway | 9999 | 调度/队列/租约/Watchdog/事件/增强/认证/产物 |
| Worker Bridge | 18080 | 后端机器常驻：隔离 workspace + spawn claude + 心跳 |

## 后端机器（实测可用）

| | 10.120.2.32 (`cvw-232`) | 10.120.2.53 (`cvw-253`) |
|---|---|---|
| SSH | 8888 / `codevideo` / `~/.ssh/id_rsa` | 同 |
| claude | 2.1.304 | 同 |
| node | v22.23.3 | 同 |
| `/opt/videokit` | ✅ three 0.186.1 · gsap 3.15 · roughjs 4.6.6 · p5 2.3.4 · @napi-rs/canvas 1.0.13 · playwright 1.64.1 · puppeteer 25.15.0 | 同 |
| `/opt/videokit/venv` | ✅ manim · numpy · scipy · cv2 · matplotlib · soundfile · librosa · edge_tts · faster_whisper | 同 |
| Chrome | ✅ 138.0.7204.168（我装在 `runtime/browser/`，两台共用） | 同 |
| 隔离 | ✅ `unshare --user --map-root-user --mount` 可用 | 同 |
| uid / 共享存储 | 10207，`/mnt/afs_toolcall` 可读写 | 同 |

**无需安装任何东西** —— videokit 已齐备，唯一缺的 Chromium 用我装的 Chrome 复用（实测 puppeteer 与 playwright 都能 `executablePath` 指向它）。

## 模型

| 用途 | 地址 | 模型 |
|---|---|---|
| 生产（claude CLI） | `app-e6e20e71bb8a47d396c65a15b33464c8…:8000` | `Qwen3.8-27B-video-generation-v4` |
| 增强（opus） | `tokenhub.sensetime.com` | `claude-opus-5-5/ccmax/sfa` |

增强 `max_tokens` 必须 **32000**（原 4096 会截断 dense prompt；实测输出 8868~9087 字符）。
地址会变 → 改 `config/backend.json` 的 `model.base_url` 与 `prompt_enhancement.aux_model.base_url`，
以及 `config/video_settings.json` 的 `env.ANTHROPIC_BASE_URL`。

## 并发

全局 **8**，单机 **4**。两 mode 共享，不可切 mode 突破。生产上限 **12 小时**。

## 关键实现决策

**skill 结构**（与同事 benchmark 统一）：`assets/skillsets/` 下两组独立 skill
- `coding_to_video/` 9 个（code-video-core + 8 craft）
- `blockout_3d/` 10 个（+ whitebox-previs）

白模权限靠**目录隔离**：无权限用户的工作区里没有 whitebox-previs 目录。
**已验证 claude 的 init 事件确实只列出对应数量的 skill**。
另按用户要求，`blockout_3d` 在 output contract 里**显式触发**白模（加一节 `## Mode: 3D Blockout`）。

**隔离**（改编同事 bench_runner，非 root 版）：工作区 bind 到浅路径 `/workspace` + 整个遮蔽 `/mnt`
→ 实测 `find /` 从 **7 分钟 → 676ms**，根治 claude 卡死。

**增强必须异步**：实测 opus 要 37~56 秒。同步等待会让 Next.js 转发 `socket hang up`，
也违反"提交立即返回"。做法：Job 以 `ENHANCING` 建好秒回，增强在后台推进，
完成后换 dense prompt 入队；判为非视频请求则转 `OUT_OF_SCOPE` 终态。

## 已验证（真实后端 + 真实模型）

| 项 | 结果 |
|---|---|
| coding_to_video 生成 | ✅ h264 320×240 24fps 2.000s |
| blockout_3d 生成 | ✅ h264 640×360 24fps 72帧 3.000s，完整解码 |
| whitebox 3D 渲染链路 | ✅ three + Chrome + ffmpeg，5.2 秒渲 72 帧 |
| claude 识别 skill | ✅ base 9 个 / whitebox 10 个 |
| claude 主动 load skill | ✅ `Skill{code-video-core}` `Skill{whitebox-previs}` |
| 隔离 | ✅ `isolated=true`，`/mnt` 遮蔽，`node_modules/three` 可达 |
| 过程事件 | ✅ 116 条，thinking_tokens 已过滤 |
| 单任务取消隔离 | ✅ 取消 A 后 B 组照常运行，Bridge 存活 |
| 残留清理 | ✅ 实测 killed 3 |
| 并发控制 | ✅ 单机满 PROCESS_CAPACITY / 全局满 GLOBAL_CAPACITY |
| 幂等 | ✅ 同 key 返回同一 job |
| 权限 | ✅ 无白模 403；越权他人 job 404 |
| 产物接口 | ✅ Range 206，不暴露 storage_path |
| 邀请码 | ✅ 时效 + 用完即踢（单测 + 全栈均通过） |
| 附件上传 | ✅ png/mp4，ffprobe meta 自动采集 |
| 增强 | ✅ 实测 9087 字符 dense prompt，2 个素材 |
| 前端 | ✅ TypeScript strict 零错误，build 通过 |

## 已修的真实 bug

| # | bug | 根因 | 修法 |
|---|---|---|---|
| 1 | 反向对账**误杀运行中任务** | `writeJob` 非原子 → `getJob` 读到半个 JSON → `catch{return null}` 把读失败伪装成"不存在" → 下发 `abort_not_owner` | 原子写（tmp+rename）、读失败抛错、对账三重保护（容错读+60s 宽限+实例归属）。回归测试 `run-reconcile-guard.sh` 并发 400 次零误判 |
| 2 | 取消一个 Job 波及另一个 | 假设 `detached` 下 `pid === pgid` | 用 `ps` 实测 pgid + 同组保护 + null 退化为单进程 |
| 3 | 隔离后产物找不到 | contract 写宿主路径，但隔离内 `/mnt` 被遮蔽，claude 转而乱探查文件系统 | contract 用 agent 视图路径（`agentWsPath`） |
| 4 | SSE `ReferenceError: ka` | 回放阶段命中终态事件时 `clearInterval` 撞 `const` TDZ | 可空变量 + `closed` 标志 + 统一 `finish()` |
| 5 | 提交 `Internal Server Error` | 增强同步等 37s，Next.js 转发 `socket hang up` | 增强改异步，Job 先以 ENHANCING 秒回 |
| 6 | Chrome 装好却崩 | zip 不保留权限位，`chrome_crashpad_handler` 无执行权 | 从 zip 元数据恢复 11 个可执行权限 |
| 7 | 阶段停在 PREPARING 250 秒 | claude 工具输出不走 stdout，正则匹配不到 | 改用 stream-json 事件 + 文件系统兜底 |

## 流程教训（本轮踩的，务必遵守）

### 1. 验证 UI 必须用真实浏览器，不能只 curl

我用 curl 测出 API 全通过，就说"可以 review"，结果用户打开页面看到
`Application error: a client-side exception has occurred`。

curl 只能验 HTTP 状态与响应体，**测不出**：
- hydration mismatch（SSR 与客户端 DOM 结构不一致）
- React 事件未绑定（按钮点了没反应）
- 客户端 JS 运行时异常

→ 已固化 `tests/integration/run-browser-e2e.sh`：借后端机器的 chrome 反向访问本机前端，
真实加载、真实点击、抓 `pageerror`/console error/失败请求，并检查 body 下的渲染根数量。
**任何前端改动后必须跑它**。

### 2. 构建未完成就启动服务

`next build` 跑了十几秒才输出 `Compiled successfully`，但产物（`prerender-manifest.json`、
`BUILD_ID`）还要更久才写完。我提前启动 → `ENOENT prerender-manifest.json`；
更糟的是我在前一次构建还在跑时又发起一次 → 两个构建互相覆盖，`.next` 被清空，
服务报 `Could not find a production build`。

→ 规矩：
- 启动前确认 `.next/BUILD_ID` **与** `.next/prerender-manifest.json` 都存在
- 且 `pgrep -f 'next build'` 为空（进程真的退出了）
- 重建前先 `pkill -f 'next build'` 清残留，再 `rm -rf .next`

## 待完成

| # | 项 | 状态 |
|---|---|---|
| 1 | V2 全栈测试复跑（异步增强后） | 进行中 |
| 2 | `docs/` 旧文档按 V2 修订（7 处冲突已在 V2_REQUIREMENTS 列明） | 未开始 |
| 3 | PostgreSQL / Redis（可选，文件存储已够联调） | 未提供 |
| 4 | 管理后台 UI | 未开始 |

## 环境备忘

- Node：系统默认 v16 过旧，**必须** `export PATH=/mnt/afs_toolcall/codevideo/.nvm/versions/node/v22.23.4/bin:$PATH`
  （`npx`/`npm` 的 shebang 是 `#!/usr/bin/env node`，子进程会解析到 v16 → 直接用 `node node_modules/next/dist/bin/next`）
- 外网：`curl --proxytunnel --proxy http://10.120.0.246:7890`
- 集群内：必须 `NO_PROXY`，否则代理拦截 `.svc.cluster.local`
- 大文件下载：必须 `nohup` 后台跑（前台命令有 120s 超时，会在下载中途被杀）
- 本机无 root/sudo/ffmpeg/chrome/claude（远端有）
