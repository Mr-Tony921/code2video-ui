/**
 * 前端心跳：心跳断够久则停止该会话的任务。
 *
 * 阈值只有一个来源：`config/backend.json` 的 `presence.timeout_seconds`。
 * ⚠️ 不要在代码或文案里重复写死这个数字 —— 它改过（600s → 43200s），
 *    写死的地方会立刻变成假话。
 *
 * V2 需求 5 原本要求"心跳断 10min 自动停止"（推翻 V1 的"关闭网页不影响生成"）。
 * 2026-10-27 起阈值调到 43200s（12h），与 production.max_runtime_seconds 一致，
 * 等于【关闭了因断连而自动取消】：presence 计时从最后一次心跳算起，
 * 而最后一次心跳不早于任务提交，所以 12h 上限总是先由 watchdog 命中。
 * 起因：用户重启电脑导致心跳断 624s，一个已跑 188min 且健康的任务被杀（job_8addd244）。
 *
 * 关键区分（阈值不论多大都成立）：
 *   · 切标签页 / 最小化 / 切到其他应用 → 心跳【保持】，任务继续
 *   · 关闭标签页 / 关闭浏览器         → 心跳断，超过阈值后停止任务
 *
 * 浏览器会节流隐藏页面的定时器，极端情况（冻结标签页、机器睡眠）会完全停摆，
 * 所以阈值必须远大于节流间隔：
 *   · 前端用 visibilitychange 在恢复可见时立即补发（只在切回来时才触发）
 *   · 前端用 sendBeacon 兜底
 */
import * as store from './store/job-store.mjs';
import { config } from './config.mjs';

export class PresenceTracker {
  constructor({ log = console, onTimeout } = {}) {
    this.log = log;
    this.onTimeout = onTimeout;
    /** sessionId → { userId, lastSeen, tabs:Set } */
    this.sessions = new Map();
    this.timer = null;
  }

  cfg() {
    return config.raw.presence ?? { enabled: true, timeout_seconds: 600, timeout_action: 'stop' };
  }

  /** 前端心跳。tabId 用于区分多标签页：任一标签页在线即算在线。 */
  beat(sessionId, userId, tabId) {
    const now = Date.now();
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { userId, lastSeen: now, tabs: new Map() };
      this.sessions.set(sessionId, s);
    }
    // 同账号多地址/多标签：userId 相同就并存，任一在线即算在线。
    // 若 userId 变了说明会话被另一个账号的请求碰到了 —— 不该发生，记下来。
    if (s.userId && s.userId !== userId) {
      this.log.warn?.(`[presence] ⚠ session ${sessionId} 的心跳用户从 ${s.userId} 变为 ${userId}（可能串号，已忽略新值）`);
      return { ok: false, reason: 'USER_MISMATCH', timeout_seconds: this.cfg().timeout_seconds };
    }
    s.userId = userId;
    s.lastSeen = now;
    if (tabId) s.tabs.set(tabId, now);

    // 清理过期标签页：每次刷新/重连都会生成新 tabId，旧的若不剔除会无限累积
    // （实测一个会话攒到 15 个"在线"标签页，其中绝大多数早已关闭）。
    // 标签页数量会影响判断"还有人看着吗"，必须反映真实情况。
    const stale = (this.cfg().timeout_seconds ?? 600) * 1000;
    for (const [t, seen] of s.tabs) {
      if (now - seen > stale) s.tabs.delete(t);
    }
    if (process.env.CVW_DEBUG !== '0' && s.tabs.size > 1) {
      this.log.log?.(`[dbg] {"evt":"presence.multi","sid":"${sessionId}","u":"${userId}","tabs":${s.tabs.size}}`);
    }
    return { ok: true, timeout_seconds: this.cfg().timeout_seconds, tabs: s.tabs.size };
  }

  /** 标签页显式离开（关页时 sendBeacon 发来）。不立即停，仍走超时判定。 */
  leave(sessionId, tabId) {
    const s = this.sessions.get(sessionId);
    if (s && tabId) s.tabs.delete(tabId);
    return { ok: true, remaining_tabs: s ? s.tabs.size : 0 };
  }

  ageMs(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? Date.now() - s.lastSeen : null;
  }

  start(intervalMs = 30_000) {
    this.stop();
    this.timer = setInterval(() => this.sweep().catch((e) =>
      this.log.warn(`[presence] ${e.message}`)), intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async sweep() {
    const c = this.cfg();
    if (c.enabled === false) return;
    const timeoutMs = (c.timeout_seconds ?? 600) * 1000;
    const now = Date.now();

    for (const [sessionId, s] of this.sessions) {
      const age = now - s.lastSeen;
      if (age < timeoutMs) continue;

      const live = (await store.listJobs({ sessionId }))
        .filter((j) => !store.isTerminal(j.status));
      if (!live.length) {
        this.sessions.delete(sessionId);         // 没在跑的任务，清掉记录即可
        continue;
      }

      if (c.timeout_action === 'mark') {
        for (const j of live) {
          if (j._presence_lost) continue;
          await store.patchJob(j.id, { _presence_lost: true });
          await store.appendEvent(j.id, 'job.presence_lost', {
            presence_age_ms: age, note: '用户已离开页面，任务继续执行',
          });
        }
        continue;
      }

      // stop：心跳断够久 → 停止任务
      this.log.warn(`[presence] 会话 ${sessionId} 心跳断 ${Math.round(age / 1000)}s，` +
        `停止 ${live.length} 个任务（阈值 ${c.timeout_seconds}s）`);
      for (const j of live) {
        if (j.cancellation?.requested_at) continue;     // 已在取消中
        await this.onTimeout?.(j, age);
      }
      this.sessions.delete(sessionId);
    }
  }

  snapshot() {
    const out = [];
    for (const [sid, s] of this.sessions) {
      out.push({
        session_id: sid, user_id: s.userId,
        last_seen_age_ms: Date.now() - s.lastSeen,
        tabs: s.tabs.size,
      });
    }
    return out;
  }
}
