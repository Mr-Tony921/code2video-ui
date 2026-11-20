/**
 * 成片的「网页播放用降采样预览片」。
 *
 * 为什么要有：线上 71 个产物里，最大的是 **98.6MB / 19702kbps（42 秒）**、
 * 89.6MB / 75106kbps（10 秒）、81.3MB / 13633kbps（50 秒），码率中位数 1302kbps。
 * 而对话区的 `<video>` 是 `width:100%`（约 700px 宽），1080p 的像素根本显示不出来。
 * 在受限链路上这些原片等于打不开 —— 播放要的是「快」，不是「原分辨率」。
 *
 * ★ 三条设计约束（都对应真实风险）：
 *
 * 1. **预览片放在会话目录之外** —— `<storage.root>/gateway/asset-previews/<jobId>.mp4`。
 *    不放在原片旁边，是为了彻底避开两件事：
 *      · 多轮续跑：agent 的工作区 `sessions/<sid>/workspace/` 是**各轮共用**的，
 *        `output/final.mp4` 第 2 轮就被覆盖。产物之所以能按轮回放，靠的是
 *        每轮钉住的副本 `rounds/<jid>/final.mp4`。预览片按 **job_id** 命名，
 *        job_id 本身就是每轮唯一（实测线上 130 个产物路径，被多个 job 共用的 0 个），
 *        所以多轮之间不可能互相覆盖。
 *      · 不碰生成逻辑：这个目录属于 Gateway，agent 看不到、续跑迁移不会拷它、
 *        e2e 对产物 inode/md5 的断言也不受影响（我们只新增旁路文件，原片一个字节不动）。
 *
 * 2. **网页预览同时限制分辨率和码率。** 默认最高 480P；低码率的高分辨率
 *    白模同样需要缩小。原片低于两项上限时直接播放，不放大、不改原片。
 *
 * 3. **任何失败都退化成「播原片」，绝不让播放失败。** ffmpeg 不在、转码超时、
 *    产物校验不过，统统返回 null，调用方继续用原片。
 *
 * 陈旧判定：记下源文件的 size + mtime。原片被重写过（比如 1.4.2 的 faststart 重封装
 * 会改字节数）就重新生成 —— 否则会把旧内容当成这一轮的成片播出去。
 */
import { mkdir, stat, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { probeVideo } from './examples.mjs';   // 已在 1.4.3 实测过的 ffprobe 包装，不另写一份

const previewRoot = () => join(config.storage.root, 'gateway', 'asset-previews');
export const previewPathFor = (jobId) => join(previewRoot(), `${jobId}.mp4`);
export async function initPreviews() { await mkdir(previewRoot(), { recursive: true }); }

const cfg = () => {
  const p = config.raw?.preview ?? {};
  return {
    maxHeight: Number(p.max_height ?? 480),
    maxKbps: Number(p.max_kbps ?? 600),
    audioKbps: Number(p.audio_kbps ?? 96),
    timeoutMs: Number(p.generate_timeout_ms ?? 120_000),
  };
};

export function previewCaps() { const { maxHeight, maxKbps } = cfg(); return `v2:${maxHeight}x${maxKbps}`; }
export const previewUrlFor = id => `/api/assets/${id}/playback?v=${encodeURIComponent(previewCaps())}`;

async function run(cmd, args, timeoutMs) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  return promisify(execFile)(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 22 });
}

/** 同一个 job 的并发生成只跑一次（两个人同时点播同一个成片） */
const inflight = new Map();

/**
 * 源文件指纹。只用 size + mtime，不做 hash ——
 * 对 98MB 的文件做 hash 会把播放请求拖死，而原片在钉住之后就不再变了。
 */
async function fingerprint(path) {
  try {
    const st = await stat(path);
    return { source_size: st.size, source_mtime_ms: Math.round(st.mtimeMs) };
  } catch { return null; }
}

