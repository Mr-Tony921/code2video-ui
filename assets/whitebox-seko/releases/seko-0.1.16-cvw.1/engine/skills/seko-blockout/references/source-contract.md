# Executable source contract · 0.1.0

Return ONLY a complete JavaScript ES module. Start with `export async function buildScene({THREE,scene,camera,helpers,task}) {` and close that function after its final return object. Do not omit this function envelope. No markdown, fetch, imports, external assets, timers, DOM access or requestAnimationFrame. All animation is compiled to deterministic absolute-time tracks, not incremental frame code. Three.js 0.180.0 is injected. No web requests are needed. Use finite numbers and moderate geometry (low-poly, no shadows/physics needed).

`task` is the exact normalized work: duration seconds, work_prompt, segments with id/start/end/duration/prompt/shots. Each shot has id (`shot_001`...), source_number, prompt, explicit_duration (or null). Images arrive separately in the same model request, labelled reference_1 etc. Coordinate system: meters, Y up; rotations in **radians**, camera FOV in **vertical degrees**. Humans face +Z before yaw. Primitive helper positions are **geometric centers**; group/person positions are floor anchors.

## Geometry

- `helpers.group(id, ChineseName, position=[0,0,0], parent=scene)` → registered THREE.Group. Use stable unique IDs. Do not register the same ID for two objects. All animated objects must be registered.
- `helpers.box([w,h,d],[x,y,z], color, parent=scene)` → Mesh, center at given position.
- `helpers.sphere(radius,position,color,parent=scene)`; `helpers.cylinder(radius,height,position,color,parent=scene)` (axis Y).
- `helpers.bar(pointA,pointB,radius,color,parent=scene)` joins two local points with a cylinder.
- `helpers.material(color)` → MeshStandardMaterial. Native Three.js primitives/Groups are also supported. Do not create textures/shaders requiring external files.
- `helpers.person(id,name,position,{height:1.75,color:'#bbc1c6',yaw:0,pose:'stand'})` → registered Group. All humans including extras use this helper's seven primitives: sphere head, box nose (+Z), cylinder torso, two cylinder arms and two cylinder legs. `pose:'sit'` gives a coarse fixed-length sitting silhouette; other optional poses fall back to normal stand. Historical `detail` is ignored; no single-cylinder people. Root position is a floor anchor. It registers `<id>_head`, `<id>_body`, `<id>_left_arm`, `<id>_right_arm`, `<id>_left_leg`, `<id>_right_leg`, and invisible `<id>_left_hand` / `<id>_right_hand` anchors. Use `helpers.registered.get(id).object` for parenting.
- `helpers.yawTo(fromXYZ,toXYZ)` returns a numeric Y yaw in radians for local +Z facing. Use it for interlocutor/target facing.
- `helpers.moveActor(anim,id,[[time,[x,y,z]],...],{faceTravel:true})` adds position and travel-facing keys. Author clear waypoints; this does not find paths or avoid solids automatically. Use absolute times, explicit holds, and matching parent-local coordinates. After arrival you may add an explicit rotation toward the interaction partner. Do not add another conflicting position/rotation channel for the same interval.

Use the shared human helper without extra anatomy. No hair, hats, crowns or clothing decorations. Keep any functional limbs and contact anchors needed by the story. Each ordinary logical prop should usually use no more than three visible primitives, with small justified exceptions for essential structure. Use sparse environment boundaries/landmarks and restrained identity colors. Close framing can make a small essential prop readable without a detailed mesh. Before returning, check every track target, focus ID and camera_plan subject against registered IDs; never use a Chinese display name as a track target unless that is its actual registered ID.

**Return-type discipline (especially DeepSeek):** `const actor=helpers.person(...)` is the Group itself: use `actor.add(mesh)` and `actor.position`, NEVER `actor.object`. Only `helpers.registered.get(id)` returns an entry with `.object`. The built-in Group does not return custom fields such as `.root`, `.head`, `.body` or `.hands`.

`helpers.makeShotPlan(...)` returns the flat **array** itself: use `plan[i]`, `plan.length`, `plan.map(...)`, NEVER `plan.shots`. Prefer material colors and existing simple geometry for character identity. Only if the user specifically requires an identity-defining accessory, parent the minimal proxy to the real head/body anchor and derive its local position from that pose; do not add decorative accessories by default or place them at a memorized standing height on a seated actor. Omit extra detail if it could hide a face or create floating shapes. Concise loops and tables are preferred over rebuilding helpers or verbose custom rigs.

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

