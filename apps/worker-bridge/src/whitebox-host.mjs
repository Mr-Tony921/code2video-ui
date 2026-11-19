import { mkdir, writeFile, copyFile, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const whiteboxSystemPrompt = `You are the director for the user's selected whitebox previs skill inside Claude Code.
Use the whitebox MCP tool to submit the current phase's semantic JSON. Its result performs the selected skill's deterministic CLI steps and supplies the exact next-stage rules, facts, and actual images.
Do not plan future phases before their instructions arrive. Do not invent user requirements, tool operations, numeric constraints, or extra aesthetic review loops.
Preserve the original story, required movement, ownership, scene identity, camera and duration. Details that the skill delegates downstream are not missing proxy motion.
New film: translate the user's natural language into a faithful brief, then one compact plan and at most two consolidated corrections. Follow-up: keep the prior playable base and make only the requested bounded local edit, with at most one correction.
When the tool returns actual evidence images, examine every required page directly; do not request the same pages or status again. The tool fills deterministic hashes, paths and provenance; you supply the actual semantic judgments.
Ask a concise question only for material ambiguity. Explanatory questions do not create a new film. After delivery, report the playable result, actual time and unresolved limitations concisely. Tool/model checks are not human quality approval.
Claude Code owns this conversation and model loop. The MCP tools never call another model or replace the original user prompt.`;

async function playableBase(ws, jobId) {
  let names;
  try { names = await readdir(join(ws, '.whitebox')); } catch { return null; }
  const candidates = [];
  for (const name of names) {
    if (name === jobId) continue;
    try {
      const state = JSON.parse(await readFile(join(ws, '.whitebox', name, 'state.json'), 'utf8'));
      if (!state.delivered || !state.render_success) continue;
      const relative = `work/${name}`;
      const native = JSON.parse(await readFile(join(ws, relative, 'job.json'), 'utf8'));
      // The upstream CLI revalidates the actual base video before accepting an edit.
      const when = (await stat(join(ws, '.whitebox', name, 'state.json'))).mtimeMs;
      candidates.push({ relative, when, quality_pass: state.quality_pass, native });
    } catch {}
  }
  return candidates.sort((a, b) => b.when - a.when)[0] ?? null;
}

export async function prepareWhiteboxHost({ repoRoot, ws, viewPath, bookDir, jobId, skill, continued, modelSelection, prompt }) {
  const relative = `.whitebox/${jobId}`, host = join(ws, relative), agent = join(viewPath, relative);
  const inputs = `work/${jobId}-inputs`;
  await mkdir(host, { recursive: true }); await mkdir(join(ws, inputs), { recursive: true });
  await copyFile(join(repoRoot, 'apps/worker-bridge/scripts/whitebox-cc-host.py'), join(host, 'host.py'));
  await copyFile(join(repoRoot, 'apps/worker-bridge/scripts/whitebox-mcp.py'), join(host, 'mcp.py'));
  await copyFile(join(repoRoot, 'apps/worker-bridge/scripts/whitebox-edit-evidence.py'), join(host, 'edit_evidence.py'));
  const python = '/media/blockout-093/python/bin/python3.11';
  const requireFacts = /deepseek/i.test(modelSelection?.profile_id ?? modelSelection?.model ?? '');
  const base = continued ? await playableBase(ws, jobId) : null;
  const edit = Boolean(base);
  const skillRoot = join(ws, '.claude/skills', skill);
  const planningFiles = edit ? ['references/user-edits.md', 'references/action-scope.md']
    : ['references/brief.md', 'references/action-scope.md'];
  const source = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
  const intake = source.split('1. **Translate the brief into an explicit story contract.**')[1]?.split('2. **Start one shared measured job**')[0];
  if (!intake) throw new Error('Selected skill intake section changed; review the CC adapter before executing');
  const planningContext = (edit ? '' : `### Selected skill: natural-language intake\n${intake}\n`)
    + (await Promise.all(planningFiles.map(async f => `\n### Selected skill: ${f}\n${await readFile(join(skillRoot, f), 'utf8')}`))).join('\n');
  await writeFile(join(host, 'planning-context.md'), planningContext);
  const config = { workspace: viewPath, job: `work/${jobId}`, inputs, skill: `.claude/skills/${skill}`, python,
    continued: edit, resumed_conversation: continued, base_job: base?.relative ?? null,
    require_facts: requireFacts, user_prompt: prompt, planning_files: planningFiles, context_policy: requireFacts ? 'current-phase-v1' : 'native', stage_transport: modelSelection?.profile_id === 'whitebox-deepseek' ? 'chat-json-v1' : 'native', version: 'cvw-whitebox-cc-v9' };
  await writeFile(join(host, 'config.json'), JSON.stringify(config, null, 2));
  const state = { started_at: Date.now() / 1000, phase: 'initial', mcp_phase: edit ? 'edit' : 'brief', repairs: 0, max_repairs: edit ? 1 : 2, seen: {} };
  await writeFile(join(host, 'state.json'), JSON.stringify(state, null, 2));
  const command = `${python} ${agent}/host.py hook`;
  const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command, timeout: 10 }] }] } };
  await writeFile(join(host, 'settings.json'), JSON.stringify(settings, null, 2));
  const mcp = { mcpServers: { whitebox: { type: 'stdio', command: python, args: [join(agent, 'mcp.py')], timeout: 1200000 } } };
  await writeFile(join(host, 'mcp.json'), JSON.stringify(mcp, null, 2));
  await copyFile(join(host, 'host.py'), join(bookDir, 'whitebox-host.py'));
  await copyFile(join(host, 'mcp.py'), join(bookDir, 'whitebox-mcp.py'));
  await copyFile(join(host, 'edit_evidence.py'), join(bookDir, 'whitebox-edit-evidence.py'));
  let baseContext = '';
  if (base) {
    const load = async name => { try { return JSON.parse(await readFile(join(ws, base.relative, name), 'utf8')); } catch { return null; } };
    const actual = await load(base.quality_pass ? 'output/effective-scene.json' : 'reference-output/effective-scene.json')
      ?? await load(base.quality_pass ? 'scene.json' : 'last-renderable-scene.json') ?? await load('scene.json');
    baseContext = '\nPLAYABLE_BASE: ' + JSON.stringify({ job: base.relative, quality_pass: base.quality_pass,
      brief: await load('brief.json'), draft: await load(base.quality_pass ? 'draft.json' : 'last-renderable-draft.json') ?? await load('draft.json'),
      actual_cameras: actual?.shots?.map(s => ({ id: s.id, camera: s.camera })) });
    baseContext += '\nFor numeric camera edits, include acceptance_checks in the edit declaration: [{shot_id,metric:camera_distance|camera_height|camera_fov,direction:increase|decrease|unchanged}]. Declare the direction requested by the user, not the direction your candidate happens to take. camera_distance is actual camera-to-look distance at both endpoints. Missing compact fields mean compiler defaults, not zero. These checks are frozen before patching and use actual baseline/candidate data. Other edits still require explicit semantic comparison against the user change. Do not include a patch inside the edit declaration; the next phase accepts the exact top-level {shots,stages,entities} patch.\n';
  }
  return { state_path: join(host, 'state.json'), version: config.version, context_policy: config.context_policy, stage_transport: config.stage_transport, user_prompt: prompt, settings_path: join(agent, 'settings.json'),
    mcp_config_path: join(agent, 'mcp.json'),
    contract: `\n## Selected skill: current phase only\n${planningContext}\n## Whitebox tool integration\nCurrent phase: ${edit ? 'edit' : 'brief'}. Use mcp__whitebox__submit with kind=${edit ? 'edit' : 'brief'} and data containing the actual JSON, not a JSON string or a file path. The tool supplies compact-plan rules after the brief is frozen, and factual/image-review rules with actual evidence at those stages. Do not plan the whole film before submitting the brief.\n${continued && !base ? 'This resumes a conversation without a playable base. Incorporate earlier user details and any clarification answer; continue natural-language intake, not a scoped edit of a nonexistent video.\n' : ''}Independent factual review: ${requireFacts ? 'required before images (DeepSeek)' : 'not required; do not add the DeepSeek-only phase'}. The caller uses low for initial planning and review, high after a real correction is needed. 600 seconds is a soft target.\nThe tool handles installed dependencies, compilation, checking, evidence generation, validated video export and packaging. It supplies real images inline, fills deterministic hashes/paths, and keeps the original capture and skill artifacts. It does not make any model calls.\nKeep the original user story and explicit requirements. For temporary stay-behind clauses, use until_event for the actual later movement. Do not invent distances, permanent holds, or camera variety constraints.\nFor material ambiguity use kind=clarify with {question: concise_question}. For an explanation that needs no film change, use kind=answer with {text: concise_answer}. Otherwise complete the requested workflow. ${baseContext}\n` };
}
