import '../fixtures.mjs';
import { TEST_TMP_ROOT, TEST_REPO_ROOT } from '../fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
process.env.CVW_INTERNAL_TOKEN = 'experimental-http-fixture-token';
const users = await import('../../apps/gateway/src/users.mjs');
const store = await import('../../apps/gateway/src/store/job-store.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const secret = 'fixture-cookie-secret';
function cookie(username, role = 'user') {
  const body = Buffer.from(JSON.stringify({ id: username, username, role, exp: Date.now() + 60_000 })).toString('base64url');
  return `cvw_fixture_session=${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
test('whitebox HTTP binds model and one skill, isolates permissions and disables the whole-task cutoff', async () => {
  await users.create({ username: 'test', password: 'Fixture-Password123' });
  await users.create({ username: 'test-peer', password: 'Fixture-Password123' });
  let delivered;
  const worker = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const b = body ? JSON.parse(body) : {};
    res.setHeader('content-type', 'application/json');
    if (req.url === '/sessions') return res.end(JSON.stringify({ backend_session_ref: b.session_id, skills: [], isolation: { ok: true } }));
    if (req.url === '/jobs') { delivered = b; res.statusCode = 202; }
    return res.end('{}');
  });
  await new Promise(resolve => worker.listen(0, '127.0.0.1', resolve));
  const reserved = createServer(); await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
  const raw = JSON.parse(await readFile(join(TEST_REPO_ROOT, 'config/backend.json'), 'utf8'));
  raw.auth.session_cookie_name = 'cvw_fixture_session';
  raw.deployment.internal_allowed_cidrs = ['127.0.0.0/8'];
  raw.whitebox = { enabled: true, default_model: 'whitebox-deepseek', default_skill: 'blockout-previs-video', skills: raw.whitebox.skills,
    models: [{ id: 'whitebox-deepseek', name: 'Fixture whitebox', channels: [
      { model: 'fixture-model', endpoint: 'http://models.test', api_key_env: 'SEKO_HTTP_TEST_KEY' },
      { model: 'fixture-model-backup', endpoint: 'http://models.test', api_key: 'backup-key' },
    ] }] };
  const address = { host: '127.0.0.1', port: worker.address().port };
  const dedicated = { worker_id: 'upstream-fixture', bridge: address, max_concurrent_jobs: 1,
    supported_modes: ['blockout_3d', 'coding_to_video'] };
  const production = { worker_id: 'production-fixture', bridge: address, max_concurrent_jobs: 1,
    supported_modes: ['coding_to_video', 'blockout_3d'] };
  raw.workers = [dedicated, production];
  const configFile = join(TEST_TMP_ROOT, 'backend.json'); await writeFile(configFile, JSON.stringify(raw));
  let logs = '';
  const child = spawn(process.execPath, [join(TEST_REPO_ROOT, 'apps/gateway/src/server.mjs')], {
    cwd: TEST_TMP_ROOT, env: { ...process.env, CVW_BACKEND_CONFIG: configFile, SEKO_HTTP_TEST_KEY: 'fixture-key',
      CVW_GATEWAY_PORT: String(port), CVW_GATEWAY_HOST: '127.0.0.1', CVW_SESSION_SECRET: secret },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  const base = `http://127.0.0.1:${port}`;
  async function req(path, { body, as = 'test', role, expected = 200, internal = false, method } = {}) {
    const r = await fetch(base + path, { method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { cookie: cookie(as, role), 'content-type': 'application/json',
        ...(internal ? { 'x-internal-token': process.env.CVW_INTERNAL_TOKEN } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const data = await r.json(); assert.equal(r.status, expected, path + ': ' + JSON.stringify(data)); return data;
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/healthz')).ok) { ready = true; break; } } catch {}
      await sleep(30);
    }
    assert.ok(ready, logs);
    await req('/api/whitebox/settings', { expected: 403 });
    await req('/api/sessions', { body: { mode: 'blockout_3d', model_id: 'whitebox-fixture' }, expected: 403 });
    await users.setBlockout3d('test', true);
    const settings = await req('/api/whitebox/settings');
    assert.match(settings.default_model_id,/^seko-/);
    assert.equal(settings.default_skills.configured[0].version,'0.1.12');
    await req('/api/sessions', { body: { mode: 'blockout_3d', model_id: 'seko-00000000000000000000000000000000' }, expected: 403 });
    assert.equal(settings.fixed_model,true); assert.equal(settings.fixed_skill,true);
    assert.ok(!JSON.stringify(settings).includes('fixture-key'));
    assert.equal(settings.hard_timeout_seconds, null);
    const wid = raw.workers[0].worker_id;
    for (const w of raw.workers) await req('/internal/processes/register', { internal: true,
      body: { ...w, ...address, process_instance_id: w.worker_id + ':fixture', max_sessions: 16 } });
    const userC2V = await req('/api/sessions', { body: { mode: 'coding_to_video' }, expected: 201 });
    const peerC2V = await req('/api/sessions', { as: 'test-peer', body: { mode: 'coding_to_video' }, expected: 201 });
    assert.ok(raw.workers.some(w => w.worker_id === userC2V.binding.worker_id));
    assert.ok(raw.workers.some(w => w.worker_id === peerC2V.binding.worker_id));
    await users.setBlockout3d('test-peer', true);
    const peerSettings=await req('/api/whitebox/settings',{as:'test-peer'});
    assert.equal(peerSettings.default_model_id,settings.default_model_id);
    assert.deepEqual(peerSettings.default_skills,settings.default_skills);
    await req('/api/sessions', { as: 'test-peer', body: { mode: 'blockout_3d' }, expected: 201 });
    const session = (await req('/api/sessions', { body: { mode: 'blockout_3d' }, expected: 201 })).session;
    assert.equal(session.model_selection.harness,'seko-v1');
    assert.equal(session.model_selection.model, 'fixture-model');
    assert.equal(session.experimental_skills.builtin, 'none');
    const body = { prompt: 'A moving cube', enhance: true, max_runtime_seconds: 600, idempotency_key: 'whitebox-first' };
    const first = (await req(`/api/sessions/${session.id}/jobs`, { body, expected: 202 })).job;
    assert.equal(first.max_runtime_seconds, 0); assert.equal(first.enhancement.reason, 'whitebox');
    assert.equal(first.model_selection.engine_release,'seko-0.1.12-cvw.1');
    assert.equal(first.experimental_skills.builtin, 'none');
    const dup = await req(`/api/sessions/${session.id}/jobs`, { body });
    assert.equal(dup.job.id, first.id); assert.equal(dup.idempotent_replay, true);
    for (let i=0; i<100 && !delivered; i++) await sleep(30);
    assert.equal(delivered.mode, 'blockout_3d'); assert.equal(delivered.max_runtime_seconds, 0);
    assert.equal(delivered.model_selection.profile_id, settings.default_model_id);
    assert.equal(delivered.experimental_skills.builtin,'none');
    await req(`/api/sessions/${session.id}`, { as: 'test-peer', expected: 404 });
    const prod = (await store.createJob({ userId: 'test-peer', sessionId: 'fixture-production', mode: 'coding_to_video', prompt: 'Production queue fixture', workerId: wid, initialStatus: 'QUEUED' })).job;
    const wb = (await store.createJob({ userId: 'test', sessionId: 'fixture-whitebox', mode: 'blockout_3d', prompt: 'Whitebox queue fixture', workerId: wid, initialStatus: 'QUEUED' })).job;
    const c2v = (await store.createJob({ userId: 'test', sessionId: userC2V.session.id, mode: 'coding_to_video',
      prompt: 'Upstream C2V queue fixture', workerId: wid, initialStatus: 'QUEUED' })).job;
    for (const [i, job] of [prod, wb, c2v].entries()) await store.patchJob(job.id, { queued_at: new Date(Date.now() - 3000 + i * 100).toISOString() });
    const wbView = (await req('/api/jobs/' + wb.id)).job;
    const c2vView = (await req('/api/jobs/' + c2v.id)).job;
    const prodView = (await req('/api/jobs/' + prod.id, { as: 'test-peer' })).job;
    assert.deepEqual(wbView.queue, { position: 2, total: 3, ahead: 1 });
    assert.deepEqual(c2vView.queue, { position: 3, total: 3, ahead: 2 });
    assert.deepEqual(prodView.queue, { position: 1, total: 3, ahead: 0 });
    await req(`/internal/jobs/${first.id}/complete`, { internal: true, expected: 400,
      body: { lease_token: delivered.lease_token, response: { kind: 'clarification', text: '' } } });
    const reply = { kind: 'clarification', text: '希望故事发生在室内还是室外？' };
    await req(`/internal/jobs/${first.id}/complete`, { internal: true,
      body: { lease_token: delivered.lease_token, response: reply } });
    const finished = (await req('/api/jobs/' + first.id)).job;
    assert.equal(finished.status, 'COMPLETED'); assert.equal(finished.result_asset, null);
    assert.deepEqual(finished.response, reply); assert.equal(finished.last_assistant_text, reply.text);
    await req(`/api/whitebox/jobs/${first.id}/source`, { as: 'test-peer', expected: 404 });
    await req(`/api/sessions/${session.id}/jobs`, { body: { prompt: 'change skill', idempotency_key: 'forbidden-skill', experimental_skills: { builtin: 'coding_to_video' } }, expected: 400 });
    await store.updateSession(session.id, { model_selection: { profile_id: 'old-whitebox', model: 'old' } });
    await req(`/api/sessions/${session.id}/jobs`, { body: { prompt: 'change old whitebox', idempotency_key: 'legacy-readonly' }, expected: 409 });
    await users.setBlockout3d('test', false);
    await req('/api/whitebox/settings', { expected: 403 });
    await req(`/api/sessions/${session.id}/jobs`, { body: { prompt: 'change', idempotency_key: 'whitebox-next' }, expected: 403 });
    assert.equal((await store.getJob(first.id)).status, 'COMPLETED');
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
    }
    worker.closeAllConnections(); await new Promise(resolve => worker.close(resolve));
  }
});
