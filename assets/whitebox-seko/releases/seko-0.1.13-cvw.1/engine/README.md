# Web adapter release 0.1.13 / cvw.1

This fixed dev release uses the host Seko runner and configured GPT Responses provider. Initial authoring/review use low effort; local corrections keep high effort. Initial generation permits at most two corrections, follow-up at most one. Uncertain quality evidence remains unresolved and cannot alone request speculative source changes. Rendering and measured client upload are timed separately.

0.1.13 adds rigid one-cylinder limbs and precise syntax diagnostics while retaining bounded review of readable coarse story and spatial outcomes. Incidental performance poses and small tolerated contact gaps do not require a source correction. Actual sampled gaps and parent bindings remain available; missing evidence is still unresolved quality. The low draft/review, high repair and initial-plus-two/follow-up-plus-one limits are unchanged. Previous measurements remain labeled with their actual versions. The host integration instructions live in docs/WHITEBOX-SEKO.md in the web repository. The upstream 0.1.5 manifest is preserved separately as UPSTREAM-MANIFEST.json.

# Seko Engine · 0.x 候选

输入完整故事（seg 与镜头文本）及参考图，输出可编辑 Three.js 场景；不生成 MP4。Skill 可在其他 harness 中按同一流程执行。本包不依赖内部 benchmark 或旧 c2v 目录。

## 安装

需要 Python 3.11+、Node 22+、Chrome/Chromium 与可用 WebGL。以下命令在引擎解压目录执行：

```sh
python -m venv .venv
.venv/bin/pip install -r requirements.txt
npm ci --ignore-scripts
```

设置 `CHROME_PATH` 为浏览器可执行文件，默认 `/usr/bin/google-chrome`。`puppeteer-core` 不下载浏览器。配置复制 `config.example.json` 并通过环境变量提供 key；渠道和模型名字按实际平台填写。示例通道是本次实验使用的名称，不保证其他账户具有权限。平台同名 low/high 不等价于相同推理计算量，实际响应 token/通道单独记录。

## 初始生成和独立回放

```sh
.venv/bin/python cli.py generate --input input.txt --references references --config config.json --model deepseek --case-id story --out runs/story-001
.venv/bin/python cli.py probe --project runs/story-001/candidate-00/output/project.json --task runs/story-001/task.json --out checks/story-001
```

实际最终候选位置以 `artifact.json` 为准，不能假设一定是 candidate-00。初稿 low、自检 low、修正 high；初稿加最多 2 次修正，所有模型使用相同流程。超过 600 秒仍继续有限流程，`time_pass` 独立记失败。保留最后可渲染候选与未解决问题，不用空场景替代。

`job.json` 是状态和计时；`artifact.json` 指向 `project.json` 与源 JS。源 JS 的 `buildScene` 在注入 Three.js/helpers/task 的受限宿主中编译，场景序列化后由公开 `runtime/project.js` 的 `loadProject(project)` / `setTime(seconds)` / `listEntities()` 回放。绝对时间求值可以独立 seek，段与镜头索引在 project 中。所有任务使用新的输出目录，绝不覆盖原任务或悄悄重跑失败样本。

## 追问与网页草稿接续

先把最新保存的项目（包括网页拖动产生的新 project.json）导入工作区：

```sh
.venv/bin/python cli.py workspace --project latest-project.json --task task.json --out workspaces/story
.venv/bin/python cli.py revise --workspace workspaces/story --scope shot_003 --entities actor_a --request '这个镜头里人物A保持镜头开始时的位置不动' --config config.json --model deepseek --out revisions/edit-001
```

`--scope` 使用真实 seg/shot ID；`--entities` 是授权修改的实体 ID。只支持平移、位置冻结、旋转和显隐的局部覆盖，子对象跟随；复杂重新建模、改剧情时长、添加角色等明确返回 unsupported。一次修改＋最多一次修正，只检查目标区间及关联边界，未改内容沿用原记录。工作区 head 在请求前后核对；新人工编辑发生时旧请求不得覆盖它。失败或未完成的修改保留候选但不发布 head。

机器可直接提交结构化编辑：`cli.py apply-edits --workspace ... --operations ops.json --expected-revision 0`。这是人工草稿，不自动宣称质量通过。自然语言接口读最新 head，返回新 revision，旧版本始终可恢复。

## 本地持久调度

提交文件 `job-request.json` 内容为 `{"kind":"generate","args":["--input","...","--references","...","--config","...","--model","deepseek","--out","..."]}`，或 kind=revise。参数是数组，不经过 shell。

```sh
.venv/bin/python cli.py queue --db queue/tasks.sqlite enqueue --job job-request.json
.venv/bin/python cli.py queue --db queue/tasks.sqlite work
.venv/bin/python cli.py queue --db queue/tasks.sqlite list
```

worker 顺序取任务，多个 worker 通过事务认领不会重复执行；数据库可跨进程保留。`cancel --id N` 仅取消排队项。进程意外退出时已完成任务和候选仍在磁盘；running/interrupted 项需要检查原产物后显式处理，不自动重放已计费请求。当前不提供任意阶段无缝恢复或服务集群调度。

## 验证与边界

```sh
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tests -v
node --test tests/runtime.test.mjs
```

schema 与实际接口见 `contracts/项目协议.md`。截图是有限采样，模型自检有漏检和误报可能；独立 benchmark 和用户认可在包外。对业务宿主只完成了已提供 helper 子集的兼容验证，未获得其真实前端代码，不宣称生产已接入。几何是可读的空间代理，人物步态、精细表情和反复打斗不是硬要求。

## 源代码定点补充（0.1.4）

对于已完成且没有人工 overlay 的任务，可用 `cli.py refine-source --run runs/story-001 --request-file request.txt --config config.json --model deepseek --out revisions/source-001` 补充明确缺陷。高思考生成补丁、最多一次修正，保存为独立分支，原始 pass@1 不变；工作区自然语言 `revise` 仍只支持上文列出的有限操作。源代码分支不自动替换用户最新项目，不适用于绕过人工编辑或无限接力自审。

The 0.1.10 plain-shot-marker input fix is retained. 0.1.12 updates coarse review policy and executable evidence only; media encoding and finite call budgets are preserved. See host docs for activation and evidence; this directory remains immutable after binding.
