# 白模 Seko harness 接入与升级

本实现仅用于 dev 的 `blockout_3d`。C2V/experimental 保持 CC 路径。旧白模会话保留读取/视频/归档，禁止继续提交。新会话 `model_selection.harness=seko-v1`，固定模型凭据版本和 `engine_release`。

## 运行边界

gateway 与现有 FIFO/worker 容量/租约不变，每任务启动一个独立 Python 进程组，stdout/stderr 直接写文件；sidecar 记录 seko 标识，服务重启接管原进程，取消仅停止该进程组。没有附件 SQLite 第二队列。Python 运行固定引擎，模型不能调用任意 shell。

管理员在模型设置页配置白模 Tokenhub（key 必填）或内网（不发认证头），明确 Responses/Chat/Anthropic 协议，主动检测连通。模型配置私有、不可变；新配置影响新会话。普通用户不能改模型/skill。默认 GPT 6.1 Sol（TokenHub azure_L/sfa，Responses），SFB 下线后不再用于新会话。备用渠道不隐式回退；旧会话仍使用创建时的固定模型和引擎快照。

首问支持原业务 JSON 与自然语言。自然语言先整理必要输入，关键矛盾先澄清。固定 skill 负责 Three.js/镜头/模型细节。原话、图片、每次模型请求/完整回复、实际 reasoning/signature 均保存到各轮目录。模型未返回的字段不补造。固定 `whitebox-media-v2` 仅用于白模：长边最多1024像素，保持比例、不裁切；每张优先64KiB，硬上限96KiB。较大的图片依次尝试JPEG质量82/76/70/64；仍超限才等比缩小，再尝试编码。小于上限且尺寸合适的原图不重复压缩；EXIF方向先归一化，透明图在编码JPEG时合成白底。原始文件始终不改动。实际模型图片单独落盘，逐项记录原始/发送SHA、原始/归一方向/发送尺寸、字节、质量和策略版本。引擎审查拼图宽960像素，保留原有分页、布局及文字标签，不裁掉证据。该确定性编码不调用模型、不耗反思预算。

业务 `version=2` JSON 可直接提交，也支持中文说明包裹JSON；宿主确定性读取片段和镜头，保留额外原话，不让模型重新转写完整分镜。普通自然语言仍进入intake澄清/整理。

## 记忆与预算

每轮读取最后 `.done` 的实际工程和源码，失败/取消轮不覆盖基线。解释/澄清不生成新视频，不提升工程版本。intake 仅用原话、附件标识与已有工程事实分类/整理，不重复上传原图，也不冒称看图；首次创作阶段会接收所有参考图，实际微调/审查阶段使用真实的当前画面证据。源码微调保留原始任务、当前源码、修改要求和前次未解决问题。一稿最多两次修正；追问一次编辑最多一次修正。已交付原文件不可变。

按管理员填写的模型上下文上限，保守估算文本 UTF-8 token 上界、图片额度与输出保留。优先保留当前阶段完整输入/源码/图像/当前要求；超预算时移除可由最新工程替代的早期重复对话，原记录完整归档。本地文本字节数及图片额度是保守上界，上界超过预算不能证明真实token超限，因此不会仅据此拒绝必要当前输入；仍完整发送当前源码/证据，由模型服务执行其真实tokenizer的限制。服务明确返回上下文超限时转换为独立控制错误，停止该次调用并保留可回放候选/上一版，不截断源码，也不进入场景修正循环。元数据记录本地上界是否超预算及服务端裁决。上下文整理不调用额外模型，也不触碰候选/修正计数；未来若加入摘要模型，也必须作为独立控制阶段计数。不能因整理提前耗尽 skill 反思预算。

默认上下文 262144 是保守配置值，非模型能力探测结论，管理员应按渠道真实上限设置。GPT 默认 max_output_tokens=32768，初稿与审查为 low，实际源码修正为 high；实际参数与裁剪记录在每个 capture metadata 中。

## 交付与计时

按 artifact.json 指向及 SHA 选择真实可回放候选，不取最后目录猜测。engine 可能返回 renderable_with_issues，网页必须显示已知问题，不能等同人工认可。`engineering_seconds` 包含 intake/模型/探针/有限审查；约600秒为软目标，不强杀。每次 capture 的 transport.json 另记连接、提交请求、等待响应头及接收响应体时间；其中等待响应头仍可能含上游上传、排队与推理，不能全称为模型思考。MP4 用同一已交付 project 的剧情相机绝对时间采样，单独记 `video_seconds`。

