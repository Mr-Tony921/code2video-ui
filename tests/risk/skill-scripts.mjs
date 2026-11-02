import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/** Active capture scripts must agree; installers consume the same current skillset. */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const R = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let pass = 0, fail = 0;
const t = (n, c, e = '') => { c ? (pass++, console.log('  ✅', n, e)) : (fail++, console.log('  ❌', n, e)); };

/** 递归找出 assets/ 下所有 capture.mjs —— 不写死份数，也不写死路径 */
function findAll(dir, name, out = []) {
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findAll(p, name, out);
    else if (e.name === name) out.push(p);
  }
  return out;
}

const copies = findAll(join(R, 'assets'), 'capture.mjs');
t('★ 至少找到一份 capture.mjs（否则下面全是空跑）', copies.length > 0, `找到 ${copies.length} 份`);

for (const p of copies) {
  const rel = relative(R, p);
  const s = readFileSync(p, 'utf8');
  t(`${rel} 显式指定 executablePath`,
    /process\.env\.CHROME_BIN/.test(s) && /executablePath/.test(s));
  t(`${rel} 对 favicon 回 204`,
    /favicon\.ico'\s*\)\s*\{\s*res\.writeHead\(204\)/.test(s.replace(/\s+/g, ' '))
    || /favicon[\s\S]{0,120}writeHead\(204\)/.test(s));
  t(`${rel} 没有残留"裸 launch"写法`,
    !/launch\(\{\s*args:\s*glArgs\s*\}\)/.test(s));
}

/**
 * ★ 要求所有份数【完全一致】。
 * 不一致就说明有人只改了一部分 —— 这正是 1.4.4 发生过的事。
 * 一致之后，"有几份"就不再是需要人去记的信息。
 */
const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex');
const hashes = [...new Set(copies.map(md5))];
t('★ 所有 capture.mjs 完全一致（只有一个 md5）', hashes.length === 1,
  hashes.length === 1 ? hashes[0].slice(0, 12) : `出现 ${hashes.length} 个不同版本`);
if (hashes.length > 1) {
  for (const p of copies) console.log(`        ${md5(p).slice(0, 12)}  ${relative(R, p)}`);
}

/** 真正发给 agent 的那两份必须在 skillsets_root 下（配置里读，不写死） */
const cfg = JSON.parse(readFileSync(join(R, 'config/backend.json'), 'utf8'));
const root = join(R, cfg.skills.skillsets_root);
t('skillsets_root 存在', existsSync(root) && statSync(root).isDirectory(), cfg.skills.skillsets_root);
const live = copies.filter((p) => p.startsWith(root));
t('★ skillsets_root 下有 capture.mjs（这才是会发给 agent 的）', live.length > 0,
  `${live.length} 份`);

// Installation must use the active 3D skillset, with no historical bundle dependency.
const dependencyManifest = 'assets/skillsets/blockout_3d/whitebox-previs/scripts/package.json';
t('active whitebox dependency manifest exists', existsSync(join(R, dependencyManifest)));
t('installer uses active skillset', readFileSync(join(R, 'scripts/install-previs-deps.sh'), 'utf8').includes(dependencyManifest));

console.log(`\n  skill 脚本一致性: 通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
