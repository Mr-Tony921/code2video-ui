import '../fixtures.mjs';
import { TEST_TMP_ROOT, TEST_REPO_ROOT } from '../fixtures.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

process.env.CVW_INTERNAL_TOKEN = 'shared-dispatch-fixture-token';
const raw = JSON.parse(await readFile(join(TEST_REPO_ROOT, 'config/backend.json'), 'utf8'));
raw.environment.name = 'dev';
raw.concurrency = { global_max_concurrent_jobs: 6, per_machine_max_concurrent_jobs: 4,
  shared_workspace_workers: ['home', 'spare'] };
raw.production.allow_steering_during_job = false;
raw.isolation = { enabled: true, fallback_to_soft: false, workspace_mount: '/workspace' };
raw.workers = [['home', 2], ['spare', 4]].map(([id, cap]) => ({
  worker_id: id, bridge: { host: '127.0.0.1', port: 1 }, enabled: true, max_concurrent_jobs: cap,
  supported_modes: ['experimental'],
}));
const configFile = join(TEST_TMP_ROOT, 'config/backend.json');
await mkdir(join(TEST_TMP_ROOT, 'config'), { recursive: true });
await writeFile(configFile, JSON.stringify(raw));
process.env.CVW_BACKEND_CONFIG = configFile;

const { config } = await import('../../apps/gateway/src/config.mjs');
const { Dispatcher } = await import('../../apps/gateway/src/dispatcher.mjs');
const { WorkerPool } = await import('../../apps/gateway/src/worker-pool.mjs');
const { bridge } = await import('../../apps/gateway/src/bridge-client.mjs');
const store = await import('../../apps/gateway/src/store/job-store.mjs');
const quiet = { log() {}, warn() {}, error() {} };

test('available dev worker executes queued fresh and native-resume jobs without changing session ownership', async t => {
  await store.init();
  const pool = new WorkerPool({ repoRoot: TEST_TMP_ROOT, log: quiet });
  for (const w of raw.workers) pool.register({ ...w, process_instance_id: w.worker_id + ':1', max_sessions: 12 });
  const session = async () => {
    const s = await store.createSession({ userId: 'fixture', mode: 'experimental', workerId: 'home',
      processInstanceId: 'home:1' });
    return store.updateSession(s.id, { binding: { backend_session_ref: s.id } });
  };
  const makeJob = async (s, status, isRevision = false) => {
    const { job } = await store.createJob({ userId: s.user_id, sessionId: s.id, mode: s.mode,
      prompt: 'fixture', workerId: 'home', processInstanceId: 'home:1', initialStatus: status, isRevision });
    return job;
  };
  const live1 = await makeJob(await session(), 'RUNNING');
  const live2 = await makeJob(await session(), 'RUNNING');
  pool.heartbeat({ process_instance_id: 'home:1', running_jobs: 2, running_job_ids: [live1.id, live2.id] });
  const freshSession = await session();
  const fresh = await makeJob(freshSession, 'QUEUED');
  const resumed = await session();
  await makeJob(resumed, 'COMPLETED');
  const revision = await makeJob(resumed, 'QUEUED', true);
  const native = join(config.storage.sessionsRoot, config.storage.sessions_subdir, resumed.id, 'workspace',
    '.home', '.claude', 'projects', '-workspace');
  await mkdir(native, { recursive: true });
  await writeFile(join(native, resumed.id.slice(5) + '.jsonl'), '{}\n');
  const missing = await session();
  await makeJob(missing, 'COMPLETED');
  const legacy = await makeJob(missing, 'QUEUED', true);
  const leased = await makeJob(await session(), 'QUEUED');
  const claim = await store.assignQueuedJob(leased, leased);
  const lease = await store.acquireLease(claim.id, claim.process_instance_id);
  await store.requeueUnstarted(claim.id, lease.token);

  const seen = [];
  t.mock.method(bridge, 'startJob', async (_, body) => { seen.push(body); });
  const dispatcher = new Dispatcher({ pool, log: quiet });
  await dispatcher.tick();
  assert.deepEqual(seen.map(x => x.job_id), [fresh.id, revision.id]);
  assert.equal(seen[1].is_revision, true);
  assert.equal(seen[1].session_id, resumed.id);
  for (const expected of [fresh, revision]) {
    const job = await store.getJob(expected.id);
    assert.equal(job.worker_id, 'spare');
    assert.equal(job.process_instance_id, 'spare:1');
    assert.equal(job.lease.holder_process_instance_id, 'spare:1');
    assert.equal(job.queued_at, expected.queued_at);
    assert.equal((await store.getSession(job.session_id)).binding.worker_id, 'home');
  }
  assert.equal((await store.getJob(legacy.id)).status, 'QUEUED');
  assert.equal((await store.getJob(leased.id)).status, 'QUEUED');

  // Even if a second submission reached the queue, a job already assigned on the shared worker blocks it.
  const sibling = await makeJob(resumed, 'QUEUED', true);
  pool.heartbeat({ process_instance_id: 'home:1', running_jobs: 1, running_job_ids: [live1.id] });
  await store.transition(live2.id, 'COMPLETED');
  await dispatcher.tick();
  assert.equal((await store.getJob(sibling.id)).status, 'QUEUED');

  await store.rebindJobsToNewProcess('home', 'home:2', { adoptedJobIds: [live1.id] });
  await store.rebindSessionsToNewProcess('home', 'home:2', { adoptedJobIds: [live1.id] });
  assert.equal((await store.getSession(resumed.id)).status, 'ACTIVE');
  assert.equal((await store.getJob(revision.id)).lease.holder_process_instance_id, 'spare:1');
  assert.equal(await store.assignQueuedJob(fresh, fresh), null);
});
