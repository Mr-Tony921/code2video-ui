# 白模 Seko harness 接入与升级

本实现仅用于 dev 的 `blockout_3d`。C2V/experimental 保持 CC 路径。旧白模会话保留读取/视频/归档，禁止继续提交。新会话 `model_selection.harness=seko-v1`，固定模型凭据版本和 `engine_release`。

## 运行边界

gateway 与现有 FIFO/worker 容量/租约不变，每任务启动一个独立 Python 进程组，stdout/stderr 直接写文件；sidecar 记录 seko 标识，服务重启接管原进程，取消仅停止该进程组。没有附件 SQLite 第二队列。Python 运行固定引擎，模型不能调用任意 shell。

管理员在模型设置页配置白模 Tokenhub（key 必填）或内网（不发认证头），明确 Responses/Chat/Anthropic 协议，主动检测连通。模型配置私有、不可变；新配置影响新会话。普通用户不能改模型连接或 skill；运维可通过 whitebox.model_access 按用户 ID 授予已保存模型快照的选择权限。默认 GPT 6.1 Sol（TokenHub azure_L/sfa，Responses），SFB 下线后不再用于新会话。备用渠道不隐式回退；旧会话仍使用创建时的固定模型和引擎快照。

首问支持原业务 JSON 与自然语言。自然语言先整理必要输入，关键矛盾先澄清。固定 skill 负责 Three.js/镜头/模型细节。原话、图片、每次模型请求/完整回复、实际 reasoning/signature 均保存到各轮目录。模型未返回的字段不补造。固定 `whitebox-media-v2` 仅用于白模：长边最多1024像素，保持比例、不裁切；每张优先64KiB，硬上限96KiB。较大的图片依次尝试JPEG质量82/76/70/64；仍超限才等比缩小，再尝试编码。小于上限且尺寸合适的原图不重复压缩；EXIF方向先归一化，透明图在编码JPEG时合成白底。原始文件始终不改动。实际模型图片单独落盘，逐项记录原始/发送SHA、原始/归一方向/发送尺寸、字节、质量和策略版本。引擎审查拼图宽960像素，保留原有分页、布局及文字标签，不裁掉证据。该确定性编码不调用模型、不耗反思预算。

业务 `version=2` JSON 可直接提交，也支持中文说明包裹JSON；宿主确定性读取片段和镜头，保留额外原话，不让模型重新转写完整分镜。普通自然语言仍进入intake澄清/整理。

## 记忆与预算

每轮读取最后 `.done` 的实际工程和源码，失败/取消轮不覆盖基线。解释/澄清不生成新视频，不提升工程版本。intake 仅用原话、附件标识与已有工程事实分类/整理，不重复上传原图，也不冒称看图；首次创作阶段会接收所有参考图，实际微调/审查阶段使用真实的当前画面证据。源码微调保留原始任务、当前源码、修改要求和前次未解决问题。一稿最多两次修正；追问一次编辑最多一次修正。已交付原文件不可变。

按管理员填写的模型上下文上限，保守估算文本 UTF-8 token 上界、图片额度与输出保留。优先保留当前阶段完整输入/源码/图像/当前要求；超预算时移除可由最新工程替代的早期重复对话，原记录完整归档。本地文本字节数及图片额度是保守上界，上界超过预算不能证明真实token超限，因此不会仅据此拒绝必要当前输入；仍完整发送当前源码/证据，由模型服务执行其真实tokenizer的限制。服务明确返回上下文超限时转换为独立控制错误，停止该次调用并保留可回放候选/上一版，不截断源码，也不进入场景修正循环。元数据记录本地上界是否超预算及服务端裁决。上下文整理不调用额外模型，也不触碰候选/修正计数；未来若加入摘要模型，也必须作为独立控制阶段计数。不能因整理提前耗尽 skill 反思预算。

GPT 默认上下文预算为 524288（512K），这是宿主预算配置，不代表渠道最大能力探测结论；旧会话保留原配置快照。管理员应按渠道真实上限设置。GPT 默认 max_output_tokens=32768，初稿与审查为 low，实际源码修正为 high；实际参数与裁剪记录在每个 capture metadata 中。

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

## 2026-11-20 GPT 固化版 0.1.10

该次验收固定引擎为 `seko-0.1.10-cvw.1`；当前默认见下方 0.1.12 发布记录。首轮初稿最多2次修正，追问一次编辑最多1次修正；没有隐藏整案重试。已有业务JSON或明确分段时间文本由确定性 intake 处理，不为了重新转写再调用模型。只有必要澄清/无法确定结构时才调用 intake。

