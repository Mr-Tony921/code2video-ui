/**
 * 示例 prompt（管理员维护，所有用户可见）。
 *
 * 用途：给用户现成的、已经调好的创作描述。
 * 关键约定：**示例本身就是增强后的结果**，点击使用时前端会自动关闭增强 ——
 * 再过一遍增强只会偏离原意、还白等几十秒。
 */
import { mkdir, writeFile, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';

const root = () => join(config.storage.root, 'gateway', 'examples');
const pathFor = (id) => join(root(), `${id}.json`);
/**
 * 示例视频的落盘目录。
 * 与 json 分开放：示例元数据很小、视频几十上百 MB，分开便于单独清理与备份。
 */
const assetRoot = () => join(config.storage.root, 'gateway', 'example-assets');
export const videoPathFor = (id) => join(assetRoot(), `${id}.mp4`);
export async function initAssets() { await mkdir(assetRoot(), { recursive: true }); }

export async function init() { await mkdir(root(), { recursive: true }); }

/* ───────── 示例片的"预览化"处理 ───────── */

/**
 * 弹框里视频最大只显示 **360px 高**（见 components/ExampleDialog.tsx 的 maxHeight），
 * 所以示例片没有任何理由保持 1080p / 高码率。
 * 超过这两条就重新编码：高于 720p，或码率高于 PREVIEW_MAX_KBPS。
 */
const PREVIEW_MAX_HEIGHT = 720;
const PREVIEW_MAX_KBPS = 1800;

async function run(cmd, args, timeoutMs = 600_000) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  return promisify(execFile)(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 22 });
}

/** ffprobe 出 width/height/duration/bitrate。读不出来返回 null。 */
export async function probeVideo(path) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name',
      '-show_entries', 'format=duration,size,bit_rate',
      '-of', 'json', path], 60_000);
    const info = JSON.parse(stdout);
    const vs = (info.streams ?? [])[0] ?? {};
    const dur = Number(info.format?.duration);
    const size = Number(info.format?.size);
    let kbps = Number(info.format?.bit_rate) / 1000;
    // 有些文件 format.bit_rate 缺失，用 size/duration 推
    if (!(kbps > 0) && size > 0 && dur > 0) kbps = (size * 8) / dur / 1000;
    return {
      width: Number(vs.width) || null,
      height: Number(vs.height) || null,
      codec: vs.codec_name ?? null,
      duration_ms: dur > 0 ? Math.round(dur * 1000) : null,
      size_bytes: size > 0 ? size : null,
      kbps: kbps > 0 ? Math.round(kbps) : null,
    };
  } catch { return null; }
}

/** mp4 的 moov 是否已在 mdat 之前（faststart）。读不出来按"是"处理，不去动它。 */
export async function isFaststart(path) {
  try {
    const { open } = await import('node:fs/promises');
    const fh = await open(path, 'r');
    try {
      const total = (await fh.stat()).size;
      let pos = 0, moov = -1, mdat = -1;
      const hdr = Buffer.alloc(16);
      while (pos + 8 <= total && (moov < 0 || mdat < 0)) {
        const { bytesRead } = await fh.read(hdr, 0, 16, pos);
        if (bytesRead < 8) break;
        let len = hdr.readUInt32BE(0);
        const typ = hdr.toString('latin1', 4, 8);
        if (len === 1) len = Number(hdr.readBigUInt64BE(8));
        else if (len === 0) len = total - pos;
        if (typ === 'moov' && moov < 0) moov = pos;
        if (typ === 'mdat' && mdat < 0) mdat = pos;
        if (len < 8) break;
        pos += len;
      }
      if (moov < 0 || mdat < 0) return true;        // 读不明白就别动
      return moov < mdat;
    } finally { await fh.close(); }
  } catch { return true; }
}

/**
 * 把示例片处理成"适合在弹框里预览"的形态，产物落到 dst。
 *
 * ★ 为什么要做（用户反馈「示例里面的视频加载也很卡」）：
 *   实测线上唯一那个示例片是 **40.33MB / 61s = 5.3 Mbps、1080p**，
 *   而它在弹框里最大只显示 360px 高。
 *   分档实测（CDP 限速）：不限 / 20 / 8 / 5 Mbps 都 0 卡顿，
 *   **1.5 Mbps 卡 3 次** —— 也就是说它需要稳定 5~6 Mbps 才流畅，
 *   5 Mbps 时缓冲几乎没有余量。这跟对话区那个 `loop` 的问题**不是一回事**
 *   （弹框里的 video 没有 loop），纯粹是码率太高。
 *
 * 两档处理：
 *   1. 超过 720p 或码率超 PREVIEW_MAX_KBPS ⇒ **重新编码**（这才是"卡"的解法）
 *   2. 否则只做 faststart 重封装（`-c copy`，画质无损）
 *      —— moov 在尾部时浏览器要先抓文件尾才能拿到元信息，
 *      实测 3 次 Range / 1.32MB / 限速 1.5Mbps 下 1802ms；搬到头部后 1 次请求。
 *
 * ★ 安全：全部写 dst，**失败就返回 applied:false 让调用方改用原文件**。
 *   这是管理员上传路径，宁可退化成"存原片"，也不能把上传搞失败。
 *
 * @returns {{applied:boolean, reason:string, mode:'reencode'|'faststart'|'none'}}
 */
