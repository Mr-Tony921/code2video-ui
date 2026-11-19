import '../fixtures.mjs';
import { TEST_TMP_ROOT } from '../fixtures.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeConnection, normalizeEndpoint, saveModel, lastPersonalModel, adminModelViews,
  resolveManagedModel, c2vModelSnapshot, canUsePersonalModel, prepareConnection, checkConnection } from '../../apps/shared/model-settings.mjs';
import { modelSettingsRoutes } from '../../apps/gateway/src/model-settings-routes.mjs';
const raw = { model_settings: { root: join(TEST_TMP_ROOT, 'model-settings') },
  model: { base_url: 'http://original-model:8000', model: 'original', max_context_tokens: 524288 },
  prompt_enhancement: { aux_model: { base_url: 'https://tokenhub.example.test', model: 'opus', api_key: 'original-enhancer-key' } } };
const input = { kind: 'tokenhub', endpoint: 'https://tokenhub.example.test/v1/messages', model: 'sfb', api_key: 'fixture-secret-123456789' };

test('connection validation requires tokenhub keys, handles internal service strings and rejects credential URLs', () => {
  assert.equal(normalizeEndpoint('model.ns.svc.cluster.local', 'intranet'), 'http://model.ns.svc.cluster.local:8000');
  assert.equal(normalizeEndpoint('10.0.0.1:12345', 'intranet'), 'http://10.0.0.1:12345');
  assert.equal(normalizeEndpoint('https://tokenhub.example.test/v1/messages', 'tokenhub'), 'https://tokenhub.example.test');
  assert.throws(() => normalizeConnection({ ...input, api_key: '' }), /需要填写 Key/);
  assert.throws(() => normalizeConnection({ ...input, api_key: 'sk-13****121' }), /需要填写 Key/);
  assert.throws(() => normalizeEndpoint('http://name:password@host', 'intranet'));
  assert.throws(() => normalizeEndpoint('file:///etc/passwd', 'tokenhub'));
  assert.throws(() => normalizeEndpoint('a b', 'intranet'));
  assert.equal(normalizeConnection({ kind: 'intranet', endpoint: 'host', model: 'local' }).api_key, '');
});

test('personal credentials are isolated, masked, kept across blank edits and immutable for existing sessions', () => {
  const first = saveModel(raw, 'experimental', 'alice', input);
  assert.equal(first.key_mask, 'fixtur****789');
  assert.ok(!JSON.stringify(first).includes(input.api_key));
  assert.equal(lastPersonalModel(raw, 'bob'), null);
  assert.ok(canUsePersonalModel(raw, first, 'alice'));
  assert.equal(canUsePersonalModel(raw, first, 'bob'), false);
  assert.throws(() => prepareConnection(raw, 'experimental', 'bob', { ...input, reference_id: first.profile_id, api_key: '' }), /无权/);
  const saved = saveModel(raw, 'experimental', 'alice', { ...input, endpoint: first.endpoint, api_key: '', reference_id: first.profile_id });
  assert.equal(saved.profile_id, first.profile_id);
  const second = saveModel(raw, 'experimental', 'alice', { ...input, api_key: 'new-fixture-key' });
  assert.notEqual(second.profile_id, first.profile_id);
  assert.equal(resolveManagedModel(raw, first).apiKey, input.api_key);
  assert.equal(resolveManagedModel(raw, second).apiKey, 'new-fixture-key');
  assert.throws(() => prepareConnection(raw, 'experimental', 'alice', { ...input, endpoint: 'https://different.example.test', api_key: '' }), /需要填写 Key/);
  assert.throws(() => resolveManagedModel(raw, { ...first, revision: 'stale' }), /版本不匹配/);
  for (const f of readdirSync(raw.model_settings.root)) assert.equal(statSync(join(raw.model_settings.root, f)).mode & 0o777, 0o600);
  assert.equal(statSync(raw.model_settings.root).mode & 0o777, 0o700);
});

test('C2V defaults preserve old credential snapshots and leave primary/whitebox settings unchanged', () => {
  const original = JSON.stringify(raw);
  const one = saveModel(raw, 'c2v', 'admin', input);
  assert.equal(c2vModelSnapshot(raw).profile_id, one.profile_id);
  assert.equal(canUsePersonalModel(raw, one, 'admin'), false);
  const two = saveModel(raw, 'c2v', 'admin', { kind: 'intranet', endpoint: '10.0.0.2:8000', model: 'next' });
  assert.equal(c2vModelSnapshot(raw).profile_id, two.profile_id);
  assert.equal(resolveManagedModel(raw, one).model, 'sfb');
  assert.equal(resolveManagedModel(raw, two).apiKey, 'sk-local-proxy');
  assert.equal(adminModelViews(raw).c2v.has_key, false);
  assert.equal(JSON.stringify(raw), original);
});

test('connectivity checks test authenticated model inference, reject incomplete 200 replies and redact provider errors', async () => {
  const c=normalizeConnection(input);
  const good=await checkConnection(c,{ fetchImpl: async (url, options) => {
    assert.equal(url,'https://tokenhub.example.test/v1/messages');
    assert.equal(options.headers['x-api-key'],input.api_key);
    assert.equal(JSON.parse(options.body).model,'sfb');
    return new Response(JSON.stringify({ stop_reason:'end_turn', content:[{type:'text',text:'OK'}] }));
  } });
  assert.equal(good.ok,true);
  const bad=await checkConnection(c,{ fetchImpl: async () => new Response(JSON.stringify({error:{message:input.api_key}}),{status:403}) });
  assert.equal(bad.ok,false); assert.equal(bad.http_status,403); assert.ok(!JSON.stringify(bad).includes(input.api_key));
  assert.equal((await checkConnection(c,{fetchImpl:async()=>new Response('{}')})).ok,false);
  assert.equal((await checkConnection(c,{fetchImpl:async()=>{throw Object.assign(new Error(input.api_key),{name:'TimeoutError'});}})).ok,false);
});

test('model routes check current administrator role and experimental permissions before touching credentials', async () => {
  let signed={username:'test'}, permission=false;
  const views={test:{id:'test',role:'user',status:'active'},admin:{id:'admin',role:'admin',status:'active'}};
  const routes=modelSettingsRoutes({config:{raw},currentUser:()=>signed,users:{get:async id=>views[id]},
    experimentalUser:async()=>{if(!permission)throw Object.assign(new Error('permission'),{status:403});return views.test;},
    readJson:async req=>req.body,json:(res,status,body)=>Object.assign(res,{status,body})});
  const get=routes['GET /api/admin/models'];
  await assert.rejects(get({},{}),{status:403});
  signed=null; await assert.rejects(get({},{}),{status:401});
  signed={username:'admin'};
  const res={};await get({},res);assert.equal(res.status,200);assert.ok(!JSON.stringify(res.body).includes('original-enhancer-key'));
  await assert.rejects(routes['POST /api/experimental/custom-model']({body:input},{}),{status:403});
  permission=true;
  const personal={};await routes['POST /api/experimental/custom-model']({body:input},personal);
  assert.equal(personal.status,200);assert.equal(canUsePersonalModel(raw,personal.body.model,'test'),true);
  assert.ok(!JSON.stringify(personal.body).includes(input.api_key));
});
