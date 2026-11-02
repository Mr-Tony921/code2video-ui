/**
 * Session 持久化：按用户恢复会话、导出用户轨迹。
 *
 * 设计要点：
 *  · 文件存储即权威记录——没有 DB 也能完整工作，DB 到位后作为镜像
 *  · 追加写（jsonl），避免并发覆盖；崩溃最多丢最后一行而非整个文件
 *  · 索引文件支持「按 user_id 找会话」，无需扫全盘
 *  · 轨迹 = 消息 + Prompt 版本 + Job 生命周期事件，全部带服务端时间戳
 *
 * 目录结构：
 *   runtime/sessions/<session_id>/
 *     meta.json         会话元信息（user_id / mode / 绑定进程 / 状态）
 *     messages.jsonl    对话与事件轨迹（追加）
 *     jobs/<job_id>/    PROMPT.md · claude.log · output/ · .done | .cancelled
 *   runtime/session-index.jsonl   全局索引（追加）：session_id ↔ user_id
 */
import { mkdir, writeFile, readFile, appendFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

// 会话目录与 session-index 一起放 sessionsRoot，保证「会话数据」整体可迁移
const sessionsRoot = () => join(config.storage.sessionsRoot, config.storage.sessionsSubdir);
const indexFile = () => join(config.storage.sessionsRoot, 'session-index.jsonl');

function nowIso() { return new Date().toISOString(); }

export function sessionPath(sessionId) {
  return join(sessionsRoot(), sessionId);
}
function metaPath(sessionId) { return join(sessionPath(sessionId), 'meta.json'); }
function tracePath(sessionId) { return join(sessionPath(sessionId), 'messages.jsonl'); }

/** 创建或更新会话元信息。幂等。 */
export async function upsertSessionMeta({
  sessionId, userId, mode, workerId, processInstanceId, skill, status = 'ACTIVE', extra = {},
}) {
  await mkdir(sessionPath(sessionId), { recursive: true });
  const p = metaPath(sessionId);
  let meta = {};
  if (existsSync(p)) {
    try { meta = JSON.parse(await readFile(p, 'utf8')); } catch { meta = {}; }
  }
  const isNew = !meta.created_at;
  meta = {
    ...meta,
    session_id: sessionId,
    user_id: userId ?? meta.user_id ?? null,
    mode: mode ?? meta.mode,
    worker_id: workerId ?? meta.worker_id,
    process_instance_id: processInstanceId ?? meta.process_instance_id,
    skill: skill ?? meta.skill,
    status,
    created_at: meta.created_at ?? nowIso(),
    last_activity_at: nowIso(),
    ...extra,
  };
  await writeFile(p, JSON.stringify(meta, null, 2), 'utf8');

  // 首次创建时写全局索引，供「按用户找会话」
  if (isNew) {
    await mkdir(config.storage.sessionsRoot, { recursive: true });
    await appendFile(indexFile(), JSON.stringify({
      session_id: sessionId, user_id: meta.user_id, mode: meta.mode,
      // 渠道写进索引：按渠道（测试/外发）筛选导出时不必逐个读 meta.json
      channel: meta.channel ?? null,
      worker_id: meta.worker_id, process_instance_id: meta.process_instance_id,
      created_at: meta.created_at,
    }) + '\n', 'utf8');
  }
  return meta;
}

export async function readSessionMeta(sessionId) {
  const p = metaPath(sessionId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

/**
 * 追加一条轨迹记录。这是用户轨迹导出的数据源。
 * kind: user_message | assistant_message | prompt_revision | job_created
 *     | job_phase | job_completed | job_failed | job_cancelled | notice
 */
export async function appendTrace(sessionId, entry) {
  await mkdir(sessionPath(sessionId), { recursive: true });
  const rec = { at: nowIso(), ...entry };
  await appendFile(tracePath(sessionId), JSON.stringify(rec) + '\n', 'utf8');
  // 顺带刷新 last_activity_at，便于「最近会话」排序
  const p = metaPath(sessionId);
  if (existsSync(p)) {
    try {
      const m = JSON.parse(await readFile(p, 'utf8'));
      m.last_activity_at = rec.at;
      await writeFile(p, JSON.stringify(m, null, 2), 'utf8');
    } catch { /* 元信息损坏不应阻断轨迹写入 */ }
  }
  return rec;
}

export async function readTrace(sessionId) {
  const p = tracePath(sessionId);
  if (!existsSync(p)) return [];
  const txt = await readFile(p, 'utf8');
  return txt.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return { at: null, kind: 'corrupt', raw: l }; }
  });
}

