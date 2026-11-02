import '../fixtures.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
process.env.CVW_INTERNAL_TOKEN='atomic-write-test-only-token';
const store=await import('../../apps/gateway/src/store/job-store.mjs');
const {config}=await import('../../apps/gateway/src/config.mjs');

test('concurrent readers never mistake an existing job for missing or malformed data',async()=>{
  await store.init();
  const {job}=await store.createJob({userId:'fixture',sessionId:'fixture',mode:'coding_to_video',
    prompt:'x'.repeat(50000),workerId:'fixture',processInstanceId:'fixture:1',idempotencyKey:'atomic'});
  await Promise.all([
    (async()=>{for(let i=0;i<120;i++) await store.patchJob(job.id,{phase:'P'+i,prompt:'y'.repeat(50000)});})(),
    (async()=>{for(let i=0;i<400;i++){assert.equal((await store.getJob(job.id)).id,job.id); await new Promise(r=>setTimeout(r,1));}})()
  ]);
  assert.equal(await store.getJob('job_missing_fixture'),null);
  await writeFile(join(config.storage.root,'gateway/jobs/job_broken_fixture.json'),'{broken');
  await assert.rejects(store.getJob('job_broken_fixture'));
  await assert.rejects(store.getJobReliable('job_broken_fixture',{tries:2,delayMs:10}));
});
