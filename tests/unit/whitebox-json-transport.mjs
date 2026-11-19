import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWhiteboxJson,fromWhiteboxJson,whiteboxJsonSSE } from '../../apps/worker-bridge/src/whitebox-json-transport.mjs';
const tools=[{name:'mcp__whitebox__submit',input_schema:{type:'object'}}];
const body={system:[{type:'text',text:'Exact instructions'}],tools,max_tokens:98304,messages:[{role:'user',content:[{type:'text',text:'Exact story and observations'},{type:'image',source:{type:'base64',media_type:'image/jpeg',data:'AQID'}}]}]};
test('phase transport retains text and observed image bytes, same effort/ceiling, no API tool mode',()=>{
 const original=structuredClone(body);const out=toWhiteboxJson(body,{model:'same',maxOutputTokens:98304},'low','review');assert.deepEqual(body,original);
 assert.equal(out.messages[0].content,'Exact instructions');assert.equal(out.messages[1].content[0].text,body.messages[0].content[0].text);
 assert.equal(out.messages[1].content[1].image_url.url,'data:image/jpeg;base64,AQID');assert.equal(out.reasoning_effort,'low');assert.equal(out.max_tokens,98304);assert.equal(out.tools,undefined);
 assert.throws(()=>toWhiteboxJson(body,{model:'same'},'low','brief'),/complete current-phase/);
 assert.throws(()=>toWhiteboxJson({...body,messages:[...body.messages,...body.messages]},{model:'same'},'low','review'),/complete current-phase/);
});
const response=(value,extra={})=>({id:'original-response',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(value),reasoning_content:'actual reasoning',...extra}}],usage:{prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:30}}});
test('literal tool arguments, reasoning and actual signature survive normalized CC wire',()=>{
 const value={name:'mcp__whitebox__submit',input:{kind:'review',data:{findings:['Actual blocker']}}};const {message,audit}=fromWhiteboxJson(response(value,{reasoning_signature:'actual-signature'}),'same');
 assert.deepEqual(message.content[1].input,value.input);assert.equal(message.content[0].thinking,'actual reasoning');assert.equal(message.content[0].signature,'actual-signature');assert.equal(audit.response_id,'original-response');assert.equal(message.usage.input_tokens,70);assert.equal(message.usage.cache_read_input_tokens,30);
 const wire=whiteboxJsonSSE(message);assert.match(wire,/thinking_delta/);assert.match(wire,/signature_delta/);assert.match(wire,/Actual blocker/);assert.match(wire,/message_stop/);
 const no=fromWhiteboxJson(response(value),'same');assert.equal('signature'in no.message.content[0],false);assert.doesNotMatch(whiteboxJsonSSE(no.message),/signature_delta/);
});
test('never discard extra findings or invent a tool on malformed/incomplete output',()=>{
 const value={name:'mcp__whitebox__submit',input:{kind:'review',data:{}},extra_finding:'must preserve'};const out=fromWhiteboxJson(response(value),'same');assert.equal(out.message.stop_reason,'end_turn');assert.equal(out.message.content.at(-1).text,JSON.stringify(value));assert.equal(out.audit.tool_envelope,'invalid_preserved_as_text');
 const bad=response(value);bad.choices[0].finish_reason='length';assert.throws(()=>fromWhiteboxJson(bad,'same'),/Incomplete/);
});
