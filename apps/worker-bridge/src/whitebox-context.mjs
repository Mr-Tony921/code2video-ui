/** Stage-scoped provider context for the CC whitebox loop.
 * CC keeps its full conversation; the proxy separately archives original and
 * actual provider requests. No new model calls, synthetic observations or
 * rewritten evidence. Intake/resume stays native until a complete stage packet.
 */
export function whiteboxPhaseContext(body, host, phase) {
  const native = reason => ({ request: body, audit: { policy: 'native', reason } });
  if (!['cvw-whitebox-cc-v8','cvw-whitebox-cc-v9'].includes(host?.version) || host.context_policy !== 'current-phase-v1') return native('not_enabled');
  if (!['draft', 'patch', 'facts', 'review'].includes(phase?.mcp_phase)) return native('conversation_phase');
  if (typeof host.user_prompt !== 'string' || !host.user_prompt.trim()) return native('missing_user_request');
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length < 2) return native('missing_tool_pair');
  const previous = messages.at(-2), last = messages.at(-1);
  if (previous.role !== 'assistant' || last.role !== 'user' || !Array.isArray(previous.content) || !Array.isArray(last.content)) return native('not_tool_turn');
  const calls = previous.content.filter(b => b.type === 'tool_use');
  if (calls.length !== 1 || calls[0].name !== 'mcp__whitebox__submit') return native('supplementary_or_parallel_tools');
  if (last.content.length !== 1 || last.content[0].type !== 'tool_result') return native('additional_user_input');
  const receipt = last.content[0];
  if (receipt.tool_use_id !== calls[0].id || receipt.is_error) return native('tool_error_or_mismatched_id');
  const content = typeof receipt.content === 'string' ? [{ type: 'text', text: receipt.content }] : receipt.content;
  if (!Array.isArray(content) || !content.length || content.some(b => !['text', 'image'].includes(b.type))) return native('unsupported_observation');
  let packet;
  try { packet = JSON.parse(content[0].text); } catch { return native('missing_phase_packet'); }
  if (packet.phase !== phase.mcp_phase) return native('stale_phase_packet');
  // A complete packet includes both the frozen requirement and the current
  // candidate/evidence. Never shorten a partial receipt or an ad-hoc tool read.
  const complete = packet.phase === 'draft' ? packet.frozen_brief
    : packet.phase === 'patch' ? packet.frozen_brief && packet.current_draft
    : packet.phase === 'facts' ? content.some(b => {
      try { const p = JSON.parse(b.text); return p.original_brief && p.actual_scene; } catch { return false; }
    }) : packet.original_brief && packet.actual_scene && content.some(b => b.type === 'image');
  if (!complete || content.length < 2) return native('incomplete_phase_packet');
  return { request: { ...body, messages: [{ role: 'user', content: [
    { type: 'text', text: 'Original user request:\n' + host.user_prompt }, ...content,
  ] }] }, audit: { policy: 'current-phase-v1', phase: packet.phase,
    source_tool_use_id: receipt.tool_use_id, original_messages: messages.length,
    supplied_messages: 1, evidence_blocks: content.length,
    retained: 'Exact current tool packet and image bytes; original user request; system; tools. Full CC request remains archived.',
    omitted: 'Completed prior phases, their thinking and superseded candidate observations; not a synthetic summary.' } };
}
