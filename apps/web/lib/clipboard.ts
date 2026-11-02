/**
 * 复制到剪贴板。
 *
 * navigator.clipboard 只在**安全上下文**（HTTPS / localhost）存在；
 * 经 http://10.120.x.x 访问时它是 undefined，直接调用会静默失败 ——
 * 与 crypto.randomUUID 是同一个坑（见 lib/uuid.ts）。
 *
 * 因此必须有 execCommand 兜底；两条路都失败时返回 false，
 * 由调用方展示"请手动复制"，绝不假装已复制。
 */
export async function copyText(text: string): Promise<boolean> {
  // 路径一：标准 API（仅安全上下文）
  try {
    const c = globalThis.navigator?.clipboard;
    if (c?.writeText) {
      await c.writeText(text);
      return true;
    }
  } catch { /* 落到兜底 */ }

  // 路径二：隐藏 textarea + execCommand（HTTP 下唯一可用方式）
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // 不能用 display:none / hidden —— 那样选不中，复制必然为空
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);     // iOS 需要显式范围
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
