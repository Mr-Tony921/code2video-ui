# Review rough story outcomes

Read ORIGINAL_TASK, executable tracks/parent bindings, technical checks and every supplied image/reference sheet. Inspect exactly CURRENT_REVIEW_SCOPE. An authored camera_plan is intent, not proof. Finite samples cannot certify all frames.

## What warrants a correction

For each original shot, identify the minimum story/spatial result needed to understand this shot and its continuation. Repair a demonstrated contradiction: an absent/offscreen necessary subject, wrong location/direction/POV, unreadable key action result, wrong event/segment timing, visibly detached owned/supported prop, failed arrival/rescue, premature reveal, or a plot-critical state such as seated versus standing or carrying versus dropping. Judge the actual event time and moving endpoints. Prefer sparse positions and state changes; realistic motion is unnecessary.

Small incidental arm-angle differences, greetings/nods, repeated walking/mining/fighting gestures, facial expressions, subtle eye gaze, costumes, lighting polish, smooth camera motion, physically exact contact and small harmless intersections are optional. A passing story shot does not fail merely because one of these details appears in the original prose. Keep the original requested framing/POV and meaningful camera movement, but do not upgrade cinematography. A pose becomes essential when the plot/spatial outcome depends on it; the mere presence of an action verb does not make it essential. Record omitted detail as a simplification/warning, without requesting a patch.

Distinguish omitted anatomy from harmful geometry. Every human must use the uniform seven-part helper; visibly elongated limbs or a held object jumping between distant endpoints can destroy readable ownership and are not fine acting. Static torso/seat/table intersections are allowed if the person and coarse pose remain readable; reject disappearance or an unreadable story outcome, not intersection depth itself. Check these at the decisive contact/transfer and moving endpoints. Fix by restoring fixed-size cylinders, removing unnecessary limb motion or adjusting actor/support placement, not by adding a detailed rig. Minor silhouette overlap remains acceptable. Never infer correct holding solely from a parent binding when the visible offset is remote.

For a real missing result, explain in `problem` what story/spatial outcome is unreadable or contradicted and propose its smallest local fix. Group the actual causes in the same bounded correction; do not fix unrelated details, rewrite the story or add geometry for polish. Use an appropriate fixed/follow view or local cutaway of an optional occluder. Preserve necessary environment, actors, supports, timing and geography. Do not erase required objects or make them transparent to pass.

## Evidence and coarse contact

Use images, actual tracks and `entities.parent_id` together. Parent IDs are registered scene hierarchy, not names or an authored claim. A correctly bound prop travelling visibly with its owner can support ownership without a separate pair/time receipt. Binding alone is not enough if the offset is visibly remote, the object drifts, or it is hidden. Continuous prior evidence can establish ownership for a deliberate close-up; do not demand every context cue again.

`opaque_aabb_gap` and the historical `coarse_contact_tolerance` are diagnostic geometry, not acceptance thresholds. Static holding/standing/sitting/support may intersect or have approximate gaps. Do not demand centimetre-level contact or spend a source correction on it. Assess actual ownership/support readability, relative drift over time, meaningful facing and critical visibility. A prop progressively separating from its owner, swapping to the wrong owner, or a body moving through a solid barrier is actionable; a fixed rough grip is not. AABB separation alone cannot distinguish these. The host records cited distances without automatically overriding `core`. Do not turn this into automatic acceptance: genuinely remote ownership, an absent support relationship or insufficient decisive evidence remains missing/uncertain as appropriate.

Use `contacts` only for plot-relevant pairs supported by the actual geometry table, citing its exact IDs and sampled times at the relevant event. For holding, cite the held portion, not only a later table landing. If a pair is absent, use `[]` and assess any available image/binding/track evidence; missing a redundant audit row is not a scene defect. If the necessary result genuinely remains unestablished, mark `uncertain`. Do not fabricate pairs/times or change geometry just to obtain proof. The host validates evidence IDs/times and records raw gaps; it does not infer a quality verdict from contact precision.

`world_root_transform_constant_over_shot:true` proves that body root and ancestors do not move through the full shot, including interior keys. It does not prove child poses, visible variants or cameras are fixed. A required entry/exit/arrival needs a visible state transition, not just a stationary endpoint-looking pose. Distinguish intentional pre-reveal concealment from missing post-reveal subjects; a deliberate prop insert or POV may crop people.

## Output and stopping

Return one row for every scoped original shot:

