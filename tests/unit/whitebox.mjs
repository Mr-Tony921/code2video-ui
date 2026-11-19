import '../fixtures.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { TEST_TMP_ROOT } from '../fixtures.mjs';
import { WorkerPool } from '../../apps/gateway/src/worker-pool.mjs';
import { whiteboxModels, resolveWhiteboxModel, prepareWhiteboxSkills, newWhiteboxModels, defaultWhiteboxModel, resolveNewWhiteboxModel } from '../../apps/shared/whitebox.mjs';
import { toResponses, fromResponses, anthropicSSE } from '../../apps/shared/responses-adapter.mjs';
import { createWhiteboxProxy, whiteboxToken } from '../../apps/worker-bridge/src/whitebox-proxy.mjs';
const raw = { environment: { name: 'dev' }, whitebox: { enabled: true, models: [{
  id: 'whitebox-fixture', name: 'Fixture', max_context_tokens: 200000, max_output_tokens: 32768,
  channels: [1, 2].map(i => ({ model: `model/channel${i}`, endpoint: 'http://models.test', api_key: `fixture-${i}` })),
}] } };

test('whitebox families pin all channels; key rotation keeps sessions, model mutation does not', () => {
  const [selected] = whiteboxModels(raw); assert.equal(selected.channels.length, 2);
  assert.ok(!JSON.stringify(selected).includes('fixture-1'));
  const rotated = structuredClone(raw); rotated.whitebox.models[0].channels[0].api_key = 'new';
  assert.equal(resolveWhiteboxModel(rotated, selected).channels[0].apiKey, 'new');
  rotated.whitebox.models[0].channels[1].model = 'different';
  assert.throws(() => resolveWhiteboxModel(rotated, selected), /配置已变更/);
  assert.deepEqual(whiteboxModels({ ...raw, environment: { name: 'prod' } }), []);
});
test('four workers share fourteen slots across all modes and recover healthy heartbeats', () => {
  const modes = ['coding_to_video', 'blockout_3d', 'experimental'];
  const workers = [2, 4, 4, 4].map((capacity, i) => ({
    worker_id: 'worker-' + i, bridge: { host: 'host-' + i, port: 18081 },
    max_concurrent_jobs: capacity, supported_modes: modes,
  }));
  let clock = 0;
  const raw = { workers, concurrency: { global_max_concurrent_jobs: 14, per_machine_max_concurrent_jobs: 4 } };
  const pool = new WorkerPool({ backendConfig: raw, now: () => clock });
  for (const w of workers) pool.register({ ...w, process_instance_id: w.worker_id });
  assert.equal(pool.capacitySnapshot().global.capacity, 14);
  for (const mode of modes) assert.ok(pool.pickForSession(mode));
  for (const w of workers) for (let i = 0; i < w.max_concurrent_jobs; i++) pool.reserve(w.worker_id, w.worker_id + '-' + i);
  assert.equal(pool.globalUsed, 14);
  assert.equal(pool.canAdmit('worker-0').reason, 'GLOBAL_CAPACITY');
  pool.release('worker-3-3');
  assert.ok(pool.canAdmit('worker-3').ok);
  clock = 130000;
  pool.sweepHealth();
  assert.equal(pool.capacitySnapshot().global.capacity, 0);
  for (const w of workers) pool.heartbeat({ process_instance_id: w.worker_id, status: 'healthy' });
  assert.equal(pool.capacitySnapshot().global.capacity, 14);
  assert.equal(pool.capacitySnapshot().global.used, 0);
});

