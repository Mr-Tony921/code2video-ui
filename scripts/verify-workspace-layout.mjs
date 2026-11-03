#!/usr/bin/env node
/** Read-only browser geometry regression with ordinary test sessions; never submits a job. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('python3', [join(root, 'scripts/guard-isolation.py')]);
const cfg = JSON.parse(await readFile(join(root, 'config/backend.json'), 'utf8'));
assert.equal(cfg.environment.name, 'dev');
const creds = JSON.parse(await readFile(join(root, 'runtime/test-account.json'), 'utf8'));
const experimental = JSON.parse(await readFile(join(root, 'runtime/validation/v1.5.2/experimental-live.json'), 'utf8'));
const normal = JSON.parse(await readFile(join(root, 'runtime/validation/v152-normal/report.json'), 'utf8'));
const before = process.argv.includes('--before');
const preview = process.argv.includes('--preview');
const out = join(root, 'runtime/validation/layout-hotfix'); await mkdir(out, { recursive: true });
const require = createRequire(join(cfg.runtime_binaries.videokit_node_modules, '..', 'package.json'));
let chrome = cfg.runtime_binaries.chrome_bin;
for (const bind of cfg.isolation?.bind_paths ?? []) {
  if (chrome.startsWith(bind.dst + '/')) { chrome = join(bind.src, chrome.slice(bind.dst.length)); break; }
}
const report = { checks: [], measurements: [], errors: [], passed: false };
const settle = () => new Promise(resolve => setTimeout(resolve, 150));
let browser, server, serverLog = '';
try {
  let base = `http://${cfg.deployment.web.host}:${cfg.deployment.web.port}`;
  if (preview) {
    const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    const app = join(root, 'runtime/builds/layout-preview/apps/web');
    server = spawn(process.execPath, [join(root, 'apps/web/node_modules/next/dist/bin/next'), 'start', app, '-p', String(port), '-H', '127.0.0.1'], {
      cwd: app, env: { ...process.env, CVW_REPO_ROOT: root,
        CVW_GATEWAY_BASE_URL: `http://${cfg.deployment.gateway.host}:${cfg.deployment.gateway.port}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', b => { serverLog += b; }); server.stderr.on('data', b => { serverLog += b; });
    base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
      await settle();
    }
    assert.ok(ready, serverLog);
  }
  browser = await require('puppeteer').launch({ executablePath: chrome, headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
  const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', e => report.errors.push(e.message));
  await page.evaluateOnNewDocument(({ username, sid, initialHeight }) => {
    localStorage.setItem('cvw:welcomed', '1');
    if (!localStorage.getItem('cvw:procH')) localStorage.setItem('cvw:procH', String(initialHeight));
    let h = 0; for (const c of username) h = (h * 31 + c.charCodeAt(0)) | 0;
    const userScope = Math.abs(h).toString(36);
    if (!localStorage.getItem(`cvw:ctx:${userScope}`)) localStorage.setItem(`cvw:ctx:${userScope}`,
      JSON.stringify({ v: 1, userScope, sessionId: sid, mode: 'experimental', jobId: null }));
  }, { username: creds.username, sid: experimental.session, initialHeight: before ? 240 : 9999 });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('input[autocomplete="username"]');
  await page.type('input[autocomplete="username"]', creds.username);
  await page.type('input[autocomplete="current-password"]', creds.password);
  await page.click('button.btn.primary.full'); await page.waitForSelector('.procpanel'); await settle();
  const geometry = () => page.evaluate(() => {
    const rect = selector => {
      const el = document.querySelector(selector); const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom };
    };
    return { main: rect('main.main'), stream: rect('.stream'), composer: rect('.composer'),
      process: rect('.procpanel'), grip: rect('.proc-grip'),
      children: [...document.querySelector('main.main').children].map(el => el.className),
      rows: getComputedStyle(document.querySelector('main.main')).gridTemplateRows };
  });
  const toggle = () => page.$eval('.procpanel-head button[aria-expanded]', el => el.click());
  if (before) {
    await page.$eval('main > details > summary', el => el.click()); await toggle(); await settle();
    const g = await geometry(); report.measurements.push(g);
    await page.screenshot({ path: join(out, 'before.png'), fullPage: true });
    assert.equal(g.children.length, 3, 'experimental skills occupy an unintended fourth grid row');
  }
  const folded = await geometry();
  assert.ok(folded.process.height < 120, 'collapsed process should release its reserved space');
  await toggle(); await settle();
  function check(g) {
    assert.deepEqual(g.children, ['stream', 'composer', 'procpanel']);
    assert.ok(g.stream.height >= g.process.height - 2, 'conversation must retain at least half of the remaining space');
    assert.ok(Math.abs(g.stream.bottom - g.composer.y) < 2);
    assert.ok(Math.abs(g.composer.bottom - g.process.y) < 2);
    assert.ok(g.process.bottom <= g.main.bottom + 2);
    assert.ok(g.stream.height > 80, 'conversation collapsed to a sliver');
  }
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 },
    { width: 1000, height: 600 }, { width: 500, height: 700 }]) {
    await page.setViewport(viewport); await settle(); const g = await geometry(); check(g);
    report.measurements.push({ viewport, ...g });
  }
  report.checks.push('three explicit rows; oversized saved heights and viewport changes preserve conversation space');
  await page.setViewport({ width: 1440, height: 1000 }); await settle();
  async function dragBy(delta) {
    const g = await geometry(), x = g.grip.x + g.grip.width / 2, y = g.grip.y + g.grip.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x, y + delta, { steps: 8 }); await page.mouse.up(); await settle();
    return { old: g, next: await geometry() };
  }
  const up = await dragBy(-80);
  assert.ok(Math.abs(up.next.process.height - up.old.process.height - 80) < 3, 'upward drag must increase process height');
  assert.ok(Math.abs(up.next.grip.y - up.old.grip.y + 80) < 3, 'grip must follow upward pointer movement');
  const down = await dragBy(40);
  assert.ok(Math.abs(down.next.process.height - down.old.process.height + 40) < 3, 'downward drag must decrease process height');
  assert.ok(Math.abs(down.next.grip.y - down.old.grip.y - 40) < 3, 'grip must follow downward pointer movement');
  report.checks.push('pointer capture follows the cursor in both drag directions');
  const closed = await geometry();
  await page.click('.composer button[aria-label="实验 skill 设置"]');
  await page.waitForSelector('dialog[open][aria-label="实验 skill 设置"]'); await settle();
  const opened = await geometry();
  for (const area of ['stream', 'composer', 'process']) {
    assert.ok(Math.abs(opened[area].height - closed[area].height) < 1, 'skill dialog changed the ' + area + ' height');
    assert.ok(Math.abs(opened[area].y - closed[area].y) < 1, 'skill dialog displaced the ' + area);
  }
  await page.keyboard.press('Escape'); await settle(); check(await geometry());
  await page.screenshot({ path: join(out, preview ? 'preview.png' : 'after.png'), fullPage: true });
  report.checks.push('skill settings open in a dialog without changing main layout; Escape restores focus');
  const expanded = await geometry(); await toggle(); await settle(); const collapsed = await geometry();
  report.measurements.push({ expanded, collapsed });
  const reclaimed = expanded.process.height - collapsed.process.height;
  assert.ok(reclaimed > 20, 'collapsed process must release its expanded height');
  assert.ok(Math.abs(collapsed.stream.height - expanded.stream.height - reclaimed) < 2);
  report.checks.push('collapsing process releases height back to the conversation');
  await page.evaluate(({ username, sid }) => {
    let h = 0; for (const c of username) h = (h * 31 + c.charCodeAt(0)) | 0;
    const userScope = Math.abs(h).toString(36);
    localStorage.setItem(`cvw:ctx:${userScope}`, JSON.stringify({ v: 1, userScope, sessionId: sid, mode: 'coding_to_video', jobId: null }));
  }, { username: creds.username, sid: normal.jobs[0].session });
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('.procpanel');
  assert.equal(await page.$('.composer button[aria-label="实验 skill 设置"]'), null);
  await toggle(); await settle(); check(await geometry());
  report.checks.push('ordinary mode retains the same three-row layout');
  assert.deepEqual(report.errors, []); report.passed = true;
  console.log('PASS', report.checks.join('; '));
} catch (e) {
  report.error = e.message; throw e;
} finally {
  await browser?.close();
  if (server && server.exitCode == null && server.signalCode == null) {
    server.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 5000);
      server.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (preview) await writeFile(join(out, 'preview-server.log'), serverLog);
  await writeFile(join(out, before ? 'before.json' : preview ? 'preview.json' : 'after.json'), JSON.stringify(report, null, 2) + '\n');
}