Seko 的 source.js 依赖 helpers/runtime，默认 ZIP 同时包含 source、project、task、runtime、依赖锁及接入说明。公开下载必须验用户归属、完成状态、路径范围和 SHA；不包含 key、capture 或服务器绝对路径。业务读取 project + runtime 的 `loadProject` / `setTime`，后续交互由业务负责。

## 升级流程（不会自动启用新包）

1. `python scripts/whitebox-stage-release.py --archive PACKAGE.zip --out NEW_STAGING_DIR`：校验原包全部 hash、路径与公共接口；新目录保留原发行物，状态 staged_not_active。
2. 对比技能、source contract、模型协议、输出 schema、修正预算、追问契约。接口变化需适配代码；不得仅换 ZIP 即称适配完成。为候选建立新 release 目录，不覆盖旧 release。
3. 确认固定依赖锁。复用宿主模型 capture、无 key 支持、软件 WebGL 和视频渲染；显式核对兼容补丁，不能盲目改新版本字符串。RELEASE.json 记录每文件 hash，worker 启动校验后逐任务快照。
4. 运行 Node/Python 单元、真实浏览器 fixture、白模 HTTP 权限和 `tests/integration/seko-runner.mjs`；再使用原业务 benchmark 的完整输入与8图，记录每阶段时间、最终结构、逐镜采样、全片解码与源码包独立回放。追加一次自然语言追问，比较旧版文件 hash 与修改范围。
5. 记录实际模型设置、包/host/hash、源码视频与人审结论。通过后将服务端 `whitebox.seko_release` 指向新发布目录并安全部署。新会话用新包；旧新版会话继续固定旧包。在飞任务不换引擎/host 快照。C2V/experimental 不走此开关。

回滚：只回退白模发布配置与相应 dev 代码；保留所有已产生会话/模型配置/版本目录，不重写历史。

## 可重复的隔离单案命令

在选定 dev worker 的 tmux 中使用 `node scripts/whitebox-acceptance.mjs --worker WORKER_ID --out NEW_OUTPUT_DIR --prompt INPUT_FILE --references REFERENCE_DIR`。INPUT_FILE 可以是原始业务 JSON 或用户自然语言。脚本读取当前管理员白模模型，仅在全新目录建立独立模型/会话/任务存储，不提交公众队列，也不冒充网页 test 会话。实际生成仍走同一 worker runner。输出每轮独立 JSON 报告、视频/源码路径和分段耗时。

后续用 `node scripts/whitebox-acceptance.mjs --resume FIRST_REPORT_JSON --prompt FOLLOWUP_TEXT_FILE` 在同一个隔离会话中验证追问。保留首轮 hash，并另行对下载工程、真实样帧和 MP4 全解码做验收；脚本完成不等于视觉质量通过。

## 2026-11-19 完整三案验证

三案共122镜、20张原图，重新生成及源码/视频技术验收3/3；独立有限质量仅相亲记基本可读，林小鱼及矿坑仍有明确缺陷。图片固定压缩、业务JSON保真和上下文误拦截修复已验证。工程API等待与额外MP4渲染单独记录，该次历史网络不作为严格速度验收。见[完整三案报告](WHITEBOX-SEKO-THREECASE-20261119.md)。

## 2026-11-20 GPT 固化版 0.1.10

dev 新会话默认引擎为 `seko-0.1.10-cvw.1`。首轮初稿最多2次修正，追问一次编辑最多1次修正；没有隐藏整案重试。已有业务JSON或明确分段时间文本由确定性 intake 处理，不为了重新转写再调用模型。只有必要澄清/无法确定结构时才调用 intake。

审查针对可渲染、时间/片段/镜头保真，以及可见的核心剧情矛盾。证据缺失保持 uncertain 和已知问题，不标成质量通过，也不驱动模型改场景来补一张证明。真正的几何/动作/时序错误才进入修正。主 skill 与 source contract 都允许简单人物：按剧情需要添加姿态、接触与四肢，不为所有人补精细面部或步态。

`timings.engineering_excluding_measured_upload_seconds` = 工程总时间减客户端实测请求提交时间；视频另计。等待响应头仍可能含上游上传/排队/推理，不应解释成纯模型推理。网络未完成首稿时会明确失败；审查网络失败已有可回放场景则保留它和已知问题，不能冒充质量通过。

离线回归：在 dev worker 执行 `/opt/videokit/venv/bin/python scripts/check-seko.py`，报告落在本 checkout 的 runtime/validation。新机需按 engine/package-lock.json 安装依赖。隔离真实验收可加 `--release seko-0.1.10-cvw.1`；续改不能更换已固定版本。完整实际结果、速度限制和 medium 对照记录见 [GPT 接手与验收报告](WHITEBOX-GPT-20261120.md)。