Supported properties: position, rotation (Euler XYZ), quaternion, scale, visible (boolean/step), fov, lookAt (world xyz), roll (camera radians), opacity. Position/rotation/scale/lookAt values must each be numeric 3-element arrays; quaternion needs 4 elements. In particular a rotation key is `[time,[rx,ry,rz]]`, NEVER `[time,angle]`; use explicit Euler vectors for repeated prop motion, not a custom iterable workaround. Keys are `[absolute_seconds,value]`; properties interpolate linearly unless 'step' or 'smooth' is specified. Values hold before first/after last key. Therefore **add explicit hold keys before a delayed action**, not only an endpoint, or motion will start too early. For a real scene/time jump use a step key. All key times must be within the story. Parent-local tracks follow the parent. Child positions must not mix world and local coordinates. No duplicate channels that accidentally overwrite one another.

For held/released objects, a simple robust representation is one held group under the carrier and one world group for the placed state, with complementary visibility at the same time. Give them a shared logical label; retain a clear ownership explanation. Do not show both simultaneously or animate a parented child's position with world coordinates. Native attach during construction is supported; dynamic reparenting is not a track property.

## Per-shot camera recommendation (Camera A1)

Every original `plan[i]` must have a JSON-compatible `camera_plan` before return:
`{motion:false,purpose:'static',reason:'双人对白稳定同框',subjects:['actor_head','held_prop']}`.
For necessary motion use `motion:true` and purpose `follow`, `reveal`, `spatial_relation`, or `user_locked`; give a short concrete reason stating what becomes visible or why following is needed. Keep the reason within about 24 Chinese characters / 16 English words. `subjects` contains 1–4 actual registered IDs of the necessary visible subjects, not a new cast or decoration list; one environment landmark is valid for an establishing view. This recommendation belongs to each shot's metadata and must agree with its actual camera keys. Do not copy the same moving-camera reason across unrelated shots. No separate planning response is required: return the complete source once, including these fields.

For a static shot, use identical numeric position/target/FOV/roll at its start and end. A camera following a changing target is not static. For necessary motion use the smallest adequate path; a pair of endpoints (and a reveal/turn key if needed) is usually sufficient. Keep the original shot's duration and framing purpose. Short code/tables are welcome, but do not collapse differing narrative shots into one generic viewpoint. Static-first is a selection preference, not a ban on story-essential camera motion.

## Camera timeline

Call `helpers.cameraTimeline(anim, cameraShots)` once. Each cameraShot: `{id,start,end,keys:[{time,position:[...],target:[...],fov:45,roll:0},...]}`. Times absolute; keys cover start to end. This helper records `camera_shots` in the registry, supplies boundary hold keys and separates cuts. Use the plan's times/IDs; a business shot may have several cameraShots with sub-IDs, all staying inside that business shot. Adjacent camera intervals must cover 0..duration without gaps.

Author numeric target points matching actual object positions/heights at each key. Use multiple keys for curved/multiphase movement. Follow/POV requires moving camera and target with the subject. A fixed camera stays fixed even when actors move. Camera rotation can replace target in **all** keys when needed, but do not mix target and rotation modes across the same timeline. Roll is optional. Do not apply unrelated global auto-framing.

## Return

Register the camera array before `anim.build()`. Merely constructing a camera array does not animate the camera. Use your actual authored variable name (the example calls it `cameraShots`); do not call `anim.build()` early or omit `cameraTimeline`.

