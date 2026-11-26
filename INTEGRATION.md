# 业务集成入口 · 1.5.8

当前可分享源码为本仓库 main；部署事实以 [README](README.md) 和 [部署说明](docs/DEPLOYMENT.md) 为准。旧1.3.x线上升级清单已移出当前说明，可在Git历史中查看。

## 使用现有 dev API

1. 在 `http://10.210.9.14:20211` 用普通账号登录；复用登录Cookie调用同源 `/api/*`。浏览器不直连Worker或内部调度接口。
2. `POST /api/sessions`，C2V填写 `{"mode":"coding_to_video"}`，服务端绑定当前默认模型。保存返回的会话ID。
3. 通过现有 reference 上传接口提交用户附件，等待完成后再提交任务；保留原始prompt，避免擅自改写业务测试集。
4. `POST /api/sessions/:id/jobs` 带稳定的 `Idempotency-Key`，正文含 `prompt`、`enhance`（默认开启）、`fast_mode`（默认false）、`is_revision`。快照与skill版本由服务端决定。
5. 使用任务状态/SSE查看排队和生成，终态后使用返回的playback/download URL。快速模式不绕过可播放性校验。
6. 追加修改在同一会话提交新任务；保留已有源码和CC记忆，`is_revision:true` 跳过扩写。快速模式每轮显式传入；原始API客户端省略该字段即普通模式。

详细请求/类型以 `apps/web/lib/api.ts`、`apps/web/lib/types.ts` 和Gateway路由为准；已有接口、取消、附件、历史成片、会话归属权限不变。

## 自行部署

配置模板为 `config/backend.example.json`，复制为被Git忽略的 `config/backend.json`。按目标环境设置地址、模型、路径和私有凭据，不拷贝本dev的运行账号、密钥或历史数据。安装前后端依赖，并准备README列出的容器及共享渲染依赖；使用 `scripts/service.py` 与隔离守卫管理服务。并发不是每模型独占，详见README。

## 验证与版本

- 快速模式回归：`node --test tests/unit/c2v-fast*.mjs`，覆盖输入校验、幂等、排队传递、不可变快照、工作区续改及切回普通模式。
- 全量工程回归：`node --test tests/unit/*.mjs`、`python3 tests/unit/service_test.py`、前端构建与 `bash scripts/release-check.sh`。
- 业务测试台与冻结case：`tools/c2v-bench/`；大媒体、实验报告、实际轨迹在私有runtime中另行交付，不能把旧测试结果算作新版验证。
- 快速skill 0.1.0 与应用1.5.8分别版本化；更新skill新增发行目录并更新服务端快照入口，不覆盖已排队/历史版本。
