---
name: whitebox-previs
description: "Simplified 3D scene studies for exploring spatial staging, character or vehicle movement, action timing, shot composition and camera choreography, including previs and blocking. Use when the task uses untextured grey primitives to study how actors or vehicles move through a space, how an action reads over time, or how shots and camera moves connect — rather than to deliver a finished textured film. Provides specialized character, camera and capture guidance plus a three.js runtime and frame-accurate renderer; defaults to no audio and modest resolution unless the user asks otherwise."
---

# Three-dimensional whitebox previs

Use this guide when the purpose is to explore or communicate spatial staging, actor or vehicle movement, action timing, shot composition or camera choreography through a simplified 3D scene. Infer that purpose from the complete request and context; no particular word, language or label is required.

For example, testing how a guard blocks someone's path and how the shots connect, rehearsing a vehicle chase with primitive models, or studying a camera orbit around a stationary product can fit this workflow. These are examples of intent, not a keyword list or mandatory plots. A request for a polished product advertisement or finished character film does not by itself justify replacing its requested look with whitebox geometry. When purpose and desired fidelity are clear, follow them; ask only if the distinction would materially change the result and remains ambiguous.

Use the parent code-video workflow once: SPEC → full rough cut → frame evidence → targeted improvements → verification. The following specialize that workflow; they do not start another production or review loop.

## Defaults and precedence

- Preserve the user's explicit duration, shot intervals, actions, camera directions and format. Distinguish these from adjustable creative choices in SPEC.md.
- Use simplified 3D geometry with readable silhouettes and restrained gray/white materials; small identification colors are fine. Keep essential actions even when geometry is simple.
- For whitebox only, default to **no audio stream** unless the user requests sound. This overrides the generic sound suggestion, not an explicit user request. Start with modest resolution (e.g. 640×360 at 24 fps) when format is unspecified; record the choice.
- For whitebox, read the references below instead of loading overlapping generic character and 3D craft guides by default. Read other craft guides only for additional requested capabilities.

## Read as needed

Paths below are relative to this craft file:

- First production: [workflow](references/workflow.md) and [directing](references/directing.md).
- Sandbox dependencies and input/output contract: [runtime](references/runtime.md).
- Characters, vehicles or props: [motion](references/motion.md); for people also [characters](references/characters.md).
- Framing, camera movement and continuity: [cameras](references/cameras.md).
- Prompt writing only: [rewrite](references/rewrite.md); do not produce a film unless requested. Upstream prompt enhancement is separate from production.

## World, motion and evidence

One continuous world, multiple cameras: evaluate positions, facing, poses and held props directly from global time. Cuts never reset the action. Use local +Z forward, +Y up, +X right; separate path/orientation nodes from pose nodes. Inspect connected limbs, grounded feet, prop contact, wheel rolling and steering axes on action strips.

Obtain a complete low-resolution rough cut early. Inspect a whole-film contact sheet and dense frames around key actions; watch at normal speed when supported. Fix visible issues, preserve the last usable version, and label anything not actually verified. Intentional stillness, suspense holds and a stationary product are not motion failures.

## Tools

In commands, SKILL is the installed **code-video root**, PROJECT is the task directory:

- scripts/whitebox-previs/runtime.mjs: local task server and Three.js starter.
- scripts/whitebox-previs/render.mjs: deterministic capture, streaming encode and bounded chunks; use this instead of generic capture.mjs for whitebox.
- scripts/whitebox-previs/review.py: contact sheets, action strips and file validation.
- scripts/whitebox-previs/vehicle-rig.mjs: reusable wheel and steering assemblies; copy into the task before browser import.

Follow runtime.md for dependencies. Tools do not implement human IK, vehicle physics or automatic visual grading. Platform controls model/API, task limits and finalization triggers.
