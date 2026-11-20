/**
 * Reference 附件（V2 需求 1）。
 *
 * 白模每 session 最多 100 张图片，其他模式最多 10 个，放 session 固定目录 references/，供 skill 判断如何使用。
 * 任务提交后冻结该 session 的附件集合 —— 避免生产中途变更导致结果不可复现。
 */
import { mkdir, writeFile, readFile, readdir, unlink, stat, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readSessionMeta } from './session-store.mjs';
const execFileAsync = promisify(execFile);
import { config } from './config.mjs';
import { referencesDir } from './session-workspace.mjs';

const cfg = () => config.raw.references ?? {};

// A session has one assigned bridge. Serialize its mutations (including freeze)
// so concurrent uploads cannot lose manifest entries or bypass the limit.
const mutations = new Map();
function mutate(sessionId, operation) {
  const next = (mutations.get(sessionId) ?? Promise.resolve()).then(operation);
  const tail = next.catch(() => {});
  mutations.set(sessionId, tail);
  void tail.then(() => { if (mutations.get(sessionId) === tail) mutations.delete(sessionId); });
  return next;
}
export function referenceLimit(mode) { return mode === 'blockout_3d' ? 100 : Math.min(10, cfg().max_per_session ?? 10); }
export async function referenceManifest(sessionId) {
  const [meta, manifest] = await Promise.all([readSessionMeta(sessionId), readManifest(sessionId)]);
  const max = referenceLimit(meta?.mode);
  return { ...manifest, max_per_session: max, remaining: Math.max(0, max - manifest.items.length) };
}

function manifestPath(sessionId) {
  return join(referencesDir(sessionId), cfg().manifest_file ?? 'manifest.json');
}

/** 后缀 → 类型。未知后缀拒绝，不猜。 */
export function classify(filename) {
  const ext = extname(filename).toLowerCase();
  for (const [type, exts] of Object.entries(cfg().allowed_types ?? {})) {
    if (exts.includes(ext)) return type;
  }
  return null;
}

export async function readManifest(sessionId) {
  const p = manifestPath(sessionId);
  if (!existsSync(p)) return { items: [], frozen: false };
  try { return JSON.parse(await readFile(p, 'utf8')); }
  catch { return { items: [], frozen: false }; }
}

async function writeManifest(sessionId, m) {
  await mkdir(referencesDir(sessionId), { recursive: true });
  // Readers must see either the old or the complete new manifest.
  const state = join(referencesDir(sessionId), '.state');
  await mkdir(state, { recursive: true });
  const tmp = join(state, randomUUID() + '.json');
  try {
    await writeFile(tmp, JSON.stringify(m, null, 2), 'utf8');
    await rename(tmp, manifestPath(sessionId));
  } finally { await unlink(tmp).catch(() => {}); }
  return m;
}

/** ffprobe 实测 meta —— dense prompt 模板要它来算倍速等（usage.md 建议填） */
async function probeMeta(path, type) {
  const ff = config.runtimeBinaries.ffprobe ?? 'ffprobe';
  try {
    const r = await execFileAsync(ff, ['-v', 'error', '-show_entries',
      'format=duration:stream=codec_type,width,height,r_frame_rate',
      '-of', 'json', path], { encoding: 'utf8', timeout: 30_000 });
    const d = JSON.parse(r.stdout);
    const v = (d.streams ?? []).find((s) => s.codec_type === 'video');
    const meta = {};
    if (d.format?.duration) meta.duration_s = Math.round(Number(d.format.duration) * 1000) / 1000;
    if (v) {
      meta.width = v.width; meta.height = v.height;
      if (type !== 'image' && v.r_frame_rate) {
        const [n, de] = v.r_frame_rate.split('/').map(Number);
        if (de) meta.fps = Math.round((n / de) * 1000) / 1000;
      }
    }
    if (type !== 'image') meta.has_audio = (d.streams ?? []).some((s) => s.codec_type === 'audio');
    return meta;
  } catch { return {}; }
}

/** 文件名冲突时加 -2、-3 后缀，保留原名语义（skill 要靠文件名理解素材） */
function uniqueName(dir, name) {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = basename(name, ext);
  for (let i = 2; i < 100; i++) {
    const cand = `${stem}-${i}${ext}`;
    if (!existsSync(join(dir, cand))) return cand;
  }
  return `${stem}-${Date.now()}${ext}`;
}

export class ReferenceError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

