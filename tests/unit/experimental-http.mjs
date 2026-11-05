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
test('HTTP enforces fresh experimental permissions, binds model and skills, bypasses enhancement, and isolates histories', async () => {
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
    endpoint: 'https://models.example.test', api_key: 'fixture-key' }, { id: 'intranet-default', source: 'primary' }] };
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
    await req('/api/experimental/models', { expected: 403 });
    await req('/api/experimental/skills', { expected: 403 });
    await req('/api/sessions', { body: { mode: 'experimental', model_id: 'fixture' }, expected: 403 });
    // Change permission after cookie issue: creation must read current user storage.
    await req('/api/admin/users/test/permissions', { method: 'PATCH', body: { can_use_experimental: true }, expected: 403 });
    const granted = await req('/api/admin/users/test/permissions', { method: 'PATCH', as: 'fixture-admin', role: 'admin',
      body: { can_use_experimental: true } });
    assert.equal(granted.user.role, 'user');
    const me = await req('/api/auth/me'); assert.ok(me.permissions.modes.includes('experimental'));
    const models = await req('/api/experimental/models'); assert.equal(models.models[0].model, 'fixture-opus');
    assert.equal(models.models[1].model, 'fixture-intranet');
    assert.ok(!JSON.stringify(models).includes('fixture-key'));
    const wid = raw.workers[0].worker_id;
    await req('/internal/processes/register', { internal: true, body: { worker_id: wid, process_instance_id: wid + ':fixture',
      host: '127.0.0.1', port: worker.address().port, supported_modes: ['coding_to_video', 'experimental'],
      max_concurrent_jobs: 2, max_sessions: 4 } });
    const session = (await req('/api/sessions', { body: { mode: 'experimental', model_id: 'fixture' }, expected: 201 })).session;
    assert.equal(session.model_selection.model, 'fixture-opus');
    const submitted = await req(`/api/sessions/${session.id}/jobs`, { body: { prompt: 'exact user prompt', enhance: true,
      idempotency_key: 'fixture-job', experimental_skills: { text: 'My exact custom skill.', builtin: 'none' } }, expected: 202 });
    assert.equal(submitted.enhancing, false); assert.equal(submitted.job.status, 'QUEUED');
    assert.equal(submitted.job.enhancement.reason, 'experimental');
    assert.equal(submitted.job.model_selection.profile_id, 'fixture');
    for (let i = 0; i < 100 && !delivered; i++) await sleep(30);
    assert.equal(delivered.prompt, 'exact user prompt'); assert.equal(delivered.model_selection.model, 'fixture-opus');
    assert.equal(delivered.experimental_skills.builtin, 'none');
    const headerOnly = join(TEST_TMP_ROOT, 'header-only.mp4');
    await writeFile(headerOnly, Buffer.alloc(48));
    const invalid = await req(`/internal/jobs/${submitted.job.id}/complete`, { internal: true,
      body: { lease_token: (await store.getJob(submitted.job.id)).lease.token,
        asset: { storage_path: headerOnly, size_bytes: 48 } }, expected: 400 });
    assert.equal(invalid.error.code, 'INVALID_VIDEO');
    assert.equal((await store.getJob(submitted.job.id)).status, 'ASSIGNED');
    delivered = null;
    const catalog = (await req('/api/experimental/skills')).skills;
    assert.equal(catalog[0].id, 'anatomy'); assert.equal(catalog[0].archive, undefined);
    await req('/api/experimental/skills', { as: 'test-peer', expected: 403 });
    const localSession = (await req('/api/sessions', { body: { mode: 'experimental', model_id: 'intranet-default', builtin_skills: 'none' }, expected: 201 })).session;
    assert.equal(localSession.model_selection.model, 'fixture-intranet');
    const localJob = (await req(`/api/sessions/${localSession.id}/jobs`, { body: { prompt: 'raw local prompt', enhance: true,
      idempotency_key: 'fixture-local-job' }, expected: 202 })).job;
    assert.equal(localJob.enhancement.reason, 'experimental');
    assert.equal(localJob.experimental_skills.builtin, 'none');
    assert.deepEqual(localJob.experimental_skills.skills, []);
    for (let i = 0; i < 160 && !delivered; i++) await sleep(30);
    assert.equal(delivered.model_selection.model, 'fixture-intranet');
    assert.equal(delivered.prompt, 'raw local prompt');
    assert.deepEqual(delivered.experimental_skills.skills, []);
    const anatomySession = (await req('/api/sessions', { body: { mode: 'experimental', model_id: 'fixture', builtin_skills: 'coding_to_video' }, expected: 201 })).session;
    await req(`/api/sessions/${anatomySession.id}/jobs`, { body: { prompt: 'conflict', idempotency_key: 'conflict', experimental_skills: {
      configured: catalog, text: '---\nname: anatomy\n---\npasted duplicate' } }, expected: 400 });
    const anatomyJob = (await req(`/api/sessions/${anatomySession.id}/jobs`, { body: { prompt: 'use anatomy and core', idempotency_key: 'anatomy-job',
      experimental_skills: { configured: catalog } }, expected: 202 })).job;
    assert.equal(anatomyJob.experimental_skills.builtin, 'coding_to_video');
    assert.equal(anatomyJob.experimental_skills.configured[0].version, anatomy.version);
    assert.deepEqual(anatomyJob.experimental_skills.skills, ['anatomy']);
    const listed = await req('/api/me/jobs?kind=all&limit=50');
    assert.ok(listed.jobs.some(j => j.id === anatomyJob.id));
    await req(`/api/sessions/${session.id}`, { as: 'test-peer', expected: 404 });
    await req(`/api/sessions/${session.id}/archive`, { as: 'test-peer', expected: 404 });
    const revoked = await req('/api/admin/users/test/permissions', { method: 'PATCH', as: 'fixture-admin', role: 'admin',
      body: { can_use_experimental: false } });
    assert.ok(revoked.running_jobs_kept.includes(submitted.job.id));
    await req('/api/experimental/models', { expected: 403 });
    await req('/api/experimental/skills', { expected: 403 });
    await req(`/api/sessions/${session.id}/jobs`, { body: { prompt: 'new request', idempotency_key: 'another' }, expected: 403 });
    await req(`/api/sessions/${session.id}`); // Existing owned history remains readable.
    assert.equal((await store.getJob(submitted.job.id)).status, 'ASSIGNED'); // Revocation never cancels existing execution.
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
    }
    worker.closeAllConnections(); await new Promise(resolve => worker.close(resolve));
  }
});
