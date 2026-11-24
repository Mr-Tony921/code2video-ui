import '../fixtures.mjs';
import { TEST_TMP_ROOT } from '../fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { saveSekoModel,sekoSelection } from '../../apps/shared/seko-model.mjs';
process.env.CVW_GATEWAY_BASE_URL='http://127.0.0.1:1';process.env.CVW_INTERNAL_TOKEN='fixture-seko';
const {config}=await import('../../apps/worker-bridge/src/config.mjs');
const runner=await import('../../apps/worker-bridge/src/job-runner.mjs');
const source=readFileSync(new URL('./fixtures/seko-source.mjs',import.meta.url),'utf8');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const flowRelease=process.env.SEKO_TEST_RELEASE;
const noninteractive = flowRelease && readFileSync(new URL(`../../assets/whitebox-seko/releases/${flowRelease}/engine/python/seko_engine/intake.py`,import.meta.url),'utf8').includes('NONINTERACTIVE = True');
const fastIntake=process.env.SEKO_TEST_FAST_INTAKE==='1';
const naturalPrompt=(fastIntake?'人物A向右移动并停下。总共4秒。\n片段1：移动\n时长：2秒\n分镜1 人物A向右移动。\n片段2：停下\n时长：2秒\n分镜1 人物A停下。':'人物A向右移动并停下。总共4秒。\n片段1：移动，2秒\n分镜1 人物A向右移动。\n片段2：停下，2秒\n分镜1 人物A停下。');
const prompt='用户要求：完整故事一次生成。\n'+JSON.stringify({version:2,duration:4,work_prompt:'人物A向右移动并停下。',segments:[{id:'a',title:'移动',start:0,end:2,duration:2,resolved_duration:2,prompt:'【镜头1】时长：2秒 人物A向右移动。'},{id:'b',title:'停下',start:2,end:4,duration:2,resolved_duration:2,prompt:'【镜头1】时长：2秒 人物A停下。'}]});
test('new whitebox harness uses shared execution slots, cancels only its own process and retains immutable artifacts', {timeout:180000}, async()=>{
 const requests=[];
 const server=http.createServer(async(req,res)=>{
  let text='';for await(const c of req)text+=c;
  const b=JSON.parse(text);requests.push(b);assert.equal(req.headers.authorization,undefined);
  const p=b.messages.find(m=>m.role==='user').content[0].text;
  if(p.includes('CONTROL_CONTEXT_FIXTURE') && p.includes('CURRENT_REVIEW_SCOPE:')) { res.statusCode=400;res.end(JSON.stringify({error:{code:'context_length_exceeded',message:'maximum context length exceeded'}}));return; }
  let answer;
  if(p.includes('SOURCE_LINES:')) {
    assert.ok(p.includes('人物A向右移动并停下。'));
    answer=JSON.stringify({action:'generate',segments:[{title:'移动',first_line:2,last_line:3,duration:2},{title:'停下',first_line:4,last_line:5,duration:2}]});
  } else if(p.includes('intake stage for a Seko')) {
    if(noninteractive){assert.ok(!p.includes('{"action":"clarify"'));assert.ok(p.includes('Never return clarify or wait for the user'));}
    const current=JSON.parse(p.split('SAVED_CONVERSATION (recent turns verbatim; earlier edits are in CURRENT_SOURCE/latest delivered project):\n')[1]).at(-1).user;
    answer=JSON.stringify(current.includes('先解释人物') ? {action:'answer',text:'当前工程有一名人物。'} : current.includes('改好看点') ? (noninteractive ? {action:'answer',text:'已有工程保留。当前没有明确修改范围，采用维持原方案的保守处理。'} : {action:'clarify',text:'请说明希望调整哪个镜头或人物。'}) : {action:'refine',request:'修改第一镜头相机'});
  } else if(p.includes('CURRENT CALL: Refine')) {
    const numbered=p.includes('CURRENT_SOURCE_SHA256:');
    if(numbered){
      assert.ok(p.includes('CURRENT_SOURCE_SHA256: '+createHash('sha256').update(source).digest('hex')));
      const lines=p.split('CURRENT_SOURCE (1-based line labels are metadata, not JavaScript):\n')[1].split('\nREQUEST:')[0].trimEnd().split('\n');
      assert.equal(lines.map((line,i)=>{assert.ok(line.startsWith(`L${i+1}: `));return line.slice(line.indexOf(': ')+2);}).join('\n')+'\n',source);
    }else assert.ok(p.includes('CURRENT_SOURCE:') && p.includes(source.trim()));
    assert.ok(!p.includes('Earlier project from another account'));
    const old='{time:s.start,position:[2,2,5],target:[0,1,0]}',replacement='{time:s.start,position:s.start===0?[2,2,4.5]:[2,2,5],target:[0,1,0]}';
    const sourceLines=source.trimEnd().split('\n'),index=sourceLines.findIndex(line=>line.includes(old));assert.ok(index>=0);
    answer=JSON.stringify(numbered?{source_sha256:createHash('sha256').update(source).digest('hex'),line_edits:[{start_line:index+1,end_line:index+1,new_lines:[sourceLines[index].replace(old,replacement)]}]}:{replacements:[{old,new:replacement}]});
  } else if(p.includes('CURRENT CALL: Author')) { assert.ok(p.includes('用户要求：完整故事一次生成。') || (flowRelease && p.includes('人物A向右移动并停下。')));answer=source; }
  else if(p.includes('CURRENT_REVIEW_SCOPE:')) {
    const ids=JSON.parse(p.split('CURRENT_REVIEW_SCOPE:')[1].split('\n')[0]);
    const pages=JSON.parse(p.split('PAGES:')[1].split('\nTECHNICAL_CHECKS:')[0]);
    answer=JSON.stringify({seen:pages,shots:ids.map(id=>({id,verdict:'pass',core:'met',simplification:'none',requirement:'Fixture actor visible',observed:'Fixture actor visible',contacts:[],evidence:[pages[0]]})),issues:[],warnings:[]});
  } else { res.statusCode=500;res.end(JSON.stringify({error:'Unexpected fixture model phase'}));return; }
  await sleep(250);res.end(JSON.stringify({choices:[{message:{content:answer,reasoning_content:'fixture reasoning',reasoning_signature:'fixture-signature'},finish_reason:'stop'}]}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 config.raw.model_settings={root:join(TEST_TMP_ROOT,'models')};
 config.raw.whitebox={enabled:true,default_model:'whitebox-deepseek',models:[{id:'whitebox-deepseek',channels:[{model:'fixture',endpoint:'http://127.0.0.1',api_key_env:'unused'}]}]};
 saveSekoModel(config.raw,{kind:'intranet',endpoint:'http://127.0.0.1:'+server.address().port,model:'fixture',max_context_tokens:262144});
 if(flowRelease)config.raw.whitebox.seko_release=flowRelease;
 const selection=sekoSelection(config.raw);config.worker.maxConcurrentJobs=2;
 const ids=[];const futures=[];
 try {
  for(let i=0;i<2;i++) {
    const sid='sess_'+randomUUID(),jid='job_'+randomUUID();ids.push({sid,jid});
    let done;const finished=new Promise(r=>done=r);futures.push(finished);
    await runner.startJob({sessionId:sid,jobId:jid,mode:'blockout_3d',prompt:flowRelease && i===0 ? naturalPrompt : prompt,experimentalSkills:{builtin:'none'},modelSelection:selection,leaseToken:'fixture',maxRuntimeSeconds:0,
      hooks:{onComplete:meta=>done({meta}),onFail:failure=>done({failure}),onCancelled:meta=>done({cancelled:meta})}});
  }
  assert.equal(runner.runningCount(),2);
  await runner.cancelJob(ids[1].jid,'fixture cancel',.1);
  const [a,b]=await Promise.all(futures);
  assert.ok(a.meta,JSON.stringify(a));assert.ok(b.cancelled,JSON.stringify(b));assert.equal(runner.runningCount(),0);
  const book=join(config.storage.sessionsRoot,config.storage.sessionsSubdir,ids[0].sid,'rounds',ids[0].jid);
  const result=JSON.parse(readFileSync(join(book,'seko/result.json')));
  assert.equal(result.scene_success,true);assert.equal(result.status,'self_checked');assert.equal(result.structure_pass,true);assert.equal(result.shot_count,2);assert.equal(result.repairs,0);
  const trace=readFileSync(join(book,'seko/trace/events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(trace.some(e=>e.kind==='model_reply'));assert.ok(trace.some(e=>e.kind==='tool_call'));
  assert.ok(trace.some(e=>e.kind==='tool_result'));assert.ok(trace.every(e=>!('seconds'in e)));
  assert.ok(existsSync(join(book,'seko/diagnostics/operations.jsonl')));
  assert.ok(existsSync(join(book,'seko/source.zip')));assert.ok(a.meta.duration_ms>=3990);
  assert.equal(result.timings.api_calls,flowRelease&&!fastIntake?3:2);
  assert.equal(result.timings.api_complete_calls,result.timings.api_calls);
  assert.equal(result.timings.engineering_excluding_measured_upload_seconds,Math.max(0,result.timings.engineering_seconds-result.timings.api_upload_seconds));

  assert.equal(readFileSync(join(book,'seko/capture/0001/response.json'),'utf8').includes('fixture-signature'),true);
  if(flowRelease){assert.equal(result.user_prompt,naturalPrompt);assert.ok(result.timings.intake_seconds>0);if(fastIntake)assert.equal(JSON.parse(readFileSync(join(book,'seko/intake-input-map.json'))).model_calls,0);assert.equal(JSON.parse(readFileSync(join(book,'seko/intake-input-map.json'))).source_text_rewritten,false);}
  assert.ok(requests.length>=(flowRelease&&!fastIntake?3:2) && requests.length<=(flowRelease&&!fastIntake?4:3)); // cancelled work may have sent one request before cancellation
  const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
  const sourceZip=join(book,'seko/source.zip'),before=hash(sourceZip);
  const runFollowup=async prompt=>{
    const jid='job_'+randomUUID();ids.push({sid:ids[0].sid,jid});let done;const finished=new Promise(r=>done=r);
    await runner.startJob({sessionId:ids[0].sid,jobId:jid,mode:'blockout_3d',prompt,experimentalSkills:{builtin:'none'},modelSelection:selection,leaseToken:'fixture',maxRuntimeSeconds:0,hooks:{onComplete:meta=>done({meta}),onFail:failure=>done({failure})}});
    const completion=await finished;assert.ok(completion.meta,JSON.stringify(completion));
    for(let i=0;i<30&&runner.runningCount();i++)await sleep(50);
    const dir=join(config.storage.sessionsRoot,config.storage.sessionsSubdir,ids[0].sid,'rounds',jid,'seko');
    return {dir,result:JSON.parse(readFileSync(join(dir,'result.json')))};
  };
  if(noninteractive){const conservative=await runFollowup('改好看点');assert.equal(conservative.result.status,'answered');assert.ok(!conservative.result.message.includes('？'));} else {const clarify=await runFollowup('改好看点');assert.equal(clarify.result.status,'waiting_user');assert.equal(clarify.result.scene_success,false);assert.equal(existsSync(join(clarify.dir,'output/final.mp4')),false);}
  const answer=await runFollowup('先解释人物');assert.equal(answer.result.status,'answered');assert.equal(answer.result.scene_success,false);
  const edited=await runFollowup('只把第一镜头相机焦距稍微调近一点，其余保持不变');assert.equal(edited.result.scene_success,true);assert.equal(edited.result.parent_job_id,ids[0].jid);assert.equal(edited.result.repairs,0);assert.equal(hash(sourceZip),before);
  const job=JSON.parse(readFileSync(join(edited.dir,'run/job.json')));assert.equal(job.kind,'source_refinement');assert.equal(job.max_repairs,1);
  assert.equal(existsSync(join(edited.dir,'run/plan-request.json')),false);
  // Simulate the service owner exiting: task stdout stays a file and the new
  // owner adopts the same Python PID. No duplicate model generation is allowed.
  const adoptSid='sess_'+randomUUID(),adoptJid='job_'+randomUUID();ids.push({sid:adoptSid,jid:adoptJid});
  const fixtureConfig=join(TEST_TMP_ROOT,'adoption-config.json');
  writeFileSync(fixtureConfig,JSON.stringify(config.raw));
  const params={sessionId:adoptSid,jobId:adoptJid,mode:'blockout_3d',prompt,experimentalSkills:{builtin:'none'},modelSelection:selection,leaseToken:'fixture',maxRuntimeSeconds:0};
  const starter=join(TEST_TMP_ROOT,'start-adoption.mjs');
  writeFileSync(starter,`const runner=await import(${JSON.stringify(new URL('../../apps/worker-bridge/src/job-runner.mjs',import.meta.url).href)});await runner.startJob(${JSON.stringify(params)});process.exit(0);`);
  const child=spawn(process.execPath,[starter],{env:{...process.env,CVW_BACKEND_CONFIG:fixtureConfig},stdio:'ignore'});
  const exit=await new Promise(r=>child.on('exit',r));assert.equal(exit,0);
  let adoptedDone;const adoptedFinished=new Promise(r=>adoptedDone=r);
  const {adoptRunningJobs}=await import('../../apps/worker-bridge/src/job-adopter.mjs');
  const adopted=await adoptRunningJobs(()=>({onComplete:meta=>adoptedDone({meta}),onFail:failure=>adoptedDone({failure})}));
  assert.ok(adopted.adopted.includes(adoptJid));
  const resultAfterRestart=await adoptedFinished;assert.ok(resultAfterRestart.meta,JSON.stringify(resultAfterRestart));
  for(let i=0;i<30&&runner.runningCount();i++)await sleep(50);
  assert.equal(runner.runningCount(),0);

  // A real model context rejection is a control failure, not a scene repair.
  const contextSid='sess_'+randomUUID(),contextJid='job_'+randomUUID();ids.push({sid:contextSid,jid:contextJid});
  let contextDone;const contextFinished=new Promise(r=>contextDone=r);
  await runner.startJob({sessionId:contextSid,jobId:contextJid,mode:'blockout_3d',prompt:prompt.replace('人物A向右移动并停下。','CONTROL_CONTEXT_FIXTURE'),experimentalSkills:{builtin:'none'},modelSelection:selection,leaseToken:'fixture',maxRuntimeSeconds:0,hooks:{onComplete:meta=>contextDone({meta}),onFail:failure=>contextDone({failure})}});
  const contextCompletion=await contextFinished;assert.ok(contextCompletion.meta,JSON.stringify(contextCompletion));
  const contextDir=join(config.storage.sessionsRoot,config.storage.sessionsSubdir,contextSid,'rounds',contextJid,'seko');
  const contextResult=JSON.parse(readFileSync(join(contextDir,'result.json')));assert.equal(contextResult.status,'renderable_with_issues');assert.equal(contextResult.repairs,0);assert.ok(contextResult.issues.some(x=>x.message?.includes('上下文超限')));
  assert.equal(requests.filter(b=>b.messages.find(m=>m.role==='user').content[0].text.includes('CONTROL_CONTEXT_FIXTURE')).length,2);
  const receipt=JSON.parse(readFileSync(join(contextDir,'capture/0002/receipt.json')));assert.equal(receipt.failure_kind,'context_limit');

 } finally {for(const {jid} of ids)if(runner.getJob(jid))await runner.cancelJob(jid,'cleanup',.1);server.closeAllConnections();await new Promise(r=>server.close(r));}
});
