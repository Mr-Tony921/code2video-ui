# 回归测试点

每次改代码 / 重启服务后跑一遍。目标：**基本功能不被打破**。

## ⚠️ 发布前必跑（唯一判据）

```bash
bash scripts/release-check.sh
```

14 项，覆盖"改完代码到能对外"之间所有容易漏的环节：
单实例 / 线上是否最新构建 / **公网前缀是否正确** / 三层可达 /
**公网入口与资源实际可取** / job 记录完整性 / 版本与 CHANGELOG。

**失败就不要交付。** 它替代了"我觉得应该没问题"。

### 为什么要有这个
公网整站打不开出现过两次，根因都一样：
构建产物的 `basePath` 丢了 → 页面里的 `_next/*` 指向域名根 →
那里是**另一个应用**，返回 HTML 冒充 CSS/JS → 白屏。
第二次是我调试时图快直接跑了 `next build`，绕过了注入前缀的脚本。

所以现在有两道闸：
- `start-frontend.sh start` 启动前比对 basePath，不一致**直接拒绝启动**
- `release-check.sh` + 冒烟都会校验，且会**真的去取一次 CSS**确认 200

**永远不要直接跑 `next build`**，用 `bash scripts/start-frontend.sh build`。

## 一键冒烟

```bash
bash scripts/smoke.sh              # 内网直连，含并发幂等实测（会提交 1 个 1 秒任务）
bash scripts/smoke.sh --no-job     # 跳过提交任务，纯只读，最快
WEB=https://api-gai-volc-internal.sensetime.com/sensechat-vision/signpost/v0/prod-sensenova-codevideo-v0-1 \
  bash scripts/smoke.sh --no-job   # 测公网转发路径
```

覆盖 18 项：可达性 / 认证越权 / 核心读接口 / 会话素材 / 并发幂等 / 归属校验。
**任一失败都不要上线。**

## 依赖完整性（换机器或改路径后必跑）

```bash
bash scripts/verify-deps.sh 10.120.0.161 10.120.0.175
```

53 项。其中两项是**命名空间内**检查 —— 宿主机上看着正常、任务里却不可见的坑
（chrome / previs-deps 装在被遮蔽的 `/mnt` 下）只有这里能发现。

## 需要人工点的（脚本测不了）

| # | 场景 | 预期 |
|---|---|---|
| 1 | 无痕窗口打开站点 | 停在登录页，不自动进工作区 |
| 2 | 登录 → 提交 1 秒视频 | 右侧过程框实时滚动工具调用；完成后视频可播放、可下载 |
| 3 | 任务完成后再输入 | 输入框解锁，可继续提交 |
| 4 | 问一句非视频内容（如"你是谁"） | 提示超出范围；**输入框不锁死**，同一对话可继续 |
| 5 | 上传 1~2 个参考素材再提交 | 提交后素材冻结；dense prompt 里出现 `assets/xxx` |
| 6 | 切 3D Blockout 提交 | 能渲染出白模视频（验证 chrome bind 生效） |
| 7 | 生成不带白模权限的邀请码 → 注册 → 登录 | 切不到 3D Blockout |
| 8 | 管理后台生成邀请码 → 复制 | 复制成功；历史列表能看到完整码 |
| 9 | 管理后台改用户渠道/备注 | 保存后刷新仍在 |
| 10 | 同账号在两个浏览器/地址登录同一任务 | 两边都能看到过程推进（不是只有一边动） |
| 11 | 点"停止生成" | 任务转 CANCELLED，`global_used` 立刻 -1 |
| 12 | 关闭网页 10 分钟 | 任务被自动停止（心跳超时） |

## 并发/稳定性（同事上线前重点）

```bash
# 看当前负载与两台 worker 的健康
curl -s --noproxy '*' http://10.120.0.161:9998/healthz | python3 -m json.tool

# 按用户追踪（排障主力）
grep '"u":"某用户名"' runtime/logs/gateway.log | tail -40
grep '"evt":"job.submit"' runtime/logs/gateway.log | tail -20
grep '"evt":"sse.open"\|"evt":"sse.close"' runtime/logs/gateway.log | tail -20
grep 'presence.multi' runtime/logs/gateway.log        # 同账号多端在线
grep '⚠' runtime/logs/gateway.log                      # 串号/异常告警
```

关键不变量（出问题先查这几条）：
- `global_used` 应等于两台 bridge `running_jobs` 之和；长期对不上 = 槽位泄漏
- `processes` 应等于在线 worker 数（当前 2）；只增不减 = 旧实例没清理
- `runtime/gateway/jobs/*.json` 必须都能 `json.load`；解析失败 = 并发写损坏
- `runtime/gateway/jobs/*.tmp` 应为 0；堆积 = 原子写失败

```bash
# 一条命令自查上面四项
python3 - <<'PY'
import json,glob
bad=[f for f in glob.glob('runtime/gateway/jobs/*.json') if not _try(f)] if False else []
for f in glob.glob('runtime/gateway/jobs/*.json'):
    try: json.load(open(f))
    except Exception as e: bad.append((f.split('/')[-1][:24],str(e)[:40]))
tmp=glob.glob('runtime/gateway/jobs/*.tmp')
print('损坏 job:',bad or '✅ 0');print('残留 tmp:',len(tmp) or '✅ 0')
PY
```

## 本轮修复的问题（都已实测验证）

| 问题 | 根因 | 验证方式 |
|---|---|---|
| 白模任务找不到 chrome | `hide_paths` 遮蔽 `/mnt`，但 chrome 装在 `/mnt` 下 | 命名空间内实测 chrome 138 可执行；真实白模任务渲出 s0.mp4，无自下载 |
| 并发提交产生重复任务 | 幂等 check-then-write 无锁 | 并发 10 次同 key：修复前 10 个任务，修复后 1 个 |
| job 文件损坏 | 临时文件名只到毫秒，同毫秒两次写互相截断 | 并发 60 写 + 60 读：0 失败，文件合法，0 残留 tmp |
| 一台 worker 失联锁死全局容量 | `globalUsed` 统计了 UNAVAILABLE 进程 | 单测：失联后健康机器仍可派发 |
| 孤儿任务永久卡 RUNNING | 进程消失时 reconcile 无限退避 | 30 分钟后判 FAILED 并释放槽 |
| 12h 超时显示为"已取消" | cancel-ack 一律转 CANCELLED | 用 60s 限制实测：FAILED + E_MAX_RUNTIME_EXCEEDED |
| `processes` 只增不减 | 旧实例只标 UNAVAILABLE 不删除 | 重启后 processes 从 4 回到 2 |
