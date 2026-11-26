# 后端集成说明

当前接入入口为 [INTEGRATION.md](../INTEGRATION.md)，运行架构与并发见 [README](../README.md)，镜像/依赖/CC启动见 [DEPLOYMENT.md](DEPLOYMENT.md)。

旧文档中的2026-10-23阻塞项、node16、旧后端主机与v1.3部署状态已过期，不再作为当前接入依据；需要追溯时查看Git历史。

保留边界：浏览器经Web/BFF调用公开API；Gateway管理认证/任务/调度；Bridge隔离运行CC并固定每轮成片；Seko白模走独立harness。内部接口需要网络白名单及共享token，不能暴露给浏览器。具体接口实现见`apps/gateway/src/server.mjs`和`apps/worker-bridge/src/server.mjs`。
