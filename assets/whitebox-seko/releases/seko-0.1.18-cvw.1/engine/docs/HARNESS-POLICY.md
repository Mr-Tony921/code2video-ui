# Harness 系统约束与工具契约 · 0.1.15

本文件随 skill、runtime、harness 一起冻结。系统提示的唯一源码是 `python/seko_engine/policy.py` 的 `SYSTEM_PROMPT`，版本 `POLICY_VERSION`，SHA256 为 `SYSTEM_SHA256`。修改提示必须更新发行版本并运行回归；实际请求的 system 内容、policy版本/hash保存在 capture 中，不能靠文档声称已发送。

## 提示层级和协议

宿主发送固定 system 提示；阶段 user 消息包含当前 skill/契约、原始故事与参考、当前源码和真实工具证据。用户原始 prompt 不追加内部生产话术。Responses 使用 system input；Chat 使用 system message；Anthropic 使用顶层 system。旧引擎没有policy模块时保持旧协议，不修改冻结版本。

模型按阶段返回 intake JSON、初稿JS模块、源码原子补丁JSON或审查JSON。这里**没有模型原生function calling工具表**：Python宿主依次调用固定工具，不开放任意shell/网络。system中准确列出这个边界，不伪造工具调用能力。工具执行及输出仍由轨迹记录。

|宿主工具|输入/结果|触发条件|
|---|---|---|
|normalize / intake|原文、附件标识→片段分镜；矛盾则澄清|业务JSON确定性整理；自由文本必要时模型整理|
|apply_source_patch|最新源码SHA、原子行替换→新源码|修复/追问；失败不部分应用|
|probe.mjs|source/task→project、结构、focus、seek、截图|每个实际候选|
|motionAudit|真实project→移动人物穿越单个实体网格风险、时刻|probe内确定性运行，无额外模型请求|
|build_sheets / changed_shots|实际截图与曲线→分页拼图、局部复审范围|编译成功后|
|camera-proposals.mjs|项目+问题镜头→可选局部相机数值|已有真实渲染且有修复；不会自动套用|
|package / render-video.mjs|最后可渲染项目→工程包／MP4|交付；MP4计时独立|

## 人物与空间

所有人，包括路人，统一 `helpers.person` 七部件：圆球头、方块鼻、圆柱躯干、两圆柱手臂、两圆柱腿。手仅不可见锚点，肢体固定长度。站坐是安全默认；可选精细动作失败就省略，不通过下沉或伸长肢体表达。移动朝向与对话对象合理，伸手结束恢复放松，持续持物/承重除外。宠物等真正非人主体可显式标记nonhuman，不可用于规避人形规范。

移动路线通过实际空门洞，门板提前移开，用少量路径点绕过墙、栏杆和家具。不要求步态、IK或物理仿真。静态细微重叠可保留，动态穿透优先修。motionAudit是有限几何证据：箱体使用局部实体内部；圆柱包围盒仅为疑似；移动/旋转障碍按采样区间检查，无法证明全部帧无碰撞。真实门洞不以整组包围盒填平。截图对重要风险加一张事件帧，每镜头最多一张，不增加模型调用。

## 有限循环与追问

首稿最多两次修复请求；追问一次局部编辑最多一次修复。首修后若仅剩同类旧问题、没有新回归且渲染/结构正常，立即保留问题交付，不再为剩余问题进行第二次相同尝试。第二次用于技术恢复或新回归，要求更简单的替代实现。问题使用稳定problem_id追踪；技术失败和仅证据不足分别处理。停止不等于质量通过。

追问基于最后交付源码，保留原故事和版本，修改用户指定部分及直接回归，不全片提升建模质量。网络中断保留最后有效候选，既有问题注明未复核；不让源码修复解决网络。工程600秒是软目标，单调用故障与总耗时分别记录，不为指标伪造通过。

计数分开：`repair_requests`（发起即计数，包括调用失败）、`repair_candidates_compiled`（修复后成功编译候选）、`selected_candidate`（实际采用）、`stop_reason`。旧`repairs`仅保留兼容，不再独立用作真实请求次数。请求/响应/图像/工具在trace，耗时在diagnostics，接口实际返回的thinking/签名按原样留存，不补造缺失CoT。

## 验证与更新

完整三案采用原始输入和参考，独立新生成，不以旧工程回放替代。验证工程结构、全视频解码、关键帧、统一人物与移动风险，性能采用工程扣实测上传且视频另计。运行 `SEKO_TEST_RELEASE=seko-0.1.15-cvw.1 python scripts/check-seko.py`；定向测试包括 motion-human、rigid-limbs 和 repair_policy。实验报告放宿主runtime，不进入发行包或Git。

版本变化：0.1.13允许简单无肢体人物，首稿固定最多2修复；0.1.14首次固定七部件、默认安全姿态/朝向、增加运动穿越证据、重复语义问题提前停止，并首次独立冻结system策略。只有实际三案完成后才记录性能/质量结论。

0.1.15基于0.1.14实测修正：问题文字/ID变化不能使同一已失败镜头再次获得修复；结合前次core结果、稳定focus身份及实际新增穿越证据判断。初稿技术结构失败先修复，不进行无效全片语义复审。旧候选0.1.14三案记录保留作问题证据，不覆盖。


0.1.16 acceptance boundary: static holding/standing/sitting/support intersections and rough contact are allowed while the coarse relation remains readable. No repair for grip precision, gait or fine poses. Clear root travel through a solid obstacle, wrong route/destination, significant ownership drift, wrong facing/POV or hidden key result remains reviewable. These quality findings never prevent last-renderable delivery and never extend the existing correction cap. Contact distances are advisory; co-moving props are not stationary path obstacles. Technical, coarse quality, allowed detail and provider failure are reported separately. Ordinary stories do not acquire Seko segment/shot obligations they never requested.

## 0.1.17 targeted changes

- Clear ordinary stories without specified duration are timed in the existing intake call (0 < total <=300s). Explicit timing and verbatim user text stay authoritative; nonessential ambiguities resolve conservatively and are reported with the video; unusable input/contradictory mandatory timing fails explicitly without waiting for a reply. Generated English shot-marker normalization is deterministic and preserves raw decisions.
- Optional contact citation errors become unavailable diagnostic entries, not failure of otherwise valid shot/image review. Missing shots, invalid JSON or invented image references still fail the contract. No extra review call.
- Second correction receives only new/regressed or technical recovery targets; previously attempted semantic findings are recorded read-only. Initial two/follow-up one correction caps stay unchanged.
- Authoring emphasizes shared movement for carried furniture, continuous release transforms, event-time framing and positive visibility evidence. No new rigs, physics, extra review rounds or expanded evidence budget.

## 0.1.18 — bounded output recovery and shot-heading parsing

- Shot parsing distinguishes narrative references from actual headings, while retaining explicit timed inline storyboards. Original prompt text and hard timing remain immutable; genuine duplicate headings still fail.
- Confirmed output-token exhaustion before any renderable candidate can trigger one compact complete-module recovery. It consumes an existing correction slot, uses low effort, retains all original shots/references, and never compiles truncated text. Opus may use the verified 64K output cap for this recovery only; other model families keep the configured cap. It is not an extra review loop.
- Once a renderable candidate exists, truncated review/repair preserves it with unresolved diagnostics. Transport errors, context errors and ordinary malformed JSON do not enter output-limit recovery. Follow-up one-correction and initial two-correction limits remain unchanged.
- Frozen older releases retain their incomplete-output behavior. Actual request cap, original incomplete response, recovery decision, system/skill and separate timing diagnostics remain auditable.
