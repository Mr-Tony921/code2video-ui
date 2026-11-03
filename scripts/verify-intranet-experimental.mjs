#!/usr/bin/env node
/** Ordinary-user real smoke for the primary model with an empty skill workspace. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('python3', [join(root, 'scripts/guard-isolation.py')]);
const cfg = JSON.parse(await readFile(join(root, 'config/backend.json'), 'utf8'));
assert.equal(cfg.environment.name, 'dev');
const out = join(root, 'runtime/validation/intranet-experimental'); await mkdir(out, { recursive: true });
const base = cfg.deployment.web.public_url;
const continuing = process.argv.includes('--continue');
const report = continuing ? JSON.parse(await readFile(join(out, 'live.json'), 'utf8')) : { checks: [], started_at: new Date().toISOString(), base };
let cookie, outstanding;
const save = () => writeFile(join(out, 'live.json'), JSON.stringify(report, null, 2) + '\n');
async function req(path, body, expected = 200) {
  const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const value = await res.json(); assert.equal(res.status, expected, path + ': ' + JSON.stringify(value).slice(0, 400));
  return { value, headers: res.headers };
}
try {
  const creds = JSON.parse(await readFile(join(root, 'runtime/test-account.json'), 'utf8'));
  cookie = (await req('/api/auth/login', creds)).headers.get('set-cookie').split(';')[0];
  const me = (await req('/api/auth/me')).value.user;
  assert.equal(me.role, 'user'); assert.equal(me.can_use_experimental, true);
  const models = (await req('/api/experimental/models')).value.models;
  const local = models.find(m => m.profile_id === 'intranet-default');
  assert.ok(local); assert.equal(local.model, cfg.model.model);
  assert.ok(models.some(m => m.profile_id === 'enhancement-default'));
  report.models = models; report.checks.push('both existing API and intranet choices available to ordinary authorized user');
  const session = continuing ? (await req(`/api/sessions/${report.session}`)).value.session :
    (await req('/api/sessions', { mode: 'experimental', model_id: local.profile_id, builtin_skills: 'none' }, 201)).value.session;
  report.session = session.id; await save();
  const prompt = 'Use ffmpeg directly to create a 1-second 320x180 10fps solid blue H.264 MP4. No audio, no web search and no extra assets. Save it to output/final.mp4. Run the command now and finish.';
  const result = continuing ? { job: { id: report.job } } : (await req(`/api/sessions/${session.id}/jobs`, { prompt, enhance: false,
    idempotency_key: randomUUID(), max_runtime_seconds: 900 }, 202)).value;
  outstanding = result.job.id; report.job = outstanding; await save();
  let final, previous;
  for (let i = 0; i < 450; i++) {
    const j = (await req(`/api/jobs/${outstanding}`)).value.job;
    if (previous !== j.status) { console.log(j.id, j.status); previous = j.status; }
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'OUT_OF_SCOPE'].includes(j.status)) { final = j; break; }
    await req(`/api/sessions/${session.id}/presence`, { tab_id: 'intranet-model-smoke' });
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.equal(final?.status, 'COMPLETED', JSON.stringify(final?.failure)); outstanding = null;
  assert.equal(final.model_selection.profile_id, 'intranet-default');
  assert.equal(final.model_selection.model, cfg.model.model); assert.equal(final.enhancement.skipped, true);
  const sessionRoot = join(cfg.storage.sessions_root, cfg.storage.sessions_subdir, session.id);
  assert.deepEqual(await readdir(join(sessionRoot, 'workspace/.claude/skills')), []);
  const meta = JSON.parse(await readFile(join(sessionRoot, 'rounds', final.id, '_meta.json'), 'utf8'));
  assert.deepEqual(meta.skills, []); assert.equal(meta.skillset, 'experimental-none');
  assert.equal(meta.model_selection.profile_id, 'intranet-default');
  const stream = await readFile(join(sessionRoot, 'workspace/claude.jsonl'), 'utf8');
  const init = stream.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } })
    .find(row => row?.type === 'system' && row.subtype === 'init');
  assert.equal(init.model, cfg.model.model);
  assert.ok(!(init.skills ?? []).includes('code-video-core'));
  assert.ok(!(init.skills ?? []).includes('whitebox-previs'));
  const skillCalls = stream.split('\n').some(line => {
    try { const row = JSON.parse(line); return row.type === 'assistant' && (row.message?.content ?? []).some(c => c.type === 'tool_use' && c.name === 'Skill'); }
    catch { return false; }
  });
  assert.equal(skillCalls, false, 'model should execute directly without invoking any skill');
  report.cli_builtin_capabilities = init.skills ?? []; report.skill_calls = 0;
  report.checks.push('intranet model executed raw prompt; no enhancement, builtin skills or custom skills');
  const playback = await fetch(base + final.result_asset.playback_url, {
    headers: { cookie, range: 'bytes=0-1023' }, signal: AbortSignal.timeout(30_000) });
  assert.equal(playback.status, 206); assert.equal((await playback.arrayBuffer()).byteLength, 1024);
  report.checks.push('video completed and authenticated Range playback works');
  delete report.error; report.checks = [...new Set(report.checks)];
  report.passed = true; report.finished_at = new Date().toISOString(); await save();
  console.log('PASS intranet model / zero skills / real video / Range playback');
} catch (e) {
  report.passed = false; report.error = e.message; await save();
  if (outstanding) await req(`/api/jobs/${outstanding}/cancel`, {}, 202).catch(() => {});
  throw e;
}
