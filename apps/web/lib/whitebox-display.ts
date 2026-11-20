/** Display-only mapping for fixed host receipts, including historical rounds.
 * Never rewrite stored evidence, user prompts, follow-up answers or failures.
 */
export function whiteboxMessage(text: string | null | undefined): string {
  if (!text) return '';
  const receipts = [
    '白模工程与视频已生成。有限自检仍有待核对项，请查看结果说明。',
    '白模工程与视频已生成。已通过有限自检，效果请以预览为准。',
  ];
  return receipts.includes(text.trim()) ? '白模工程与视频已生成，可预览视频或下载工程。' : text;
}
