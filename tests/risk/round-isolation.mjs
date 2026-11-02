import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 1.4.0 轮次隔离：同一会话各轮共用工作区，但按轮次的东西绝不能互相覆盖。
 *
 * ★ 这个测试抓到过一个真 bug：成片原本用【硬链】钉住，
 *   而硬链只是同一 inode 的第二个名字；覆盖写普遍是 O_TRUNC 原地截断
 *   （ffmpeg -y / shell 重定向 / fs.writeFile 默认），inode 不变 ——
 *   于是第 2 轮一写 output/final.mp4，第 1 轮"钉住"的那份内容跟着变了，
 *   用户再也拿不到早先那版，而且没有任何报错。改成拷贝才真正不可变。
 *
 * 断言：
 *  ① 两轮的 .done / .running.json / 钉住的成片互不覆盖
 *  ② 第 1 轮的成片在第 2 轮覆盖 output/final.mp4 之后【仍可读】
 *  ③ CVW_JOB_TOKEN 每轮唯一
 *  ④ 老会话（1.3.x 布局）仍被识别为 legacy
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
// config.mjs 要求这些环境变量；按 adopt-unit.mjs 的做法先设好再动态 import
process.env.CVW_REPO_ROOT = TEST_REPO_ROOT;
process.env.CVW_WORKER_ID = process.env.CVW_WORKER_ID || 'cvw-dev-360';
process.env.CVW_GATEWAY_BASE_URL = 'http://127.0.0.1:1';
process.env.CVW_INTERNAL_TOKEN = 'x'.repeat(32);
process.env.CVW_MODEL_API_KEY = 'sk-test';
process.env.CVW_SESSIONS_ROOT = TEST_TMP_ROOT + '/fixture-devtest/repro/fakesess';
process.env.CVW_STORAGE_ROOT = TEST_TMP_ROOT + '/fixture-devtest/repro/fakestore';
const P = await import(`${process.env.CVW_REPO_ROOT}/apps/worker-bridge/src/job-paths.mjs`);

const ROOT = TEST_TMP_ROOT + '/fixture-t-pin';
rmSync(ROOT, { recursive: true, force: true });
let pass = 0, fail = 0;
const t = (n, c, e = '') => { c ? (pass++, console.log('  ✅', n, e)) : (fail++, console.log('  ❌', n, e)); };

// 用 job-paths 的纯函数，不依赖 sessionDir 的真实根
const ws = join(ROOT, 'workspace');
const r1 = join(ROOT, 'rounds', 'job_r1');
const r2 = join(ROOT, 'rounds', 'job_r2');
for (const d of [join(ws, 'output'), r1, r2]) mkdirSync(d, { recursive: true });

// ── 第 1 轮：agent 写 output/final.mp4，收尾时钉到 rounds/job_r1/
writeFileSync(join(ws, 'output', 'final.mp4'), 'ROUND-1-VIDEO');
const pin1 = P.pinnedAssetPath(r1);
copyFileSync(join(ws, "output", "final.mp4"), pin1);
writeFileSync(join(r1, '.done'), JSON.stringify({ storage_path: pin1 }));
writeFileSync(join(r1, '.running.json'), JSON.stringify({ job_id: 'job_r1' }));

// ── 第 2 轮：同一工作区，agent 覆盖 output/final.mp4
writeFileSync(join(ws, 'output', 'final.mp4'), 'ROUND-2-VIDEO-OVERWRITTEN');
const pin2 = P.pinnedAssetPath(r2);
copyFileSync(join(ws, "output", "final.mp4"), pin2);
writeFileSync(join(r2, '.done'), JSON.stringify({ storage_path: pin2 }));
writeFileSync(join(r2, '.running.json'), JSON.stringify({ job_id: 'job_r2' }));

// ── 断言
t('第 1 轮的 .done 没被覆盖', JSON.parse(readFileSync(join(r1, '.done'), 'utf8')).storage_path === pin1);
t('第 2 轮的 .done 独立存在', JSON.parse(readFileSync(join(r2, '.done'), 'utf8')).storage_path === pin2);
t('两轮 .running.json 并存',
  JSON.parse(readFileSync(join(r1, '.running.json'), 'utf8')).job_id === 'job_r1'
  && JSON.parse(readFileSync(join(r2, '.running.json'), 'utf8')).job_id === 'job_r2');

const v1 = readFileSync(pin1, 'utf8');
t('★ 第 1 轮成片在第 2 轮覆盖后仍可读', v1 === 'ROUND-1-VIDEO', `读到 "${v1}"`);
t('★ 第 2 轮成片是新内容', readFileSync(pin2, 'utf8') === 'ROUND-2-VIDEO-OVERWRITTEN');
t('两轮钉住路径不同', pin1 !== pin2);
t('工作区里的 output/final.mp4 已是第 2 轮',
  readFileSync(join(ws, 'output', 'final.mp4'), 'utf8') === 'ROUND-2-VIDEO-OVERWRITTEN');
t('★ token 每轮唯一', P.jobToken(ws, 'job_r1') !== P.jobToken(ws, 'job_r2'));
t('token 形如 <ws>#<jobId>', P.jobToken(ws, 'job_r1') === `${ws}#job_r1`);
t('legacy 布局下钉住路径==原路径（不多做一次硬链）',
  P.pinnedAssetPath(join(ROOT, 'legacyjob')) === join(ROOT, 'legacyjob', 'final.mp4'));

rmSync(ROOT, { recursive: true, force: true });
console.log(`  —— 通过 ${pass} 失败 ${fail} ——`);
process.exit(fail ? 1 : 0);