- `core: met`: the necessary coarse story/spatial result is supported. Optional omissions use `simplification: appearance|fine_acting|decorative_camera` and a concise warning; otherwise `none`.
- `core: missing`: a demonstrated necessary result is absent, contradicted or hidden. Add an evidence-backed local issue; optional details do not belong here.
- `core: uncertain`: necessary evidence is insufficient. Explain exactly what is unconfirmed. This is not a quality pass and must not trigger a source correction.

```json
{"seen":["sheet filename"],"shots":[{"id":"shot_001","requirement":"必要的粗剧情/空间结果","observed":"实际证据支持的结果或具体缺陷","core":"met|missing|uncertain","simplification":"none|appearance|fine_acting|decorative_camera","evidence":["sheet filename"],"contacts":[{"a":"actual id","b":"actual other id","times":[1.001]}]}],"issues":[{"shot_id":"shot_...","requirement":"必要结果","evidence":["sheet filename"],"problem":"具体矛盾及其剧情/空间影响","fix":"最小局部修正"}],"warnings":["可选细节或粗略近似"],"summary":"中文结论"}
```

List every supplied page in `seen`, each scoped shot exactly once, and only actual evidence names. Keep passing observations short. The host derives verdicts; missing/uncertain core cannot be disguised as quality pass. Review protocol errors or unavailable images are incomplete evidence, not source defects. Do not invent acceptance.

Report all demonstrated core problems together in the first review. Later reviews concentrate on changed and previously unresolved results; do not reopen an accepted coarse result for cosmetic detail. Review stays low effort; actionable correction stays high. Initial draft plus at most two corrections; follow-up edit plus at most one. Preserve the last renderable candidate and unresolved findings at the limit. No extra evidence-only correction, model call, beauty pass, audio or subtitle work.

## Review after a local correction

Re-review the changed shots and every unresolved core finding. Inherit an unchanged shot's previous finite-sample assessment when its core requirement was met; an accepted optional simplification alone does not reopen it. Retain the original uncertainty and evidence provenance. The harness compares actual supported animation curves, changed samples, metadata and visibility to find affected intervals; shifted redundant keys or an unchanged held tail are not story changes. Unknown dependencies/formats and global timing/reference changes remain conservative. The original correction limit still applies; do not start a second full-story review or a new beautification loop.

## Movement, neutral posture and bounded second repair

Check the same seven-part human silhouette for all people. A normal stand/sit is preferable to broken optional action. An arm held out indefinitely without carrying/supporting, an actor facing away from the partner during interaction, or facing backwards along a travel path is not an acceptable neutral posture. Simplify the offending motion locally, without adding choreography.

Read `motion_audit` and event frames alongside the original story. A clear root travel route through a solid wall, closed door, rail or furniture is high-priority. Edge grazing and static contact intersections are accepted proxy details. Co-moving props must not be counted as stationary barriers. Its geometric finding is not an all-frame verdict: check the actual frame, actor identity, obstacle and timing; a legitimate scene cut, intended prop contact, or conservative cylinder bound must not be mistaken for walking penetration. Review actual openings, door state and intermediate route, not only destination. Minor stationary silhouette overlap can remain.

Give each actionable issue a stable `problem_id` (shot + cause + involved entity IDs), `issue_type` (visibility|motion_crossing|ownership|support|posture|facing|human_contract|story|timing) and `entity_ids`. When CURRENT_PREVIOUS_FINDINGS describes the same unresolved cause, reuse its problem_id exactly even if wording changes. New regressions get new IDs. Do not rename a persistent issue to obtain another correction. These are semantic identities, not proof that the defect exists.

After the first repair, if the remaining blockers are all previously attempted and there is no new defect, stop and disclose them. Do not spend a second request merely on the remaining 2 of 10 issues. If a second repair is justified by a new regression or broken render/structure, choose a simpler alternative (neutral posture, real opening/clear route, fixed ownership, smaller optional occluder), not a second elaborate attempt at the same action. Unresolved remains unresolved.

## Acceptance policy 0.1.16

Use three separate questions: (1) Can the host render the original timeline? (2) Are the coarse route, camera, ownership, facing and plot outcomes readable? (3) Which fine details were deliberately simplified? Category 3 is a warning/simplification, never a source repair. Quality issues in category 2 remain explicit but do not prevent packaging a renderable scene after bounded correction. Do not demand realistic grip, feet, gait, hand poses or static non-intersection. For Seko preserve its exact original shot/segment contract; for ordinary stories do not invent a stricter business shot contract. First review groups every demonstrated priority issue; after one attempt an unchanged old issue is disclosed, not repeatedly repaired. A server error is not scene evidence.
