# 模型配置（1.5.5）

管理员后台的“模型配置”分别维护 C2V 推理模型和 Prompt 增强模型。支持 Tokenhub 与内网 Anthropic Messages 接口。Tokenhub 需要完整模型名称和 Key，内网仅需地址和模型名。纯内网服务名自动补 `http://` 和端口 `8000`，显式端口保留。

“检测连通性”调用所填地址的 `/v1/messages`，实际发送一条短推理请求，并显示绿色连通、红色失败或超时。只列出 `/v1/models` 不算通过。检测当前表单，不会修改保存的配置。修改字段后清除旧检测结果。

Key 保存在服务端私有目录，不返回原文。页面显示脱敏值，修改框留空保留同一地址保存的 Key；地址变更时需要重新填写 Key。切换为内网模型后不用 Key。

## 默认与生效范围

首次发布运行 `node scripts/initialize-c2v-models.mjs`，从现有 `tokenhub-deepseek-v41-flash` 配置初始化 C2V 默认模型，保留现有 Opus 5.5 增强配置。该命令仅初始化尚未保存的项，重复执行不会覆盖管理员修改。

C2V 推理模型在新建对话时固定。后续调整管理员默认模型或 Key 不改变旧对话使用的配置，正在执行和排队任务继续使用自己的快照。原有未记录模型的 C2V 对话继续使用原基础模型配置，避免续写时混入另一模型的历史。普通 C2V 用户传入 `model_id` 无效，也不能调用管理员读写和检测接口。

增强配置用于之后启动的增强请求。单次增强开始时固定模型、地址与 Key，agent 回退单轮仍使用同一配置。续写和显式关闭增强保持原有跳过逻辑。

## 实验模式

新建对话可选择已有模型，或选择“自行填写模型”。自填配置保存在该用户的服务端记录，默认不带公共 Key。保存成功后可新建对话，仍默认 `builtin: none`。只有显式选择时才加载内置 Skill。

重新打开时读取该用户上一次保存的配置，Key 只显示掩码。其他用户不能读取、检测或使用该私有配置，即使知道配置 ID。保存新配置不会改变旧会话快照。

## 存储与接口

默认目录为 `<CVW_STORAGE_ROOT 或 storage.root>/model-settings/`，也可通过 `model_settings.root` 指定共享目录。Gateway 和 Worker 必须能读取同一目录。目录权限 `700`，文件权限 `600`。

独立不可变配置文件保存模型快照和凭据，默认项和每用户“上一次”仅保存指针。Session/Job 只保存不含 Key 的模型快照，凭据不放入会话归档，也不写入 Git。备份迁移时需额外保留该私有目录，否则历史会话无法解析其模型配置。

- `GET /api/admin/models`
- `PATCH /api/admin/models/c2v`、`PATCH /api/admin/models/enhancement`
- `POST /api/admin/models/c2v/check`、`POST /api/admin/models/enhancement/check`
- `GET /api/experimental/custom-model`
- `POST /api/experimental/custom-model`
- `POST /api/experimental/custom-model/check`

连接输入为 `kind`（`tokenhub` 或 `intranet`）、`endpoint`、`model`、可选 `api_key` 与 `reference_id`。`reference_id` 仅用于复用自己有权访问的已保存 Key。所有读取接口仅返回 `has_key` 和 `key_mask`。

本功能独立于原 `raw.model` 和白模模型配置；白模选择、模型路由、Skill、运行及编辑流程不变。当前 CC 自带的 system prompt 与工具 schema 仍由 CC 生成。
