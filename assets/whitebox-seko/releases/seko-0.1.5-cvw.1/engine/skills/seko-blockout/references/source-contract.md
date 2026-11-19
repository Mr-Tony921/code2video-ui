# Executable source contract · 0.1.0

Return ONLY a complete JavaScript ES module exporting `async function buildScene({THREE,scene,camera,helpers,task})`. No markdown, fetch, imports, external assets, timers, DOM access or requestAnimationFrame. All animation is compiled to deterministic absolute-time tracks, not incremental frame code. Three.js 0.180.0 is injected. No web requests are needed. Use finite numbers and moderate geometry (low-poly, no shadows/physics needed).

`task` is the exact normalized work: duration seconds, work_prompt, segments with id/start/end/duration/prompt/shots. Each shot has id (`shot_001`...), source_number, prompt, explicit_duration (or null). Images arrive separately in the same model request, labelled reference_1 etc. Coordinate system: meters, Y up; rotations in **radians**, camera FOV in **vertical degrees**. Humans face +Z before yaw. Primitive helper positions are **geometric centers**; group/person positions are floor anchors.

## Geometry

- `helpers.group(id, ChineseName, position=[0,0,0], parent=scene)` → registered THREE.Group. Use stable unique IDs. Do not register the same ID for two objects. All animated objects must be registered.
- `helpers.box([w,h,d],[x,y,z], color, parent=scene)` → Mesh, center at given position.
- `helpers.sphere(radius,position,color,parent=scene)`; `helpers.cylinder(radius,height,position,color,parent=scene)` (axis Y).
- `helpers.bar(pointA,pointB,radius,color,parent=scene)` joins two local points with a cylinder.
- `helpers.material(color)` → MeshStandardMaterial. Native Three.js primitives/Groups are also supported. Do not create textures/shaders requiring external files.
- `helpers.person(id,name,position,{height:1.75,color:'#bbc1c6',yaw:0,pose:'stand',detail:'simple'})` → registered Group. Built-in initial poses: stand/sit/crouch/kneel/lean; a non-standing pose has cheap limb silhouettes. `detail:'articulated'` gives limbs without gait. It also registers `<id>_head`, `<id>_body` and (when limbs are used) `<id>_left_hand`, `<id>_right_hand`; these are valid track IDs. You can obtain these with `helpers.registered.get(id).object`. Simple extras remain simple. For an actual posture transition, animate these groups or construct your own minimal pivots with group; never assume a textual pose label animates itself.

Build recognizable environment boundaries rather than an endless floor. Complex settings can use repeated low-poly parts. Give required small props meaningful silhouettes; use closer inserts rather than giant props. Geometry can use muted identity colors.

**Return-type discipline (especially DeepSeek):** `const actor=helpers.person(...)` is the Group itself: use `actor.add(mesh)` and `actor.position`, NEVER `actor.object`. Only `helpers.registered.get(id)` returns an entry with `.object`. The built-in Group does not return custom fields such as `.root`, `.head`, `.body` or `.hands`.

`helpers.makeShotPlan(...)` returns the flat **array** itself: use `plan[i]`, `plan.length`, `plan.map(...)`, NEVER `plan.shots`. Prefer material colors and existing simple geometry for character identity. If adding hair/hat/apron is actually useful, parent it to the real head/body anchor and derive local position from that pose; never place it at a memorized standing height on a seated actor. Omit extra detail if it could hide a face or create floating shapes. Concise loops and tables are preferred over rebuilding helpers or verbose custom rigs.

Runtime compatibility patch: `.object` on registered Groups and `.shots` on the returned plan array are tolerated aliases. New sources should use the canonical forms above. These aliases only normalize the same object/array, never modify geometry or fill missing story content.

**Anchor-based framing:** `helpers.worldPosition(id, localOffset=[0,0,0])` returns the actual initial world `[x,y,z]` for any registered group/anchor. For a seated close-up, derive its target from `helpers.worldPosition(actorId+'_head')`; do not aim at an assumed standing eye height. Poses change actual head height. A +Z-facing person's front camera is on their +Z side before yaw. For later movement add the same displacement/rotation to camera targets as to the actor; initial anchor lookup does not evaluate future tracks. Use the actor's yaw and actual furniture occluders to place front/side/over-shoulder cameras, then inspect evidence. Parent props to real registered anchors.

## Business shot plan

