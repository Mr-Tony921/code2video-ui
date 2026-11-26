# Dev部署与后端环境 · 1.5.8

当前入口、主机和并发以 [README](../README.md) 为准。旧1.3/1.4部署步骤仅保留在Git历史，不能据此操作正式服务。

## 镜像与依赖边界

部署方提供的后端镜像：

```text
registry.cn-tj-01.sensecore.cn/ccr-zuhu2026/coding-video-cc-v2-261023:hjw-hermes-20261023112829
```

镜像由用户于2026-11-26确认；本轮未重新拉取镜像，也未校验运行Pod的image digest。业务侧需具备该私有镜像仓库的拉取权限。仓库不包含镜像拉取凭据或Dockerfile；使用下表核对镜像内依赖及外置共享资源。

| 项目 | 当前约定 |
| --- | --- |
| Node | 22+；Worker默认`/usr/local/bin/node` |
| Claude Code | `/usr/local/bin/claude`，当前配置验证记录2.1.304；以部署实测为准 |
| 系统依赖 | FFmpeg/ffprobe、Python、LaTeX、Noto CJK字体、Linux unshare、tmux |
| Node渲染包 | `/opt/videokit/node_modules`：Canvas、Three.js、GSAP、Playwright、Puppeteer等 |
| Python环境 | `/opt/videokit/venv/bin/python`：manim、numpy、Pillow、OpenCV、TTS等 |
| Chrome | 宿主位于共享runtime/browser；隔离内`/srv/chrome-linux64/chrome` |
| 白模依赖 | 共享runtime/previs-deps与版本化Seko引擎；不能假设镜像含这些文件 |
| 会话存储 | 多Worker共享；每会话workspace、每轮rounds分别保存，权限由应用校验 |

用 `bash scripts/verify-deps.sh <worker-IP>` 核查依赖；该脚本中的默认旧拓扑不可用于新部署，显式传当前主机。如果目标环境缺Chrome/白模依赖，按相应安装脚本与配置路径部署，避免覆盖既有冻结版本。

## 启动与更新

服务所属主机在checkout内使用 `python3 scripts/service.py <web|gateway|bridge> <start|stop|restart|status|logs> [worker-id]`，专用tmux socket为`cvw-codex`。后端Bridge启动CC，前端不执行模型任务。每台Worker只启动自己的worker-id；Gateway单实例负责幂等、FIFO、租约与并发上限。

前端变更先stop，再`web build`，最后start；service.py会拒绝覆盖正在使用的构建。后端更新用 `bash scripts/hot-update.sh run`，在维护态按Bridge→Gateway顺序更新并核对认领。优先等待活动任务和队列为空；不要强杀用户任务。脚本的具体主机/端口来自当前配置，不能照搬本dev的地址去覆盖业务环境。

## CC与凭据

实际启动入口 `apps/worker-bridge/src/job-runner.mjs`，工作区准备在`job-workspace.mjs`。默认C2V使用CC的`-p --permission-mode bypassPermissions --output-format stream-json --verbose`；首轮`--session-id`，续轮`--resume`，prompt通过stdin；每会话HOME隔离。命名空间将工作区挂到`/workspace`并遮蔽宿主/mnt；必须保留该隔离，不能只复制bypassPermissions参数。

真实配置`config/backend.json`、`runtime/.secrets`和模型快照凭据不入Git。C2V默认模型由管理员保存的不可变快照决定，配置模板model节点只作为fallback；更新默认不改旧会话。提交任务只能选fast_mode布尔值，不能传宿主skill路径。

## 留存与诊断

- gateway持久化任务：原prompt、增强结果、模型快照、fast_mode/fast_skill、状态时间、错误与结果。
- `session/workspace/`：源码、参考、CC原生会话、追加轨迹、工具输出。
- `session/rounds/<job>/`：本轮prompt.md、_meta.json、终态标记及固定成片；续改不覆盖历史成片。
- 验证和实验：`runtime/validation`、`runtime/reports`；不提交视频/日志/用户数据。
- 总时间拆分排队、增强、运行；快速skill的工具耗时不是完整模型耗时。约5分钟目标无硬杀，现有平台运行保护仍适用。

发版必须完成工程回归、前端build、健康检查及普通账号真实生成；检查Git工作区、线性提交和仓库凭据后再分享。GitHub私有仓库的保护规则必须实际生效，不能把未受套餐支持的规则当作权限保证。
