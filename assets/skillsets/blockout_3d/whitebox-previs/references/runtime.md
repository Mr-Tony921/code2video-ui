# Sandbox runtime contract

## Dependencies

- Node.js 20 or newer; Python 3 (review.py uses only the standard library).
- Chromium/Chrome with headless WebGL support.
- ffmpeg and ffprobe on PATH, with libx264 and drawtext support and a usable font for timestamps.
- three and puppeteer-core. The known project versions are pinned in scripts/whitebox-previs/package.json. Prefer dependencies preinstalled in the sandbox image rather than installing them per task.

Resolve Node packages from the task's node_modules, or set PREVIS_DEPENDENCY_ROOT to an environment root containing node_modules. Without that variable, resolution starts from the task package.json location and never falls back to a previous project. This configuration does not grant additional filesystem access.

## Configuration example

The platform supplies actual paths; these examples are not assumed to exist:

```bash
export CHROME_BIN=/sandbox/runtime/chrome/chrome
export PREVIS_DEPENDENCY_ROOT=/sandbox/runtime/node
export PREVIS_RENDER_WORKERS=1
node "$SKILL/scripts/whitebox-previs/runtime.mjs" start --project "$PROJECT" --init
```

SKILL is the installed code-video root; PROJECT is the writable task directory. To prepare an environment, copy scripts/whitebox-previs/package.json to the chosen dependency root and install there using the platform's network policy or package cache. No Python packages, conda or legacy activation script are required.

Chrome keeps its own sandbox by default. Set PREVIS_CHROME_NO_SANDBOX=1 only when the platform explicitly requires it and supplies external isolation. Otherwise the renderer does not pass --no-sandbox.

Optional PREVIS_OWNER_PID stops the task server when the specified owner exits. Without it, the caller must run runtime.mjs stop. The platform should clean up the task process group at completion. Tools do not scan for or stop other tasks.

## Inputs and outputs

The caller supplies an isolated writable task directory, original user request, optional enhanced brief and video format. Record defaults for missing settings in SPEC.md. A useful starting format is 640×360 at 24 fps; explicit requirements take precedence. Default to no audio. The supplied renderer encodes silent video only; requested sound requires a separate audio workflow.

Expected artifacts:

- deliver/final.mp4: final H.264/yuv420p video at the task's exact format.
- SPEC.md and shots.json: required content, adjustable choices and actual shot table.
- VERIFY.md and VERIFY.parameters.json: visual findings and file checks.
- work/state.md: concise recoverable engineering state.
- build/: versioned rough cuts and review images.
- render-runtime.json: task-local service control, including a token; do not publish it as an artifact.

The platform collects artifacts and exposes status/logs. API credentials, model selection, concurrency, timeouts, turn limits and finalization triggers belong to the platform. This module does not connect to model services or request compute resources.

Install the complete merged code-video directory at .claude/skills/code-video in the task workspace, retaining relative crafts, references and scripts structure. Record the module version and hashes for reproducibility. No fixed skill installation path or host filesystem mount is required.
