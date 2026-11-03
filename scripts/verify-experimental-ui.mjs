#!/usr/bin/env node
/** Browser acceptance on a dev worker with videokit/Chrome installed; ordinary users only. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('python3', [join(root, 'scripts/guard-isolation.py')]);
const cfg = JSON.parse(await readFile(join(root, 'config/backend.json'), 'utf8'));
assert.equal(cfg.environment.name, 'dev');
const base = `http://${cfg.deployment.web.host}:${cfg.deployment.web.port}`;
const require = createRequire(join(cfg.runtime_binaries.videokit_node_modules, '..', 'package.json'));
const puppeteer = require('puppeteer');
let chrome = cfg.runtime_binaries.chrome_bin;
for (const bind of cfg.isolation?.bind_paths ?? []) {
  if (chrome.startsWith(bind.dst + '/')) { chrome = join(bind.src, chrome.slice(bind.dst.length)); break; }
}
const browser = await puppeteer.launch({ executablePath: chrome, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server'] });
const report = { base, checks: [], errors: [] };
async function login(filename) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage(); await page.setViewport({ width: 1440, height: 1000 });
  page.on('pageerror', e => report.errors.push(e.message));
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('cvw:welcomed', '1'); } catch {} });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('input[autocomplete="username"]');
  const creds = JSON.parse(await readFile(join(root, 'runtime', filename), 'utf8'));
  await page.type('input[autocomplete="username"]', creds.username);
  await page.type('input[autocomplete="current-password"]', creds.password);
  await page.click('button.btn.primary.full');
  await page.waitForSelector('.topbar');
  return { context, page };
}
try {
  const own = await login('test-account.json');
  await own.page.waitForSelector('button[data-mode="experimental"]');
  const alreadySelected = await own.page.$eval('button[data-mode="experimental"]', el => el.getAttribute('aria-pressed') === 'true');
  await own.page.click(alreadySelected ? '.sidebar > button' : 'button[data-mode="experimental"]');
  await own.page.waitForSelector('dialog[open] select');
  await own.page.waitForFunction(() => (document.querySelector('dialog[open] select')?.options.length ?? 0) > 0);
  const selections = await own.page.$$eval('dialog[open] select', nodes => nodes.map(n => ({ value: n.value,
    options: [...n.options].map(o => ({ value: o.value, text: o.textContent })) })));
  assert.ok(selections[0].options.length > 0);
  assert.equal(selections[1].value, 'none');
  report.checks.push('ordinary authorized user sees experimental mode and configured model selector; builtin skills default to none');
  await own.page.screenshot({ path: join(root, 'runtime/validation/v1.5.2/experimental-model-dialog.png'), fullPage: true });
  await own.page.click('dialog[open] button.btn.primary');
  const expectedName = cfg.experimental.models[0].name;
  await own.page.waitForFunction(name => document.querySelector('.topbar .pill')?.textContent === name, {}, expectedName);
  await own.page.waitForSelector('.composer button[aria-label="实验 skill 设置"]');
  await own.page.click('.composer button[aria-label="实验 skill 设置"]');
  await own.page.waitForSelector('dialog[open][aria-label="实验 skill 设置"]');
  await own.page.waitForSelector('textarea[placeholder^="粘贴你的 skill"]');
  const state = await own.page.$eval('.composer input[type="checkbox"]', el => ({ checked: el.checked, disabled: el.disabled }));
  assert.deepEqual(state, { checked: false, disabled: true });
  assert.ok(await own.page.$('input[type="file"][accept=".zip,application/zip"]'));
  await own.page.click('button[aria-label="关闭实验 skill 设置"]');
  await own.page.$eval('.composer-row > textarea', el => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'x'.repeat(9000));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await own.page.waitForFunction(() => document.querySelector('.composer-side .tiny')?.textContent === '9000');
  await own.page.$eval('.composer-row > textarea', el => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  report.checks.push('created conversation displays its model; custom skill editor/upload present; enhancement disabled');
  await own.page.screenshot({ path: join(root, 'runtime/validation/v1.5.2/experimental-workspace.png'), fullPage: true });
  await own.context.close();
  const peer = await login('test-peer-account.json');
  assert.equal(await peer.page.$('button[data-mode="experimental"]'), null);
  report.checks.push('ordinary unauthorized peer has no experimental entry');
  await peer.context.close();
  assert.deepEqual(report.errors, []); report.passed = true;
  console.log('PASS browser experimental mode selection and permission visibility');
} finally {
  await browser.close();
  await writeFile(join(root, 'runtime/validation/v1.5.2/ui-report.json'), JSON.stringify(report, null, 2) + '\n');
}
