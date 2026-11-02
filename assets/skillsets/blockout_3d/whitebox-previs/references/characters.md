# Whitebox characters: rigs, motion and contact

Use for platforms, courtyards, chases, driving and other character scenes. The goal is readable performance and blocking, not realistic anatomy, fingers, facial animation or cloth simulation. Implement the requested actions without adding plot or close-ups merely to demonstrate a rig.

## Modeling and joints

- Keep height, limb lengths and identifying features stable. Restrained gray values, simple hair or clothing can distinguish actors. Do not hide every leg movement with clothing, or violate the requested costume to expose legs.
- Use `motionRoot(world position, yaw) → pelvis/body → shoulder/hip → elbow/knee → wrist/ankle`, with separate neck and head nodes. Grounding follows leg length and hip height; burying the model is not a fix.
- Put shoulders and hips on either side of the torso. Rotate limbs around joint endpoints; offset capsule meshes by half a segment length. Rotating around capsule centers disconnects joints. Inspect a neutral pose and a bent-knee pose.
- Local +Z is forward, +Y up, and X spans the sides. Provide a visible forward cue through nose, chest or toes. Appearance nodes must not change joint axes or lengths.
- Swing shoulders and hips around local X. Knees bend plausibly in the forward/back plane. Alternate legs with opposite arms, retaining the same local axes after a turn.

## Walking, running, stopping and sidestepping

- Root nodes control translation and facing; the skeleton controls pose. In ordinary forward travel, nose and toes follow horizontal velocity. A guard deliberately sidestepping may face an opponent; do not apply that rule to normal running.
- Drive gait phase from accumulated travel distance. Match stride and cadence to speed. Decelerate into a stable contact phase; stop the walking cycle once stationary.
- Where feet are visible, define stance and swing phases: a planted foot maintains its world contact while the other lifts, advances and lands. Two-bone IK is optional; constrain reach and knee bend plane to avoid singularities and flips. Distant simplified gaits must still avoid obvious sliding, floor penetration and sideways running.
- Running may include flight phases. Modest body and clothing movement can help readability, but strong bouncing cannot hide foot sliding. Inspect the last step and settled state, not just steady-speed midpoints.

## Head turns, gaze and hand actions

- A reaction to footsteps needs visible head orientation change. Use nose or hair cues if there is no face. Share large turns between head, shoulders and body. Define a world gaze target, then convert into parent-relative rotation without applying root yaw twice.
- Structure hiding, blocking and warning actions as preparation → execution → arrival → brief hold. Sample the same world action across cuts; do not restart it when a close-up begins or crowd out a required event.
- Distinguish world targets from parent-local coordinates. Use `parent.worldToLocal` for a hand under the actor; scene-level hands use world coordinates. Keep shoulder, elbow and wrist connected when reaching.
- Attach props with a fixed grip offset. Steering-wheel grip targets receive the wheel transform once. Do not rotate an already transformed world target again. Derive attachment transitions from absolute time so out-of-order seek remains consistent.

## Evidence proportional to the task

Use existing rough-cut samples rather than launching a separate render for every rule.

| Requested action | Inspect | Useful evidence |
|---|---|---|
| Walk/run | Facing, alternation, knees, ground contact | Side-view frames spanning a gait cycle |
| Decelerate/stop | Final step and stable rest | A short sequence across the stop |
| Look back/turn | Head–shoulder order, gaze, neck range | Before, during and after; head-and-shoulders framing if present |
| Carry/hide a prop | Connected arms, grip, intended occlusion | Contact sequence rather than one attractive still |
| Sidestep to block | Chest direction and lateral step | Full-body two-shot and final positions |

Optional diagnostics include planted-foot drift, relative head angle and hand–prop distance. Set tolerances by actor scale and screen size rather than universal millimeter thresholds. Forward, reverse and repeated evaluation at the same time must agree. Mark unseen feet or grips as unverified; a correct still does not prove a correct gait.

Fix shared coordinates, joint hierarchy or contact targets before per-frame patches. Do not hide broken anatomy by repeatedly changing cameras. Prioritize errors that obscure the action and keep appearance at whitebox fidelity.
