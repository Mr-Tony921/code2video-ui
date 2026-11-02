import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 轮次口径回归：用线上/dev 真实会话数据验证「第 N 轮」。
 * 事故：原来用 jobs.length + 1，把正在跑的那一轮自己也数进去 ——
 * 用户第一次修改却显示「第 3 轮」（dev 会话 sess_eed1b7a6，足球进球门）。
 */
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'OUT_OF_SCOPE']);
const isTerminal = (s) => TERMINAL.has(s);
const roundOld = (jobs) => jobs.length + 1;
const roundNew = (jobs) => jobs.filter((j) => isTerminal(j.status)).length + 1;

let pass = 0, fail = 0;
const t = (n, c, e = '') => { c ? (pass++, console.log('  ✅', n, e)) : (fail++, console.log('  ❌', n, e)); };

// 用户实测场景：首轮已完成 + 第一次修改正在跑
const real = [{ status: 'COMPLETED' }, { status: 'RUNNING' }];
t('★ 真实场景：第一次修改应显示第 2 轮', roundNew(real) === 2, `新=${roundNew(real)} 旧=${roundOld(real)}`);
t('   旧口径确实会误报第 3 轮', roundOld(real) === 3);

// 提交前
t('提交前（只有首轮已完成）→ 第 2 轮', roundNew([{ status: 'COMPLETED' }]) === 2);
// 修改跑完后，下一次应是第 3 轮
t('第一次修改跑完 → 下次是第 3 轮',
  roundNew([{ status: 'COMPLETED' }, { status: 'COMPLETED' }]) === 3);
// 中途失败/取消也算一轮结束
t('失败的轮次也计入已结束',
  roundNew([{ status: 'COMPLETED' }, { status: 'FAILED' }]) === 3);
t('取消的轮次也计入已结束',
  roundNew([{ status: 'COMPLETED' }, { status: 'CANCELLED' }]) === 3);
// 排队/增强中的不计入
t('ENHANCING 不计入已结束',
  roundNew([{ status: 'COMPLETED' }, { status: 'ENHANCING' }]) === 2);
t('QUEUED 不计入已结束',
  roundNew([{ status: 'COMPLETED' }, { status: 'QUEUED' }]) === 2);

console.log(`  —— 通过 ${pass} 失败 ${fail} ——`);
process.exit(fail ? 1 : 0);
