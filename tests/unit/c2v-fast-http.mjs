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
test('C2V fast mode survives HTTP queueing, dispatch and idempotent replay', async () => {
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
  raw.experimental = { enabled: true, models: [{ id: 'fixture', name: 'Fixture model', model: 'fixture-opus',
    endpoint: 'https://models.example.test', api_key: 'fixture-key' }, { id: 'intranet-default', source: 'primary' }, {
    id: 'fable', name: 'Fable', model: 'fixture-fable', endpoint: 'https://models.example.test',
    api_key: 'fixture-fable-key', allowed_user_ids: ['test'],
  }] };
  const anatomy = JSON.parse(await readFile(join(TEST_REPO_ROOT, 'config/backend.example.json'))).experimental.skills[0];
  raw.experimental.skills = [anatomy];
  raw.model = { ...raw.model, model: 'fixture-intranet', base_url: 'http://127.0.0.1:1', api_key_env: 'FIXTURE_PRIMARY_KEY' };
  raw.workers = [{ ...raw.workers[0], bridge: { host: '127.0.0.1', port: worker.address().port } }];
  const configFile = join(TEST_TMP_ROOT, 'backend.json'); await writeFile(configFile, JSON.stringify(raw));
  let logs = '';
  const child = spawn(process.execPath, [join(TEST_REPO_ROOT, 'apps/gateway/src/server.mjs')], {
    cwd: TEST_TMP_ROOT, env: { ...process.env, CVW_BACKEND_CONFIG: configFile,
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
    const wid = raw.workers[0].worker_id;
    await req('/internal/processes/register', { internal: true, body: { worker_id: wid, process_instance_id: wid + ':fixture',
      host: '127.0.0.1', port: worker.address().port, supported_modes: ['coding_to_video'],
      max_concurrent_jobs: 2, max_sessions: 16 } });
    const session = (await req('/api/sessions', { body: { mode: 'coding_to_video' }, expected: 201 })).session;
    await req(`/api/sessions/${session.id}/jobs`, { body: { prompt: 'invalid', fast_mode: 'true',
      idempotency_key: 'invalid-fast' }, expected: 400 });
    const submitted = await req(`/api/sessions/${session.id}/jobs`, { body: { prompt: 'Exact original story.',
      enhance: false, fast_mode: true, idempotency_key: 'fast-job' }, expected: 202 });
    assert.equal(submitted.job.fast_mode, true);
    assert.equal(submitted.job.fast_skill.skill, 'c2v-fast-compact');
    for (let i = 0; i < 150 && !delivered; i++) await sleep(30);
    assert.ok(delivered);
    assert.equal(delivered.fast_mode, true);
    assert.deepEqual(delivered.fast_skill, submitted.job.fast_skill);
    assert.equal(delivered.prompt, 'Exact original story.');
    const saved = await store.getJob(submitted.job.id);
    assert.equal(saved.original_prompt, 'Exact original story.');
    assert.equal(saved.enhancement.skipped, true);
    const replay = await req(`/api/sessions/${session.id}/jobs`, { body: { prompt: 'ignored duplicate',
      fast_mode: false, idempotency_key: 'fast-job' } });
    assert.equal(replay.idempotent_replay, true);
    assert.deepEqual(replay.job.fast_skill, submitted.job.fast_skill);
    assert.equal(replay.job.fast_mode, true);
    const listed = await req('/api/me/jobs?kind=all&limit=50');
    assert.equal(listed.jobs.find(j => j.id === saved.id).fast_mode, true);
    const normal = (await req('/api/sessions', { body: { mode: 'coding_to_video' }, expected: 201 })).session;
    const ordinary = (await req(`/api/sessions/${normal.id}/jobs`, { body: { prompt: 'Normal story.',
      enhance: false, idempotency_key: 'normal-job' }, expected: 202 })).job;
    assert.equal(ordinary.fast_mode, false);
    assert.equal(ordinary.fast_skill, null);
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
    }
    worker.closeAllConnections(); await new Promise(resolve => worker.close(resolve));
  }
});
