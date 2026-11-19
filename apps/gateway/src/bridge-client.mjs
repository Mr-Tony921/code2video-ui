/**
 * Gateway → Bridge 的出向 HTTP 客户端。
 * 这是生产数据通路（不经 SSH）。
 */
import { config } from './config.mjs';

async function call(baseUrl, path, { method = 'POST', body, timeoutMs } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs ?? config.bridge.requestTimeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-internal-token': config.auth.internalToken },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};
    if (!res.ok) {
      const e = new Error(`bridge ${res.status}: ${json?.error?.code ?? text.slice(0, 160)}`);
      e.status = res.status; e.code = json?.error?.code; e.body = json;
      throw e;
    }
    return json;
  } finally { clearTimeout(timer); }
}

export const bridge = {
  health: (base) => call(base, '/health', { method: 'GET', timeoutMs: 8000 }),
  initSession: (base, body) => call(base, '/sessions', { body }),
  startJob: (base, body) => call(base, '/jobs', { body,
    // ZIP extraction and host adaptation can exceed the regular 20s admission timeout on cold AFS.
    // In-flight admission reserves its slot while the dispatcher fills the remaining slots.
    timeoutMs: body.mode === 'blockout_3d' ? 90_000 : undefined }),
  cancelJob: (base, jobId, body) => call(base, `/jobs/${jobId}/cancel`, { body }),
  /** 对账：Job 状态未知时查询真实情况 */
  probeJob: (base, jobId, sessionId) =>
    call(base, `/jobs/${jobId}?session_id=${encodeURIComponent(sessionId)}`, { method: 'GET', timeoutMs: 10_000 }),
  isolation: (base, sessionId, mode) =>
    call(base, `/sessions/${sessionId}/isolation?mode=${mode}`, { method: 'GET', timeoutMs: 8000 }),
  /** 拉过程事件（V2 需求 4）。after=已收到的最大 seq。 */
  jobStream: (base, jobId, after = 0, sessionRef = '') =>
    call(base, `/jobs/${jobId}/stream?after=${after}` +
      (sessionRef ? `&session_id=${encodeURIComponent(sessionRef)}` : ''),
      { method: 'GET', timeoutMs: 15_000 }),
  /* Reference 附件（V2 需求 1） */
  refsList: (base, sid) => call(base, `/sessions/${sid}/references`, { method: 'GET' }),
  refsAssetsJson: (base, sid) => call(base, `/sessions/${sid}/references/assets-json`, { method: 'GET' }),
  refsAdd: (base, sid, body) => call(base, `/sessions/${sid}/references`, { body }),
  refsFreeze: (base, sid) => call(base, `/sessions/${sid}/references/freeze`, {}),
  refsRemove: (base, sid, name) =>
    call(base, `/sessions/${sid}/references/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  /** 释放会话名额（只释放名额，不删工作区）。 */
  releaseSession: (base, sid) =>
    call(base, `/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE', timeoutMs: 8000 }),
  drain: (base) => call(base, '/drain', {}),
};
