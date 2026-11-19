---
name: seko-blockout
description: Generate or locally revise a continuous Three.js previs project from a story containing segments, prose shots and scene/character reference images. Preserve business timing and identities; deliver a renderable editable scene with bounded self-checking.
metadata:
  version: 0.1.5
---

# Seko scene previs

Use the engine tools shipped with this skill's release, or an equivalent implementation of their documented public interface. The workflow and stopping limits apply with any harness. No benchmark, internal website, specific test story or answer is needed.

Read [the source contract](references/source-contract.md) when generating geometry/animation. Read [review requirements](references/review.md) before checking a candidate. For follow-up edits read [local revisions](references/revisions.md).

In the standalone skill ZIP, the self-contained engine is at `scripts/engine/`; install its pinned `requirements.txt` and `package-lock.json`, then use `python scripts/engine/cli.py --help`. In the full engine release this skill lives under `skills/` and the CLI is at the release root. Do not expect an internal benchmark server to supply missing tools.

## Initial story

1. Normalize the original work/segments/shot text and reference images. Preserve original segment IDs, source shot numbering, order and specified times; no shot may cross a segment. Allocate unspecified shot durations within its fixed segment. Keep camera subdivisions distinct from business shots. A segment is not a location. Reject contradictions rather than silently trimming a story over 300 seconds.
2. Actually inspect all supplied reference images during planning. Bind reference indices to named locations/characters/props. Explain concrete geometric decisions in `reference_usage`. When an image's identity is inferred, label uncertainty. Do not merely copy image names. Use meaningful walls/openings/paths/furniture/landmarks around action; reproduce readable silhouette and spatial relationships, not texture or exact single-image reconstruction.
3. Establish one global cast/prop/location registry. Same person in different costume keeps identity. Related rooms/exterior entrances and regions share sensible geography. Returning to a scene retains previous prop states. Model the whole story together; do not independently reset at segment boundaries.
4. Author a compact `buildScene` module using the provided helpers. Use primitive/composite geometry and absolute animation tracks. Make necessary position/ownership/camera changes executable. Main actors may have simple sitting/kneeling/crouching silhouettes; extras can be cylinders/spheres. Gait, repeated combat/mining gestures, expressions, fingers, realistic physics and polished modeling are optional. Preserve causal results, important height changes and required camera timing despite simplifying performance.
5. Compile and render sampled evidence through the actual Three.js runtime. Check every segment/shot and fixed duration, all boundary times, A→B→A seek consistency, dependencies and finite state. Review paginated real screenshots for original instruction compliance, references, actors, props, continuity and requested camera. A valid JSON/module is not render success. Use actual world/track data for positions; screenshots for what is visible. Do not mistake simple geometry for a missing optional performance.
6. Repair factual/technical blockers only, collectively and locally where possible. **Initial candidate + at most two corrections for the whole job.** Invalid/partial candidates consume the same allowance. A 600-second target is measured but never resets the clock or grants new attempts. Keep the last renderable candidate. If limits are reached, deliver it with unresolved issues; if none exists, report technical failure. Never substitute a generic empty story to claim success.
7. Package the serialized scene, shot plan, source, reference bindings, self-check evidence/receipt, hashes and known limitations. No video export is required. Record initial and final status, time per phase, actual model settings and correction count. Separate scene usability, timing/structure and semantic quality. User acceptance is not inferred from model self-review.

## Camera and contact discipline

Honor prompt camera scales, paths, POV, roll, inserts and cuts. Do not turn every shot into a wide orbit or center every character. A face/prop insert may crop a body; a huge establishing view may make people tiny. Remove optional decorative occlusion if necessary while preserving a specified camera and required environment. Camera target and object must share the same coordinate system.

Place held props under an actual hand/chest/root group where practical so translation and turning cannot detach them. A placement changes ownership and persists. A seated wheelchair user must occupy the chair, not stand beside it. A rescue's victim must reach the safe region, even without detailed pushing animation. Preserve actor identity and intended result; optional limb detail never justifies missing a required displacement.

Do not add subtitles, dialogue/audio synthesis or unrelated beauty passes. Preserve full source dialogue and downstream performance intent as metadata. On unclear nonessential artistic detail choose a lightweight interpretation and disclose it; seek clarification for contradictions that change the story.

## Follow-up

Read the latest saved project revision, including manual edits. Apply the user's requested segment/shot/entity scope and directly dependent attachments/camera/boundaries only. **One edit candidate + at most one correction.** Retain the previous revision and inherited checks for unchanged content. Do not raise modeling quality or reopen the whole story. A stale base revision must not overwrite a newer edit.

A failed patch-format attempt consumes its allowance but must retain the original unresolved issues in the next feedback; never replace them with the syntax error alone. For source-only targeted changes use `refine-source` on an immutable completed run, with one candidate and at most one correction. Its time and result are a separate follow-up, not a new pass@1. It refuses projects with manual overlays; use latest-workspace `revise` for those supported edits. Source refinement checks all technical timing again and visually checks changed/unresolved shots; it is not a guaranteed arbitrary editing API.