Call `const plan=helpers.makeShotPlan(durations)` where durations is **an array per segment, each containing that segment's shot durations**. This assigns immutable source shot IDs/segment IDs and absolute times. Every unspecified duration must be chosen; all explicit durations are checked. If every source shot has explicit duration, `helpers.makeShotPlan()` is sufficient. This does not create camera animation or infer actions.

## Absolute animation

For an explicitly requested close-up or prop insert, add a small `focus` array to that business shot in the plan: `plan[i].focus=[{entity_id:'actor_head',time:(plan[i].start+plan[i].end)/2,front:true}]`. Use the real head/prop anchor, not the actor's floor root. `front:true` means the actual +Z facial direction must face the camera; omit it for props, profiles, backs or overhead inserts. For a multiphase shot choose a time in the requested close-up phase; no check is needed for intentional entry/exit before/after that phase. This is a declared instruction check, never generic auto-framing. The tool measures projection and opaque occlusion at those points and reports factual framing errors. It cannot prove all-time visibility or replace visual review. Do not suppress a required check to hide a failure. Wide/establishing/intentional obscured shots may use no focus checks.

```js
const anim=helpers.createAnimationRegistry({duration:task.duration});
helpers.track(anim,'actor_id','position',[[0,[0,0,0]],[5,[0,0,0]],[8,[2,0,0]],[task.duration,[2,0,0]]]);
helpers.track(anim,'actor_id','rotation',[[0,[0,0,0]],[8,[0,Math.PI/2,0]]]);
helpers.track(anim,'prop_id','visible',[[0,false],[6,true]],'step');
```

Supported properties: position, rotation (Euler XYZ), quaternion, scale, visible (boolean/step), fov, lookAt (world xyz), roll (camera radians), opacity. Keys are `[absolute_seconds,value]`; properties interpolate linearly unless 'step' or 'smooth' is specified. Values hold before first/after last key. Therefore **add explicit hold keys before a delayed action**, not only an endpoint, or motion will start too early. For a real scene/time jump use a step key. All key times must be within the story. Parent-local tracks follow the parent. Child positions must not mix world and local coordinates. No duplicate channels that accidentally overwrite one another.

For held/released objects, a simple robust representation is one held group under the carrier and one world group for the placed state, with complementary visibility at the same time. Give them a shared logical label; retain a clear ownership explanation. Do not show both simultaneously or animate a parented child's position with world coordinates. Native attach during construction is supported; dynamic reparenting is not a track property.

## Camera timeline

Call `helpers.cameraTimeline(anim, cameraShots)` once. Each cameraShot: `{id,start,end,keys:[{time,position:[...],target:[...],fov:45,roll:0},...]}`. Times absolute; keys cover start to end. This helper records `camera_shots` in the registry, supplies boundary hold keys and separates cuts. Use the plan's times/IDs; a business shot may have several cameraShots with sub-IDs, all staying inside that business shot. Adjacent camera intervals must cover 0..duration without gaps.

Author numeric target points matching actual object positions/heights at each key. Use multiple keys for curved/multiphase movement. Follow/POV requires moving camera and target with the subject. A fixed camera stays fixed even when actors move. Camera rotation can replace target in **all** keys when needed, but do not mix target and rotation modes across the same timeline. Roll is optional. Do not apply unrelated global auto-framing.

## Return

```js
return {
  version:1,
  entities:[...helpers.registered.values()],
  animation:anim.build(),
  animationRegistry:anim.describe(),
  shot_plan:plan,
  reference_usage:[{reference_id:'reference_1',objects:['registered_id'],observed:'具体看到的结构',implemented:'对应几何/空间',uncertainty:'若有推断'}],
  notes:['实际省略的表演细节；其他必要限制']
};
```

Legacy helpers `planScene`, `registerActor`, registry `data/program/bind` are available for compatible sources; normal new generation should prefer direct tracks and cameraTimeline. Avoid recreating the whole helper library in model output. A short generic procedural loop for repeated props is welcome; do not collapse different narrative camera shots into one repeated viewpoint merely to save code.

**Prevent avoidable repairs:** Declare IDs once and reuse those constants for groups, tracks, focus and reference usage. A JavaScript variable name is not an entity ID. Use `const headPosition=helpers.worldPosition(id)` for numeric camera targets; use a distinct `headGroup=helpers.registered.get(id).object` only for parenting. For every location jump, move or instantiate all required companions/props with explicit visibility and logical ownership. Do not leave a car or held object at the previous location. Keep large occluders and effect shells away from the required face/prop viewing ray; smaller support silhouettes can preserve an action without burying its subject.
