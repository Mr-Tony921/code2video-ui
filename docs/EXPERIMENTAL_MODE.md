# dev 实验模式（1.5.2）

仅 `environment.name=dev` 且 `experimental.enabled=true` 时可用。在管理后台的用户页勾选「实验模式」后，该用户才看得到入口；管理员自己也需要显式开启。权限撤销立即阻止新会话和新任务，不中止已运行任务，不删除历史。

模型由本机忽略提交的 `config/backend.json` 中 `experimental.models` 管理。初始配置复制当前增强模型的 endpoint、key 和 model，此后独立维护，不会随增强模型设置自动漂移。脱敏格式见 `config/backend.example.json`。

每项配置包含稳定 `id`、显示 `name`、请求用 `model`、`endpoint`、`api_key_env` 或 `api_key`，可选 `max_context_tokens`、`max_output_tokens`、`autocompact_pct`。`endpoint_env` 与 `model_env` 可覆盖相应字段。环境变量优先于文件值；密钥只在服务端配置，模型列表不返回密钥。首版沿用现有 Claude CLI 的 Messages 兼容协议。未设上下文/输出限制时使用 CLI 对该 API 模型的默认值，不继承内网模型的 512K/64K。

修改模型配置后通过 `scripts/hot-update.sh` 滚动更新 dev 服务。增加模型可增加配置项；停用用 `enabled:false`。每个会话固定模型描述与配置 revision；endpoint、模型或参数变化后须新建对话，旧对话保留历史且不会悄悄换模型。仅轮换 API key 不改变 revision。

新建实验对话时选模型及内置 skill（默认「不使用任何内置 skill」）。生成页可粘贴 SKILL.md、上传 ZIP 包，可同时使用。ZIP 应包含一个或多个 skill 目录，每个目录含 SKILL.md 及自己的 scripts/resources；也支持根目录直接放 SKILL.md。压缩包上限 8 MiB，解压后 64 MiB/2000 文件，拒绝越界路径和链接。加载内置白模 skill 仍需白模权限。

发送任务时保存本轮 skill 的不可变版本，后续修改不会覆盖历史。原始 prompt 直接交给模型，不做增强，不附加平台创作流程或续改指令；仅追加交付位置 `output/final.mp4`。保留现有资源隔离、并发、取消、租约和最大运行时间约束。主执行与 CLI 内部其他模型角色统一使用所选模型。

会话数据继续使用 `workspace/`、`rounds/<job>/` 与原生 `.home/.claude/projects/` 布局。`skill-revisions/<sha256>/` 保存原始 ZIP、粘贴文本及实际挂载文件；每轮 `_meta.json` 记录模型和 skill 版本。所有模式的页面都可「下载完整会话」，包含源码、产物、原始 stdout/stderr、原生会话与子任务 JSONL、各轮记录和输入。推理签名等不透明字段按原文保存，页面的摘要/截断不改变原始记录。可重新安装的依赖、缓存、临时目录及凭据设置文件不进入导出。

增强环节也将 prompt、原始输出与原生会话保存在该轮 `enhancement/`，包括失败时已产生的记录。原有历史中未落盘或已清理的信息无法补回。

验证：`node --test tests/unit/*.mjs`、`bash tests/risk/run-all.sh`；真实验收使用已获得权限的普通 test 账号运行 `node scripts/verify-experimental.mjs`，报告放在 `runtime/validation/v1.5.2/`。不得使用管理员账号冒烟。

浏览器验收在安装 videokit/Chrome 的 dev Worker 上运行 `node scripts/verify-experimental-ui.mjs`，检查授权入口、模型选择、9000 字输入和 skill 编辑页；通过配置中的隔离挂载映射找到宿主 Chrome。
