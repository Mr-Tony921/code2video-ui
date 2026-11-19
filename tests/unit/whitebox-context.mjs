import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whiteboxPhaseContext } from '../../apps/worker-bridge/src/whitebox-context.mjs';
import { parseStreamLine, phaseFromEvent } from '../../apps/worker-bridge/src/stream-parser.mjs';

const host = { version: 'cvw-whitebox-cc-v8', context_policy: 'current-phase-v1', user_prompt: '原始续写：改第二个镜头，其他不变' };
function fixture(phase) {
  const packet = {phase, frozen_brief:{story:'original'}, current_draft:{shots:[{id:'s1'}]}, original_brief:{story:'original'}, actual_scene:{shots:[{id:'s1'}]}};
  const content = [{type:'text',text:JSON.stringify(packet)}, {type:'text',text:'exact skill rules'},
    {type:'image',source:{type:'base64',media_type:'image/png',data:'original-bytes'}}];
  return {system:[{type:'text',text:'director'}],tools:[{name:'mcp__whitebox__submit',input_schema:{type:'object'}}],max_tokens:98304,thinking:{type:'enabled',budget_tokens:32768},
    messages:[{role:'user',content:'earlier intake'}, {role:'assistant',content:[{type:'thinking',thinking:'old',signature:'unaltered-signature'},
      {type:'tool_use',id:'call1',name:'mcp__whitebox__submit',input:{kind:'patch',data:{}}}]},
      {role:'user',content:[{type:'tool_result',tool_use_id:'call1',content}]}]};
}
test('current phase retains exact requirements, tool schema, actual image bytes and original capture',()=>{
  for (const version of ['cvw-whitebox-cc-v8','cvw-whitebox-cc-v9']) for (const phase of ['draft','patch','facts','review']) {
    const body=fixture(phase), before=structuredClone(body);
    const out=whiteboxPhaseContext(body,{...host,version},{mcp_phase:phase});
    assert.equal(out.audit.policy,'current-phase-v1');assert.deepEqual(body,before);
    assert.deepEqual(out.request.messages[0].content.slice(1),body.messages.at(-1).content[0].content);
    assert.match(out.request.messages[0].content[0].text,/原始续写/);
    for(const key of ['system','tools','thinking','max_tokens'])assert.deepEqual(out.request[key],body[key]);
  }
});
test('intake, clarification, old jobs, errors and partial/additional evidence keep native history',()=>{
  const base=fixture('draft');
  for(const h of [{...host,version:'cvw-whitebox-cc-v6'},{...host,context_policy:'native'}, {...host,user_prompt:''}])
    assert.equal(whiteboxPhaseContext(base,h,{mcp_phase:'draft'}).request,base);
  for(const p of ['brief','edit','waiting_user','delivered'])assert.equal(whiteboxPhaseContext(base,host,{mcp_phase:p}).request,base);
  for(const mutate of [b=>b.messages.at(-1).content[0].is_error=true,
    b=>b.messages.at(-1).content[0].tool_use_id='wrong',
    b=>b.messages.at(-1).content.push({type:'text',text:'new user instruction'}),
    b=>b.messages.at(-2).content[1].name='mcp__whitebox__evidence',
    b=>b.messages.at(-1).content[0].content[0].text='{"phase":"draft"}',
    b=>b.messages.at(-1).content[0].content.push({type:'document'})]) {
    const body=structuredClone(base);mutate(body);
    assert.equal(whiteboxPhaseContext(body,host,{mcp_phase:'draft'}).request,body);
  }
});
test('large MCP draft remains a generation event in the UI',()=>{
  const events=parseStreamLine(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'x',name:'mcp__whitebox__submit',input:{kind:'draft',data:{title:'Scene',shots:[{id:'s1',text:'x'.repeat(5000)}]}}}]}}));
  const event=events.find(e=>e.kind==='tool_use');assert.equal(event.input.kind,'draft');assert.equal(phaseFromEvent(event),'GENERATING');
});
