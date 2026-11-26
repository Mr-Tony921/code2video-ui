// Capture a deterministic web page to MP4, frame by frame.
// The page must set window.READY = true when loaded and expose window.seek(t) (may return a Promise).
// usage: node capture.mjs PROJECT_DIR [--page index.html] [--fps 30] [--dur 12] [--size 1920x1080]
//                         [--out out/video.mp4] [--start 0] [--frames N] [--selector canvas] [--jpeg]
// Uses Playwright if installed, otherwise Puppeteer. Needs ffmpeg on PATH.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const dir = path.resolve(argv[0] || '.');
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const page_ = opt('page', 'index.html'), fps = +opt('fps', 30), [W, H] = String(opt('size', '1920x1080')).split('x').map(Number);
const out = path.resolve(dir, opt('out', 'out/video.mp4')), sel = opt('selector', null), jpeg = !!opt('jpeg', false);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  /**
   * ★ /favicon.ico 必须回 204，不能落到下面的 404。
   *
   *   浏览器总会自己请求一次 favicon；拿到 404 就会打一条 console error，
   *   而下面的抓帧循环**见到任何 console error 就 break**（见 errors 的用法）——
   *   于是整段视频只剩第 1 帧，脚本却照样打印 "wrote ..."。
   *   实测：页面不声明 icon 时，--fps 10 --dur 2 应出 20 帧，实际只出 1 帧
   *   （duration=0.1s）；页面加上 <link rel="icon"> 后立刻恢复成 20 帧。
   *   是这个服务器自己造的 404，所以在这里消掉，而不是去放宽错误判据
   *   —— 真正的页面报错仍然应该中断抓帧。
   */
  if ((req.url ?? '').split('?')[0] === '/favicon.ico') { res.writeHead(204); return res.end(); }
  const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(p).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/${page_}`;

// Import from the project folder first, so a local node_modules is found.
const { createRequire } = await import('node:module');
const req = createRequire(path.join(dir, 'package.json'));
const load = async name => { try { return req(name); } catch { return import(name); } };
const glArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
/**
 * ★ 浏览器可执行文件必须显式给出 —— 不给的话 Playwright/Puppeteer 会去找
 *   【它们自己下载的】浏览器，默认在 `$HOME/.cache/ms-playwright/`。
 *   在我们的隔离沙箱里那个目录必然是空的（HOME 是每会话新建的 .home、/mnt 被遮蔽、
 *   沙箱内无外网下不动），于是 launch 直接报
 *   `Executable doesn't exist at .../ms-playwright/chromium_headless_shell-xxxx/...`。
 *
 *   环境里本来就装了 chrome，路径在 CHROME_BIN（任务说明里也告诉了 agent 要传它），
 *   偏偏这个脚本自己没传 —— 结果 agent 照着说明书调它必定失败，
 *   只能自己抄一份改好再用（实测浪费十几分钟）。
 *
 *   CHROME_BIN 没设时保持原行为（本地装了真浏览器的开发机照旧可用）。
 */
const exe = process.env.CHROME_BIN;
const launchOpts = { args: ['--no-sandbox','--disable-dev-shm-usage',...glArgs], ...(exe ? { executablePath: exe } : {}) };
let browser, page, lib;
try { lib = await load('playwright'); } catch { lib = null; }
if (lib) {
  browser = await lib.chromium.launch(launchOpts);         // launch errors (missing system libs) surface here
  page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
} else {
  const puppeteer = (await load('puppeteer')).default;      // throws if neither is installed
  browser = await puppeteer.launch(launchOpts);
  page = await browser.newPage(); await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
}
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url);
await page.waitForFunction(() => window.READY === true && typeof window.seek === 'function', null, { timeout: 120000 });
const dur = +opt('dur', 0) || await page.evaluate(() => window.DUR || 0);
if (!dur) throw new Error('give --dur or set window.DUR');
const start = +opt('start', 0), total = +opt('frames', 0) || Math.round(dur * fps) - start;

fs.mkdirSync(path.dirname(out), { recursive: true });
const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-preset', 'veryfast', '-movflags', '+faststart', '-an', out],
  { stdio: ['pipe', 'inherit', 'inherit'] });
const target = sel ? await page.$(sel) : page;
const t0 = Date.now();
for (let i = start; i < start + total; i++) {
  await page.evaluate(async t => { await window.seek(t); }, i / fps);
  const buf = await target.screenshot(jpeg ? { type: 'jpeg', quality: 95 } : { type: 'png' });
  if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  if (errors.length) { console.error('page error at frame', i, errors); break; }
  if ((i - start) % fps === 0) process.stdout.write(`\rframe ${i - start + 1}/${total}  ${((Date.now() - t0) / (i - start + 1)).toFixed(0)} ms/frame`);
}
ff.stdin.end();
await new Promise(r => ff.on('close', r));
await browser.close(); server.close();
console.log(`\nwrote ${out}`);
if (errors.length) process.exit(1);
