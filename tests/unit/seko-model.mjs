import '../fixtures.mjs';
import { TEST_TMP_ROOT } from '../fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { saveSekoModel, sekoSelectionForUser, sekoSettings, sekoSelection, sekoConnection, checkSekoConnection, prepareSekoConnection } from '../../apps/shared/seko-model.mjs';
import { modelSettingsRoutes } from '../../apps/gateway/src/model-settings-routes.mjs';
const raw={model_settings:{root:join(TEST_TMP_ROOT,'seko-models')},whitebox:{default_model:'whitebox-deepseek',models:[{id:'whitebox-deepseek',channels:[{endpoint:'https://tokenhub.invalid',model:'deepseek/sfb',api_key_env:'SEKO_FIXTURE_KEY'}]}]}};
process.env.SEKO_FIXTURE_KEY='test-private-secret';
test('whitebox immutable model snapshots cannot modify other model purposes or expose keys',()=>{
 const baseline=JSON.stringify(raw),one=sekoSelection(raw);
 assert.equal(one.harness,'seko-v1'); assert.ok(!JSON.stringify(one).includes(process.env.SEKO_FIXTURE_KEY));
 saveSekoModel(raw,{kind:'intranet',endpoint:'http://127.0.0.1:4444',model:'internal',protocol:'chat',max_context_tokens:524288});
 const two=sekoSelection(raw);assert.notEqual(one.profile_id,two.profile_id);
 assert.equal(sekoConnection(raw,one).api_key,'test-private-secret');assert.equal(sekoConnection(raw,two).api_key,'');
 assert.equal(sekoConnection(raw,two).max_context_tokens,524288);assert.equal(JSON.stringify(raw),baseline);
 assert.throws(()=>prepareSekoConnection(raw,{kind:'tokenhub',endpoint:'https://new.invalid',model:'abc',api_key:''}));
 assert.throws(()=>sekoConnection(raw,{...one,revision:'wrong'}));
});
test('nonadministrators cannot change or check whitebox configuration',async()=>{
 const routes=modelSettingsRoutes({config:{raw},currentUser:()=>({username:'test'}),users:{get:async()=>({role:'user',status:'active'})}});
 for(const key of ['GET /api/admin/whitebox/model','PATCH /api/admin/whitebox/model','POST /api/admin/whitebox/model/check'])await assert.rejects(routes[key]({},{}),e=>e.status===403);
});
test('intranet connectivity uses actual protocol and no authorization; incomplete responses fail',async()=>{
 let body={choices:[{message:{content:'OK'},finish_reason:'stop'}]};
 const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,undefined);assert.equal(req.headers['x-api-key'],undefined);assert.equal(req.url,'/v1/chat/completions');res.end(JSON.stringify(body));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {const c={kind:'intranet',endpoint:'http://127.0.0.1:'+server.address().port,model:'local',protocol:'chat'};
 assert.equal((await checkSekoConnection(c)).ok,true);body={choices:[{message:{content:'partial'},finish_reason:'length'}]};assert.equal((await checkSekoConnection(c)).ok,false);
 }finally{await new Promise(r=>server.close(r));}
});

