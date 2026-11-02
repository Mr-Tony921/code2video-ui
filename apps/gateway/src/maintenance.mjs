/**
 * 维护（热更新）标记。
 *
 * 为什么落文件而不是内存：
 *  · 部署脚本要在 Gateway【停着】的时候置位/清除；
 *  · Bridge 也要读它（心跳失联时不能自保停止，否则 Gateway 一重启就杀光任务）。
 * 两个进程共享 storage.root，文件是最简单可靠的交汇点。
 *
 * expires_at 是硬要求，不是装饰：部署脚本崩了也不能把前端永久锁死，
 * 过期即视为未激活。读失败一律 fail-open（当作没在维护）。
 */
import { readFileSync, existsSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from './config.mjs';

const DEFAULT_WINDOW_SEC = 900;

export function flagPath() {
  return join(config.storage.root, 'gateway', 'maintenance.json');
}

let cache = { at: 0, mtime: 0, value: { active: false } };

export function read() {
  const p = flagPath();
  try {
    if (!existsSync(p)) { cache = { at: Date.now(), mtime: 0, value: { active: false } }; return cache.value; }
    // 1 秒内复用，避免每个请求都读盘
    if (Date.now() - cache.at < 1000) return cache.value;
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    // 没有 expires_at（手工置位/旧格式）也要有绝对上限：
    // 维护标记卡住 = 全站只读，比漏一次维护严重得多。
    if (raw.active && !raw.expires_at && raw.started_at) {
      const cap = (config.raw?.maintenance?.max_window_seconds ?? DEFAULT_WINDOW_SEC) * 1000;
      if (Date.now() - Date.parse(raw.started_at) > cap) {
        console.warn('[maintenance] 维护标记无 expires_at 且已超过最大窗口，按「未在维护」处理');
        cache = { at: Date.now(), mtime: 0, value: { active: false } };
        return cache.value;
      }
    }
    if (raw.active && raw.expires_at && Date.parse(raw.expires_at) < Date.now()) {
      console.warn('[maintenance] 维护标记已过期，按「未在维护」处理（部署脚本可能异常退出了）');
      cache = { at: Date.now(), mtime: 0, value: { active: false, expired_at: raw.expires_at } };
      return cache.value;
    }
    cache = { at: Date.now(), mtime: 0, value: raw };
    return raw;
  } catch (e) {
    // 读坏了绝不能把站点锁住
    return { active: false, read_error: e.message };
  }
}

export function isActive() { return read().active === true; }

export function begin(info = {}) {
  const sec = Number(info.expected_seconds) > 0
    ? Number(info.expected_seconds)
    : (config.raw?.maintenance?.max_window_seconds ?? DEFAULT_WINDOW_SEC);
  const body = {
    active: true,
    title: info.title ?? '系统正在更新',
    message: info.message ?? '正在运行的任务不受影响，更新期间暂时无法新建对话或提交任务',
    started_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + sec * 1000).toISOString(),
    expected_seconds: sec,
    version_from: info.version_from ?? null,
    version_to: info.version_to ?? null,
  };
  const p = flagPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
  renameSync(tmp, p);
  cache = { at: 0, mtime: 0, value: body };
  return body;
}

export function end() {
  rmSync(flagPath(), { force: true });
  cache = { at: 0, mtime: 0, value: { active: false } };
  return { active: false };
}