审查针对可渲染、时间/片段/镜头保真，以及可见的核心剧情矛盾。证据缺失保持 uncertain 和已知问题，不标成质量通过，也不驱动模型改场景来补一张证明。真正的几何/动作/时序错误才进入修正。主 skill 与 source contract 都允许简单人物：按剧情需要添加姿态、接触与四肢，不为所有人补精细面部或步态。

`timings.engineering_excluding_measured_upload_seconds` = 工程总时间减客户端实测请求提交时间；视频另计。等待响应头仍可能含上游上传/排队/推理，不应解释成纯模型推理。网络未完成首稿时会明确失败；审查网络失败已有可回放场景则保留它和已知问题，不能冒充质量通过。

离线回归：在 dev worker 执行 `/opt/videokit/venv/bin/python scripts/check-seko.py`，报告落在本 checkout 的 runtime/validation。新机需按 engine/package-lock.json 安装依赖。隔离真实验收可加 `--release seko-0.1.10-cvw.1`；续改不能更换已固定版本。实验数据与报告属于部署运行数据，保存在 runtime/validation 与 runtime/reports/whitebox，不随代码提交；使用具体批次的模型、版本、输入 SHA 和实际结果支撑结论。

## 代码、依赖与实验目录

- assets/whitebox-seko/releases/ 保留正式版本源码、技能和依赖锁；engine/node_modules 是本机依赖，首次安装在对应 engine 下执行 npm ci，不进入 Git。
- runtime/validation/ 保存版本固定的验收批次；runtime/reports/whitebox/ 保存实验结论；这些目录由运行环境独立保留。
- runtime/whitebox-seko/legacy-releases/ 保存历史 dev 引擎，在原 assets 路径保留本机兼容软链接，以保持旧会话和旧任务依赖路径有效。历史引擎不是新会话默认发布物。搬迁运行数据时需同步归档及链接，不能仅删除旧引擎。

## 粗白模自检 0.1.11

`seko-0.1.11-cvw.1` 保留为独立候选，当时 dev 默认仍为 `seko-0.1.10-cvw.1`。`scripts/check-seko.py` 默认验证最新候选，不意味着服务已启用该版本。候选不能仅凭代码回归或可渲染率提升为默认；需要同时评估完整任务的画面结果和端到端耗时。

必要结果按剧情和空间关系判断：主体可见、方向和位置正确、重要持物/承重及救援因果成立、片段/镜头时长正确。抱臂、点头、重复步态/打斗、细微穿插和接触精度不是独立修正理由；姿态只有影响上述必要结果时才是必修项。主体整体遮挡、明显悬空/道具漂移、错误位移、缺少关键事件仍需修正。

接触容差由实际不透明包围盒计算：较小物体最大尺寸的5%，最多0.02米。原始间隙不改写；超过容差仍可推翻必要接触的通过判断，零间隙或容差内都不自动证明接触。审查可以结合实际父子绑定、轨迹和画面确认持物，不因缺少一条冗余接触采样就认定场景有错；真正证据不足保留未确认，不能消耗源码修正。

初稿/审查low、源码修正high和有限循环上限不变；没有新增模型调用。对照旧版时区分审查标准变化与实际画面/速度变化，不能把新标准的通过率直接当成视觉质量提升。正式使用前以该版本完整三案、独立回放与工程校验为准，原版本目录和会话快照保留。

已知限制：修正后的审查范围仍使用保守关键帧邻域，并保留此前的 warning 镜头，其中包括 `core=met` 的表演简化。因此局部修正仍可能触发全片复审；本候选未修复范围扩大，不能作为稳定提速承诺。模型服务中断时保留可渲染候选和已知问题，这是失败回退，不是质量通过或优化收益。实际版本对照证据放在 `runtime/validation/seko-0.1.11-gpt512-20261120/`，不随代码提交。

### 0.1.12 局部复审发布

用户于 2026-11-21 明确要求固定 dev 默认到冻结版本 `seko-0.1.12-cvw.1`；旧会话快照不变。复审以实际动画曲线变化区间、画面/元数据变化和未解决的核心要求确定范围；已接受的可选简化不因其他镜头修正而重审。支持 linear/step/smooth 的完整曲线比较，未知格式仍保守扩大；不是靠稀疏截图认定中间帧不变。修正上限和模型档位不变。三案结果保存在 `runtime/validation/seko-0.1.12-gpt512-20261120`；构建完成不等于性能验收通过。


