import '../fixtures.mjs';
import { TEST_TMP_ROOT } from '../fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { saveSekoModel, sekoSelection, sekoConnection, checkSekoConnection, prepareSekoConnection } from '../../apps/shared/seko-model.mjs';
import { modelSettingsRoutes } from '../../apps/gateway/src/model-settings-routes.mjs';
const raw={model_settings:{root:join(TEST_TMP_ROOT,'seko-models')},whitebox:{models:[{id:'whitebox-deepseek',channels:[{endpoint:'https://tokenhub.invalid',model:'deepseek/sfb',api_key_env:'SEKO_FIXTURE_KEY'}]}]}};
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