export async function optimizeForPreview(src, dst) {
  const meta = await probeVideo(src);
  if (!meta) return { applied: false, reason: 'ffprobe 读不出元信息', mode: 'none' };

  /**
   * ★ 只按【码率】决定是否重编码，分辨率不单独触发。
   *
   *   卡顿的根源是码率超过可用带宽，不是分辨率。
   *   而重编码必然有一次世代损失，对本来就很小的文件纯属白损 ——
   *   第一版写成 `tooTall || tooFat`，结果把一个 **299kbps** 的 1 秒小片
   *   也按"高于 720p"重编了一遍（1080p/299kbps → 720p/175kbps）：
   *   它本来一点都不卡，这次重编只是掉画质。
   *
   *   分辨率上限仍然生效，但只在"确实要重编码"时顺带缩下来
   *   （既然都要重编，就没理由留着弹框根本显示不了的 1080p）。
   */
  const tooFat = (meta.kbps ?? 0) > PREVIEW_MAX_KBPS;
  const needReencode = tooFat;

  const args = needReencode
    ? ['-v', 'error', '-y', '-i', src,
       // 只缩不放；保持偶数宽高（h264 要求）
       '-vf', `scale=-2:'min(${PREVIEW_MAX_HEIGHT},ih)'`,
       '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
       '-maxrate', `${PREVIEW_MAX_KBPS}k`, '-bufsize', `${PREVIEW_MAX_KBPS * 2}k`,
       '-pix_fmt', 'yuv420p',
       // 有音轨就压成 128k aac，没有就不加（-map 用 ? 容忍缺失）
       '-map', '0:v:0', '-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k',
       '-movflags', '+faststart', '-f', 'mp4', dst]
    : ['-v', 'error', '-y', '-i', src, '-c', 'copy', '-map', '0',
       '-movflags', '+faststart', '-f', 'mp4', dst];

  if (!needReencode && await isFaststart(src)) {
    return {
      applied: false,
      reason: `码率 ${meta.kbps ?? '?'}kbps 已达标且 moov 在文件头，无需处理`,
      mode: 'none',
    };
  }

  try {
    await run('ffmpeg', args, needReencode ? 900_000 : 180_000);
    const out = await probeVideo(dst);
    if (!out || !(out.duration_ms > 0) || !(out.size_bytes > 0)) {
      throw new Error('产物校验不过（读不出时长或大小）');
    }
    return {
      applied: true,
      mode: needReencode ? 'reencode' : 'faststart',
      reason: needReencode
        ? `${meta.height}p/${meta.kbps}kbps → ${out.height}p/${out.kbps}kbps`
        : 'moov 搬到文件头',
      before: meta, after: out,
    };
  } catch (e) {
    return { applied: false, reason: `处理失败：${e.message}`, mode: 'none' };
  }
}

/**
 * 存量示例片的一次性优化（Gateway 启动后台跑一遍）。
 *
 * 为什么需要：只改上传路径的话，**已经传上去的片子不会自己变好** ——
 * 线上现在就有一个 40.33MB / 5.3Mbps 的（用户正卡在它上面）。
 * 幂等：处理过之后它已经是 720p 内 + faststart，下次直接跳过。
 * 任何一条失败都只告警，绝不影响 Gateway 启动或服务。
 */
export async function optimizeExistingVideos(log = console) {
  let checked = 0, fixed = 0;
  try {
    for (const rec of await list()) {
      if (!rec.video) continue;
      const p = videoPathFor(rec.id);
      if (!existsSync(p)) continue;
      checked += 1;
      const tmp = `${p}.opt.tmp`;
      try {
        const r = await optimizeForPreview(p, tmp);
        if (!r.applied) {
          await unlink(tmp).catch(() => {});
          continue;
        }
        await rename(tmp, p);
        const after = r.after ?? await probeVideo(p);
        await setVideo(rec.id, {
          ...rec.video,
          size_bytes: after?.size_bytes ?? rec.video.size_bytes,
          duration_ms: after?.duration_ms ?? rec.video.duration_ms,
          width: after?.width ?? rec.video.width,
          height: after?.height ?? rec.video.height,
          optimized: r.mode,
          optimized_at: new Date().toISOString(),
          original_size_bytes: rec.video.original_size_bytes ?? rec.video.size_bytes,
        });
        fixed += 1;
        log.log(`[examples] 示例片已优化 ${rec.id}（${r.mode}）：${r.reason}`);
      } catch (e) {
        await unlink(tmp).catch(() => {});
        log.warn(`[examples] 示例片优化跳过 ${rec.id}: ${e.message}`);
      }
    }
    if (checked) log.log(`[examples] 存量示例片检查完毕：${checked} 个，优化 ${fixed} 个`);
  } catch (e) {
    log.warn(`[examples] 存量示例片检查失败（不影响服务）: ${e.message}`);
  }
  return { checked, fixed };
}

