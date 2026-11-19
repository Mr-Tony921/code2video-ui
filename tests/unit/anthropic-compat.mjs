import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptAnthropicRequest, normalizeAnthropicUsage, anthropicUsageStream } from '../../apps/shared/anthropic-compat.mjs';
const compatibility = { lift_tool_images: true, input_tokens_include_cache: true };
test('channel compatibility preserves every tool/image association and original request', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'exact-bytes' } };
  const input = { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: [{type:'text',text:'before'},image,{type:'text',text:'after'}] }, { type:'tool_result',tool_use_id:'a',is_error:true,content:[image] }] }] };
  const saved = JSON.stringify(input);
  const { request, images }=adaptAnthropicRequest(input,compatibility);
  assert.equal(JSON.stringify(input),saved);
  assert.deepEqual(request.messages[0].content.slice(0,2).map(x=>x.tool_use_id),['b','a']);
  assert.equal(request.messages[0].content[1].is_error,true);
  assert.deepEqual(request.messages[0].content.filter(x=>x.type==='image'),[image,image]);
  assert.deepEqual(images.map(x=>[x.tool_use_id,x.image]),[['b',1],['a',2]]);
  assert.equal(adaptAnthropicRequest(input).request,input);
});
test('DeepSeek total input accounting normalizes once; native Anthropic accounting remains unchanged', () => {
  const usage={input_tokens:2412,cache_read_input_tokens:2304,cache_creation_input_tokens:0,output_tokens:9};
  assert.equal(normalizeAnthropicUsage(usage,compatibility).input_tokens,108);
  assert.equal(normalizeAnthropicUsage(usage),usage);
  assert.equal(normalizeAnthropicUsage({output_tokens:9},compatibility).input_tokens,undefined);
  assert.equal(normalizeAnthropicUsage({input_tokens:2412},compatibility,usage).input_tokens,108);
});
test('fragmented UTF8 SSE preserves exact thinking/signature/unknown events, normalizes usage only', () => {
  const thinking='event: content_block_delta\ndata: {"type":"content_block_delta", "delta":{"type":"thinking_delta","thinking":"中文推理","signature":"opaque exact /+="}}\n\n';
  const start='event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2412,"cache_read_input_tokens":2304}}}\n\n';
  const end='event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":2412,"output_tokens":9}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const bytes=Buffer.from(start+thinking+end), stream=anthropicUsageStream(compatibility);
  let out='';for(let i=0;i<bytes.length;i+=3)out+=stream.push(bytes.subarray(i,i+3));out+=stream.end();
  assert.ok(out.includes(thinking));assert.ok(out.includes('"input_tokens":108'));
  assert.equal((out.match(/"input_tokens":108/g)??[]).length,2);
  const plain=anthropicUsageStream();assert.equal(plain.push(bytes)+plain.end(),bytes.toString());
});

test('mixed reference and tool images retain their observation order after lifting', () => {
  const image=n=>({type:'image',source:{type:'base64',data:String(n),media_type:'image/png'}});
  const body={messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'first',content:[image(1)]},image(2),{type:'tool_result',tool_use_id:'last',content:[image(3)]}]}]};
  const {request}=adaptAnthropicRequest(body,compatibility);
  assert.deepEqual(request.messages[0].content.filter(x=>x.type==='image').map(x=>x.source.data),['1','2','3']);
});