/** 已记录的 preview 元信息是否还对得上现在的原片 */
export function previewIsFresh(preview, fp) {
  if (!preview || !fp) return false;
  /**
   * ★ 上限改了也要判过期。
   *
   * 否则调 config.preview 等于没用：已经判过"码率达标、直接播原片"（mode:'none'）
   * 的记录会永远新鲜，新上限再也套不到它身上 —— 删 asset-previews/ 目录也救不回来，
   * 因为那条记录根本没有文件。把上限一起记进指纹，改配置后下次播放自动重做。
   */
  if (preview.caps !== previewCaps()) return false;
  return preview.source_size === fp.source_size
      && preview.source_mtime_ms === fp.source_mtime_ms;
}

/**
 * 确保某个 job 的预览片就绪。
 *
 * @returns {Promise<null|{mode:'reencode'|'none', path:string|null, meta:object}>}
 *   · `mode:'reencode'` —— 预览片已生成，`path` 可直接下发
 *   · `mode:'none'`     —— 原片本来就达标，**应当直接播原片**（path 为 null）
 *   · `null`            —— 失败，调用方退化成播原片
 */
export async function ensurePreview(jobId, srcPath, { log = console } = {}) {
  if (!jobId || !srcPath || !existsSync(srcPath)) return null;
  if (inflight.has(jobId)) return inflight.get(jobId);
  const task = (async () => {
    const { maxHeight, maxKbps, audioKbps, timeoutMs } = cfg();
    const fp = await fingerprint(srcPath);
    const meta = await probeVideo(srcPath);
    if (!meta || !fp) return null;                       // ffprobe 不在/读不出 ⇒ 播原片

    // Resolution is a separate trigger: even low-bitrate 720P whitebox needs a 480P preview.
    if (!((meta.kbps ?? 0) > maxKbps || (meta.height ?? 0) > maxHeight)) {
      // 上限被调高之后，之前生成的预览片就没用了 —— 顺手删掉，别留孤儿文件
      await unlink(previewPathFor(jobId)).catch(() => {});
      return { mode: 'none', path: null,
               meta: { ...fp, caps: previewCaps(), mode: 'none',
                       width: meta.width, height: meta.height,
                       reason: `分辨率与码率均未超 ${maxHeight}P / ${maxKbps}kbps，直接播原片` } };
    }

    await mkdir(previewRoot(), { recursive: true });
    const dst = previewPathFor(jobId);
    const tmp = `${dst}.${randomUUID()}.tmp`;
    try {
      await run('ffmpeg', [
        '-v', 'error', '-y', '-threads', '2', '-i', srcPath,
        '-filter_threads', '1',
        '-vf', `scale=-2:'min(${maxHeight},ih)'`,         // 只缩不放，保持偶数宽高
        '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '26',
        '-maxrate', `${maxKbps}k`, '-bufsize', `${maxKbps * 2}k`,
        '-pix_fmt', 'yuv420p',
        '-map', '0:v:0', '-map', '0:a:0?', '-c:a', 'aac', '-b:a', `${audioKbps}k`,
        '-movflags', '+faststart', '-f', 'mp4', tmp,      // moov 搬到头部，起播少一次 Range
      ], timeoutMs);
      const out = await probeVideo(tmp);
      if (!out || !(out.duration_ms > 0) || !(out.size_bytes > 0)) {
        throw new Error('产物校验不过（读不出时长或大小）');
      }
      await rename(tmp, dst);                             // 先校验再 rename，别让半截文件被播到
      log?.log?.(`[preview] ${jobId} ${meta.height}p/${meta.kbps}kbps → `
        + `${out.height}p/${out.kbps}kbps（${(meta.size_bytes / 1048576).toFixed(1)}MB → ${(out.size_bytes / 1048576).toFixed(1)}MB）`);
      return {
        mode: 'reencode', path: dst,
        meta: { ...fp, caps: previewCaps(), mode: 'reencode', generated_at: new Date().toISOString(),
                size_bytes: out.size_bytes, width: out.width, height: out.height,
                kbps: out.kbps, duration_ms: out.duration_ms },
      };
    } catch (e) {
      await unlink(tmp).catch(() => {});
      log?.warn?.(`[preview] ${jobId} 生成失败（改播原片）: ${e.message}`);
      return null;
    }
  })().finally(() => inflight.delete(jobId));
  inflight.set(jobId, task);
  return task;
}

