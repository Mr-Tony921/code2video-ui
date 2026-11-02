# Facing, joints and contact

## Local coordinate convention

For authored actors and vehicles, use +Z forward, +Y up, +X right. World paths may follow any axis. Align imported models with a fixed correction group before animating. Camera forward is not model forward.

Use `motionRoot(position, yaw) → bodyRig(lean/roll) → joints/components`. For horizontal velocity `(vx,vz)`, root yaw is `atan2(vx,vz)`. Keep the previous travel-facing direction at a stop instead of computing a direction from zero velocity. Pose functions modify child nodes without overwriting path yaw. Evaluate directly from time, not by accumulating rotations from previous frames.

## Characters

Read [characters.md](characters.md) for rig, grounding, gaze and prop details. Apply only the actions actually in the film.

Shoulders and hips lie along ±X; nose and toes point +Z. Swing hips and shoulders about local X, alternating legs and opposite arms. Running may include flight. Place pivots at hip, knee and ankle; preserve plausible knee bends. Facing follows travel except deliberate sideways actions.

Drive phase by accumulated distance. Reduce stride and cadence during deceleration and stabilize support after stopping. Keep stance feet approximately fixed in world space while swing feet advance. Two-bone IK is optional. Swinging whole straight capsules from the hips alone produces scissor legs.

Inspect front and side samples: knees move forward, feet contact the ground and legs do not swing sideways. Measure stance-foot drift with scene-appropriate tolerances. Give the head a visible facing cue and compute gaze relative to body orientation without double rotation.

## Hands, letters, weapons and contact

Use shoulder → elbow → wrist → palm. Define palm orientation and match a reachable target; moving a disconnected palm or rotating only a wrist cannot fix the whole arm.

A held prop follows the hand's world transform and a fixed grip offset at the same time. Pickups, handoffs and releases need explicit contacts with continuous world transforms. Derive attachment state from time rather than order-dependent reparent events. Hiding a letter must follow a reachable hand path; a weapon grip contacts the hand and its direction follows the story.

Actions have preparation, execution, contact, settle and a brief hold. Add anticipation or overshoot only when appropriate. Sphere-headed warnings can use posture and gesture without detailed lip animation. An explicitly requested warning shot points into the air; do not invent a shooting injury.

## Vehicles

Vehicle forward is +Z and wheel axle is X. CylinderGeometry defaults to a Y axis: bake a PI/2 rotation about Z into wheel geometry, then roll an independent node about X. Use `body → steering pivot(Y) → wheel roll(X)` without overwriting one rotation with the other.

Wheel angle is signed accumulated travel distance divided by radius. Front-wheel steering follows the turn. Body yaw normally follows the path tangent; apply controlled slip angles only in designed drift intervals and restore alignment afterward. Reverse motion must have consistent rolling sign.

Inspect straight travel, turns and stops on simple ground before complex scenery. Corner-to-corner minimum distance does not prove cars do not intersect; use oriented planar rectangles or reliable bounds and inspect critical frames.

## Reusable vehicle components

Copy `scripts/whitebox-previs/vehicle-rig.mjs` from the code-video root to the task's `lib/vehicle-rig.mjs`, then import it from the page. Pass THREE into helpers to avoid mixed instances. The task server does not expose the skill directory.

`createWheelRig` uses +Z vehicle forward and an X axle, baking Y-to-X geometry alignment. Steering rotates about Y, rolling about X. Attach its root at the wheel center. Use side=±1 for outward markings rather than mirroring the entire rig with negative scale. Evaluate `setState(signedDistance, steeringAngle)` each frame. `bakeTravelDistance` precomputes signed distance; `speed(t)*t` is incorrect under acceleration.

`createSteeringRig` starts from a Torus in XY with Z normal. Its mounting node aligns Z with the real steering column; its spin node rotates around local Z. Use `setAngle` and `gripWorld(circumferenceAngle)` for matching hand targets, without a second transform. This assembly is distinct from front-wheel Y-axis steering.

Check actual geometry axes, mounting transforms and animation axes rather than comments. Correct legacy +X-forward models before using +Z-forward rolling rules. Helpers still require visual inspection.

`window.previsVehicleAudit()` exposes a read-only snapshot of scene-attached assemblies, world axes, angles, distances and grip queries. It does not drive or fix motion, and is not a substitute for visual evidence. Do not fabricate its results.
