/**
 * UUID v4 生成。
 *
 * ⚠️ 不能直接用 `crypto.randomUUID()` —— 它只在**安全上下文**（HTTPS 或 localhost）可用。
 * 经 http://10.120.x.x 这类内网 IP 访问时它是 undefined，调用会抛
 * `TypeError: crypto.randomUUID is not a function`，整个页面白屏
 * （表现为 "Application error: a client-side exception has occurred"）。
 *
 * 依次降级：randomUUID → getRandomValues → Math.random。
 */
export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();

  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') {
    c.getRandomValues(b);
  } else {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  // 置 version(4) 与 variant(10xx) 位
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
