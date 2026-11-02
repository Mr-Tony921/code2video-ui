import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 1.4.1：resume 的三道防线（静态检查发现的问题，这里固化）。
 *
 * 1) 老会话迁移：1.3.x 的会话只有 jobs/<旧jid>/，新一轮必须把 src/ 与 .home
 *    搬进共享工作区，否则「续写老对话 = 从零重做」，比 1.3.x 还差。
 * 2) 上下文爆过不 resume：把溢出的上下文接回来只会立刻再爆，用户出不来。
 * 3) 同会话并发：1.4.0 起各轮共用工作区并 resume 同一个 cc 会话，
 *    两个进程并存会双写 cc 会话 jsonl 与 output/final.mp4。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = TEST_TMP_ROOT + '/fixture-t-resume-guards';
process.env.CVW_REPO_ROOT = TEST_REPO_ROOT;
process.env.CVW_WORKER_ID = process.env.CVW_WORKER_ID || 'cvw-dev-360';
process.env.CVW_GATEWAY_BASE_URL = 'http://127.0.0.1:1';
process.env.CVW_INTERNAL_TOKEN = 'x'.repeat(32);
process.env.CVW_MODEL_API_KEY = 'sk-test';
process.env.CVW_SESSIONS_ROOT = ROOT;
process.env.CVW_STORAGE_ROOT = ROOT + '/store';
rmSync(ROOT, { recursive: true, force: true });

const P = await import(`${process.env.CVW_REPO_ROOT}/apps/worker-bridge/src/job-paths.mjs`);
let pass = 0, fail = 0;
const t = (n, c, e = '') => { c ? (pass++, console.log('  ✅', n, e)) : (fail++, console.log('  ❌', n, e)); };

const SID = 'sess_11111111-2222-3333-4444-555555555555';
const base = join(ROOT, 'sessions', SID);

console.log('— 1) 老会话的基准轮选择 —');
// 两个老轮次：一个失败、一个出过片（.done），应优先选出过片的
for (const [jid, done] of [['job_old_fail', false], ['job_old_done', true]]) {
  mkdirSync(join(base, 'jobs', jid, 'src'), { recursive: true });
  if (done) writeFileSync(join(base, 'jobs', jid, '.done'), '{}');
  writeFileSync(join(base, 'jobs', jid, '.cc-session'),
    JSON.stringify({ cc_session_id: done ? 'aaaa1111-2222-3333-4444-555555555555' : 'bbbb' }));
}
const prev = P.newestLegacyRound(SID);
t('找到了老会话的基准轮', !!prev, prev?.jobId);
t('★ 优先选出过片（有 .done）的那一轮', prev?.jobId === 'job_old_done', prev?.jobId);
t('能读出它记录的 cc 会话 id',
  P.recordedCcSessionId(prev.dir) === 'aaaa1111-2222-3333-4444-555555555555');

console.log('\n— 2) resolveJobPaths：老会话的【新】轮次必须走新布局 —');
const r = P.resolveJobPaths(SID, 'job_brand_new');
t('新轮次不被误判成 legacy', r.legacy === false);
t('指向共享工作区', r.agentWs.endsWith('/workspace'));
t('簿记指向 rounds/<新jid>', r.bookDir.endsWith('/rounds/job_brand_new'));
t('★ 这正是回归的根源：legacy=jobs/<新jid> 不存在',
  !existsSync(join(base, 'jobs', 'job_brand_new')));

console.log('\n— 3) 上下文爆过不 resume —');
t('没有 rounds/ 时为 false', P.lastRoundBlewContext(SID) === false);
mkdirSync(join(base, 'rounds', 'job_r1'), { recursive: true });
writeFileSync(join(base, 'rounds', 'job_r1', '.done'), '{}');
t('最近一轮是 .done → 可以 resume', P.lastRoundBlewContext(SID) === false);
await new Promise((x) => setTimeout(x, 20));
mkdirSync(join(base, 'rounds', 'job_r2'), { recursive: true });
writeFileSync(join(base, 'rounds', 'job_r2', '.failed'), JSON.stringify({ code: 'E_ASSET_UNSTABLE' }));
t('最近一轮是普通失败 → 仍可 resume', P.lastRoundBlewContext(SID) === false);
await new Promise((x) => setTimeout(x, 20));
mkdirSync(join(base, 'rounds', 'job_r3'), { recursive: true });
writeFileSync(join(base, 'rounds', 'job_r3', '.failed'), JSON.stringify({ code: 'E_TASK_TOO_COMPLEX' }));
t('★ 最近一轮上下文耗尽 → 不 resume', P.lastRoundBlewContext(SID) === true);
await new Promise((x) => setTimeout(x, 20));
mkdirSync(join(base, 'rounds', 'job_r4'), { recursive: true });
writeFileSync(join(base, 'rounds', 'job_r4', '.done'), '{}');
t('之后又成功一轮 → 恢复可 resume', P.lastRoundBlewContext(SID) === false);

console.log('\n— 4) bridge 侧按会话去重（源码断言）—');
const { readFileSync } = await import('node:fs');
const src = readFileSync(`${process.env.CVW_REPO_ROOT}/apps/worker-bridge/src/job-runner.mjs`, 'utf8');
t('★ startJob 按 sessionId 拒绝并发', /st\.sessionId === p\.sessionId/.test(src));
t('抛的是 SESSION_BUSY', /code = 'SESSION_BUSY'/.test(src));
t('去重发生在起进程之前',
  src.indexOf("st.sessionId === p.sessionId") < src.indexOf('const child = spawn('));

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n  —— 通过 ${pass} 失败 ${fail} ——`);
process.exit(fail ? 1 : 0);
