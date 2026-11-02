#!/usr/bin/env node
/** Real HTTP acceptance using ordinary test users; generation always disables enhancement. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('python3', [join(root, 'scripts/guard-isolation.py')]);
const cfg = JSON.parse(await readFile(join(root, 'config/backend.json'), 'utf8'));
const base = `http://${cfg.deployment.web.host}:${cfg.deployment.web.port}`;
const label = process.env.CVW_TEST_LABEL ?? 'acceptance';
assert.match(label, /^[a-z0-9-]+$/);
const out = join(root, 'runtime/validation', label);
await mkdir(out, { recursive: true });
const report = process.argv.includes('--continue')
  ? JSON.parse(await readFile(join(out, 'report.json'), 'utf8'))
  : { started_at: new Date().toISOString(), base, checks: [], jobs: [] };
report.checks = report.checks.filter(c => c.passed);
const save = () => writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
async function check(name, fn) {
  try { const details = await fn(); report.checks.push({ name, passed: true, details }); console.log('PASS', name, details ?? ''); }
  catch (e) { report.checks.push({ name, passed: false, error: e.message }); await save(); throw e; }
  await save();
}
async function req(path, { cookie, body, method, headers = {}, expected = 200 } = {}) {
  const r = await fetch(base + path, { method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  assert.equal(r.status, expected, `${path}: ${r.status} ${text.slice(0, 400)}`);
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { data, headers: r.headers };
}
async function login(filename) {
  const creds = JSON.parse(await readFile(join(root, 'runtime', filename), 'utf8'));
  const { headers } = await req('/api/auth/login', { body: creds });
  const cookie = headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie?.startsWith('cvw_codex_session='));
  const { data } = await req('/api/auth/me', { cookie });
  assert.equal(data.user.role, 'user');
  return cookie;
}
const cookie = await login('test-account.json');
const peer = await login('test-peer-account.json');
const own = (path, args = {}) => req(path, { cookie, ...args });
const outstanding = new Set();
async function session(mode) {
  const { data } = await own('/api/sessions', { body: { mode }, expected: 201 });
  assert.equal(data.isolation.ok, true);
  assert.equal(data.isolation.has_whitebox, mode === 'blockout_3d');
  return data.session.id;
}
async function submit(sid, prompt, revision = false) {
  const key = randomUUID();
  const body = { prompt, enhance: false, is_revision: revision, max_runtime_seconds: 900, idempotency_key: key };
  const { data } = await own(`/api/sessions/${sid}/jobs`, { body, expected: 202 });
  outstanding.add(data.job.id);
  report.jobs.push({ id: data.job.id, session: sid, revision, prompt }); await save();
  return { id: data.job.id, body };
}
async function waitJob(id) {
  const deadline = Date.now() + 1000 * 960; let previous = '', lastPrint = 0;
  while (Date.now() < deadline) {
    const { data } = await own(`/api/jobs/${id}`); const j = data.job;
    if (previous !== j.status || Date.now() - lastPrint > 45_000) {
      console.log('JOB', id, j.status, j.phase ?? ''); previous = j.status; lastPrint = Date.now();
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'OUT_OF_SCOPE'].includes(j.status)) {
      outstanding.delete(id); Object.assign(report.jobs.find(x => x.id === id), { status: j.status, asset: j.result_asset, failure: j.failure });
      await save(); assert.equal(j.status, 'COMPLETED', JSON.stringify(j.failure)); return j;
    }
    await own(`/api/sessions/${j.session_id}/presence`, { body: { tab_id: label } });
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error(`Job timed out: ${id}`);
}
async function video(job, name) {
  assert.equal(job.enhancement.skipped, true);
  const a = job.result_asset; assert.ok(a?.playable && a.size_bytes > 1000);
  const r = await fetch(`${base}/api/assets/${a.id}/playback`, { headers: { cookie, range: 'bytes=0-1023' }, signal: AbortSignal.timeout(30_000) });
  assert.equal(r.status, 206); assert.match(r.headers.get('content-range'), /^bytes 0-1023\//);
  assert.equal((await r.arrayBuffer()).byteLength, 1024);
  assert.equal(r.headers.get('content-encoding'), null);
  const d = await fetch(`${base}/api/assets/${a.id}/download`, { headers: { cookie }, signal: AbortSignal.timeout(60_000) });
  assert.equal(d.status, 200);
  const buf = Buffer.from(await d.arrayBuffer()); assert.equal(buf.length, a.size_bytes);
  await writeFile(join(out, name + '.mp4'), buf);
  await req(`/api/assets/${a.id}/download`, { cookie: peer, expected: 404 });
  const replay = await own(`/api/jobs/${job.id}/events`, { headers: { accept: 'text/event-stream' } });
  assert.match(replay.data, /job\.completed/);
  // Terminal replay ends at job.completed; live replay uses job.replay_done.
  assert.ok(replay.data.trimEnd().endsWith('}'));
  assert.equal(replay.headers.get('content-encoding'), null);
  return { bytes: buf.length, path: join(out, name + '.mp4') };
}

try {
  await check('ordinary test account / admin forbidden', async () => {
    for (const p of ['/api/admin/users', '/api/admin/invites', '/api/admin/channels', '/api/admin/gallery', '/api/admin/examples']) await own(p, { expected: 403 });
  });
  await check('anonymous / forged cookie rejected', async () => {
    await req('/api/auth/me', { expected: 401 });
    await req('/api/auth/me', { cookie: 'cvw_codex_session=forged.invalid', expected: 401 });
    await req('/api/admin/users', { expected: 401 });
  });
  await check('3D permission enforced independently of role', () => req('/api/sessions', { cookie: peer, body: { mode: 'blockout_3d' }, expected: 403 }));
  await check('core API / brief polling preserves history contract', async () => {
    for (const p of ['/api/auth/me', '/api/system/capacity', '/api/examples']) await own(p);
    const full = (await own('/api/me/active-context')).data;
    const brief = (await own('/api/me/active-context?brief=1')).data;
    assert.ok(Array.isArray(full.recent_completed_jobs));
    assert.ok(!('recent_completed_jobs' in brief));
  });
  let sid;
  await check('session / mode skills / cross-user isolation', async () => {
    sid = process.argv.includes('--continue') ? report.jobs[0].session : await session('coding_to_video');
    await req(`/api/sessions/${sid}`, { cookie: peer, expected: 404 });
    await own(`/api/sessions/${sid}/references`);
    await own(`/api/sessions/${sid}/presence`, { body: { tab_id: label } });
    return sid;
  });
  if (process.argv.includes('--no-job')) { report.finished_at = new Date().toISOString(); await save(); process.exit(0); }
  if (!process.argv.includes('--continue')) await check('reference upload / metadata / ownership / deletion', async () => {
    const form = new FormData();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    form.append('file', new Blob([png], {type:'image/png'}), 'test-reference.png');
    const r = await fetch(`${base}/api/sessions/${sid}/references`, {method:'POST', headers:{cookie}, body:form, signal:AbortSignal.timeout(30_000)});
    const result = await r.json(); assert.equal(r.status,201,JSON.stringify(result));
    assert.equal(result.manifest.items.length,1);
    const name = result.item.stored_name;
    await req(`/api/sessions/${sid}/references/${name}`,{cookie:peer,method:'DELETE',expected:404});
    await own(`/api/sessions/${sid}/references/${name}`,{method:'DELETE'});
    assert.equal((await own(`/api/sessions/${sid}/references`)).data.items.length,0);
  });
  let first;
  await check('real 2D job / five concurrent idempotent replays', async () => {
    if (process.argv.includes('--continue')) { first = { id: report.jobs[0].id }; return first.id; }
    first = await submit(sid, 'Create a simple 2-second 640x360 24fps H.264 MP4: a red ball falls and bounces once on a plain white background. Save source under src/ and the finished video to output/final.mp4. No audio needed.');
    const responses = await Promise.all(Array.from({ length: 5 }, () => own(`/api/sessions/${sid}/jobs`, { body: first.body })));
    assert.ok(responses.every(r => r.data.job.id === first.id));
    await req(`/api/jobs/${first.id}`, { cookie: peer, expected: 404 });
    await own(`/api/sessions/${sid}/jobs`, { body: { ...first.body, idempotency_key: randomUUID() }, expected: 409 });
    return first.id;
  });
  let wb;
  await check('real 3D job / skill isolation', async () => {
    if (process.argv.includes('--continue')) { wb = { id: report.jobs[1].id }; return wb.id; }
    const ws = await session('blockout_3d');
    wb = await submit(ws, 'Use the whitebox-previs skill and Three.js to render a simple 2-second 640x360 24fps 3D blockout: a gray cube rotates slowly on a flat gray floor, with fixed perspective camera, soft light and visible shadows. Save the finished H.264 MP4 to output/final.mp4. No audio, no text, no complex scenery.');
    return wb.id;
  });
  await check('references freeze after first submission', async () => {
    assert.equal((await own(`/api/sessions/${sid}/references`)).data.frozen,true);
  });
  const jobs = await Promise.all([waitJob(first.id), waitJob(wb.id)]);
  await check('2D playback / download / Range / SSE / ownership', () => video(jobs[0], 'first'));
  await check('3D playback / download / Range / SSE / ownership', () => video(jobs[1], 'blockout'));
  let revision;
  await check('same-session revision completes', async () => {
    revision = await submit(sid, 'Keep this same animation and source. Change the ball from red to green and make it bounce twice. Keep duration 2 seconds and resolution 640x360. Save output/final.mp4.', true);
    return revision.id;
  });
  const revised = await waitJob(revision.id);
  await check('revision playback / independent pinned result', async () => {
    const result = await video(revised, 'revision');
    const a = await readFile(join(out, 'first.mp4')); const b = await readFile(join(out, 'revision.mp4'));
    assert.ok(!a.equals(b));
    const sessRoot = join(cfg.storage.sessions_root, 'sessions', sid);
    const meta = JSON.parse(await readFile(join(sessRoot, 'rounds', revision.id, '_meta.json'), 'utf8'));
    assert.equal(meta.continued, true);
    assert.ok((await readFile(join(sessRoot, 'rounds', first.id, 'final.mp4'))).equals(a));
    return { ...result, resumed: true };
  });
  await check('running task cancellation / resource release / pinned video preserved', async () => {
    const pending = await submit(sid, 'Create a new version of this animation with a blue background, a green ball, and three bounces. Render a 4-second 640x360 MP4 to output/final.mp4.', true);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const j = (await own(`/api/jobs/${pending.id}`)).data.job;
      if (j.status === 'RUNNING') break;
      assert.ok(!['FAILED','COMPLETED','CANCELLED'].includes(j.status), j.status);
      await new Promise(r => setTimeout(r,1000));
    }
    assert.equal((await own(`/api/jobs/${pending.id}`)).data.job.status,'RUNNING');
    await own(`/api/jobs/${pending.id}/cancel`,{body:{},expected:202});
    let final;
    for (let i=0;i<60;i++) {
      final=(await own(`/api/jobs/${pending.id}`)).data.job;
      if (final.status === 'CANCELLED') break;
      await new Promise(r=>setTimeout(r,1000));
    }
    assert.equal(final.status,'CANCELLED');
    assert.ok(final.cancellation.resources_released_at);
    outstanding.delete(pending.id);
    Object.assign(report.jobs.find(j=>j.id===pending.id), {status:final.status, expected:'CANCELLED'});
    const old=await fetch(base+revised.result_asset.download_url,{headers:{cookie}});
    assert.equal(old.status,200);
    assert.ok(Buffer.from(await old.arrayBuffer()).equals(await readFile(join(out,'revision.mp4'))));
    return pending.id;
  });
  report.finished_at = new Date().toISOString(); await save();
  console.log('ACCEPTANCE COMPLETE', join(out, 'report.json'));
} finally {
  for (const id of outstanding) {
    try { await own(`/api/jobs/${id}/cancel`, { body: { reason: 'test_cleanup' }, expected: 202 }); }
    catch (e) { console.error('Cleanup required', id, e.message); }
  }
}
