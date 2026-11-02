# Production, capture and evidence-based delivery

## Inputs and minimal artifacts

Use the supplied task directory, original request and video format. Keep all authored files and outputs inside the task. Default to no audio. The sandbox supplies dependencies through [runtime.md](runtime.md).

Write a concise SPEC.md with one row per requirement: ID, original requirement, fixed time/constraint and verification method. For example, a requested approach, interception and prop close-up become separate observable checks; examples are not story templates.

Distinguish user requirements from added director choices. An invented cockpit, reflection or crowded composition may be adjusted while preserving user intent. Do not turn every creative addition into an immutable acceptance requirement.

Record actual time ranges, shot sizes, actions, camera movement and cut states in shots.json. VERIFY.md records pass/partial/fail/unverified with actual video timestamps or image paths. A short review.md may reference VERIFY rather than duplicate it.

## Page contract

```js
window.renderFrame = async (t, width, height) => {
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  evaluateWorld(t);
  evaluateCamera(t);
  renderer.render(scene, camera);
};
window.previsReady = true; // Only after dependencies, fonts and assets are ready.
```

The renderer also accepts window.READY=true with async window.seek(t); that implementation must ensure the correct image dimensions. Seed random parameters at initialization. Bake simulations at a fixed timestep, then sample/interpolate from time; renderFrame does not advance simulation state. Do not declare readiness prematurely.

## Rough cut to final

1. Confirm the page starts and inspect a few risky moments for silhouette, local axes and framing. Avoid repeated whole-film polishing at this stage.
2. Obtain a complete rough cut early, for example at 320×180 with final duration and fps. Low resolution does not change action timing or omit the ending.
3. Inspect the whole-film contact sheet and key-action strips. Watch at normal speed when a playback tool is available; a sheet alone does not justify claiming full-speed playback. Identify concrete weaknesses and compare targeted revisions.
4. Preserve usable versions and write short state updates to work/state.md. Follow the caller's revision budget; without one, prefer a few focused passes over unbounded rewrites. Do not rename many iterations to disguise their number.
5. Render the final format, verify parameters and full decode, then evaluate requirements against actual images. A valid MP4 is not visual approval; intentional dark passages or holds are not automatically failures.

## Commands

SKILL is the installed code-video root and PROJECT is the task directory. Use actual paths supplied by the caller. Prepare dependencies using [runtime.md](runtime.md), without a previous project's activation script.

```bash
node "$SKILL/scripts/whitebox-previs/runtime.mjs" start --project "$PROJECT" --init
```

This creates a runnable Three.js starter without overwriting existing index.html or main.js, assigns an available loopback port and records the URL in render-runtime.json. Replace the sample cube with the requested film. Normally edit main.js rather than inventing a server or port. The import map uses configured local Three.js dependencies. Existing projects can start without --init; a nested entry needs a clear root index.html.

Use runtime.mjs status --project to obtain the actual URL. Pass that URL unchanged to capture; do not serve the filesystem root or kill processes by broad patterns. Stop only this task's server with runtime.mjs stop --project. Optional owner cleanup is described in runtime.md.

```bash
node "$SKILL/scripts/whitebox-previs/render.mjs" --url http://127.0.0.1:PORT/index.html --project "$PROJECT" --out "$PROJECT/build/rough-v1.mp4" --duration 12 --width 320 --height 180 --fps 24
python3 "$SKILL/scripts/whitebox-previs/review.py" sheet "$PROJECT/build/rough-v1.mp4" "$PROJECT/work/rough-v1-sheet.jpg"
python3 "$SKILL/scripts/whitebox-previs/review.py" strip "$PROJECT/build/rough-v1.mp4" "$PROJECT/work/action-v1.jpg" --start 5 --end 7 --step 0.1
```

Substitute actual action times; do not check the same 5–7 second interval for every film. Ensure timestamps do not obscure important contacts. Render the chosen version to a new final path:

```bash
node "$SKILL/scripts/whitebox-previs/render.mjs" --url http://127.0.0.1:PORT/index.html --project "$PROJECT" --out "$PROJECT/deliver/final.mp4" --duration 12 --width 640 --height 360 --fps 24
python3 "$SKILL/scripts/whitebox-previs/review.py" verify "$PROJECT/deliver/final.mp4" --width 640 --height 360 --fps 24 --duration 12 --audio forbid --report "$PROJECT/VERIFY.parameters.json" --scan
```

All format values come from the task; 12 seconds and 24 fps are examples. Stop the task server after delivery.

## Chunking and parallel capture

Use --start as an absolute starting frame and --frames as the count. Sampling remains `(start+i)/fps`, never time zero in every chunk. Default to one worker. Set --workers 2 only when the platform explicitly permits PREVIS_RENDER_WORKERS=2. This tool supports at most two browsers; concurrent tasks share the total resource budget.

Workers stream separate encodes. Check exit codes and per-chunk frame counts, concatenate in frame order, and verify the joined count before publishing. Failed-run diagnostics remain under .capture-*. Platform-side decoding can independently verify deliverables.

Get the rough cut before optional repeat-seek diagnostics. --check-seek compares PNG output for first → other → first frame. It cannot distinguish incorrect world state from renderer cache differences. Run it once on a separate short diagnostic output when useful, without overwriting the rough cut. Fix order-dependent transforms or attachment state; do not repeatedly rewrite the film merely to match pixel hashes.

Re-render changed intervals only when retained intervals remain valid. Global trajectories, lighting, camera dependencies or random parameters may invalidate many intervals. Keep dimensions, fps and encoding consistent and inspect both sides of joins.

Streaming avoids writing every PNG to shared storage; speed and parallel benefits require measurement. Default CRF is 20; CRF 0 is available for lossless diagnostics rather than normal delivery. Capture JSON records do not implement automatic resume or automatic dependency-based chunk reuse.

## Finalization after interruption

When the platform explicitly requests finalization, preserve an existing suitable film first. If none exists, repair only blocking execution errors and complete the render. Read work/state.md and the existing project; do not rewrite the story, repeat prompt enhancement or begin a new polishing cycle. Check actual format and full decode and report unmet or unverified requirements.

The platform controls turn limits, timeouts, retries, resume and finalization triggers. This module does not start extra sessions or cluster resources. If there is no film, report failure rather than presenting source code, stills or a partial clip as completion.

## Scope

Follow the parent code-video SPEC → complete rough cut → pixel evidence → verification workflow, supplemented by whitebox motion and camera guidance. These tools do not implement human IK, vehicle dynamics or automatic visual grading. File checks do not establish action or camera quality.
