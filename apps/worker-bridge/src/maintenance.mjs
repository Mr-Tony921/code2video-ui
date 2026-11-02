/**
 * 维护标记（Bridge 侧只读）。
 *
 * 唯一用途也是最关键的用途：Gateway 重启期间 Job 心跳会连续失败，
 * supervisor 原本在失联 lease_ttl×3（实测 6 分钟）后会「自保停止」，
 * 把正在跑的任务全部杀掉。热更新时必须跳过那条分支。
 * 读的是 Gateway 写的同一个文件（两者共享 storage.root）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

let cache = { at: 0, value: { active: false } };

export function read() {
  try {
    const p = join(config.storage.root, 'gateway', 'maintenance.json');
    if (!existsSync(p)) return { active: false };
    if (Date.now() - cache.at < 1000) return cache.value;
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    // 无 expires_at 的标记也要有绝对上限：Bridge 这边卡住意味着
    // 自保停止被永久关掉，真出孤儿任务时就没人收了。
    if (raw.active && !raw.expires_at && raw.started_at) {
      if (Date.now() - Date.parse(raw.started_at) > 900_000) {
        cache = { at: Date.now(), value: { active: false } };
        return cache.value;
      }
    }
    if (raw.active && raw.expires_at && Date.parse(raw.expires_at) < Date.now()) {
      cache = { at: Date.now(), value: { active: false } };
      return cache.value;
    }
    cache = { at: Date.now(), value: raw };
    return raw;
  } catch { return { active: false }; }   // fail-open
}

export function isActive() { return read().active === true; }
