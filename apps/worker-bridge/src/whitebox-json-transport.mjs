/** JSON tool-call wire adapter only. CC still initiates every model call and
 * executes every MCP tool. No phase controller, tool execution or model client.
 * Original request/response bytes remain in the ordinary model capture. */
import { randomUUID } from 'node:crypto';
const SUBMIT='mcp__whitebox__submit', EVIDENCE='mcp__whitebox__evidence';
const content = blocks => (typeof blocks==='string' ? [{type:'text',text:blocks}] : blocks).map(b=>{
  if(b.type==='text')return {type:'text',text:b.text};
  if(b.type==='image'&&b.source?.type==='base64')return {type:'image_url',image_url:{url:`data:${b.source.media_type};base64,${b.source.data}`}};
  if(b.type==='image'&&b.source?.type==='url')return {type:'image_url',image_url:{url:b.source.url}};
  throw new Error('Unsupported phase JSON observation: '+b.type);
});
export function toWhiteboxJson(body,channel,effort,phase) {
  if(!['draft','patch','facts','review'].includes(phase)||body.messages?.length!==1||body.messages[0].role!=='user')throw new Error('JSON transport requires a complete current-phase packet');
  const tools=body.tools??[];
  if(!tools.some(t=>t.name===SUBMIT)||tools.some(t=>![SUBMIT,EVIDENCE].includes(t.name)))throw new Error('JSON transport supports only the declared whitebox MCP tools');
  const system=typeof body.system==='string'?body.system:(body.system??[]).map(b=>{
    if(b.type!=='text')throw new Error('Unsupported system block');return b.text;
  }).join('\n');
  const instructions='Transport format only: the native tools are exposed here as JSON. Return exactly one JSON object {"name":"mcp__whitebox__submit","input":{"kind":"'+phase+'","data":{...the actual phase JSON...}}}.'
    +(phase==='review'?' If additional image evidence is required, you may instead return {"name":"mcp__whitebox__evidence","input":{"files":[...exact current evidence names...]}}.':'')
    +' Do not execute a tool through another protocol. Your literal JSON will be delivered to the same Claude Code MCP tool. Available tool definitions: '+JSON.stringify(tools);
  return {model:channel.model,messages:[{role:'system',content:system},{role:'user',content:[...content(body.messages[0].content),{type:'text',text:instructions}]}],
    thinking:{type:'enabled'},reasoning_effort:effort,max_tokens:Math.min(body.max_tokens??98304,channel.maxOutputTokens??98304),response_format:{type:'json_object'},stream:false};
}
export function fromWhiteboxJson(response, model) {
  if(response.error||response.choices?.length!==1||response.choices[0].finish_reason!=='stop')throw new Error('Incomplete phase JSON response; no tool was synthesized');
  const source=response.choices[0].message;
  if(typeof source?.content!=='string'||!source.content.trim())throw new Error('Empty phase JSON response');
  const blocks=[];
  // Preserve the actual visible reasoning and actual signature when provided.
  // Missing provider signatures stay missing: never invent one for CC.
  if(typeof source.reasoning_content==='string'&&source.reasoning_content)blocks.push({type:'thinking',thinking:source.reasoning_content,
    ...(typeof source.reasoning_signature==='string'?{signature:source.reasoning_signature}:{})});
  let call;try{call=JSON.parse(source.content);}catch{}
  const valid=call&&Object.keys(call).length===2&&typeof call.name==='string'&&[SUBMIT,EVIDENCE].includes(call.name)&&call.input&&typeof call.input==='object'&&!Array.isArray(call.input);
  // A malformed tool envelope is a model response, not permission to drop
  // findings or sample another hidden answer. Preserve it verbatim; CC's native
  // stop hook can ask for a corrected tool call, using its full saved history.
  if(valid)blocks.push({type:'tool_use',id:'toolu_cvw_json_'+randomUUID().replaceAll('-',''),name:call.name,input:call.input});
  else blocks.push({type:'text',text:source.content});
  const cached=response.usage?.prompt_tokens_details?.cached_tokens??0;
  return {message:{id:response.id??'msg_'+randomUUID(),type:'message',role:'assistant',model,content:blocks,
    stop_reason:valid?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:Math.max(0,(response.usage?.prompt_tokens??0)-cached),cache_read_input_tokens:cached,output_tokens:response.usage?.completion_tokens??0}},
    audit:{protocol:'chat-json-v1',response_id:response.id??null,tool_envelope:valid?'literal_model_json':'invalid_preserved_as_text',
      generated_tool_use_id:valid?blocks.at(-1).id:null,source_message_fields:Object.keys(source),reasoning_signature_present:typeof source.reasoning_signature==='string'}};
}
export function whiteboxJsonSSE(message) {
  const events=[];const emit=(type,data)=>events.push(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
  emit('message_start',{message:{...message,content:[],stop_reason:null,usage:{...message.usage,output_tokens:0}}});
  message.content.forEach((b,index)=>{
    if(b.type==='thinking'){
      emit('content_block_start',{index,content_block:{type:'thinking',thinking:''}});
      emit('content_block_delta',{index,delta:{type:'thinking_delta',thinking:b.thinking}});
      if('signature'in b)emit('content_block_delta',{index,delta:{type:'signature_delta',signature:b.signature}});
    }else if(b.type==='tool_use'){
      emit('content_block_start',{index,content_block:{...b,input:{}}});emit('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}});
    }else{
      emit('content_block_start',{index,content_block:{type:'text',text:''}});emit('content_block_delta',{index,delta:{type:'text_delta',text:b.text}});
    }
    emit('content_block_stop',{index});
  });
  emit('message_delta',{delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:message.usage});emit('message_stop',{});return events.join('');
}
