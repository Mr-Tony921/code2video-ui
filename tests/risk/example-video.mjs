import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 示例片上传的校验回归（1.4.1）。
 *
 * 用户要求「要检查格式和完整性」。两件事要守：
 *
 * A. 静态：路由的边界没被改松 —— 200MB 上限、只收 .mp4、必须 h264、
 *    管理员才能上传、下发**不泄露磁盘路径**、删除时先清字段再删文件。
 *
 * B. ★ 判据本身真的管用。原方案写的是「比对实际字节数与 ffprobe 的 format.size」，
 *    **实测无效**：format.size 就是 ffprobe stat 出来的大小，不是容器内部声明值，
 *    两者恒等。把 37403 字节的 mp4 砍一半，它照样报 size=18701（实际也是 18701）、
 *    duration 照样 1.0、streams 齐全 —— 那条判据拦不住任何东西，等于没校验。
 *    现在用整片解码（ffmpeg -f null），这个测试就是**在真二进制上**证明：
 *    好文件解码零错误、截断文件必须报错。判据要是哪天又被换回大小比对，这里会红。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const R = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// ★ 顺序很重要：**先去整行注释，再去块注释**。
//   反过来的话，注释里出现 `/api/*` 这种字样会被当成块注释开头，
//   一路吞到下一个 */ —— route.ts 第 92 行就有一条这样的整行注释，
//   导致它后面约 20 行（含 headers 构造与 accept-encoding 设置）在断言里凭空消失。
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const srv = strip(readFileSync(join(R, 'apps/gateway/src/server.mjs'), 'utf8'));
const exm = strip(readFileSync(join(R, 'apps/gateway/src/examples.mjs'), 'utf8'));

let pass = 0, fail = 0;
const t = (n, c, e = '') => { c ? (pass++, console.log('  ✅', n, e)) : (fail++, console.log('  ❌', n, e)); };

/* ───────── A. 路由边界 ───────── */
const ui = srv.indexOf("'POST /api/admin/examples/:id/video'");
t('找到上传路由', ui > 0);
const up = srv.slice(ui, ui + 6000);

t('只有管理员能上传', /role\s*!==\s*'admin'/.test(up));
t('★ 上限 200MB（不是 parseMultipart 默认的 500MB）',
  /parseMultipart\([^)]*200\s*\*\s*1024\s*\*\s*1024/.test(up));
t('★ 只接受 .mp4', /\\\.mp4\$\/i\.test/.test(up));
t('必须有 video 流', /codec_type\s*===\s*'video'/.test(up));
t('★ 必须是 h264', /codec_name\)\s*!==\s*'h264'/.test(up));
t('宽高必须 > 0', /w\s*>\s*0\s*&&\s*h\s*>\s*0/.test(up));
t('时长必须 > 0', /dur\s*>\s*0/.test(up));
t('★ 完整性用解码校验（ffmpeg -f null）',
  /'ffmpeg'/.test(up) && /'-f',\s*'null'/.test(up));
t('★ 不再用 format.size 做完整性判据（那是恒等式）',
  !/declared\s*!==\s*actual/.test(up));
