# config/ — 集中配置

> 原则：机器地址、模型地址、路径、并发等**全部**在此，代码中不得硬编码。
> 方便其他人 debug 与切换环境。

## Git 管理与本地配置

`backend.json` 含本环境部署信息和密钥，已被 Git 忽略。仓库只提交 `backend.example.json` 脱敏模板；不要把真实密钥写进模板。
新 clone 中先复制模板为 `backend.json`，再按自己的独立部署补全路径、主机和模型配置。
增强密钥可通过 `runtime/.secrets` 的 `CVW_AUX_ENHANCE_API_KEY` 配置，启动器会加载它。
Claude Code 的代理可在同一文件中设置 `CVW_CLAUDE_HTTP_PROXY`，值为代理 URL，直连列表由 `backend.json` 的 `proxy.no_proxy` 提供。隔离生成会在每个新进程启动时读取，增强和软隔离生成会在对应服务重启后读取。
现有环境保留本地 `backend.json`，正常切换代码分支不会覆盖该文件。依赖、账号、视频和凭据需要单独备份，不随 Git 克隆。
当前模型和地址以实际 `backend.json` 为准；下面早期配置记录仅作历史参考。

## 文件

| 文件 | 用途 | 谁读 |
|---|---|---|
| `backend.json` | **权威配置**：后端机器、模型、并发、存储、skill 映射、运行时二进制路径 | Worker Bridge (`apps/worker-bridge/src/config.mjs`)、Gateway |
| `video_settings.json` | claude CLI 的 settings（`claude --settings` 直接读） | claude CLI |
| `video_settings.kto.json` | 备用（kto 模型版本，**地址已失效**） | — |

## 模型地址会变 —— 改两处

模型服务会重新部署，地址随之变化。需要同时改：

1. `backend.json` → `model.base_url`
2. `video_settings.json` → `env.ANTHROPIC_BASE_URL`

改完用 `scripts/probe-remote.sh` 验证（会打印 `model-dns` 与 `model-http`）。

历史地址记录在 `backend.json` 的 `model.$history`，便于回滚排查。

### 当前值（2026-10-23 实测 PROBE_OK）

```
http://app-e6e20e71bb8a47d396c65a15b33464c8.ns-zuhu2026-c9929bca.svc.cluster.local:8000
模型名 Qwen3.8-27B-video-generation-v4
```

### 已废弃

| 地址 | 原因 |
|---|---|
| `app-7ed92ff2…:8000` | 服务下线，DNS 解析失败 |
| `app-5b97e561…:8000` | kto 版本，同样解析失败 |

## 已知无害告警

```
[claude-code:unrecognized_model] {"model":"Qwen3.8-27B-video-generation-v4"}
```

这是 claude CLI 的模型名白名单提示，**不影响推理**（实测 `PROBE_OK` 正常返回）。
`/v1/models` 与 `/v1/messages` 均 HTTP 200。可忽略。

## 环境变量覆盖

`backend.json` 的值可被环境变量覆盖，便于临时调试而不改文件：

| 环境变量 | 覆盖项 |
|---|---|
| `CVW_WORKER_ID` | **必填**，指定本 Bridge 是哪台（`cvw-232` / `cvw-253`） |
| `CVW_GATEWAY_BASE_URL` | **必填**，Gateway 地址（Bridge 回调用） |
| `CVW_INTERNAL_TOKEN` | **必填**，内部 API 共享密钥（≥16 字符） |
| `CVW_MODEL_API_KEY` | 模型 key（默认 `sk-local-proxy`） |
| `CVW_MODEL_BASE_URL` | 临时换模型地址 |
| `CVW_MODEL` | 临时换模型名 |
| `CVW_BRIDGE_PORT` | Bridge 监听端口（默认 18080） |
| `CVW_STORAGE_ROOT` | 存储根（默认 `runtime/`） |
| `CVW_CLAUDE_BIN` | claude 可执行路径（测试时可指向 fake-claude.sh） |
| `CVW_MAX_CONCURRENT_JOBS` | 单机并发（默认 4） |
| `CHROME_BIN` | chrome 路径（whitebox 渲染需要） |
| `PREVIS_DEPENDENCY_ROOT` | whitebox 的 node_modules 根 |

Bridge 启动时校验必填项，**缺失直接拒绝启动**，不会半配置运行。

## 并发

dev 的四个 Worker 共用一个 FIFO 队列，支持 C2V、实验模式和白模。Gateway 所在机器分配 2 槽，其他三台各 4 槽，总容量 14。账号、模式和模型均无专用配额或优先级。

`concurrency.shared_workspace_workers` 列出共享会话存储、相同依赖和 `/workspace` 隔离挂载的 Worker。新任务可使用任一有空槽的 Worker，同一会话按轮次串行。续写继续使用原工作区和 CC 会话，租约与回调归属于本轮实际执行者。工作区的历史记录由服务端保留。

