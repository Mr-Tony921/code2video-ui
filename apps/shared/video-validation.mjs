/** A positive file size is not evidence of a playable video. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
const run = promisify(execFile);
// Coalesce repeated probes while a slow shared-storage decode is in flight.
const checks = new Map();
export async function validateVideo(path, options = {}) {
  const current = await stat(path).catch(cause => { throw Object.assign(new Error(`成片不可读: ${cause.message}`), { code: 'E_INVALID_VIDEO' }); });
  const key = JSON.stringify([path, current.size, current.mtimeMs, options.fullDecode !== false, options.expectedSize ?? null]);
  if (checks.has(key)) return checks.get(key);
  const check = checkVideo(path, options);
  checks.set(key, check);
  // Cache successes only, bounded to avoid retaining a process-lifetime catalog.
  check.catch(() => { if (checks.get(key) === check) checks.delete(key); });
  if (checks.size > 64) checks.delete(checks.keys().next().value);
  return check;
}
async function checkVideo(path, { fullDecode = true, expectedSize = null } = {}) {
  try {
    const before = await stat(path);
    if (!before.isFile() || before.size < 128 || (expectedSize != null && before.size !== expectedSize))
      throw new Error('视频为空、未完成，或文件大小与归档记录不一致');
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name,nb_frames,duration:format=duration', '-of', 'json', path],
      { timeout: 60_000, maxBuffer: 1 << 20 });
    const info = JSON.parse(stdout), stream = info.streams?.[0];
    const duration = Number(stream?.duration ?? info.format?.duration);
    if (!(stream?.width > 0 && stream?.height > 0 && duration > 0) || Number(stream.nb_frames) === 0)
      throw new Error('缺少有效的视频轨、画面或时长');
    // Full decode also rejects a file with a valid moov but truncated/corrupt mdat.
    const decoded = await run('ffmpeg', ['-v', 'error', '-xerror', '-err_detect', 'explode', '-threads', '1',
      '-i', path, '-map', '0:v:0', ...(fullDecode ? [] : ['-frames:v', '1']), '-progress', 'pipe:1', '-f', 'null', '-'],
      { timeout: fullDecode ? 300_000 : 60_000, maxBuffer: 1 << 20 });
    const decodedFrames = Number([...decoded.stdout.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1]);
    if (!(decodedFrames > 0)) throw new Error('没有可解码的视频帧');
    if (fullDecode && Number(stream.nb_frames) > 0 && decodedFrames !== Number(stream.nb_frames))
      throw new Error(`视频帧不完整: ${decodedFrames}/${stream.nb_frames}`);
    const after = await stat(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('校验期间视频仍在写入');
    return { size_bytes: after.size, width: stream.width, height: stream.height,
      duration_ms: Math.round(duration * 1000),
      validation: { version: 1, full_decode: fullDecode, checked_at: new Date().toISOString() } };
  } catch (cause) {
    throw Object.assign(new Error(`成片校验失败: ${cause.message}`), { code: 'E_INVALID_VIDEO', cause });
  }
}
