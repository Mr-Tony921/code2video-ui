import '../fixtures.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
process.env.CVW_INTERNAL_TOKEN = 'fifo-regression-internal-token';
const {config} = await import('../../apps/gateway/src/config.mjs');
const {WorkerPool} = await import('../../apps/gateway/src/worker-pool.mjs');
const {Dispatcher} = await import('../../apps/gateway/src/dispatcher.mjs');
const {bridge} = await import('../../apps/gateway/src/bridge-client.mjs');
const store = await import('../../apps/gateway/src/store/job-store.mjs');

test('all users and modes enter fourteen slots in FIFO order while slow admission reserves one slot', async t => {
  await store.init();
  const modes = ['coding_to_video', 'experimental', 'blockout_3d'];
  const owners = ['yuruidong', 'trltrltrl', 'test'];
  const workers = [2, 4, 4, 4].map((capacity, index) => ({
    worker_id: 'fifo-worker-' + index, bridge: {host: 'host-' + index, port: 18081},
    max_concurrent_jobs: capacity, max_sessions: 128, supported_modes: modes,
  }));
  const raw = {...config.raw, environment: {name: 'dev'}, workers,
    concurrency: {global_max_concurrent_jobs: 14, per_machine_max_concurrent_jobs: 4,
      shared_workspace_workers: workers.map(w => w.worker_id)}};
  const pool = new WorkerPool({backendConfig: raw});
  for (const w of workers) pool.register({...w, process_instance_id: w.worker_id});
  const jobs = [];
  for (let index = 0; index < 17; index++) {
    const mode = modes[index % 3], userId = owners[index % 3];
    const session = await store.createSession({userId, mode, workerId: workers[0].worker_id,
      processInstanceId: workers[0].worker_id});
    await store.updateSession(session.id, {binding: {backend_session_ref: session.id}});
    const {job} = await store.createJob({userId, mode, sessionId: session.id, prompt: 'FIFO fixture',
      workerId: workers[0].worker_id, processInstanceId: workers[0].worker_id, initialStatus: 'QUEUED'});
    await store.patchJob(job.id, {queued_at: new Date(Date.UTC(2026, 10, 18, 0, 0, index)).toISOString()});
    jobs.push(job);
  }
  let release;
  const blocked = new Promise(resolve => {release = resolve;});
  const seen = [];
  t.mock.method(bridge, 'startJob', async (_, payload) => {
    seen.push(payload.job_id);
    if (payload.job_id === jobs[0].id) await blocked;
  });
  const dispatcher = new Dispatcher({pool, log: {log() {}, warn() {}, error() {}}});
  try {
    await dispatcher.tick();
    assert.deepEqual(seen, jobs.slice(0, 14).map(j => j.id));
    assert.equal(pool.globalUsed, 14);
    assert.equal(pool.canAdmit(workers[0].worker_id).reason, 'GLOBAL_CAPACITY');
    for (const job of jobs.slice(0, 14)) assert.equal((await store.getJob(job.id)).status, 'ASSIGNED');
    for (const job of jobs.slice(14)) assert.equal((await store.getJob(job.id)).status, 'QUEUED');
    await dispatcher.tick();
    assert.equal(seen.length, 14);
  } finally {
    release();
    await Promise.all(dispatcher.deliveries);
  }
});
