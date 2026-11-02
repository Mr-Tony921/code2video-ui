import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 共用工作区的「陈旧产物」防护。
 *
 * ★ 线上真实事故（1.3.x）：续写轮的 result_asset 指向 previous/final.mp4 ——
 *   也就是【上一轮成片的拷贝】，于是用户看到「第一二轮完全一样」。
 *   实测 job_0ff42e58 / job_4bd2a122，size 与上一轮一模一样（39720546 / 38211741）。
 *   1.4.0 删掉了 previous/，但各轮【共用工作区】又把同样的风险从另一个方向带回来：
 *   上一轮的 output/final.mp4 还在原地，本轮没覆盖它就会被当成本轮交付物。
 *
 * 判据：只认 mtime 不早于本轮启动的文件（留 5s 容差）。
 */
import { readFileSync } from 'node:fs';
const R = TEST_REPO_ROOT;
const src = readFileSync(`${R}/apps/worker-bridge/src/job-runner.mjs`, 'utf8');
let pass = 0, fail = 0;
const t = (n, c, e = '') => { c ? (pass++, console.log('  ✅', n, e)) : (fail++, console.log('  ❌', n, e)); };

function fnBody(text, name) {
  const i = text.indexOf(`function ${name}`);
  if (i < 0) return '';
  let k = text.indexOf('(', i), pd = 0;
  for (; k < text.length; k++) {
    if (text[k] === '(') pd++;
    else if (text[k] === ')') { pd--; if (pd === 0) { k++; break; } }
  }
  const open = text.indexOf('{', k);
  let d = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '{') d++;
    else if (text[j] === '}') { d--; if (d === 0) return text.slice(open, j + 1); }
  }
  return text.slice(open);
}
const fa = fnBody(src, 'findArtifact');
t('【自检】截出 findArtifact 函数体', fa.length > 600 && /cands/.test(fa), `${fa.length} 字符`);

t('★ 有本轮起始时间的基准', /const roundStart\s*=.*st\.startedAt/.test(fa));
t('★ 快路径 output/final.mp4 要求 fresh', /fresh\(s\.mtimeMs\)/.test(fa));
t('★ 兜底扫描也要求 mtime >= roundStart', /s\.mtimeMs >= roundStart/.test(fa));
t('留了时间容差（防文件系统时间抖动）', /- 5000/.test(fa));
t('采用了旧产物时有告警，不静默', /是上一轮的产物/.test(fa));

// roundStart 必须声明在 walk 之前，否则 walk 执行到它时是 TDZ ReferenceError
const iRound = fa.indexOf('const roundStart');
const iWalk = fa.indexOf('async function walk');
t('★ roundStart 声明在 walk 之前（避免 TDZ）', iRound >= 0 && iWalk >= 0 && iRound < iWalk,
  `roundStart@${iRound} walk@${iWalk}`);

// previous/ 必须已彻底消失 —— 它是线上那个 bug 的载体
const jw = readFileSync(`${R}/apps/worker-bridge/src/job-workspace.mjs`, 'utf8');
// ★ 先去行注释再去块注释（注释里的 `/xxx/*` 会被当成块注释开头，一路吞到下一个 */）
const code = jw.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
t("★ 不再创建 previous/（线上 bug 的载体）", !/'previous'/.test(code) && !/previous\//.test(code));

console.log(`  —— 通过 ${pass} 失败 ${fail} ——`);
process.exit(fail ? 1 : 0);
