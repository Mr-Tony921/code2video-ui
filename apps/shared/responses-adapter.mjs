/** Lossless supported-block bridge for CC -> Responses. Original wire payloads are archived separately. */
import { randomUUID } from 'node:crypto';
const STATE = 'cvw-responses-v1:';
function image(b) {
  const src = b.source;
  if (src?.type === 'base64') return { type: 'input_image', image_url: `data:${src.media_type};base64,${src.data}` };
  if (src?.type === 'url') return { type: 'input_image', image_url: src.url };
  throw new Error('Unsupported image source');
}
function userContent(content) {
  return (typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? []).map(b => {
    if (b.type === 'text') return { type: 'input_text', text: b.text };
    if (b.type === 'image') return image(b);
    throw new Error(`Unsupported Responses input block: ${b.type}`);
  });
}
export function toResponses(body, channel, effort) {
  const input = [];
  for (const message of body.messages ?? []) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    let texts = [];
    const flush = () => { if (texts.length) { input.push({ role: message.role, content: texts }); texts = []; } };
    for (const b of blocks) {
      if (b.type === 'text') texts.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: b.text });
      else if (b.type === 'image' && message.role === 'user') texts.push(image(b));
      else {
        flush();
        if (b.type === 'tool_use') input.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
        else if (b.type === 'tool_result') input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: userContent(b.content) });
        else if (b.type === 'redacted_thinking' && b.data?.startsWith(STATE)) {
          const item = JSON.parse(Buffer.from(b.data.slice(STATE.length), 'base64').toString());
          if (item.type !== 'reasoning') throw new Error('Invalid Responses reasoning state');
          input.push(item);
        } else throw new Error(`Unsupported Responses block: ${b.type}`);
      }
    }
    flush();
  }
  const instructions = typeof body.system === 'string' ? body.system : (body.system ?? []).map(b => {
    if (b.type !== 'text') throw new Error(`Unsupported system block: ${b.type}`);
    return b.text;
  }).join('\n');
  const tools = (body.tools ?? []).map(t => {
    if (!t.name || !t.input_schema) throw new Error('Only function tools are supported by this Responses adapter');
    return { type: 'function', name: t.name, description: t.description ?? '', parameters: t.input_schema, strict: false };
  });
  const tc = body.tool_choice;
  const tool_choice = tc?.type === 'tool' ? { type: 'function', name: tc.name } : tc?.type === 'any' ? 'required' : tc?.type === 'none' ? 'none' : 'auto';
  return { model: channel.model, input, instructions, tools, tool_choice, store: false,
    max_output_tokens: Math.min(body.max_tokens ?? 32768, channel.maxOutputTokens ?? 32768),
    reasoning: { effort }, include: ['reasoning.encrypted_content'], stream: false };
}
export function fromResponses(response, model) {
  if (response.status !== 'completed' || response.error)
    throw new Error(`Responses incomplete: ${response.error?.message ?? response.incomplete_details?.reason ?? response.status}`);
  const content = [];
  for (const item of response.output ?? []) {
    if (item.type === 'reasoning') {
      // Opaque transport envelope preserves all native fields (including encrypted content and IDs).
      // This is not an Anthropic signature or invented visible chain of thought.
      content.push({ type: 'redacted_thinking', data: STATE + Buffer.from(JSON.stringify(item)).toString('base64') });
    } else if (item.type === 'function_call') {
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input: JSON.parse(item.arguments) });
    } else if (item.type === 'message') {
      for (const b of item.content ?? []) {
        if (b.type === 'output_text') content.push({ type: 'text', text: b.text });
        else if (b.type === 'refusal') content.push({ type: 'text', text: b.refusal });
        else throw new Error(`Unsupported Responses output content: ${b.type}`);
      }
    } else throw new Error(`Unsupported Responses output item: ${item.type}`);
  }
  if (!content.length) throw new Error('Responses returned empty output');
  return { id: response.id ?? `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content,
    stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0 } };
}
export function anthropicSSE(message) {
  const events = [];
  const emit = (type, data) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
  message.content.forEach((b, index) => {
    if (b.type === 'redacted_thinking') emit('content_block_start', { index, content_block: b });
    else {
      emit('content_block_start', { index, content_block: b.type === 'text' ? { type: 'text', text: '' } : { ...b, input: {} } });
      emit('content_block_delta', { index, delta: b.type === 'text' ? { type: 'text_delta', text: b.text } : { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    emit('content_block_stop', { index });
  });
  emit('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage });
  emit('message_stop', {});
  return events.join('');
}