t('解码有超时兜底（200MB 不能卡死 gateway）', /timeout:\s*120_?000/.test(up));
t('解码失败走 bail（删临时文件 + 400）', (() => {
  const i = up.indexOf("'-f', 'null'");
  return i > 0 && /bail\(/.test(up.slice(i, i + 900));
})());
t('ffprobe 失败也要删临时文件', /bail\(`无法解析为视频/.test(up));
t('校验通过才落最终位置', (() => {
  // 1.4.3 起 rename 的源是 `stored`（优化成功则是优化产物，否则是原片）
  const r = up.indexOf('rename(stored, dst)');
  const f = up.indexOf("'-f', 'null'");
  return r > 0 && f > 0 && r > f;
})());

const di = srv.indexOf("'DELETE /api/admin/examples/:id/video'");
t('找到删除路由', di > 0);
t('删除也要管理员', /role\s*!==\s*'admin'/.test(srv.slice(di, di + 600)));

const gi = srv.indexOf("'GET /api/examples/:id/video'");
t('找到下发路由', gi > 0);
const get = srv.slice(gi, gi + 3000);
t('下发要登录', /UNAUTHENTICATED/.test(get));
t('白模示例要查白模权限', /can_use_blockout_3d/.test(get));
t('支持 Range（视频要能拖进度条）', /accept-ranges/.test(get) && /content-range/.test(get));
t('★ 响应里不出现磁盘路径', !/videoPathFor\(id\)\s*\}/.test(get) && !/path:\s*p/.test(get));
t('隐藏的示例不下发', /!ex\.enabled/.test(get));

const li = srv.indexOf("'GET /api/examples'");
t('★ 列表只给元信息、不给路径', (() => {
  const l = srv.slice(li, li + 1200);
  return /video:\s*e\.video\s*\?\?\s*null/.test(l) && !/videoPathFor/.test(l);
})());

t('★ clearVideo 先清字段再删文件（反了就会 404）', (() => {
  const i = exm.indexOf('export async function clearVideo');
  const b = exm.slice(i, i + 700);
  return b.indexOf('atomicWrite') < b.indexOf('unlink(videoPathFor');
})());
t('示例记录里不存磁盘路径', (() => {
  // 只看 setVideo 自己的函数体 —— 窗口开大会吃到下面 clearVideo 的 videoPathFor
  const i = exm.indexOf('export async function setVideo');
  const j = exm.indexOf('export async function', i + 10);
  return i > 0 && j > i && !/videoPathFor/.test(exm.slice(i, j));
})());
t('视频与 json 分目录（便于单独清理）', /example-assets/.test(exm));

/* ───────── A2. 预览化处理（1.4.3：示例片播放卡顿）───────── */
/**
 * 用户反馈「示例里面的视频加载也很卡」。实测线上那个示例片是
 * 40.33MB / 61s = **5.3 Mbps、1080p**，而它在弹框里最大只显示 360px 高。
 * 分档实测（CDP 限速）：不限 / 20 / 8 / 5 Mbps 都 0 卡顿，**1.5 Mbps 卡 3 次**。
 * 处理后 821kbps：1.5 Mbps 与 1 Mbps 都 0 卡顿。
 * ★ 这跟对话区那个 `loop` **不是一回事** —— 弹框里的 video 没有 loop。
 */
// 本文件用的是 readFileSync，没有 read() 辅助函数；exm 上面已经读过了
const exm2 = exm;
const tab = strip(readFileSync(join(R, 'apps/web/components/ExamplesTab.tsx'), 'utf8'));

t('gateway 有预览化处理', /export async function optimizeForPreview/.test(exm2));
t('★★ 只按【码率】触发重编码（分辨率不单独触发）', (() => {
  const i = exm2.indexOf('export async function optimizeForPreview');
  const b = exm2.slice(i, i + 3000);
  return /const needReencode = tooFat;/.test(b) && !/tooTall \|\| tooFat/.test(b);
})());
t('★ 码率达标就只做 faststart（-c copy，画质无损）', (() => {
  const i = exm2.indexOf('export async function optimizeForPreview');
  const b = exm2.slice(i, i + 3000);
  return /'-c', 'copy'/.test(b) && /\+faststart/.test(b);
})());
t('★ 重编码时顺带缩到 720p 内',
  /PREVIEW_MAX_HEIGHT\s*=\s*720/.test(exm2) && /scale=-2/.test(exm2));
t('★ 有码率上限常量 1800kbps', /PREVIEW_MAX_KBPS\s*=\s*1800/.test(exm2));
t('★ 音轨可缺失也不报错（-map 0:a:0?）', /'0:a:0\?'/.test(exm2));
t('★★ 处理失败只返回 applied:false，不抛给上传路由',
  /applied: false, reason: `处理失败/.test(exm2));
t('★ 产物要校验（读不出时长或大小算失败）', /产物校验不过/.test(exm2));
t('★★ 上传路由：处理失败就用原文件（不能让管理员上传失败）',
  /if \(optResult\.applied\) stored = opt;/.test(srv) && /未优化（用原文件）/.test(srv));
t('★★ 元信息取【最终落盘那一份】（重编码后分辨率/大小/时长都变了）',
  /const fin = optResult\.after \?\? await examples\.probeVideo\(dst\)/.test(srv));
t('★ 两个临时文件都要清', (() => {
  const i = srv.indexOf('exvid_opt_');
  const b = srv.slice(i, i + 2000);
  return /unlink\(tmp\)/.test(b) && /unlink\(opt\)/.test(b);
})());
t('★★ 存量示例片有一次性优化（只改上传路径，老片子不会自己变好）',
  /export async function optimizeExistingVideos/.test(exm2));
t('★ 存量优化在 listen 回调里异步跑、不阻塞启动',
  /void examples\.optimizeExistingVideos\(console\)/.test(srv));
t('★ 存量优化单条失败只告警、清临时文件', (() => {
  const i = exm2.indexOf('export async function optimizeExistingVideos');
  const b = exm2.slice(i, i + 2500);
  return /log\.warn/.test(b) && /unlink\(tmp\)\.catch/.test(b);
})());
t('★ 记下 original_size_bytes，便于解释体积变化',
  /original_size_bytes/.test(exm2) && /original_size_bytes/.test(srv));
t('★ 管理页把处理结果显示出来（否则会被当成上传出错）',
  /已压缩：/.test(tab) && /预览化处理/.test(tab));

/* ───────── B. 判据在真二进制上有效 ───────── */
let ffmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' }); }
catch { ffmpeg = false; }

if (!ffmpeg) {
  console.log('  ⚠️  本机没有 ffmpeg，跳过解码判据的实证部分（gateway 所在机器有）');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'exvid-'));
  try {
    /**
     * ★ 必须带 +faststart（moov 搬到文件头）。
     * 不带的话 moov 在文件尾，砍一半就把它一起砍掉了 —— ffprobe 直接报
     * "moov atom not found"，第 2 步就拦住了，根本走不到完整性那一关。
     * 那样这个测试就测不到它要测的东西：**moov 还在、元信息齐全、
     * 只有码流被截断**的文件。线上管理员上传中断拿到的正是这种
     * （播放器为了能边下边播普遍用 faststart）。
     */
    const good = join(dir, 'good.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', good], { stdio: 'pipe' });

    const buf = readFileSync(good);
    const cut = join(dir, 'truncated.mp4');
    writeFileSync(cut, buf.subarray(0, Math.floor(buf.length / 2)));

    const decode = (p) => {
      try {
        const r = execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-f', 'null', '-'],
          { stdio: 'pipe', timeout: 120_000 });
        return String(r.stderr ?? '').trim();   // 退出码 0：stderr 空才算干净
      } catch (e) { return String(e.stderr ?? e.message ?? 'error').trim() || 'error'; }
    };
    /** ffprobe 读到的时长/尺寸/大小；读不出来返回 null（不抛，否则整个测试崩） */
    const probe = (p) => {
      try {
        const out = execFileSync('ffprobe', ['-v', 'error',
          '-show_entries', 'stream=codec_name,width,height',
          '-show_entries', 'format=duration,size', '-of', 'json', p], { stdio: 'pipe' });
        return JSON.parse(String(out));
      } catch { return null; }
    };

    t('好文件解码零错误 → 会被接受', decode(good) === '');
    const bad = decode(cut);
    t('★ 截断文件解码报错 → 会被拒', bad !== '', bad.split('\n')[0].slice(0, 70));

    /*
     * 旧判据无效的证据，固化下来避免有人"优化"回大小比对：
     * 截断文件【仍然能被 ffprobe 读出完整元信息】，而且 format.size
     * 与 stat 完全一致 —— 所以 `declared !== actual` 永远不成立。
     */
    const pc = probe(cut);
    t('★ 证据：截断文件 ffprobe 仍读出元信息（所以前 3 步拦不住它）',
      !!pc && Number(pc.format?.duration) > 0 && Number(pc.streams?.[0]?.width) > 0,
      pc ? `duration=${pc.format?.duration} ${pc.streams?.[0]?.width}×${pc.streams?.[0]?.height}` : 'probe 失败');
    t('★ 证据：format.size == 实际字节数（所以比对它恒成立、等于没校验）',
      !!pc && Number(pc.format?.size) === statSync(cut).size,
      `probe=${pc?.format?.size} stat=${statSync(cut).size}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`  —— 通过 ${pass} 失败 ${fail} ——`);
process.exit(fail ? 1 : 0);