function zip(entries) {
  return execFileSync('python3', ['-c', "import io,zipfile,json,sys,base64;b=io.BytesIO();z=zipfile.ZipFile(b,'w');[(z.writestr(k,v)) for k,v in json.loads(sys.argv[1]).items()];z.close();print(base64.b64encode(b.getvalue()).decode())", JSON.stringify(entries)], { encoding: 'utf8' }).trim();
}
test('upload replaces every prior skill, original files stay immutable across subsequent turns', async () => {
  const sid = 'sess_12345678-1234-1234-1234-123456789abc';
  const archive = zip({ 'only/SKILL.md': '---\nname: only\ndescription: test\n---\nUse this only.', 'only/data.txt': 'unchanged' });
  const options = { raw, repoRoot: TEST_TMP_ROOT };
  const spec = await prepareWhiteboxSkills(TEST_TMP_ROOT, sid, { archive_base64: archive, archive_name: 'only.zip', builtin: 'coding_to_video', text: 'unrelated', configured: [{ id: 'anatomy' }] }, { builtin: 'blockout_3d' }, options);
  assert.equal(spec.builtin, 'none'); assert.equal(spec.text, ''); assert.deepEqual(spec.skills, ['only']); assert.equal(spec.configured, undefined);
  assert.deepEqual(await prepareWhiteboxSkills(TEST_TMP_ROOT, sid, {}, spec, options), spec);
  assert.equal((await readFile(join(TEST_TMP_ROOT, sid, 'skill-revisions', spec.revision, 'uploaded.zip'))).toString('base64'), archive);
  await assert.rejects(prepareWhiteboxSkills(TEST_TMP_ROOT, sid, { archive_base64: zip({ 'a/SKILL.md': 'a', 'b/SKILL.md': 'b' }) }, spec, options), /只包含一个/);
});
test('Responses conversion preserves tool images, exact arguments and opaque reasoning across continuation', () => {
  const reasoning = { id: 'rs1', type: 'reasoning', summary: [], encrypted_content: 'opaque' };
  const native = { id: 'resp1', status: 'completed', output: [reasoning, { type: 'function_call', call_id: 'call1', name: 'Read', arguments: '{"path":"x.png"}' }] };
  const adapted = fromResponses(native, 'fixture');
  const wire = anthropicSSE(adapted); assert.match(wire, /message_stop/); assert.match(wire, /redacted_thinking/);
  const input = { messages: [{ role: 'assistant', content: adapted.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: [{ type: 'text', text: 'read' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'bytes' } }] }] }] };
  const out = toResponses(input, { model: 'gpt', maxOutputTokens: 32768 }, 'low');
  assert.deepEqual(out.input[0], reasoning); assert.equal(out.input[1].arguments, '{"path":"x.png"}');
  assert.equal(out.input[2].output[1].image_url, 'data:image/png;base64,bytes');
  assert.throws(() => fromResponses({ status: 'incomplete', output: native.output }, 'gpt'), /incomplete/);
  assert.throws(() => toResponses({ messages: [{ role: 'user', content: [{ type: 'document' }] }] }, {}, 'low'), /Unsupported/);
});
test('proxy authenticates per job, falls back only before an answer, archives signatures unchanged', async t => {
  const dir = await mkdtemp(join(TEST_TMP_ROOT, 'proxy-'));
  const selected = whiteboxModels(raw)[0]; await writeFile(join(dir, '_meta.json'), JSON.stringify({ model_selection: selected }));
  const calls = []; const content = 'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"thinking","thinking":"test","signature":"exact-signature"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const proxy = createWhiteboxProxy({ raw, gateway: { internalToken: 'fixture-secret-only' } }, jid => jid === 'job1' ? { mode: 'blockout_3d', jobDir: dir } : null,
    async (url, opts) => { calls.push(JSON.parse(opts.body).model); return calls.length === 1 ? new Response('denied', { status: 403 }) : new Response(content, { status: 200, headers: { 'content-type': 'text/event-stream' } }); });
  const server = createServer((req, res) => proxy(req, res, 'job1', '/v1/messages'));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401); assert.equal(calls.length, 0);
  const response = await fetch(url, { method: 'POST', headers: { 'x-api-key': whiteboxToken('fixture-secret-only', 'job1') }, body: JSON.stringify({ stream: true, messages: [] }) });
  assert.equal(await response.text(), content); assert.deepEqual(calls, ['model/channel1', 'model/channel2']);
  // Response finishes before audit flush; wait only for this local write, not arbitrary network state.
  let meta;
  for (let i = 0; i < 20 && !meta; i++) { try { const [id] = await readdir(join(dir, 'model-capture')); meta = JSON.parse(await readFile(join(dir, 'model-capture', id, 'meta.json'))); } catch { await new Promise(r => setTimeout(r, 10)); } }
  assert.equal(meta.complete, true); assert.equal(meta.attempts[1].channel, 2);
});