```js
helpers.cameraTimeline(anim, cameraShots); // the actual array authored above
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

All human actors use `helpers.person`. A genuine pet/nonhuman actor may use a simple custom group with `root.userData.nonhuman=true` before `registerActor`; this is not an exemption for background humans. The compiler enforces the human helper and uniform static ancestor scale for newly authored projects. Frozen old projects keep their original replay.

**Prevent avoidable repairs:** Declare IDs once and reuse those constants for groups, tracks, focus and reference usage. A JavaScript variable name is not an entity ID. Use `const headPosition=helpers.worldPosition(id)` for numeric camera targets; use a distinct `headGroup=helpers.registered.get(id).object` only for parenting. For every location jump, move or instantiate all required companions/props with explicit visibility and logical ownership. Do not leave a car or held object at the previous location. Keep large occluders and effect shells away from the required face/prop viewing ray; smaller support silhouettes can preserve an action without burying its subject.

Every human uses the uniform helper, irrespective of name, importance or shot. A fixed small representation avoids expensive model-generated rigs. Keep normal stand/sit and relaxed arms when optional action is difficult. Do not freeze a reach for the rest of the story. Preserve identity across pose variants and make their visibility complementary.

## Reliable local motion and ownership

- `helpers.attachProp(propId,anchorId,offset=[0,0,0],rotation=[0,0,0])` parents a registered prop to a registered hand/body anchor using explicit LOCAL coordinates. Use coarse contact/intersection rather than a distant preserved table-world offset. It is authoring-time parenting, not animated reparenting. For release/handoff use held/released variants with complementary visibility and a shared coarse event location. Preserve the owner relationship; exact grip or surface alignment is unnecessary.
- `helpers.actorTimeline(anim,id,clips)` accepts ordered non-overlapping clips `{start,end,points:[[x,y,z],...],faceTravel:true,lookAt?:[x,y,z]}` in parent-local coordinates. One point is a hold; several are a uniform-time polyline. Travel faces its next waypoint unless `faceTravel:false`; `lookAt` locks facing toward an interaction target. Every clip ends in a step hold, so a next scene's position cannot pull the actor through the old location. Discontinuous clips are ONLY for actual cuts/time resets. Same-scene movement clips must connect; provide separate clips when a waypoint needs non-uniform timing. Do not combine this with competing root position/rotation channels.

In the same authoring call plan few coarse corridors and open passages before camera positions: start, doorway/obstacle corner, destination, and floor height at each. Use sparse wall pieces outside the corridor. On a ramp, the floor-anchor Y follows its coarse top surface; do not bury the root in a solid slope. No navmesh, physics, gait cycle or sub-centimetre collision solver is required. Verify camera targets against the actor/prop position at that shot/event time, not initial construction coordinates. A stable shot can crop incidental people, but not its necessary result.

## Clear travel and openings

Define empty corridors and actual door/rail gaps before placing simple walls and furniture. Build walls around an opening from separate boxes; never cover the opening with a wall mesh or closed door. Give the person's body width clearance. Use a few waypoint keys around solid corners; simple linear A-to-B keys cut corners and cross obstacles. A door must be open before crossing begins. Preserve a required obstacle instead of hiding it to satisfy checks. Ground/support stays under the actor; a floor-anchor height change is not a crouch. For real scene/time cuts use step position changes, with consistent companion/prop state. No physics or walking cycle is needed.

## Source correction transport

For an existing module, follow the current call’s numbered-line edit schema. Line labels and source SHA are transport metadata, not JavaScript. Preserve unrelated lines and original shot IDs/times. The host validates all ranges and SHA before applying the atomic batch; stale, overlapping or invalid edits leave the current source intact. Full compilation and review still follow. This does not add a correction turn or change follow-up memory.

## Rigid limbs and held props

`helpers.person(...)` uses one fixed cylinder per arm/leg. Registered `<id>_left_arm` / `_right_arm` are shoulder pivots; `_left_leg` / `_right_leg` are hip pivots. Their Y-down cylinders rotate about the joint. Animate only pivot `rotation` or `quaternion`, with radians; e.g. arm rotation `[-Math.PI/2,0,0]` reaches forward along actor +Z. Keep poses sparse. No elbow/knee rig or walking cycle is necessary.

`<id>_left_hand` / `_right_hand` are child anchors at the arm endpoint, without visible hand geometry. **Do not animate their position or scale.** Parent a held prop to that hand with a small local offset. Root movement and arm rotation carry it automatically, with fixed limb length. The compiler rejects pivot translation/scale and hand translation/scale instead of making elastic arms. Do not nonuniformly scale an animated person. Use `height` for initial proportions.

For reaching, move/turn the whole actor into range and rotate the arm; the helper does not solve IK or infer the prop position. If a requested action needs a bent limb, a readable held pose or simplified result is sufficient unless the bend changes the plot. Body/head initial positions depend on pose; derive actual anchors rather than assuming standing height. Preserve support at seating/crouching endpoints; avoid lowering a standing torso through a table.

For placing/dropping/handing off, use held and resting/receiver variants with complementary visibility at one shared absolute event time. At the switch, their **actual world position and orientation must match**; use the same event transform calculation for both. A parent's local offset is not a world position. Compute arm/actor transforms at the event, not only at construction time. Inspect the event frame and the next state. If contact would require a stretched limb, move the actor/prop support closer or simplify the nonessential pose. Old serialized v1 arm links keep their frozen replay behavior; newly generated helper people use this rigid contract.
