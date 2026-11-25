# dev 实验模式

仅 `environment.name=dev` 且 `experimental.enabled=true` 时可用。在管理后台的用户页勾选「实验模式」后，该用户才看得到入口；管理员自己也需要显式开启。权限撤销立即阻止新会话和新任务，不中止已运行任务，不删除历史。

本机 `config/backend.json` 的 `experimental.models` 配置 Opus 55、内网和 Fable 5.2（`claude-fable-5-2/anthropic_L/sfo`）。Opus 55 和 Fable 的模板分别从 `CVW_EXPERIMENTAL_MODEL_API_KEY` 和 `CVW_EXPERIMENTAL_FABLE_API_KEY` 读取密钥。Fable 的 `allowed_user_ids` 为 `["test"]`，账号同时需要实验模式权限。脱敏格式见 `config/backend.example.json`。

实验模式还提供「内网」选项：`{"id":"intranet-default","source":"primary"}`。它直接引用普通模式 `model` 配置及对应环境变量，沿用当前内网模型的地址、名称、上下文/输出上限与认证方式，无需另配增强渠道 key。名称默认显示为实际模型名加「（内网）」，也可通过 `name` 自定义。新增实验对话时选择该模型，并将内置 skill 保持为「不使用任何内置 skill」，即可直接用内网模型处理原始 prompt；不上传、不粘贴自定义 skill 时工作区中没有任何平台 skill。既有增强渠道继续保留，添加这个选项不会改变旧会话的模型配置版本。

每项 API 配置包含稳定 `id`、显示 `name`、请求用 `model`、`endpoint`、`api_key_env` 或 `api_key`，可选 `max_context_tokens`、`max_output_tokens`、`autocompact_pct`。`endpoint_env` 与 `model_env` 可覆盖相应字段。环境变量优先于文件值；密钥只在服务端配置，模型列表不返回密钥。首版沿用现有 Claude CLI 的 Messages 兼容协议。未设上下文/输出限制时使用 CLI 对该 API 模型的默认值，不继承内网模型的 512K/64K。

修改模型配置后通过 `scripts/hot-update.sh` 滚动更新 dev 服务。增加模型可增加配置项；停用用 `enabled:false`。每个会话固定模型描述与配置 revision；endpoint、模型或参数变化后须新建对话，旧对话保留历史且不会悄悄换模型。仅轮换 API key 不改变 revision。

新建实验对话时选模型及内置 skill（默认「不使用任何内置 skill」）。生成页可粘贴 SKILL.md、上传 ZIP 包，可同时使用。ZIP 应包含一个或多个 skill 目录，每个目录含 SKILL.md 及自己的 scripts/resources；也支持根目录直接放 SKILL.md。压缩包上限 8 MiB，解压后 64 MiB/2000 文件，拒绝越界路径和链接。加载内置白模 skill 仍需白模权限。

发送任务时保存本轮 skill 的不可变版本，后续修改不会覆盖历史。原始 prompt 直接交给模型，不做增强，不附加平台创作流程或续改指令；仅追加交付位置 `output/final.mp4`。保留现有资源隔离、并发、取消、租约和最大运行时间约束。主执行与 CLI 内部其他模型角色统一使用所选模型。

会话数据继续使用 `workspace/`、`rounds/<job>/` 与原生 `.home/.claude/projects/` 布局。`skill-revisions/<sha256>/` 保存原始 ZIP、粘贴文本及实际挂载文件；每轮 `_meta.json` 记录模型和 skill 版本。所有模式的页面都可「下载完整会话」，包含源码、产物、原始 stdout/stderr、原生会话与子任务 JSONL、各轮记录和输入。推理签名等不透明字段按原文保存，页面的摘要/截断不改变原始记录。可重新安装的依赖、缓存、临时目录及凭据设置文件不进入导出。

增强环节也将 prompt、原始输出与原生会话保存在该轮 `enhancement/`，包括失败时已产生的记录。原有历史中未落盘或已清理的信息无法补回。

验证：`node --test tests/unit/*.mjs`、`bash tests/risk/run-all.sh`；真实验收使用已获得权限的普通 test 账号运行 `node scripts/verify-experimental.mjs`，报告放在 `runtime/validation/v1.5.2/`。不得使用管理员账号冒烟。

浏览器验收在安装 videokit/Chrome 的 dev Worker 上运行 `node scripts/verify-experimental-ui.mjs`，检查授权入口、模型选择、9000 字输入和 skill 编辑页；通过配置中的隔离挂载映射找到宿主 Chrome。

