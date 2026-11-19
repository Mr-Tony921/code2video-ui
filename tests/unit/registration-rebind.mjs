import '../fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.CVW_INTERNAL_TOKEN = 'registration-rebind-fixture-token';
const store = await import('../../apps/gateway/src/store/job-store.mjs');
test('bulk session rebinding preserves adopted executions and leases while isolating unadopted and other-worker sessions', async () => {
  await store.init();
  const sessions = [], jobs = [];
  for (let i = 0; i < 12; i++) {
    const s = await store.createSession({ userId: 'fixture', mode: 'experimental', workerId: i === 11 ? 'other-worker' : 'fixture-worker', processInstanceId: 'old' });
    const { job } = await store.createJob({ userId: 'fixture', sessionId: s.id, mode: 'experimental', prompt: 'fixture',
      workerId: s.binding.worker_id, processInstanceId: 'old', idempotencyKey: s.id, initialStatus: i < 2 || i === 11 ? 'RUNNING' : 'COMPLETED' });
    sessions.push(s); jobs.push(job);
  }
  const lease = await store.acquireLease(jobs[0].id, 'old');
  await store.rebindJobsToNewProcess('fixture-worker', 'new', { adoptedJobIds: [jobs[0].id] });
  const result = await store.rebindSessionsToNewProcess('fixture-worker', 'new', { adoptedJobIds: [jobs[0].id] });
  assert.equal(result.rebound.length, 10); assert.equal(result.degraded.length, 1);
  assert.equal((await store.getSession(sessions[0].id)).binding.process_instance_id, 'new');
  assert.equal((await store.getSession(sessions[1].id)).status, 'DEGRADED');
  assert.equal((await store.getSession(sessions[11].id)).binding.process_instance_id, 'old');
  const running = await store.getJob(jobs[0].id); assert.equal(running.status, 'RUNNING');
  assert.equal(running.lease.token, lease.token); assert.equal(running.lease.epoch, lease.epoch);
  assert.equal(running.lease.holder_process_instance_id, 'new');
});

test('shared-worker registration keeps idle historical session records byte-identical', async () => {
  const s = await store.createSession({ userId: 'fixture', mode: 'experimental',
    workerId: 'shared-worker', processInstanceId: 'previous-instance' });
  const original = await store.getSession(s.id);
  await store.rebindSessionsToNewProcess('shared-worker', 'next-instance', { preserveIdle: true });
  assert.deepEqual(await store.getSession(s.id), original);
});
