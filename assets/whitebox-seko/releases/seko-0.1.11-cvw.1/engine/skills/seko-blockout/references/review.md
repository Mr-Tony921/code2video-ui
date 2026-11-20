# Review rough story outcomes

Read ORIGINAL_TASK, executable tracks/parent bindings, technical checks and every supplied image/reference sheet. Inspect exactly CURRENT_REVIEW_SCOPE. An authored camera_plan is intent, not proof. Finite samples cannot certify all frames.

## What warrants a correction

For each original shot, identify the minimum story/spatial result needed to understand this shot and its continuation. Repair a demonstrated contradiction: an absent/offscreen necessary subject, wrong location/direction/POV, unreadable key action result, wrong event/segment timing, visibly detached owned/supported prop, failed arrival/rescue, premature reveal, or a plot-critical state such as seated versus standing or carrying versus dropping. Judge the actual event time and moving endpoints. Prefer sparse positions and state changes; realistic motion is unnecessary.

Incidental arm positions, crossed arms, greetings/nods, repeated walking/mining/fighting gestures, facial expressions, secondary gaze, costumes, lighting polish, smooth camera motion, physically exact contact and small harmless intersections are optional. A passing story shot does not fail merely because one of these details appears in the original prose. Keep the original requested framing/POV and meaningful camera movement, but do not upgrade cinematography. A pose becomes essential when the plot/spatial outcome depends on it; the mere presence of an action verb does not make it essential. Record omitted detail as a simplification/warning, without requesting a patch.

For a real missing result, explain in `problem` what story/spatial outcome is unreadable or contradicted and propose its smallest local fix. Group the actual causes in the same bounded correction; do not fix unrelated details, rewrite the story or add geometry for polish. Use an appropriate fixed/follow view or local cutaway of an optional occluder. Preserve necessary environment, actors, supports, timing and geography. Do not erase required objects or make them transparent to pass.

## Evidence and coarse contact

Use images, actual tracks and `entities.parent_id` together. Parent IDs are registered scene hierarchy, not names or an authored claim. A correctly bound prop travelling visibly with its owner can support ownership without a separate pair/time receipt. Binding alone is not enough if the offset is visibly remote, the object drifts, or it is hidden. Continuous prior evidence can establish ownership for a deliberate close-up; do not demand every context cue again.

`opaque_aabb_gap` is measured in meters. Each sample's `coarse_contact_tolerance` permits a small proxy approximation: 5% of the smaller object's maximum opaque extent, capped at 0.02m. A gap within that tolerance must not by itself cause `missing` or a position fix. A cited essential pair separated beyond tolerance contradicts contact. Zero or tolerated gap is not proof of contact, since bounding boxes are only coarse bounds. Null/unavailable measurements are unknown. Never infer contact from vertical alignment alone or ask unrelated subjects to touch.

Use `contacts` only for plot-relevant pairs supported by the actual geometry table, citing its exact IDs and sampled times at the relevant event. For holding, cite the held portion, not only a later table landing. If a pair is absent, use `[]` and assess any available image/binding/track evidence; missing a redundant audit row is not a scene defect. If the necessary result genuinely remains unestablished, mark `uncertain`. Do not fabricate pairs/times or change geometry just to obtain proof. The host cross-checks supplied claims against measured tolerances; it never turns tolerated gaps into an automatic semantic pass.

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
