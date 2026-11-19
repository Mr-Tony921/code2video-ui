/** Explicit, channel-scoped compatibility. The caller archives both wire forms. */
import { StringDecoder } from 'node:string_decoder';

export function adaptAnthropicRequest(body, compatibility = {}) {
  const images = [];
  if (!compatibility.lift_tool_images) return { request: body, images };
  const messages = (body.messages ?? []).map((message, messageIndex) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return message;
    const lifted = [], userParts = [];
    let imageNumber = 0;
    const content = message.content.map((block, blockIndex) => {
      if (block.type !== 'tool_result') { userParts.push(block); return null; }
      if (!Array.isArray(block.content)) return block;
      const parts = block.content.map((part, partIndex) => {
        if (part.type !== 'image') return part;
        const n = ++imageNumber;
        lifted.push(part);
        userParts.push({ type: 'text', text: `Image ${n} returned by tool ${block.tool_use_id}:` }, part);
        images.push({ message: messageIndex, tool_result: blockIndex, part: partIndex,
          tool_use_id: block.tool_use_id, image: n });
        return { type: 'text', text: `[Image ${n} from this tool result is attached as an image in this same user message.]` };
      });
      return { ...block, content: parts };
    });
    // Keep the complete tool-result group first; retain every image byte and its association.
    return lifted.length ? { ...message, content: [...content.filter(Boolean), ...userParts] } : message;
  });
  return { request: { ...body, messages }, images };
}

export function normalizeAnthropicUsage(usage, compatibility = {}, previous = {}) {
  if (!compatibility.input_tokens_include_cache || !usage || !Number.isFinite(usage.input_tokens)) return usage;
  const read = usage.cache_read_input_tokens ?? previous.cache_read_input_tokens ?? 0;
  const created = usage.cache_creation_input_tokens ?? previous.cache_creation_input_tokens ?? 0;
  // These routes report total prompt tokens. Anthropic/CC expects only uncached input here.
  return { ...usage, input_tokens: Math.max(0, usage.input_tokens - read - created) };
}

/** Only usage JSON events change. Thinking, signatures, tool arguments and unknown events pass verbatim. */
export function anthropicUsageStream(compatibility = {}) {
  const decoder = new StringDecoder('utf8');
  let pending = '', previous = {};
  function line(value) {
    if (!value.startsWith('data:')) return value;
    let data;
    try { data = JSON.parse(value.slice(5).trim()); } catch { return value; }
    const holder = data.type === 'message_start' ? data.message : data.type === 'message_delta' ? data : null;
    if (!holder?.usage) return value;
    const normalized = normalizeAnthropicUsage(holder.usage, compatibility, previous);
    previous = { ...previous, ...holder.usage };
    if (normalized === holder.usage) return value;
    holder.usage = normalized;
    return 'data: ' + JSON.stringify(data) + (value.endsWith('\r') ? '\r' : '');
  }
  return {
    push(bytes) {
      pending += decoder.write(bytes);
      const lines = pending.split('\n'); pending = lines.pop();
      return lines.length ? lines.map(line).join('\n') + '\n' : '';
    },
    end() { pending += decoder.end(); const out = line(pending); pending = ''; return out; },
  };
}
