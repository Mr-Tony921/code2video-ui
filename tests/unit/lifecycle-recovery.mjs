import '../fixtures.mjs';
import { TEST_TMP_ROOT } from '../fixtures.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile, readFile, copyFile, truncate } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
process.env.CVW_INTERNAL_TOKEN = 'lifecycle-fixture-token';
process.env.CVW_GATEWAY_BASE_URL = 'http://127.0.0.1:1';
const store = await import('../../apps/gateway/src/store/job-store.mjs');
const { config } = await import('../../apps/gateway/src/config.mjs');
const runner = await import('../../apps/worker-bridge/src/job-runner.mjs');
const { config: workerConfig } = await import('../../apps/worker-bridge/src/config.mjs');
const { Watchdog } = await import('../../apps/gateway/src/watchdog.mjs');
const { bridge } = await import('../../apps/gateway/src/bridge-client.mjs');
const { sendJobHeartbeats } = await import('../../apps/worker-bridge/src/supervisor.mjs');
const { LeaseInvalidError } = await import('../../apps/worker-bridge/src/gateway-client.mjs');
const { validateVideo } = await import('../../apps/shared/video-validation.mjs');
const { resolveJobPaths } = await import('../../apps/worker-bridge/src/job-paths.mjs');
const quiet = { log(){}, warn(){}, error(){} };
await store.init();
let seq = 0;
async function make() {
 const s = await store.createSession({ userId:'test', mode:'experimental', workerId:'fixture', processInstanceId:'fixture:1' });
 const { job } = await store.createJob({ userId:'test', sessionId:s.id, mode:'experimental', prompt:'fixture',workerId:'fixture',processInstanceId:'fixture:1',idempotencyKey:'lifecycle-'+seq++ });
 await store.transition(job.id,'ASSIGNED',{ assigned_at:new Date(Date.now()-600000).toISOString() });
 const lease=await store.acquireLease(job.id,'fixture:1');return {id:job.id,lease};
}
test('capacity rollback is atomic, preserves FIFO and refuses a stale attempt, running job or cancellation',async()=>{
 const {id,lease}=await make(), before=await store.getJob(id);
 assert.equal((await store.requeueUnstarted(id,lease.token)).ok,true);
 const after=await store.getJob(id);assert.equal(after.status,'QUEUED');assert.ok(after.lease.revoked_at);assert.equal(after.queued_at,before.queued_at);
 await store.transition(id,'ASSIGNED');const next=await store.acquireLease(id,'fixture:1');
 assert.equal((await store.requeueUnstarted(id,lease.token)).ok,false);
 await store.transition(id,'RUNNING',{started_at:new Date().toISOString()});
 assert.equal((await store.requeueUnstarted(id,next.token)).ok,false);
 await store.transition(id,'CANCEL_REQUESTED');assert.equal((await store.requeueUnstarted(id,next.token)).ok,false);
 await store.transition(id,'CANCELLED');
});
test('watchdog requeues an unstarted assignment only after worker confirms not_found',async t=>{
 const {id}=await make();const pool={bridgeUrlFor:()=> 'http://fixture',release(){},processes:new Map()};
 const wd=new Watchdog({pool,log:quiet});
 const mock=t.mock.method(bridge,'probeJob',async()=>{throw new Error('timeout')});
 await wd.sweepJobs();assert.equal((await store.getJob(id)).status,'ASSIGNED');
 mock.mock.restore();t.mock.method(bridge,'probeJob',async()=>({status:'not_found'}));
 await wd.sweepJobs();assert.equal((await store.getJob(id)).status,'QUEUED');
 await store.transition(id,'CANCELLED');
});
test('a transient missing executor during finalization gets a grace period',async t=>{
 const {id}=await make();await store.transition(id,'RUNNING',{started_at:new Date().toISOString(),last_heartbeat_at:new Date(Date.now()-600000).toISOString()});
 t.mock.method(bridge,'probeJob',async()=>({status:'not_found'}));
 const wd=new Watchdog({pool:{bridgeUrlFor:()=> 'http://fixture',release(){},processes:new Map()},log:quiet});
 await wd.sweepJobs();assert.equal((await store.getJob(id)).status,'RECOVERING');
 wd.probeBackoff.clear();wd.missingSince.set(id,Date.now()-300001);
 await wd.sweepJobs();assert.equal((await store.getJob(id)).failure.code,'ORPHAN_NO_EXECUTOR');
});
test('heartbeats are concurrent across jobs and single-flight within a job; timeout cannot revoke an acknowledged server lease',async t=>{
 t.mock.method(console,'warn',()=>{});
 let resolveA,aborts=0,cancels=0;const calls=[];
 const executor={listRunningJobIds:()=>['a','b'],getJob:()=>({startedAt:new Date().toISOString(),leaseToken:'fixture'}),abortForLease:async()=>{aborts++},cancelJob:async()=>{cancels++}};
 const client={jobHeartbeat:async id=>{calls.push(id);if(id==='a') await new Promise(r=>resolveA=r);return {control:'continue'}}};
 const pending=sendJobHeartbeats({executor,client});await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['a','b']);
 await sendJobHeartbeats({executor,client});assert.deepEqual(calls,['a','b','b']);resolveA();await pending;
 client.jobHeartbeat=async()=>{throw new Error('HTTP timeout after server renewal')};
 for(let i=0;i<24;i++)await sendJobHeartbeats({executor,client});assert.equal(aborts,0);
 client.jobHeartbeat=async()=>{throw new LeaseInvalidError('revoked')};await sendJobHeartbeats({executor,client});assert.equal(aborts,2);
 client.jobHeartbeat=async()=>({control:'cancel'});await sendJobHeartbeats({executor,client});assert.equal(cancels,2);
});
let hasFfmpeg=true;try{execFileSync('ffmpeg',['-version'],{stdio:'ignore'});}catch{hasFfmpeg=false;}
const video=join(TEST_TMP_ROOT,'valid.mp4');
if(hasFfmpeg)execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=96x64:rate=10','-t','2','-threads','1','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',video]);
test('header-only and truncated MP4 cannot be accepted as completed video',{skip:!hasFfmpeg},async()=>{
 const valid=await validateVideo(video);assert.equal(valid.width,96);assert.equal(valid.duration_ms,2000);
 const header=join(TEST_TMP_ROOT,'header.mp4');await writeFile(header,Buffer.alloc(48));await assert.rejects(validateVideo(header),{code:'E_INVALID_VIDEO'});
 const broken=join(TEST_TMP_ROOT,'truncated.mp4');await copyFile(video,broken);await truncate(broken,Math.floor(valid.size_bytes*0.65));
 await assert.rejects(validateVideo(broken),{code:'E_INVALID_VIDEO'});
});
async function settleFixture(valid) {
 const sid='sess_'+randomUUID(),jid='job_'+randomUUID(),{agentWs,bookDir}=resolveJobPaths(sid,jid);
 await mkdir(join(agentWs,'output'),{recursive:true});await mkdir(bookDir,{recursive:true});
 if(valid)await copyFile(video,join(agentWs,'output/final.mp4'));else await writeFile(join(agentWs,'output/final.mp4'),Buffer.alloc(48));
 const log=join(agentWs,'claude.jsonl');await writeFile(log,JSON.stringify({type:'result',is_error:false,result:'finished'})+'\n');
 await writeFile(join(bookDir,'.running.json'),'{}');
 let outcome;
 const pending=runner.settleDeadJob({job_id:jid,session_id:sid,mode:'experimental',lease_token:'fixture',pid:2000000000,pgid:null,
 job_dir:bookDir,agent_ws:agentWs,out_dir:join(agentWs,'output'),log_path:log,started_at:new Date(Date.now()-5000).toISOString()},
 {onComplete:meta=>{outcome='completed';assert.ok(existsSync(join(bookDir,'.done')));assert.ok(runner.getJob(jid));},onFail:e=>{outcome=e.code;}});
 await new Promise(r=>setTimeout(r,40));assert.equal(runner.getJob(jid).phase,'FINALIZING');assert.ok(existsSync(join(bookDir,'.running.json')));
 await pending;assert.equal(runner.getJob(jid),undefined);assert.ok(!existsSync(join(bookDir,'.running.json')));
 return {outcome,bookDir};
}
test('settlement remains discoverable until durable marker; invalid video is failed, valid video is pinned',{skip:!hasFfmpeg},async()=>{
 const bad=await settleFixture(false);assert.equal(bad.outcome,'E_INVALID_VIDEO');assert.ok(!existsSync(join(bad.bookDir,'.done')));
 const good=await settleFixture(true);assert.equal(good.outcome,'completed');const marker=JSON.parse(await readFile(join(good.bookDir,'.done')));
 assert.ok(marker.validation.full_decode);assert.equal(marker.storage_path,join(good.bookDir,'final.mp4'));
});
