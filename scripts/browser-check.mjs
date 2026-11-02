import puppeteer from '../runtime/previs-deps/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const cfg = JSON.parse(await readFile(join(root, 'config/backend.json'), 'utf8'));
const lan = `http://${cfg.deployment.web.host}:${cfg.deployment.web.port}`;
const base = process.env.CVW_TEST_BASE_URL ?? lan;
assert.ok([lan, cfg.deployment.web.public_url].includes(base), 'Test URL must be a configured dev entry');
const out = join(root, 'runtime/validation/browser');
await mkdir(out, { recursive: true });
const creds = JSON.parse(await readFile(join(root, 'runtime/test-account.json'), 'utf8'));
const browser = await puppeteer.launch({ executablePath: cfg.runtime_binaries.chrome_bin_host,
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], userDataDir: join(out, 'profile') });
const errors = [], checks = [];
try {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[autocomplete=username]');
  checks.push('anonymous opens login');
  await page.type('input[autocomplete=username]', creds.username);
  await page.type('input[type=password]', creds.password);
  await page.click('button.btn.primary.full');
  await page.waitForSelector('textarea', { timeout: 30_000 });
  await page.waitForSelector('dialog[open] button');
  await page.click('dialog[open] button');
  checks.push('first-visit explanation can be dismissed');
  const content = await page.evaluate(() => document.body.innerText);
  assert.ok(content.includes('Codex 开发环境'));
  const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
  assert.ok(content.includes('v' + version), 'Frontend version differs from VERSION');
  assert.ok(!content.includes('管理后台'));
  checks.push('ordinary user logs in; no admin controls; environment label visible');
  // Login can restore an empty session; select a completed task through the actual history UI.
  await (await page.$('::-p-text(创作历史)')).click();
  await page.waitForSelector('.admin-panel video', { timeout: 30_000 });
  await (await page.$('::-p-text(回到该任务)')).click();
  await page.waitForSelector('video', { timeout: 30_000 });
  checks.push('history opens and selects a completed session');
  await page.evaluate(() => { for (const v of document.querySelectorAll('video')) { v.muted = true; v.load(); v.play().catch(() => {}); } });
  try { await page.waitForFunction(() => [...document.querySelectorAll('video')].some(v => v.videoWidth > 0), { timeout: 30_000 }); }
  catch(e) { console.log('MEDIA_DIAGNOSTICS', await page.evaluate(() => [...document.querySelectorAll('video')].map(v => ({src:v.currentSrc,err:v.error?.message,code:v.error?.code,state:v.readyState,network:v.networkState,h264:v.canPlayType('video/mp4; codecs="avc1.42E01E"')})))); await page.screenshot({path:join(out,'failure.png')}); throw e; }
  const media = await page.evaluate(() => [...document.querySelectorAll('video')].map(v => ({ width: v.videoWidth, height: v.videoHeight, duration: v.duration, error: v.error?.message })));
  assert.ok(media.every(v => !v.error));
  checks.push('completed video decodes in Chromium');
  await page.evaluate(() => { const v = document.querySelector('video'); v.muted = true; v.currentTime = 0; return v.play(); });
  await page.waitForFunction(() => document.querySelector('video').currentTime > .1);
  checks.push('video playback advances');
  await page.screenshot({ path: join(out, 'workspace.png'), fullPage: true });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('textarea');
  assert.ok(!(await page.$('input[autocomplete=username]')));
  checks.push('login and session survive reload');
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile(join(out, 'report.json'), JSON.stringify({ checks, media, errors }, null, 2));
  console.log(JSON.stringify({ checks, media, errors }, null, 2));
} finally { await browser.close(); }
