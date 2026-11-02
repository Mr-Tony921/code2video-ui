import '../fixtures.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
process.env.CVW_INTERNAL_TOKEN='cancel-integrity-fixture-token';
const store=await import('../../apps/gateway/src/store/job-store.mjs');
const {config}=await import('../../apps/gateway/src/config.mjs');
const {Watchdog}=await import('../../apps/gateway/src/watchdog.mjs');
const {bridge}=await import('../../apps/gateway/src/bridge-client.mjs');
await store.init();
const pid='fixture-worker:1';
let serial=0;
async function makeJob(status='ASSIGNED'){
  const session=await store.createSession({userId:'test',mode:'coding_to_video',workerId:'fixture',processInstanceId:pid,backendRef:'fixture-session'});
  const {job}=await store.createJob({userId:'test',sessionId:session.id,mode:'coding_to_video',prompt:'fixture',workerId:'fixture',processInstanceId:pid,idempotencyKey:'case-'+serial++,maxRuntimeSeconds:3600});
  await store.transition(job.id,status);return job.id;
}
async function corruptedCancellation(value,{status='CANCELLING'}={}){
  const id=await makeJob();await store.transition(id,'CANCEL_REQUESTED');await store.transition(id,status);
  const j=await store.getJob(id);j.cancellation=value;
  await writeFile(join(config.storage.root,'gateway/jobs',id+'.json'),JSON.stringify(j));return id;
}
function pool(status='HEALTHY',url='http://127.0.0.1:1'){
  const p={processes:new Map([[pid,{status,running_jobs:1}]]),bridgeUrlFor:()=>url,released:0,release(){this.released++}};return p;
}
const quiet={warn(){},log(){},error(){}};
for(const [label,cancellation,status] of [
  ['null timestamp',{requested_at:null},'CANCELLING'],
  ['missing cancellation',null,'CANCELLING'],
  ['invalid timestamp',{requested_at:'not-a-time'},'CANCELLING'],
  ['request not acknowledged',{requested_at:null},'CANCEL_REQUESTED']
]){
  test(`watchdog settles ${label}`,async t=>{
    const id=await corruptedCancellation(cancellation,{status});const p=pool();
    t.mock.method(bridge,'cancelJob',async()=>({stopped:true,already_gone:true}));
    const wd=new Watchdog({pool:p,log:quiet});
    try{await wd.sweepJobs();assert.equal((await store.getJob(id)).status,'CANCELLED');assert.equal(p.released,1);}
    finally{await store.transition(id,'CANCELLED');}
  });
}
test('unavailable process probes disk truth, including aborted/failed and completed assets',async t=>{
  for(const truth of [{status:'cancelled'},{status:'failed',failure:{code:'E_ABORTED'}},{status:'completed',asset:{storage_path:'/tmp/fixture.mp4',size_bytes:123}}]){
    const id=await corruptedCancellation({requested_at:null});const p=pool('UNAVAILABLE');let probes=0;
    const mock=t.mock.method(bridge,'probeJob',async()=>{probes++;return truth});
    try{
      await new Watchdog({pool:p,log:quiet}).sweepJobs();
      assert.equal(probes,1);assert.equal((await store.getJob(id)).status,truth.status.toUpperCase());assert.equal(p.released,1);
    }finally{mock.mock.restore();await store.transition(id,'CANCELLED');}
  }
});
test('unconfirmed cancellation is bounded; a fresh request keeps its grace period',async t=>{
  const id=await corruptedCancellation({requested_at:null});const p=pool();let calls=0;
  t.mock.method(bridge,'cancelJob',async()=>{calls++;return {acked:true}});
  t.mock.method(bridge,'probeJob',async()=>({status:'running'}));
  const wd=new Watchdog({pool:p,log:quiet});
  try{
    for(let i=0;i<8;i++)await wd.sweepJobs();
    const j=await store.getJob(id);assert.equal(j.status,'FAILED');assert.equal(j.failure.code,'CANCEL_UNCONFIRMED');assert.ok(calls<=5);
  }finally{await store.transition(id,'CANCELLED');}
  const fresh=await corruptedCancellation({requested_at:new Date().toISOString()});const before=calls;
  try{await wd.sweepJobs();assert.equal((await store.getJob(fresh)).status,'CANCELLING');assert.equal(calls,before);}
  finally{await store.transition(fresh,'CANCELLED');}
});
test('cancellation survives concurrent metadata writes',async()=>{
  const id=await makeJob();
  try{
    await Promise.all([
      store.transition(id,'CANCEL_REQUESTED',{cancellation:{requested_at:'2026-11-02T00:00:00.000Z',requested_by:'test',reason:'user'}}),
      ...Array.from({length:20},(_,i)=>store.patchJob(id,{['concurrent_'+i]:i})),
      store.transition(id,'CANCELLING'),
    ]);
    const j=await store.getJob(id);assert.equal(j.status,'CANCELLING');assert.equal(j.cancellation.requested_at,'2026-11-02T00:00:00.000Z');
    for(let i=0;i<20;i++)assert.equal(j['concurrent_'+i],i);
  }finally{await store.transition(id,'CANCELLED');}
});
test('stale full-record patch cannot undo status, cancellation or a revoked lease',async()=>{
  const id=await makeJob();await store.acquireLease(id,pid);const stale=await store.getJob(id);
  try{
    await store.transition(id,'CANCEL_REQUESTED',{cancellation:{requested_at:'2026-11-02T00:00:00.000Z',requested_by:'test',reason:'user'}});
    await store.revokeLease(id);await store.patchJob(id,{...stale,phase:'GENERATING'});
    const j=await store.getJob(id);assert.equal(j.status,'CANCEL_REQUESTED');assert.ok(j.cancellation.requested_at);assert.ok(j.lease.revoked_at);
  }finally{await store.transition(id,'CANCELLED');}
});
test('lease mutations preserve fencing and allocate distinct epochs concurrently',async()=>{
  const id=await makeJob();
  try{
    const leases=await Promise.all(Array.from({length:8},()=>store.acquireLease(id,pid)));
    assert.deepEqual(leases.map(l=>l.epoch),[1,2,3,4,5,6,7,8]);
    const token=(await store.getJob(id)).lease.token;
    await Promise.all([store.revokeLease(id),store.renewLease(id),store.reassignLeaseHolder(id,'fixture-worker:2'),store.releaseLease(id),store.renewLease(id)]);
    const j=await store.getJob(id);assert.ok(j.lease.revoked_at);assert.ok(j.lease.released_at);assert.equal(j.lease.token,token);assert.equal(j.lease.epoch,8);
  }finally{await store.transition(id,'CANCELLED');}
});
test('late state writers and force retries cannot regress cancellation or reopen a terminal job',async()=>{
  const id=await makeJob();
  try{
    await store.transition(id,'CANCEL_REQUESTED',{cancellation:{requested_at:new Date().toISOString()}});
    assert.equal((await store.transition(id,'RUNNING')).ok,false);
    assert.equal((await store.transition(id,'QUEUED',{}, {force:true})).ok,false);
    assert.equal(await store.acquireLease(id,pid),null);
    await store.transition(id,'CANCELLED');
    assert.equal((await store.transition(id,'COMPLETED',{}, {force:true})).ok,false);
    assert.equal((await store.getJob(id)).status,'CANCELLED');
  }finally{await store.transition(id,'CANCELLED');}
});