test('new whitebox defaults are server-owned while hidden profiles stay pinned for existing jobs', () => {
  const cfg=structuredClone(raw);const original=whiteboxModels(cfg)[0];
  cfg.whitebox.models[0].selectable=false;
  cfg.whitebox.models.push({...structuredClone(cfg.whitebox.models[0]),id:'new-default',name:'DPSK',selectable:true});
  cfg.whitebox.default_model='new-default';
  assert.equal(defaultWhiteboxModel(cfg),'new-default');
  assert.equal(resolveNewWhiteboxModel(cfg).snapshot.profile_id,'new-default');
  assert.deepEqual(newWhiteboxModels(cfg).map(x=>x.profile_id),['new-default']);
  assert.throws(()=>resolveNewWhiteboxModel(cfg,original.profile_id),/不再用于新对话/);
  assert.deepEqual(resolveWhiteboxModel(cfg,original).snapshot,original);
  cfg.whitebox.default_model='missing';assert.throws(()=>defaultWhiteboxModel(cfg),/默认白模/);
});

test('DeepSeek proxy archives raw/model-visible forms and applies the actual per-round effort', async t => {
  const cfg=structuredClone(raw);cfg.whitebox.models[0].channels[0].anthropic_compatibility={lift_tool_images:true,input_tokens_include_cache:true};
  const dir=await mkdtemp(join(TEST_TMP_ROOT,'deepseek-proxy-'));const state=join(dir,'state.json');await writeFile(state,JSON.stringify({phase:'compile',repairs:1}));
  await writeFile(join(dir,'_meta.json'),JSON.stringify({model_selection:whiteboxModels(cfg)[0],whitebox_host:{state_path:state}}));
  const usage={input_tokens:2412,cache_read_input_tokens:2304,output_tokens:9};
  const source='data: '+JSON.stringify({type:'message_start',message:{usage}})+'\n\n'+'data: '+JSON.stringify({type:'content_block_delta',delta:{type:'signature_delta',signature:'opaque-signature'}})+'\n\ndata: {"type":"message_stop"}\n\n';
  let sent;
  const proxy=createWhiteboxProxy({raw:cfg,gateway:{internalToken:'secret'}},()=>({mode:'blockout_3d',jobDir:dir}),async(url,opts)=>{sent=JSON.parse(opts.body);return new Response(source,{headers:{'content-type':'text/event-stream'}});});
  const server=createServer((req,res)=>proxy(req,res,'job1','/v1/messages'));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const body={stream:true,messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'a',content:[{type:'image',source:{type:'base64',data:'actual-bytes',media_type:'image/png'}}]}]}]};
  const r=await fetch(`http://127.0.0.1:${server.address().port}`,{method:'POST',headers:{'x-api-key':whiteboxToken('secret','job1')},body:JSON.stringify(body)});const wire=await r.text();
  assert.match(wire,/"input_tokens":108/);assert.match(wire,/opaque-signature/);assert.equal(sent.output_config.effort,'high');assert.equal(sent.messages[0].content.at(-1).source.data,'actual-bytes');
  let meta,folder;for(let i=0;i<40&&!meta;i++){try{folder=join(dir,'model-capture',(await readdir(join(dir,'model-capture')))[0]);meta=JSON.parse(await readFile(join(folder,'meta.json')));}catch{await new Promise(r=>setTimeout(r,10));}}
  assert.equal(await readFile(join(folder,'response.txt'),'utf8'),source);assert.equal(await readFile(join(folder,'client-response.txt'),'utf8'),wire);assert.deepEqual(JSON.parse(await readFile(join(folder,'request.json'))),body);assert.equal(meta.attempts[0].lifted_images.length,1);assert.equal(meta.complete,true);
});

test('disabling a primary channel cannot apply its transport quirks to its backup', () => {
  const cfg=structuredClone(raw);const [first,second]=cfg.whitebox.models[0].channels;
  first.enabled=false;first.anthropic_compatibility={input_tokens_include_cache:true};
  assert.deepEqual(resolveWhiteboxModel(cfg,'whitebox-fixture').channels[0].compatibility,{});
});