模型上下文、输出上限和压缩阈值由各模型配置提供，CC 直接使用该配置。

## skill 映射（白模权限）

```json
"skills": {
  "coding_to_video": "code-video-base",      // 无 whitebox 文件
  "blockout_3d":     "code-video-whitebox",  // base + whitebox 合并
  "target_dir_in_session": ".claude/skills/code-video"
}
```

Bridge 按 session 的 mode 挂对应那套到工作区。
无白模权限的用户工作区里**根本没有** whitebox 文件 → 权限由文件系统保证。
验证：`GET /sessions/:id/isolation?mode=...`

---

## 辅助模型（`aux_models`）

skill 中某些环节（看图评审、contact sheet 判读）若需要比主模型更强的能力，在此配置。

```json
"aux_models": {
  "enabled": false,                    // 默认关闭：实测主模型已能完成生成
  "vision_review": { "base_url": "", "api_key": "", "model": "claude-opus-5-5",
                     "api_key_env": "CVW_AUX_VISION_API_KEY" },
  "fallback":      { "base_url": "", "api_key": "", "model": "claude-sonnet-5-5",
                     "api_key_env": "CVW_AUX_FALLBACK_API_KEY" }
}
```

**当前状态**：`enabled: false`。已检查两套 skill 的全部 md/py/mjs/sh，
**未发现对 opus/sonnet 等外部模型的硬依赖** —— 看图评审由主模型自己完成
（`SKILL.md` §5 "Look at the frames"），`whitebox-previs/review.py` 只用 ffprobe 做机械校验。

需要启用时：填 `base_url` + `api_key`（或用对应 `api_key_env` 环境变量），置 `enabled: true`。

## skill 外部依赖（`skill_dependencies`）

skill 脚本依赖的外部服务，排障先查这里：

| 依赖 | 用途 | 需要代理 | 状态 |
|---|---|---|---|
| **edge-tts** | `scripts/tts.py` 旁白合成（默认 TTS） | ✅ `speech.platform.bing.com` | 集群内必须走 `HTTP_PROXY` |
| **faster-whisper** | `scripts/sync_check.py` 旁白校验 | ✅ 首次下模型 | 需预下载 `base.en` / `small`，建议预置到共享目录 |
| Python 包 | `numpy scipy soundfile librosa edge-tts faster-whisper` | — | **TO_CONFIRM** 需在后端机器核实 |

> 只做无声视频时这些都用不到（已实测：无声 mp4 生成全程未触及 TTS）。

## Session 持久化（`session_store`）

用于**按用户恢复会话**与**导出用户轨迹**。

```
runtime/sessions/<session_id>/
  meta.json         user_id / mode / 绑定进程 / 状态 / 创建与活动时间
  messages.jsonl    轨迹（追加写）
  jobs/<job_id>/    PROMPT.md · claude.log · output/ · .done|.cancelled|.failed
runtime/session-index.jsonl   全局索引：session_id ↔ user_id
```

**文件存储即权威记录** —— 没有 DB 也完整可用；DB 到位后作为镜像（`driver: "postgres"`）。
追加写（jsonl）避免并发覆盖，崩溃最多丢最后一行而非整个文件。

轨迹 `kind`：`session_created` · `job_created` · `job_phase` · `job_completed` · `job_failed` · `job_cancelled`

### 查询接口（Bridge，需内部 token）

| 接口 | 用途 |
|---|---|
| `GET /sessions/:id/trace` | 会话元信息 + 完整轨迹 + Job 列表（**按用户恢复会话**） |
| `GET /users/:id/sessions?limit=50` | 按用户列会话（**localStorage 丢失时的服务端兜底**） |
| `GET /users/:id/export?logs=1` | 导出用户完整轨迹（`logs=1` 含 claude 日志） |

⚠️ 导出含**用户 Prompt 原文**，对外分享前需脱敏（`export.$privacy_note`）。

`retain_days: null` = 永久保留 —— 轨迹导出依赖长期留存。

---

## Prompt 增强（`prompt_enhancement`）—— 当前关闭

```json
"prompt_enhancement": {
  "enabled": false,
  "provider": "none",
  "upstream_bundle": { "path": null, "whitebox_adapter_path": null },
  "same_model":      { "model": null }
}
```

### 为什么关闭

两套 skill 里**都没有增强实现**。whitebox addon 的文档三处明确说它是**上游独立组件**：

