/** An explicit whitebox intake outcome is conversational, never a video asset. */
export function whiteboxResponse(mode, value) {
  if (mode !== 'blockout_3d' || !value || !['clarification', 'answer'].includes(value.kind)
    || typeof value.text !== 'string' || !value.text.trim()) return null;
  return { kind: value.kind, text: value.text.trim() };
}

export function whiteboxResponsePatch(mode, value) {
  const response = whiteboxResponse(mode, value);
  return response ? { response, result_asset: null, last_assistant_text: response.text } : null;
}