test('CC phase JSON routing retains literal calls, unsigned reasoning, images and raw capture; other turns stay native',async t=>{
  const dir=await mkdtemp(join(TEST_TMP_ROOT,'phase-json-'));const state=join(dir,'state.json');
  await writeFile(state,JSON.stringify({phase:'preview',mcp_phase:'review',repairs:0}));
  const meta={model_selection:whiteboxModels(raw)[0],whitebox_host:{version:'cvw-whitebox-cc-v9',state_path:state,context_policy:'current-phase-v1',stage_transport:'chat-json-v1',user_prompt:'Original user story'}};
  await writeFile(join(dir,'_meta.json'),JSON.stringify(meta));
  const packet={phase:'review',original_brief:{story:'original'},actual_scene:{shots:[]}};
  const observation=[{type:'text',text:JSON.stringify(packet)},{type:'text',text:'Exact skill rules'},{type:'image',source:{type:'base64',media_type:'image/png',data:'real-bytes'}}];
  const request={stream:true,system:'Exact system',max_tokens:98304,tools:[{name:'mcp__whitebox__submit',input_schema:{type:'object'}}],messages:[{role:'user',content:'earlier'},
    {role:'assistant',content:[{type:'tool_use',id:'prior',name:'mcp__whitebox__submit',input:{kind:'facts',data:{}}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'prior',content:observation}]}]};
  const literal={name:'mcp__whitebox__submit',input:{kind:'review',data:{status:'complete',findings:['Actual blocker']}}};
  const response={id:'upstream-original',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(literal),reasoning_content:'Original reasoning'}}],usage:{prompt_tokens:100,completion_tokens:20}};
  const calls=[];const proxy=createWhiteboxProxy({raw,gateway:{internalToken:'local-secret'}},()=>({mode:'blockout_3d',jobDir:dir}),async(url,opts)=>{
    calls.push({url,request:JSON.parse(opts.body)});return new Response(url.endsWith('/chat/completions')?JSON.stringify(response):'data: {"type":"message_stop"}\n\n',{headers:{'content-type':url.endsWith('/chat/completions')?'application/json':'text/event-stream'}});
  });
  const server=createServer((req,res)=>proxy(req,res,'job1','/v1/messages'));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const send=body=>fetch(`http://127.0.0.1:${server.address().port}`,{method:'POST',headers:{'x-api-key':whiteboxToken('local-secret','job1')},body:JSON.stringify(body)});
  const wire=await(await send(request)).text();assert.match(wire,/thinking_delta/);assert.match(wire,/Original reasoning/);assert.doesNotMatch(wire,/signature_delta/);assert.match(wire,/Actual blocker/);
  assert.ok(calls[0].url.endsWith('/v1/chat/completions'));assert.equal(calls[0].request.reasoning_effort,'low');assert.equal(calls[0].request.tools,undefined);
  assert.ok(calls[0].request.messages[1].content.some(b=>b.image_url?.url==='data:image/png;base64,real-bytes'));
  let captured;for(let i=0;i<30&&!captured;i++)try{const [id]=await readdir(join(dir,'model-capture'));const base=join(dir,'model-capture',id);captured={meta:JSON.parse(await readFile(join(base,'meta.json'))),raw:JSON.parse(await readFile(join(base,'upstream-0.response.json'))),request:JSON.parse(await readFile(join(base,'request.json')))};}catch{await new Promise(r=>setTimeout(r,10));}
  assert.deepEqual(captured.raw,response);assert.deepEqual(captured.request,request);assert.equal(captured.meta.attempts[0].protocol,'chat-json-v1');assert.equal(captured.meta.attempts[0].transport.response_id,'upstream-original');
  await writeFile(state,JSON.stringify({phase:'initial',mcp_phase:'brief',repairs:0}));await(await send({...request,messages:[{role:'user',content:'New real input'}]})).text();assert.ok(calls[1].url.endsWith('/v1/messages'));
  await writeFile(state,JSON.stringify({phase:'preview',mcp_phase:'review',repairs:0}));delete meta.whitebox_host.stage_transport;await writeFile(join(dir,'_meta.json'),JSON.stringify(meta));await(await send(request)).text();assert.ok(calls[2].url.endsWith('/v1/messages'));
});
