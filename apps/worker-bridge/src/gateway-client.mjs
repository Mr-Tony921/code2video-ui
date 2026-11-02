/**
 * Bridge → Gateway 的出向 HTTP 客户端。
 * 这是生产数据通路（不经 SSH）：注册、心跳、进度、完成、失败、取消确认。
 *
 * 错误处理铁律（对应 BACKEND_REQUIREMENTS §2.3）：
 *   409 LEASE_INVALID → 立即停止，放弃结果
 *   401/5xx/网络错误  → 绝不停止计算，指数退避重试
 */
import { config } from './config.mjs';

export class LeaseInvalidError extends Error {
  constructor(msg) { super(msg); this.name = 'LeaseInvalidError'; }
}
export class JobNotFoundError extends Error {
  constructor(msg) { super(msg); this.name = 'JobNotFoundError'; }
}

async function call(path, body, { method = 'POST', timeoutMs = 15_000 } = {}) {
  const url = `${config.gateway.baseUrl.replace(/\/$/, '')}${path}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-internal-token': config.gateway.internalToken,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};

    if (res.status === 409 && json?.error?.code === 'LEASE_INVALID') {
      throw new LeaseInvalidError(json.error.message ?? 'lease invalid');
    }
    if (res.status === 404) throw new JobNotFoundError(json?.error?.message ?? 'not found');
    if (!res.ok) {
      const e = new Error(`gateway ${res.status}: ${json?.error?.code ?? text.slice(0, 200)}`);
      e.status = res.status;
      e.retryable = res.status === 401 || res.status >= 500;
      throw e;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export const gateway = {
  registerProcess: (payload) => call('/internal/processes/register', payload),
  processHeartbeat: (payload) => call('/internal/processes/heartbeat', payload),
  jobHeartbeat: (jobId, payload) => call(`/internal/jobs/${jobId}/heartbeat`, payload),
  jobProgress: (jobId, payload) => call(`/internal/jobs/${jobId}/progress`, payload),
  jobComplete: (jobId, payload) => call(`/internal/jobs/${jobId}/complete`, payload),
  jobFail: (jobId, payload) => call(`/internal/jobs/${jobId}/fail`, payload),
  jobCancelAck: (jobId, payload) => call(`/internal/jobs/${jobId}/cancel-ack`, payload),
};

/** 带指数退避的重试。LeaseInvalid / JobNotFound 不重试（它们是明确结论）。 */
export async function withRetry(fn, { tries = 5, baseMs = 1000, maxMs = 30_000, label = '' } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof LeaseInvalidError || e instanceof JobNotFoundError) throw e;
      lastErr = e;
      if (i === tries - 1) break;
      const wait = Math.min(baseMs * 2 ** i, maxMs);
      console.warn(`[gateway] ${label} 第 ${i + 1} 次失败: ${e.message}，${wait}ms 后重试`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