/** 按 user_id 列出会话（走索引，不扫全盘）。 */
export async function listSessionsByUser(userId, { limit = 50 } = {}) {
  const p = indexFile();
  if (!existsSync(p)) return [];
  const txt = await readFile(p, 'utf8');
  const rows = [];
  for (const l of txt.split('\n')) {
    if (!l) continue;
    try {
      const r = JSON.parse(l);
      if (!userId || r.user_id === userId) rows.push(r);
    } catch { /* 跳过损坏行 */ }
  }
  // 用各自 meta 的 last_activity_at 排序（索引只记创建时间）
  const enriched = [];
  for (const r of rows.slice(-limit * 3)) {
    const m = await readSessionMeta(r.session_id);
    enriched.push(m ?? r);
  }
  enriched.sort((a, b) =>
    String(b.last_activity_at ?? b.created_at ?? '').localeCompare(
      String(a.last_activity_at ?? a.created_at ?? '')));
  return enriched.slice(0, limit);
}

/** 列出会话内的 Job 及其终态（从磁盘标记读，不依赖内存）。 */
export async function listSessionJobs(sessionId) {
  // ★ 1.4.0：终态标记落在 rounds/<jid>/；1.3.x 的老会话在 jobs/<jid>/。
  //   两个都扫 —— 只扫一个的话，要么新会话导出不出任务，要么老会话查不到历史。
  const dirs = [join(sessionPath(sessionId), 'rounds'), join(sessionPath(sessionId), 'jobs')]
    .filter((d) => existsSync(d));
  if (!dirs.length) return [];
  const out = [];
  const seen = new Set();
  for (const jdir of dirs) {
  for (const e of await readdir(jdir, { withFileTypes: true })) {
    if (e.isDirectory() && seen.has(e.name)) continue;      // 同名只取先扫到的（rounds 优先）
    if (e.isDirectory()) seen.add(e.name);
    if (!e.isDirectory()) continue;
    const d = join(jdir, e.name);
    const job = { job_id: e.name, status: 'unknown' };
    for (const [marker, status] of [['.done', 'completed'], ['.cancelled', 'cancelled'], ['.failed', 'failed']]) {
      const mp = join(d, marker);
      if (existsSync(mp)) {
        job.status = status;
        try { Object.assign(job, JSON.parse(await readFile(mp, 'utf8'))); } catch {}
        break;
      }
    }
    const pp = join(d, 'PROMPT.md');
    if (existsSync(pp)) {
      const t = await readFile(pp, 'utf8');
      job.prompt_summary = t.slice(0, 200);
      job.prompt_length = t.length;
    }
    try { job.created_at = (await stat(d)).birthtime?.toISOString?.() ?? null; } catch {}
    out.push(job);
  }
  }
  return out;
}

/**
 * 导出完整用户轨迹。用于「根据用户信息恢复」与「导出用户轨迹」两个需求。
 * 注意：含用户 Prompt 原文，对外分享前需脱敏。
 */
export async function exportSession(sessionId, { includeClaudeLogs = false } = {}) {
  const meta = await readSessionMeta(sessionId);
  if (!meta) return null;
  const jobs = await listSessionJobs(sessionId);
  const executionLogs = {};
  if (includeClaudeLogs) {
    // Current sessions share one append-only stream. Export it once, not once per round.
    const ws = join(sessionPath(sessionId), 'workspace');
    for (const name of ['claude.jsonl', 'claude.stderr']) {
      if (existsSync(join(ws, name))) executionLogs[name] = await readFile(join(ws, name), 'utf8');
    }
    async function nativeLogs(dir, prefix = '') {
      if (!existsSync(dir)) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name), key = prefix + entry.name;
        if (entry.isDirectory()) await nativeLogs(path, key + '/');
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) executionLogs['native/' + key] = await readFile(path, 'utf8');
      }
    }
    await nativeLogs(join(ws, '.home', '.claude', 'projects'));
    for (const j of jobs) {
      const legacy = join(sessionPath(sessionId), 'jobs', j.job_id, 'claude.log');
      if (existsSync(legacy)) j.claude_log = await readFile(legacy, 'utf8');
    }
  }
  return { meta, trace: await readTrace(sessionId), jobs,
    ...(includeClaudeLogs ? { execution_logs: executionLogs } : {}), exported_at: nowIso() };
}

export async function exportUserTrajectory(userId, { includeClaudeLogs = false, limit = 50 } = {}) {
  const sessions = await listSessionsByUser(userId, { limit });
  const out = [];
  for (const s of sessions) {
    const e = await exportSession(s.session_id, { includeClaudeLogs });
    if (e) out.push(e);
  }
  return { user_id: userId, session_count: out.length, sessions: out, exported_at: nowIso() };
}
