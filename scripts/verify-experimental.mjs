#!/usr/bin/env node
/** Real dev-only acceptance. Credentials stay in runtime; no administrator login. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('python3', [join(root, 'scripts/guard-isolation.py')]);
const cfg = JSON.parse(await readFile(join(root, 'config/backend.json'), 'utf8'));
assert.equal(cfg.environment.name, 'dev');
const base = cfg.deployment.web.public_url;
const out = join(root, 'runtime/validation/v1.5.2'); await mkdir(out, { recursive: true });
const report = { started_at: new Date().toISOString(), base, jobs: [], checks: [] };
let cookie, peerCookie, outstanding;
const save = () => writeFile(join(out, 'experimental-live.json'), JSON.stringify(report, null, 2) + '\n');
async function req(path, { body, asPeer = false, expected = 200, raw = false } = {}) {
  const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(asPeer ? { cookie: peerCookie } : cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(raw ? 120_000 : 30_000) });
  if (raw) { assert.equal(r.status, expected); return Buffer.from(await r.arrayBuffer()); }
  const data = await r.json(); assert.equal(r.status, expected, path + ': ' + JSON.stringify(data).slice(0, 400));
  return { data, headers: r.headers };
}
async function login(file) {
  const creds = JSON.parse(await readFile(join(root, 'runtime', file), 'utf8'));
  const { headers } = await req('/api/auth/login', { body: creds });
  return headers.get('set-cookie').split(';')[0];
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(id, desired = 'COMPLETED') {
  const until = Date.now() + 900_000; let previous;
  while (Date.now() < until) {
    const j = (await req(`/api/jobs/${id}`)).data.job;
    if (j.status !== previous) { console.log(id, j.status); previous = j.status; }
    if (j.status === desired) return j;
    assert.ok(!['FAILED', 'CANCELLED', 'OUT_OF_SCOPE'].includes(j.status), JSON.stringify(j.failure));
    await req(`/api/sessions/${j.session_id}/presence`, { body: { tab_id: 'experimental-acceptance' } });
    await sleep(2000);
  }
  throw new Error('Real dev job exceeded acceptance timeout');
}
try {
  cookie = await login('test-account.json'); peerCookie = await login('test-peer-account.json');
  const me = (await req('/api/auth/me')).data.user; assert.equal(me.role, 'user');
  assert.equal(me.can_use_experimental, true);
  await req('/api/experimental/models', { asPeer: true, expected: 403 });
  const models = (await req('/api/experimental/models')).data.models;
  const model = models[0]; assert.ok(model);
  const session = (await req('/api/sessions', { body: { mode: 'experimental', model_id: model.profile_id,
    builtin_skills: 'none' }, expected: 201 })).data.session;
  report.session = session.id; report.model = model; await save();
  await req(`/api/sessions/${session.id}/archive`, { asPeer: true, expected: 404 });
  const skill = '---\nname: lab-package\ndescription: Render a tiny fixture video using a provided script and palette.\n---\nRead resources/palette.json. Run python3 .claude/skills/lab-package/scripts/render.py from the project directory. The script renders output/final.mp4. For revisions edit the palette then run the script again.';
  const renderer = "import json,pathlib,subprocess\np=pathlib.Path(__file__).resolve().parents[1]\ncolor=json.loads((p/'resources/palette.json').read_text())['color']\npathlib.Path('output').mkdir(exist_ok=True)\nsubprocess.run(['ffmpeg','-y','-f','lavfi','-i',f'color=c={color}:s=320x180:r=10','-t','1','-c:v','libx264','-pix_fmt','yuv420p','output/final.mp4'],check=True)\n";
  const archive = execFileSync('python3', ['-c', "import io,json,sys,zipfile,base64; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); [(z.writestr(k,v)) for k,v in json.loads(sys.argv[1]).items()]; z.close(); print(base64.b64encode(b.getvalue()).decode())",
    JSON.stringify({ 'lab-package/SKILL.md': skill, 'lab-package/scripts/render.py': renderer,
      'lab-package/resources/palette.json': '{"color":"blue"}' })], { encoding: 'utf8' }).trim();
  async function submit(prompt, extra = {}) {
    const body = { prompt, enhance: false, max_runtime_seconds: 900, idempotency_key: randomUUID(), ...extra };
    const result = (await req(`/api/sessions/${session.id}/jobs`, { body, expected: 202 })).data;
    outstanding = result.job.id; report.jobs.push({ id: outstanding }); await save(); return outstanding;
  }
  const first = await submit('Load the lab-package and lab-notes skills and use the supplied script to create the 1-second blue video. Save output/final.mp4. No audio. Do not add other elements.', {
    experimental_skills: { builtin: 'none', text: '---\nname: lab-notes\ndescription: Keep this model test deterministic.\n---\nUse the provided script. Keep the video 1 second, 320x180, 10fps. No other assets are needed.',
      archive_base64: archive, archive_name: 'lab-package.zip' } });
  const a = await wait(first); outstanding = null;
  assert.equal(a.model_selection.model, model.model); assert.ok(a.result_asset.playable);
  const video = await req(a.result_asset.download_url, { raw: true }); await writeFile(join(out, 'experimental-first.mp4'), video);
  const sessionRoot = join(cfg.storage.sessions_root, cfg.storage.sessions_subdir, session.id);
  const meta = JSON.parse(await readFile(join(sessionRoot, 'rounds', first, '_meta.json'), 'utf8'));
  assert.deepEqual(meta.skills.sort(), ['lab-notes', 'lab-package']); assert.equal(meta.skillset, 'experimental-none');
  report.checks.push('API model / no builtins / pasted skill + ZIP script + resources / completed video'); await save();
  const second = await submit('Continue this same project and conversation. Change the supplied palette color from blue to green, run the same script again and deliver output/final.mp4. Keep all other video parameters.', { is_revision: true });
  const b = await wait(second); outstanding = null;
  const secondMeta = JSON.parse(await readFile(join(sessionRoot, 'rounds', second, '_meta.json'), 'utf8'));
  assert.equal(secondMeta.continued, true); assert.equal(secondMeta.cc_session_id, meta.cc_session_id);
  assert.equal(secondMeta.model_selection.revision, meta.model_selection.revision);
  assert.ok((await readFile(join(sessionRoot, 'rounds', first, 'final.mp4'))).equals(video));
  report.checks.push('same native CLI session resumed / model version retained / earlier video immutable'); await save();
  const zip = await req(`/api/sessions/${session.id}/archive`, { raw: true });
  await writeFile(join(out, 'experimental-session.zip'), zip);
  const summary = JSON.parse(execFileSync('python3', ['-c', `import io,json,sys,zipfile
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); names=z.namelist(); counts={}
def scan(v):
 if isinstance(v,dict):
  for k,x in v.items():
   if k in ['signature','reasoning_signature'] and x: counts[k]=counts.get(k,0)+1
   scan(x)
 elif isinstance(v,list):
  for x in v:scan(x)
for n in names:
 if n.endswith('.jsonl'):
  for line in z.read(n).decode().splitlines():
   try:scan(json.loads(line))
   except ValueError:pass
print(json.dumps({'files':len(names),'raw_stream':'workspace/claude.jsonl' in names,'native_sessions':sum('/projects/' in n and n.endswith('.jsonl') for n in names),'signature_counts':counts,'has_package':any(n.endswith('uploaded.zip') for n in names)}))`], { input: zip, encoding: 'utf8' }));
  assert.ok(summary.raw_stream && summary.native_sessions > 0 && summary.has_package);
  report.archive = summary; report.checks.push('complete archive / raw stream + native session + original skill package');
  report.passed = true; report.finished_at = new Date().toISOString(); await save();
  console.log('PASS experimental live acceptance', JSON.stringify(summary));
} catch (e) {
  report.passed = false; report.error = e.message; await save();
  if (outstanding) await req(`/api/jobs/${outstanding}/cancel`, { body: {}, expected: 202 }).catch(() => {});
  throw e;
}