test('whitebox Responses config normalizes endpoint and probes actual complete output',async()=>{
 let payload={status:'completed',output:[{type:'reasoning',encrypted_content:'preserve'},{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'OK'}]}]};
 const requests=[];const server=http.createServer((req,res)=>{let text='';req.on('data',b=>text+=b);req.on('end',()=>{requests.push({url:req.url,body:JSON.parse(text),auth:req.headers.authorization});res.end(JSON.stringify(payload));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const c=prepareSekoConnection(raw,{kind:'intranet',endpoint:'http://127.0.0.1:'+server.address().port+'/v1/responses',model:'gpt-6.1-sol/fixture',protocol:'responses',max_context_tokens:262144});
  assert.equal(c.family,'gpt');assert.equal(c.protocol,'responses');assert.equal(c.api_key,'');assert.equal((await checkSekoConnection(c)).ok,true);
  assert.equal(requests[0].url,'/v1/responses');assert.equal(requests[0].auth,undefined);assert.equal(requests[0].body.reasoning.effort,'low');assert.equal(requests[0].body.max_tokens,undefined);assert(requests[0].body.input);
  payload={...payload,status:'incomplete'};assert.equal((await checkSekoConnection(c)).ok,false);
  payload={...payload,status:'completed',output:[{type:'message',role:'assistant',status:'in_progress',content:[{type:'output_text',text:'partial'}]}]};assert.equal((await checkSekoConnection(c)).ok,false);
 }finally{await new Promise(r=>server.close(r));}
});

test('GPT bootstrap and saved connections preserve Responses and configured output limits',()=>{
 const gpt={model_settings:{root:join(TEST_TMP_ROOT,'gpt-bootstrap')},whitebox:{models:[{id:'whitebox-gpt',protocol:'responses',max_output_tokens:32768,channels:[{endpoint:'https://tokenhub.invalid',model:'gpt-6.1-sol/fixture',api_key_env:'SEKO_FIXTURE_KEY'}]}]}};
 const one=sekoSelection(gpt),c=sekoConnection(gpt,one);
 assert.equal(c.family,'gpt');assert.equal(c.protocol,'responses');assert.equal(c.max_output_tokens,32768);assert.equal(c.max_context_tokens,524288);
 const changed=prepareSekoConnection(gpt,{kind:'tokenhub',endpoint:c.endpoint,model:'gpt-6.1-sol/second',protocol:'responses',max_context_tokens:262144,max_output_tokens:16384});
 assert.equal(changed.max_output_tokens,16384);saveSekoModel(gpt,changed);
 assert.equal(sekoConnection(gpt,one).max_output_tokens,32768);assert.equal(sekoConnection(gpt,one).max_context_tokens,524288);
 assert.equal(sekoConnection(gpt,sekoSelection(gpt)).max_output_tokens,16384);
 assert.throws(()=>prepareSekoConnection(gpt,{...changed,max_output_tokens:262144}));
});


test('allowlisted batch model is pinned without changing the global default or exposing credentials',()=>{
 const before=sekoSelection(raw);
 const saved=saveSekoModel(raw,{kind:'intranet',endpoint:'http://127.0.0.1:4455',model:'batch-second',protocol:'chat'},{makeDefault:false});
 assert.equal(sekoSelection(raw).profile_id,before.profile_id);
 const cfg={...raw,whitebox:{...raw.whitebox,model_access:{batch:[saved.profile_id]}}};
 const user={id:'batch',status:'active'};
 const selected=sekoSelectionForUser(cfg,user,saved.profile_id);
 assert.equal(selected.profile_id,saved.profile_id);assert.equal(selected.skill_version,'0.1.13');
 assert.equal(sekoConnection(cfg,selected).model,'batch-second');
 assert.equal(sekoSettings(cfg,user).models.length,2);
 assert.equal(sekoSettings(cfg,{id:'peer',status:'active'}).models.length,1);
 assert.throws(()=>sekoSelectionForUser(cfg,{id:'peer',status:'active'},saved.profile_id),e=>e.status===403);
 assert.throws(()=>sekoSelectionForUser(cfg,{...user,status:'disabled'},saved.profile_id),e=>e.status===403);
 assert.throws(()=>sekoSelectionForUser(cfg,user,'seko-00000000000000000000000000000000'),e=>e.status===403);
 assert.equal('api_key'in selected,false);
 assert.equal(sekoSelection(raw).profile_id,before.profile_id);
});

test('public skill metadata follows the configured release including rollback',()=>{
 for(const version of ['0.1.12','0.1.13']){
  const release=`seko-${version}-cvw.1`;
  const settings=sekoSettings({...raw,whitebox:{...raw.whitebox,seko_release:release}});
  assert.equal(settings.skills[0].version,version);assert.equal(settings.skills[0].release,release);
  assert.equal(settings.default_skills.configured[0].release,release);
  assert.equal(settings.models[0].engine_release,release);
 }
});