内网零 skill 真实验收：`node scripts/verify-intranet-experimental.mjs`。CLI 自带能力可能仍出现在 init 列表中，验收同时检查平台 skill 目录为空及实际 Skill 工具调用为 0；它们与平台挂载的 skillset 分开记录。

## 可配置 skill：Anatomy

在实验对话的「实验 skill 设置」中，上方内置 skill 选择 **Coding to Video**，再勾选 **Anatomy**。Anatomy 默认不勾选；它提供精密机械与等轴造型，`code-video-core` 保留视频时间轴、`window.seek(t)` / `window.READY` / `window.DUR` 和逐帧导出能力。模型仍按原始 prompt 执行；请在 prompt 中要求通过 Skill 工具加载所选技能，并交付 `output/final.mp4`。参考图通过「参考素材」在首轮发送前上传。完整按钮/发动机参考实验资料位于交接研究目录，本次接入不预设这些素材。

服务端在 `config/backend.json` 的 `experimental.skills` 数组维护可选项，例子见 `config/backend.example.json`。每项包含稳定 `id`、显示 `name`、`enabled`、固定 `version`、相对 `archive` 路径、`archive_sha256`，可选 `description` 和 `source`。包必须放在本副本持久目录 `assets/experimental-skills/` 下；导入复用原 ZIP 的大小、文件数、路径和链接校验。列表接口 `GET /api/experimental/skills` 同样要求 dev 开关和当前用户的实验权限，不暴露包路径。

Anatomy 固定为上游 commit `1482e8469b0a9e0d8cc18ea2740a01423d29ae80`，MIT 许可。持久包、LICENSE、逐文件来源与校验值保存在 `assets/experimental-skills/anatomy/`。仅排除预生成 PDF，164 个原文件字节不变。没有安装到全局技能目录。子进程中 `CHROME_PATH` 与平台的 `CHROME_BIN` 指向同一浏览器。

发送时 `experimental_skills.configured` 传入所选项的 `id`、`version`、`archive_sha256`（可直接使用列表返回的对象）。服务端校验启用状态和版本，再将完整 ZIP、解包内容及来源信息保存到会话 `skill-revisions/<revision>/configured-packages/<id>/uploaded.zip`、`skills/`、`manifest.json`。任务和本轮 `_meta.json` 保存该快照，完整会话下载包含这些内容。Bridge 仅从本轮快照挂载，不读取当前目录配置；修改服务端配置或停用条目不会影响已提交任务与历史文件。后续轮次若仍携带旧版本，会明确要求重新选择；停用后需移除选择。配置 skill、上传 ZIP、粘贴内容与内置 skill 若同名，拒绝提交或挂载，不静默覆盖。

更新版本时：先把新 ZIP 放到新的固定路径，校验 SHA256 并保留许可证/来源，再修改条目的 `version`、`archive`、`archive_sha256`；不要覆盖旧包。用现有 `scripts/hot-update.sh` 滚动更新 dev 后端，用户重开设置弹窗获取列表并确认当前版本。停用设 `enabled:false`。仅修改目录配置或包无需重建 UI；首次接入本功能需要更新 UI 构建。历史快照不做清理。

验证入口：`node --test tests/unit/experimental-catalog.mjs tests/unit/experimental-http.mjs tests/unit/experimental-runner.mjs`；真实小规模出片 `node scripts/verify-anatomy.mjs`（普通 test/test-peer，可用 `--continue` 继续验收同一个任务）；浏览器检查 `CVW_TEST_ANATOMY=1 CVW_TEST_REPORT_DIR=<本副本报告目录> node scripts/verify-experimental-ui.mjs`。本次仅验收小规模集成出片，不代表已经验证 18 秒按钮或 30 秒发动机完整实验的质量。

## 临时多图实验

默认附件上限仍为10，白模仍为100。仅在明确授权的实验会话可用服务端配置 `references.experimental_session_limits` 扩容，形如 `{ "sess_UUID": { "max_per_session": 25, "expires_at": "ISO-8601 UTC" } }`。必须是1至100内整数、超过默认值且尚未到期；缺失/错误/过期配置回退默认。不得通过上传请求参数扩大上限。

配置载入后依现有空闲重载门禁更新 Bridge。会话外不生效；到期不删除已上传素材，附件集合依旧在提交任务时冻结。实验结束后可清理配置条目；仅清理元数据，勿删除原图或改写历史任务。
