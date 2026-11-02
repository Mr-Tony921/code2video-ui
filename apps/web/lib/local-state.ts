/**
 * 浏览器本地恢复入口。
 *
 * 只存【非敏感标识】，用于恢复 UI 初始态。
 * 禁止存：密码、Token、密钥、完整 Prompt、视频数据、任何权限信息。
 * 权限一律由服务端 /api/auth/me 决定；改本地 mode 不会获得白模权限。
 *
 * 本地缓存不是权威来源 —— 它只提供候选 ID，状态一律以服务端快照为准。
 */
import type { Mode } from './types';

const VERSION = 1;

export type LocalContext = {
  v: number;
  userScope: string;      // 用户名哈希，避免共用设备串号
  sessionId: string | null;
  mode: Mode;
  jobId: string | null;
  lastSeenAt: string;
  lastEventSeq?: number;
};

function scopeKey(userScope: string) {
  return `cvw:ctx:${userScope}`;
}

/** 简易哈希：只为隔离不同用户的本地键，不作安全用途 */
export function hashScope(username: string): string {
  let h = 0;
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export function loadContext(userScope: string): LocalContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(scopeKey(userScope));
    if (!raw) return null;
    const c = JSON.parse(raw) as LocalContext;
    if (c.v !== VERSION || c.userScope !== userScope) return null;
    return c;
  } catch {
    return null;   // 隐私模式 / 被清理 / 畸形数据：走服务端兜底
  }
}

export function saveContext(c: Omit<LocalContext, 'v' | 'lastSeenAt'>): void {
  if (typeof window === 'undefined') return;
  try {
    const full: LocalContext = { ...c, v: VERSION, lastSeenAt: new Date().toISOString() };
    window.localStorage.setItem(scopeKey(c.userScope), JSON.stringify(full));
  } catch { /* 存不进去不影响功能，服务端兜底 */ }
}

export function clearContext(userScope: string): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(scopeKey(userScope)); } catch {}
}

/** 输入框草稿：按会话隔离，切换会话不丢失 */
export function loadDraft(sessionId: string): string {
  if (typeof window === 'undefined') return '';
  try { return window.localStorage.getItem(`cvw:draft:${sessionId}`) ?? ''; } catch { return ''; }
}
export function saveDraft(sessionId: string, text: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (text) window.localStorage.setItem(`cvw:draft:${sessionId}`, text);
    else window.localStorage.removeItem(`cvw:draft:${sessionId}`);
  } catch {}
}

/** 多标签页同步：纯 UI 优化，不可用时功能不降级 */
export function broadcast(msg: unknown): void {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return;
  try {
    const ch = new BroadcastChannel('cvw');
    ch.postMessage(msg);
    ch.close();
  } catch {}
}
export function onBroadcast(fn: (msg: unknown) => void): () => void {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return () => {};
  try {
    const ch = new BroadcastChannel('cvw');
    ch.onmessage = (e) => fn(e.data);
    return () => ch.close();
  } catch { return () => {}; }
}