/** 原子写：避免并发下读到半截 JSON（与 job-store 同样的教训） */
let seq = 0;
async function atomicWrite(p, obj) {
  const tmp = `${p}.${process.pid}.${Date.now()}.${seq++}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
    await rename(tmp, p);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export class ExampleError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

export async function create({ title, prompt, mode, note, createdBy }) {
  await init();
  const t = String(title ?? '').trim();
  const pr = String(prompt ?? '').trim();
  if (!t) throw new ExampleError('VALIDATION_FAILED', '标题不能为空');
  if (!pr) throw new ExampleError('VALIDATION_FAILED', '示例内容不能为空');
  if (!['coding_to_video', 'blockout_3d'].includes(mode)) {
    throw new ExampleError('VALIDATION_FAILED', 'mode 必须是 coding_to_video 或 blockout_3d');
  }
  const id = `ex_${randomUUID()}`;
  const rec = {
    id, title: t.slice(0, 80), prompt: pr, mode,
    note: note ? String(note).slice(0, 200) : null,
    enabled: true,
    created_by: createdBy ?? null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    /** 用了多少次 —— 管理员据此判断哪些示例有用 */
    use_count: 0,
    /**
     * 可选的示例视频（管理员上传，ffprobe 校验过）。
     * null 表示没有；有则形如
     * { size_bytes, duration_ms, width, height, mime_type, uploaded_at }。
     * 不存磁盘路径 —— 路径由 videoPathFor(id) 推出，避免记录里出现可被下发的绝对路径。
     */
    video: null,
  };
  await atomicWrite(pathFor(id), rec);
  return rec;
}

export async function list({ onlyEnabled = false } = {}) {
  await init();
  const out = [];
  for (const f of await readdir(root())) {
    if (!f.endsWith('.json') || f.includes('.tmp')) continue;
    try {
      const r = JSON.parse(await readFile(join(root(), f), 'utf8'));
      if (onlyEnabled && r.enabled === false) continue;
      out.push(r);
    } catch { /* 单条坏了不影响整体 */ }
  }
  out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return out;
}

export async function update(id, patch) {
  const p = pathFor(id);
  if (!existsSync(p)) throw new ExampleError('NOT_FOUND', '示例不存在');
  const r = JSON.parse(await readFile(p, 'utf8'));
  for (const k of ['title', 'prompt', 'mode', 'note', 'enabled']) {
    if (patch[k] !== undefined) r[k] = patch[k];
  }
  r.updated_at = new Date().toISOString();
  await atomicWrite(p, r);
  return r;
}

export async function remove(id) {
  const p = pathFor(id);
  if (!existsSync(p)) throw new ExampleError('NOT_FOUND', '示例不存在');
  await unlink(p);
  return { ok: true };
}

/** 记一次使用。失败不抛 —— 统计不该挡住用户用示例。 */
export async function touchUse(id) {
  try {
    const p = pathFor(id);
    if (!existsSync(p)) return null;
    const r = JSON.parse(await readFile(p, 'utf8'));
    r.use_count = (r.use_count ?? 0) + 1;
    r.last_used_at = new Date().toISOString();
    await atomicWrite(p, r);
    return r;
  } catch { return null; }
}

/** 读单条（内部用）。与 update() 同一套：先判存在，再解析。 */
async function readOne(id) {
  const p = pathFor(id);
  if (!existsSync(p)) throw new ExampleError('NOT_FOUND', '示例不存在');
  return { p, rec: JSON.parse(await readFile(p, 'utf8')) };
}

/** 写入/替换示例视频的元信息（文件本身由调用方校验并落到 videoPathFor(id)）。 */
export async function setVideo(id, meta) {
  const { p, rec } = await readOne(id);
  rec.video = meta;
  rec.updated_at = new Date().toISOString();
  await atomicWrite(p, rec);
  return rec;
}

/**
 * 删除示例视频。
 * 先清字段再删文件 —— 顺序反了会出现「记录还指着视频、文件已经没了」，
 * 用户点播放就是 404；反过来最坏只是多一个无人引用的文件。
 */
export async function clearVideo(id) {
  const { p, rec } = await readOne(id);
  rec.video = null;
  rec.updated_at = new Date().toISOString();
  await atomicWrite(p, rec);
  await unlink(videoPathFor(id)).catch(() => {});
  return rec;
}

/** 单条读取（供下发视频时校验归属与 enabled）。不存在返回 null。 */
export async function getOne(id) {
  try { return (await readOne(id)).rec; } catch { return null; }
}