| 出处 | 原文 |
|---|---|
| `WHITEBOX_ADDON_README.md:52` | "The **second repository's** prompt enhancement **stays upstream**; use the previously supplied **prompt-enhancement bundle** and whitebox adapter rather than repeating enhancement in the production session." |
| `whitebox-previs.md:24` | "Upstream prompt enhancement is **separate from production**." |
| `workflow.md:78` | "do not rewrite the story, **repeat prompt enhancement** or begin a new polishing cycle" |

全仓搜索 `prompt.enhancement|enhance_prompt|promptEnhance` 只命中上述 3 个**说明文档**，无实现代码。
已查过且没有的位置：`skills/`、`skills_v2/`、`skills_peer/`、`mv_prompt_20261022/`、`3_seko/`。

设计是三段分离：**上游增强 → 用户确认 → production 执行**，production session 中禁止重复增强。

### 关闭状态下的行为

```
前端 → POST /api/sessions/:id/jobs  （带 Idempotency-Key）→ 直接建 Job
```

`POST /api/sessions/:id/messages` 返回 `409 PROMPT_ENHANCEMENT_DISABLED`，并在 `details.submit_url`
里指向正确的提交地址。**不影响联调**：全栈测试走的就是直接提交。

### 开启方式

拿到上游 bundle 后：

```json
"enabled": true,
"provider": "upstream_bundle",
"upstream_bundle": { "path": "<bundle 路径>", "whitebox_adapter_path": "<adapter 路径>" }
```

退路（无 bundle 时）：`provider: "same_model"` —— 用主模型在**独立 session** 做增强
（不污染 production 上下文，符合 addon 的 separate-from-production 要求）。
白模增强可用 `references/whitebox-previs/rewrite.md` 作为指引，它本就是提示词写作用的。

开启后需实现 `API_CONTRACT.md` §6.2 的 `revise` / `approve` 流程
（增强 → Prompt Review Card → 用户确认 → 建 Job）。接口契约已定好，替换实现即可。

## Dev 白模配置

`whitebox.enabled` 在 dev 中开放模型与 Skill 设置。白模、C2V 和实验模式共用 FIFO 队列和 14 槽。

`whitebox.default_model` 与 `whitebox.default_skill` 指定新对话的默认选择。当前默认值为 `whitebox-deepseek` 和 `blockout-previs-video` 0.11.1。各模型的 `channels` 按配置顺序尝试，凭据使用 `api_key_env` 提供。会话保存模型版本，每轮 capture 保存实际调用渠道和原始响应。已开始输出的回答只使用同一渠道。

GPT 通过 Responses 适配器接入 CC，保留图片回执与原生 reasoning 状态。其他模型使用 Anthropic Messages。现有会话仍可解析已经隐藏的新建选项，历史配置不做替换。

白模上传 ZIP 必须恰好含一个 Skill，上传后替换默认、内置和粘贴的 Skill。续写保留原 CC 会话和工作区，每轮单独固定产物和执行依赖。旧版 0.9.3 的兼容处理只针对已核验的源文件哈希，原始上传包及每轮执行副本均保留。

白模整案时限为 `max_runtime_seconds: 0`，600 秒仅为耗时对照目标。模型请求超时默认 300 秒，白模工作区准备的接单超时为 90 秒。派发期间预留槽位，其余任务继续填充空槽。

已核验的 Blockout Previs 0.11.1 使用专用 CC 分阶段宿主：初稿/首次审查为 `output_config.effort: low`，需要修正时为 `high`；保留每个模型的上下文和输出上限。确定性的 compile/check/facts/preview/render/package 由文件写入 hook 调用原 skill CLI，CC 保留 Read/Write/Edit/Bash、原生会话和实际看图。未知上传版本继续使用原通用执行流程，不套用此版本的脚本契约。新任务记录 `whitebox_host`，并在 round 中保存实际宿主脚本。

仅对实测需要的渠道设置 `whitebox.models[].channels[].anthropic_compatibility`，默认均关闭：

- `lift_tool_images: true`：把 `tool_result` 内图片移到同一条 user 消息的工具回执组后，附工具 ID 关联，保留字节和图片观测顺序。请求原件与实际上游请求同时保存；这是渠道兼容变换，不是删除图片。
- `input_tokens_include_cache: true`：当渠道将缓存输入重复计入 `input_tokens` 时，发送给 CC 的统计减去 cache read/create，避免 CC 高估上下文。上游 SSE 原字节保存在 `response.txt`，兼容后的流另存 `client-response.txt`，thinking/签名/工具调用不变。

2026-11-18 只为 DeepSeek `zijian/sfb` 主渠道启用这两个开关；Opus 和未经验证的备用渠道不启用。兼容开关不改变已有会话的模型配置版本。更新 bridge 会中断它所代理的在途白模 HTTP 流，因此此类更新必须等白模任务结束后进行；仅更新每轮复制的宿主脚本可供后续任务使用，无需重启 bridge。