## 批量提交与轨迹留存

运维可用 `saveSekoModel(raw, connection, {makeDefault:false})` 保存不可变模型连接，再在私有配置 `whitebox.model_access` 中按用户 ID 列出允许的 profile_id。创建会话 API 的 model_id 仅接受当前默认或该用户被授予的快照；任意连接/未知 profile 会拒绝。此配置不改 C2V、实验模式或其他账号，提交后切换默认也不会改变已排队会话。

所有任务仍走普通账号的登录、创建会话、附件上传、提交 jobs API 和现有 FIFO 队列。批次索引、源 prompt 哈希、附件顺序与 SHA 单独记入运维批次回执，不能追加到用户 prompt。Seko 原生 version 2 数据可直接发送；通用文本保持原文，不能把数据集内部估时强制注入。

每轮 `rounds/<job>/prompt.md` 保存原文，`seko/capture/<call>/request.json`、`response.json`/`response.raw` 保留完整模型请求、回复与签名，原图及实际发送媒体均保留。新增 `seko/trace/events.jsonl` 按序关联用户原话、模型调用/回复、工具 argv 与完整 stdout/stderr；路径以该轮 seko 目录为基准，失败也追加记录。`seko/diagnostics/operations.jsonl` 单独记录耗时和状态，关联 operation_id；细分传输仍在 capture 的 transport.json。语义轨迹不嵌入计时指标，也不记录认证头或环境密钥。强制取消可能只有 call 而没有 result，按未完成处理，不能伪造完整轨迹。

复核：`python tests/unit/seko-audit.py`、`node --test tests/unit/seko-model.mjs tests/unit/whitebox-http.mjs`、`SEKO_TEST_RELEASE=seko-0.1.12-cvw.1 SEKO_TEST_FAST_INTAKE=1 node --test tests/integration/seko-runner.mjs`。真实模型可用性与批次进度单独保存在 runtime，不作为 skill 质量通过的证据。


提交入口：`python scripts/whitebox-submit-batch.py --dataset DATASET_DIR --models MODELS_JSON --account PRIVATE_ACCOUNT_JSON --out LEDGER_DIR --base-url DEV_WEB_URL`。账号文件为 username/password，模型文件为 profile_id/model 列表。先加 `--limit 4` 验证两类输入和各模型启动，再以相同参数去掉 limit 继续；已记入回执的 job 不重复提交，提交 jobs 使用稳定幂等键。会话创建接口尚无幂等保证，创建响应丢失时脚本会停下并标记 session_create_pending，必须先核对服务端会话再恢复，不能盲目重建。脚本需要在有权读取该 dev 会话共享存储的运维机器执行，以核验上传附件 SHA；凭据和回执不提交 Git。


### Web 输入适配：未指定时长

用户于 2026-11-21 选择：通用需求没有时长时，模型按剧情复杂度自行安排，最长300秒；明确给出的镜头/片段/总时长仍是强约束。`seko-intake.py` 仅为固定 0.1.12 的网页输入替换“缺少时长就追问”的路由规则，复用原引擎的原文组装、完整镜头保留和时长校验。不修改冻结 skill，不把内部编题估时或额外指令写入用户 prompt，不增加模型调用或修正次数。空故事及明确约束冲突仍应澄清。涉及语义时长规划时记录 intake-policy.json；每轮记录 host_sha256，以区分宿主适配版本。

批次脚本可加 `--group seko` 或 `--group general` 分组提交，两组仍共用原有完整 manifest 和幂等回执。早期仅返回澄清的试投记录保留，重新提交需要在批次回执中显式关联旧记录，不能当成已生成或删除轨迹。

仅经确认需要重提的条目可记录 `submission_attempt`（正整数）和 `prior_attempts`，以生成新的幂等键；普通中断恢复必须沿用原回执，不自动增加 attempt。首次提交的旧幂等键保持兼容。新增回归：`python tests/unit/seko-web-intake.py`、`python tests/unit/whitebox-batch.py`（亦纳入 `scripts/check-seko.py`）。

同日宿主策略 v2：英文自由文本的模型规划可能使用 `Shot 1:` 等行首编号。只在模型新生成的 `planned_segments.prompt` 中，将明确的英文数字镜头标记规范成引擎要求的 `分镜1`；不改用户原文、原始响应或按原文 span 组装的段落。原始决定仍为 intake-decision.json，有变更时另存 intake-effective-decision.json 与 marker 变更清单，不增加调用。不同宿主版本以每轮 host_sha256 区分，早期失败不自动重提。