/**
 * 保存一个附件。tmpPath 是已落盘的临时文件，本函数负责改名入位。
 */
export function addReference(sessionId, input) { return mutate(sessionId, () => addReferenceUnlocked(sessionId, input)); }
async function addReferenceUnlocked(sessionId, { filename, tmpPath, note }) {
  const c = cfg();
  if (c.enabled === false) throw new ReferenceError('REFERENCES_DISABLED', 'Reference 功能未启用');

  const m = await readManifest(sessionId);
  if (m.frozen) {
    throw new ReferenceError('REFERENCES_FROZEN',
      '该会话已提交生成任务，附件集合已冻结。请新建会话后再上传。');
  }
  const meta = await readSessionMeta(sessionId);
  const max = referenceLimit(meta?.mode);
  if (m.items.length >= max) {
    throw new ReferenceError('REFERENCE_LIMIT_EXCEEDED',
      `每个会话最多 ${max} 个参考素材，当前已有 ${m.items.length} 个`);
  }

  const type = classify(filename);
  if (!type) {
    throw new ReferenceError('REFERENCE_TYPE_UNSUPPORTED',
      `不支持的文件类型：${extname(filename) || '(无后缀)'}。支持图片、视频、音频。`);
  }
  // Match the Seko engine's supported image inputs. Reject unsupported files
  // at upload, instead of silently omitting them when a job starts.
  if (meta?.mode === 'blockout_3d' &&
      (type !== 'image' || !['.png', '.jpg', '.jpeg', '.webp'].includes(extname(filename).toLowerCase()))) {
    throw new ReferenceError('REFERENCE_TYPE_UNSUPPORTED', '白模参考图支持 PNG、JPEG、WebP；请先转换后再上传');
  }
  const s = await stat(tmpPath);
  const maxBytes = c.max_file_bytes ?? 524288000;
  if (s.size > maxBytes) {
    throw new ReferenceError('REFERENCE_TOO_LARGE',
      `单个文件不能超过 ${Math.round(maxBytes / 1048576)}MB（该文件 ${Math.round(s.size / 1048576)}MB）`);
  }

  const dir = referencesDir(sessionId);
  await mkdir(dir, { recursive: true });
  const stored = uniqueName(dir, basename(filename));
  const dest = join(dir, stored);
  await rename(tmpPath, dest);

  const item = {
    stored_name: stored,
    original_name: filename,
    type,
    size_bytes: s.size,
    note: note ?? null,
    meta: await probeMeta(dest, type),
    uploaded_at: new Date().toISOString(),
  };
  m.items.push(item);
  await writeManifest(sessionId, m);
  return { item, manifest: m };
}

export function removeReference(sessionId, storedName) { return mutate(sessionId, () => removeReferenceUnlocked(sessionId, storedName)); }
async function removeReferenceUnlocked(sessionId, storedName) {
  const m = await readManifest(sessionId);
  if (m.frozen) {
    throw new ReferenceError('REFERENCES_FROZEN', '该会话已提交生成任务，附件集合已冻结');
  }
  const i = m.items.findIndex((x) => x.stored_name === storedName);
  if (i < 0) throw new ReferenceError('NOT_FOUND', `未找到素材 ${storedName}`);
  await unlink(join(referencesDir(sessionId), storedName)).catch(() => {});
  m.items.splice(i, 1);
  await writeManifest(sessionId, m);
  return m;
}

/** 任务提交时冻结 */
export function freezeReferences(sessionId) { return mutate(sessionId, () => freezeReferencesUnlocked(sessionId)); }
async function freezeReferencesUnlocked(sessionId) {
  const m = await readManifest(sessionId);
  if (!m.frozen) {
    m.frozen = true;
    m.frozen_at = new Date().toISOString();
    await writeManifest(sessionId, m);
  }
  return m;
}

/**
 * 给增强模型用的 assets JSON（dense_prompt_template 的 {{ASSETS_JSON}}）。
 * path 必须与最终放进 job 工作区的位置一致 —— usage.md 强调了这点。
 */
export async function assetsJsonForEnhance(sessionId) {
  const m = await readManifest(sessionId);
  return m.items.map((it) => ({
    path: `assets/${it.stored_name}`,
    type: it.type,
    ...(it.note ? { note: it.note } : {}),
    ...(Object.keys(it.meta ?? {}).length ? { meta: it.meta } : {}),
  }));
}
