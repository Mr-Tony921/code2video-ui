import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 成片交付链路的回归（1.4.1）。
 *
 * 用户反馈「对话框的视频加载很慢」「2 秒的片子第一次播放中间断了很多次，
 * 不确定是不是内网问题」。查出来是三件互不相干的事：
 *
 *   1. `<video loop>` —— 成片常常只有 1~2 秒，loop 每次回绕都是一次 seek，
 *      readyState 掉到 1 再回 4，画面顿一下。A/B 实测（1 秒片、8 秒窗）：
 *      loop 开 → waiting 9 次 / seek 8 次；loop 关 → waiting 1 次 / seek 0 次。
 *      **而且播放期间 /playback 请求 0 条（全在缓存里）—— 跟网络无关。**
 *   2. `moov` 在文件尾部 —— ffmpeg 默认这么写，于是浏览器必须把整片下完
 *      才能出第一帧。实测 dev 上 8 个成片里 3 个如此，最大的 40.3MB、
 *      moov 就在 40.3MB 处。钉住成片时做一次 `-c copy -movflags +faststart`
 *      重封装（40MB 只要 0.09 秒，视频流 md5 不变）。
 *   3. 前端代理对【除 SSE 以外的一切】套了 120s 超时，把成片流也算进去了：
 *      40MB 在 300KB/s 的链路上要 130 秒 → 120 秒被掐断 → 浏览器重试，
 *      看起来就是「一直加载不出来」。
 *
 * 另外补上 width/height/duration_ms：原来两条上报路径都是**固定字段列表**，
 * job-runner 探到也白探，result_asset 里这三项永远 null（实测 12 个成片无一例外）。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const R = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(R, p), 'utf8');
// ★ 顺序很重要：**先去整行注释，再去块注释**。
//   反过来的话，注释里出现 `/api/*` 这种字样会被当成块注释开头，
//   一路吞到下一个 */ —— route.ts 第 92 行就有一条这样的整行注释，
//   导致它后面约 20 行（含 headers 构造与 accept-encoding 设置）在断言里凭空消失。
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

let pass = 0, fail = 0;
const t = (n, c, e = '') => { c ? (pass++, console.log('  ✅', n, e)) : (fail++, console.log('  ❌', n, e)); };

/* ───── 1. 播放器属性 ───── */
const jc = strip(read('apps/web/components/JobCard.tsx'));
const vid = /<video[^>]*\/>/.exec(jc)?.[0] ?? '';
t('找到 <video>', !!vid);
t('★★ 不带 loop（短片每次回绕都顿一下）', !/\bloop\b/.test(vid), vid.replace(/\s+/g, ' ').slice(0, 110));
t('仍然 autoPlay + muted（自动预览）', /autoPlay/.test(vid) && /muted/.test(vid));
t('仍然有 controls（没了 loop 要能手动重播）', /controls/.test(vid));
t('preload=metadata（不要一上来拉整片）', /preload="metadata"/.test(vid));

/* ───── 2. 代理不给视频流套超时 ───── */
const px = strip(read('apps/web/app/api/[...path]/route.ts'));
// 原来这条写成了 `A && B === false || C`，运算优先级下只要 C 成立就通过 —— 等于没测。
t('★★ 代理识别出流式路径（assets 的 playback/download）',
  /isStream/.test(px) && /playback\|download/.test(px));
/**
 * 1.4.4 起这条判据改了。
 *
 * 1.4.2 的写法是 `signal: isSse || isStream ? undefined : AbortSignal.timeout(...)`，
 * 当时只要求「流式别套超时」——目的达到了，却留下更大的坑：
 * `undefined` 意味着**客户端断开也传不到上游**，Gateway 的读流永远收不到 close。
 * 线上 16 小时攒了 141 个 mp4 句柄（78 个压在同一个文件上）、RSS 1.9GB 还在涨。
 *
 * 所以现在要求两件事同时成立：流式【没有超时】，但【必须带客户端的 signal】。
 * 不能再用「匹配 undefined」来表达第一件事 —— 那正是要消灭的写法。
 */
