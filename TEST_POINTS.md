# 当前回归入口

- `node --test tests/unit/*.mjs`：隔离夹具验证状态、调度、权限、取消、历史、模型和skill。
- `python3 tests/unit/service_test.py`：服务进程管理。
- `python3 scripts/service.py web build`：前端类型与构建，需先停止本checkout的Web。
- `bash scripts/release-check.sh`：部署版本、服务与端点。
- 快速模式：普通test账号完成真实首轮与同会话局部续改；检查fast_mode、skill版本/hash、Read入口、录制与技术校验、历史成片和工具轨迹。

运行位置、隔离范围与依赖见 [README](README.md)。测试输出、截图和成片放runtime/validation，不进入共享仓库。
