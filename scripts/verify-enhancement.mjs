#!/usr/bin/env node
/** Separate opt-in feature verification; standard smoke continues to use enhance:false. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
execFileSync('python3',[join(root,'scripts/guard-isolation.py')]);
const cfg=JSON.parse(await readFile(join(root,'config/backend.json')));
const base=`http://${cfg.deployment.web.host}:${cfg.deployment.web.port}`;
const out=join(root,'runtime/validation/enhancement');
await mkdir(out,{recursive:true});
let cookie, jobId;
async function request(path,body,expected=200){
  const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(cookie?{cookie}:{}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30_000)});
  const data=await r.json(); assert.equal(r.status,expected,JSON.stringify(data).slice(0,400));
  return {data,headers:r.headers};
}
const report={started_at:new Date().toISOString(),states:[]};
const save=()=>writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
try{
  const credentials=JSON.parse(await readFile(join(root,'runtime/test-account.json')));
  cookie=(await request('/api/auth/login',credentials)).headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/auth/me')).data.user.role,'user');
  const session=(await request('/api/sessions',{mode:'coding_to_video'},201)).data.session;
  const prompt='Create exactly a 2-second 640x360 24fps silent video showing one blue circle moving from left to right on a white background. Keep it minimal, with no text, no other elements, and no external assets. Save a playable H.264 MP4 to output/final.mp4.';
  const j=(await request(`/api/sessions/${session.id}/jobs`,{prompt,enhance:true,idempotency_key:randomUUID(),max_runtime_seconds:900},202)).data.job;
  jobId=j.id; report.job_id=jobId; report.session_id=session.id; await save();
  let previous='',lastPrint=0,done;
  for(const deadline=Date.now()+20*60_000;Date.now()<deadline;){
    const job=(await request(`/api/jobs/${jobId}`)).data.job;
    if(job.status!==previous){report.states.push({status:job.status,at:new Date().toISOString()});previous=job.status;await save();}
    if(Date.now()-lastPrint>45_000){console.log(jobId,job.status);lastPrint=Date.now();}
    if(['COMPLETED','FAILED','CANCELLED','OUT_OF_SCOPE'].includes(job.status)){done=job;break;}
    await request(`/api/sessions/${session.id}/presence`,{tab_id:'enhancement-verification'});
    await new Promise(r=>setTimeout(r,5000));
  }
  assert.ok(done,'Timed out');
  report.status=done.status;report.enhancement=done.enhancement;report.failure=done.failure;await save();
  assert.equal(done.status,'COMPLETED');
  assert.equal(done.enhancement.skipped,false,JSON.stringify(done.enhancement));
  const asset=done.result_asset;assert.ok(asset?.playable);
  const video=await fetch(base+asset.download_url,{headers:{cookie},signal:AbortSignal.timeout(60_000)});
  assert.equal(video.status,200);
  await writeFile(join(out,'enhanced.mp4'),Buffer.from(await video.arrayBuffer()));
  report.passed=true;report.finished_at=new Date().toISOString();await save();
  console.log('PASS enhanced prompt -> generation -> playable asset',jobId);
}catch(e){report.passed=false;report.error=e.message;await save();throw e;}
finally{
  if(jobId){const job=(await request(`/api/jobs/${jobId}`)).data.job;
    if(!['COMPLETED','FAILED','CANCELLED','OUT_OF_SCOPE'].includes(job.status))await request(`/api/jobs/${jobId}/cancel`,{},202);
  }
}