t('★★ 流式路径仍然不套超时（由 upstreamSignal 决定）',
  /signal:\s*upstreamSignal\(/.test(px)
  && /function upstreamSignal[\s\S]{0,400}if \(streaming\) return client/.test(px));
t('★★ 流式路径把客户端断开传给上游（否则句柄泄漏）',
  /function upstreamSignal[\s\S]{0,600}req\.signal/.test(px)
  && !/signal:\s*isSse\s*\|\|\s*isStream\s*\?\s*undefined/.test(px));
t('示例片播放也免超时', /examples/.test(px.slice(px.indexOf('isStream'), px.indexOf('isStream') + 400)));
t('其他接口仍有 120s 超时（别把兜底一起去掉）', /AbortSignal\.timeout\(120_?000\)/.test(px));

/* ───── 3. 钉住成片：faststart 必须【绝对安全】 ───── */
const jr = strip(read('apps/worker-bridge/src/job-runner.mjs'));
const pin = jr.slice(jr.indexOf('async function pinArtifact'), jr.indexOf('async function probeAssetMeta'));
t('★★ 先 copyFile 落地、再尝试 faststart（顺序反了就有丢片风险）',
  pin.indexOf('copyFile(art.path, dst)') < pin.indexOf('faststartInPlace'));
t('★★ remux 写临时文件，不直接写目标', /\.fs\.tmp/.test(pin));
t('★★ 校验（ffprobe 读出时长）通过才 rename 覆盖',
  pin.indexOf('ffprobe') < pin.indexOf('rename(tmp, dst)'));
t('★★ 失败时清临时文件并保留原拷贝', /rm\(tmp, \{ force: true \}\)/.test(pin));
t('★★ faststart 失败只告警、不抛给调用方', (() => {
  const f = pin.slice(pin.indexOf('async function faststartInPlace'));
  return /catch \(e\)/.test(f) && /console\.warn/.test(f) && !/throw/.test(f.slice(f.indexOf('catch (e)')));
})());
t('★ 用 -c copy（不重编码，画质无损）', /'-c',\s*'copy'/.test(pin));
t('★ remux 有超时兜底', /timeout:\s*180_?000/.test(pin));
t('★ 只对 mp4 做（其他容器别乱动）', /ext === 'mp4'/.test(pin));

/* ───── 4. 元信息要真的流到前端 ───── */
t('job-runner 探测画面元信息', /async function probeAssetMeta/.test(jr));
t('★ probeAssetMeta 读不到就返回空对象（不能挡住收尾）',
  /catch \{ return \{\}; \}/.test(jr.slice(jr.indexOf('async function probeAssetMeta'))));
t('★★ size_bytes 取【钉住后】文件的实际大小（faststart 会改字节数）',
  /pinnedSize = \(await stat\(pinned\)\)\.size/.test(jr) && /size_bytes: pinnedSize/.test(jr));
t('.done 里带上元信息', /\.\.\.vmeta/.test(jr));
const bs = strip(read('apps/worker-bridge/src/server.mjs'));
const oc = bs.slice(bs.indexOf('onComplete:'), bs.indexOf('onFail:'));
t('★★ onComplete 上报带 width/height/duration_ms（原来是固定字段列表，全丢了）',
  /width: meta\.width/.test(oc) && /height: meta\.height/.test(oc) && /duration_ms: meta\.duration_ms/.test(oc));
t('★ 用条件展开，探不到就不带这个键（别用 null 覆盖已有值）',
  /\.\.\.\(meta\.width \? \{ width: meta\.width \} : \{\}\)/.test(oc));
const pr = bs.slice(bs.indexOf("[['.done', 'completed']"), bs.indexOf("if (status === 'cancelled')"));
t('★★ 对账补判那条路也带（字段不能比 onComplete 少）',
  /width: meta\.width/.test(pr) && /duration_ms: meta\.duration_ms/.test(pr));

/* ───── 5. faststart 在真二进制上有效且无损 ───── */
let ff = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' }); } catch { ff = false; }
if (!ff) {
  console.log('  ⚠️  本机没有 ffmpeg，跳过 faststart 的实证部分（worker 上有）');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'fs-'));
  try {
    const src = join(dir, 'src.mp4'), out = join(dir, 'out.mp4');
    // ffmpeg 默认不加 faststart —— 正是 agent 产出的那种形态
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
      '-i', 'testsrc=size=640x360:rate=30:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src], { stdio: 'pipe' });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-c', 'copy', '-map', '0',
      '-movflags', '+faststart', '-f', 'mp4', out], { stdio: 'pipe' });

    /** 顶层原子顺序 */
    const atoms = (p) => {
      const buf = readFileSync(p); const out = []; let pos = 0;
      while (pos + 8 <= buf.length) {
        let l = buf.readUInt32BE(pos);
        const typ = buf.toString('latin1', pos + 4, pos + 8);
        if (l === 1) l = Number(buf.readBigUInt64BE(pos + 8));
        else if (l === 0) l = buf.length - pos;
        out.push([typ, pos]); if (l < 8) break; pos += l;
      }
      return out;
    };
    const posOf = (a, n) => (a.find(([t]) => t === n) ?? [])[1] ?? -1;
    const A = atoms(src), B = atoms(out);
    t('★ 对照：ffmpeg 默认把 moov 写在 mdat 之后（所以这事真实存在）',
      posOf(A, 'moov') > posOf(A, 'mdat'),
      `源原子序 ${A.map(([t]) => t).join(',')}`);
    t('★★ faststart 后 moov 在 mdat 之前（首帧不必等整片）',
      posOf(B, 'moov') < posOf(B, 'mdat'),
      `输出原子序 ${B.map(([t]) => t).join(',')}`);
    const vmd5 = (p) => String(execFileSync('ffmpeg',
      ['-v', 'error', '-i', p, '-map', '0:v', '-c', 'copy', '-f', 'md5', '-'],
      { stdio: 'pipe' })).trim();
    t('★★ 视频流逐字节一致（只重排容器，画质无损）', vmd5(src) === vmd5(out), vmd5(out));
    t('体积基本不变', Math.abs(statSync(out).size - statSync(src).size) < statSync(src).size * 0.05);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`  —— 通过 ${pass} 失败 ${fail} ——`);
process.exit(fail ? 1 : 0);
