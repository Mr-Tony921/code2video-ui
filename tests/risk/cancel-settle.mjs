import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 取消后必须落终态的回归（1.4.1 修，缺陷见 BUG-cancelling-stuck-forever.md）。
 *
 * 事故：用户点「停止」，Bridge 其实已经干净收尾（`.cancelled` 已写、cc 进程已消失、
 * 运行索引已清），但 Gateway 永远停在 `CANCELLING`，watchdog 每个 tick 重发一次取消、
 * 无限循环。线上 208 个 job 里 2 个中招（≈4%），其中一个**真实用户**的任务卡了
 * **24 小时以上**，界面一直显示「正在停止」。
 *
 * 根因是两件事叠起来形成死锁：
 *   1. `HEALTHY` 分支写成 `await bridge.cancelJob(...).catch(() => {})` ——
 *      **连返回值都不接**，Bridge 怎么回答都不据此落终态；
 *   2. 唯一能 settle 的 `else` 分支要求「进程失联」，而 Bridge 活得好好的
 *      ⇒ `else` 永远走不到。
 * Bridge 其实每次都明确回答了 `{stopped:true, already_gone:true}`，每次都被丢掉。
 *
 * ★ 这里是【行为测试】，不是正则守卫：
 *   造一条真的 CANCELLING job 记录 + 一个按剧本回答的假 Bridge，
 *   跑一次 `sweepJobs()`，断言它真的落到了终态。
 *   报告里也特别提了「静态正则容易被改写方式绕过」。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const R = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SANDBOX = mkdtempSync(join(tmpdir(), 'cancel-settle-'));
process.env.CVW_REPO_ROOT ??= R;
process.env.CVW_STORAGE_ROOT = SANDBOX;            // ★ 绝不碰真数据
process.env.CVW_INTERNAL_TOKEN ??= 'x'.repeat(32);
process.env.CVW_MODEL_API_KEY ??= 'sk-test';
process.env.CVW_SESSIONS_ROOT ??= join(SANDBOX, 'sessions');

let pass = 0, fail = 0;
const t = (n, c, e = '') => { c ? (pass++, console.log('  ✅', n, e)) : (fail++, console.log('  ❌', n, e)); };

const store = await import(join(R, 'apps/gateway/src/store/job-store.mjs'));
const bridgeMod = await import(join(R, 'apps/gateway/src/bridge-client.mjs'));
const { Watchdog } = await import(join(R, 'apps/gateway/src/watchdog.mjs'));
const { config } = await import(join(R, 'apps/gateway/src/config.mjs'));

// 确认沙箱真的生效了，否则这个测试会去改真数据
t('★ 存储根指向临时沙箱（不碰真数据）',
  config.storage.root === SANDBOX, config.storage.root);
if (config.storage.root !== SANDBOX) {
  console.log('  —— 沙箱未生效，拒绝继续 ——');
  rmSync(SANDBOX, { recursive: true, force: true });
  process.exit(1);
}
await store.init();

const PID = 'proc-test-1';
/** 假进程池：Bridge 健康（正是卡住的那个前提） */
function fakePool() {
  return {
    processes: new Map([[PID, { process_instance_id: PID, status: 'HEALTHY', host: '127.0.0.1', port: 1, running_jobs: 1 }]]),
    reservations: new Map(),
    bridgeUrlFor: () => 'http://127.0.0.1:1',
    release() {},
  };
}

/** 造一条「已经请求取消、宽限早已超时」的 CANCELLING job */
async function makeCancellingJob(tag) {
  const sess = await store.createSession({
    userId: 'u1', mode: 'coding_to_video', workerId: 'w1',
    processInstanceId: PID, backendRef: `ref-${tag}`, skillset: 's', skills: [],
  });
  // ★ createJob 返回的是 { job, replayed }，不是 job 本身
  const { job } = await store.createJob({
    userId: 'u1', sessionId: sess.id, workflowId: 'wf', mode: 'coding_to_video',
    prompt: 'p', workerId: 'w1', processInstanceId: PID,
    idempotencyKey: `k-${tag}`, maxRuntimeSeconds: 3600,
  });
  await store.transition(job.id, 'ASSIGNED');
  await store.transition(job.id, 'RUNNING', { last_heartbeat_at: new Date().toISOString() });
  await store.transition(job.id, 'CANCEL_REQUESTED');
  // requested_at 设成很久以前 ⇒ 必然超过 cancelGraceMs
  await store.transition(job.id, 'CANCELLING', {
    cancellation: {
      requested_at: new Date(Date.now() - config.timing.cancelGraceMs - 60_000).toISOString(),
      requested_by: 'user', reason: 'user',
    },
  });
  return (await store.getJob(job.id));
}

/** 按剧本替换 bridge 的两个方法；返回还原函数与调用计数 */
function scriptBridge({ cancel, probe }) {
  const orig = { cancelJob: bridgeMod.bridge.cancelJob, probeJob: bridgeMod.bridge.probeJob };
  const calls = { cancel: 0, probe: 0, probeSid: [] };
  bridgeMod.bridge.cancelJob = async () => { calls.cancel++; return cancel(calls.cancel); };
  bridgeMod.bridge.probeJob = async (base, id, sid) => {
    calls.probe++; calls.probeSid.push(sid); return probe(calls.probe);
  };
  return { calls, restore: () => Object.assign(bridgeMod.bridge, orig) };
}

async function runSweeps(wd, n) { for (let i = 0; i < n; i++) await wd.sweepJobs(); }

/* ───────── 场景 1：Bridge 说 already_gone（线上卡住的那一种）───────── */
{
  const job = await makeCancellingJob('gone');
  const { calls, restore } = scriptBridge({
    cancel: () => ({ acked: true, stopped: true, already_gone: true }),
    probe: () => ({ status: 'running' }),
  });
  const wd = new Watchdog({ pool: fakePool() });
  await runSweeps(wd, 1);
  restore();
  const after = await store.getJob(job.id);
  t('★★ Bridge 回 already_gone ⇒ 一个 tick 内落 CANCELLED（原来永久 CANCELLING）',
    after.status === 'CANCELLED', `status=${after.status} cancel 调用 ${calls.cancel} 次`);
  t('   终态落了 finished_at', !!after.finished_at);
  t('   记了 cancellation.effective', after.cancellation?.effective === true);
  const evs = await store.readEvents(job.id, 0);
  t('   发了 job.cancelled 事件', evs.some((e) => e.type === 'job.cancelled'));
}

/* ───────── 场景 2：只回 stopped（正常路径的第一次取消）───────── */
{
  const job = await makeCancellingJob('stopped');
  const { restore } = scriptBridge({
    cancel: () => ({ acked: true, stopped: true }),      // 没有 already_gone
    probe: () => ({ status: 'running' }),
  });
  const wd = new Watchdog({ pool: fakePool() });
  await runSweeps(wd, 1);
  restore();
  const after = await store.getJob(job.id);
  t('★★ 只回 stopped 也要落终态（别只判 already_gone）',
    after.status === 'CANCELLED', `status=${after.status}`);
}

/* ───────── 场景 3：回复全丢 ⇒ 靠 probe 读磁盘标记兜底 ───────── */
{
  const job = await makeCancellingJob('probe');
  const { calls, restore } = scriptBridge({
    cancel: () => { throw new Error('网络抖动'); },       // 回复拿不到
    probe: () => ({ status: 'cancelled' }),               // 磁盘上有 .cancelled
  });
  const wd = new Watchdog({ pool: fakePool() });
  await runSweeps(wd, 3);
  restore();
  const after = await store.getJob(job.id);
  t('★★ 回复丢了也能靠 probe 落终态', after.status === 'CANCELLED', `status=${after.status}`);
  t('★ probe 带上了 session_id（Bridge 要靠它定位簿记目录）',
    calls.probe > 0 && calls.probeSid.every((x) => !!x), JSON.stringify(calls.probeSid.slice(0, 2)));
}

/* ───────── 场景 4：取消来晚了，其实已经做完 ⇒ 按完成处理，别丢产物 ───────── */
{
  const job = await makeCancellingJob('late');
  const { restore } = scriptBridge({
    cancel: () => ({ acked: true }),                      // 既没 stopped 也没 already_gone
    probe: () => ({ status: 'completed', asset: { storage_path: '/tmp/x.mp4', size_bytes: 123 } }),
  });
  const wd = new Watchdog({ pool: fakePool() });
  await runSweeps(wd, 3);
  restore();
  const after = await store.getJob(job.id);
  t('★★ 取消前已完成 ⇒ 落 COMPLETED 并保留产物',
    after.status === 'COMPLETED' && after.result_asset?.storage_path === '/tmp/x.mp4',
    `status=${after.status}`);
}

/* ───────── 场景 5：始终无定论 ⇒ 重发有上限，不许永远刷 ───────── */
{
  const job = await makeCancellingJob('cap');
  const { calls, restore } = scriptBridge({
    cancel: () => ({ acked: true }),                      // 永远不表态
    probe: () => ({ status: 'running' }),                 // 也查不出定论
  });
  const wd = new Watchdog({ pool: fakePool() });
  await runSweeps(wd, 12);                                // 远超上限
  restore();
  const after = await store.getJob(job.id);
  t('★★ 重发有上限：到顶后落终态而非无限循环',
    after.status === 'FAILED', `status=${after.status} 重发 ${calls.cancel} 次`);
  t('   失败码是 CANCEL_UNCONFIRMED（不谎称取消成功）',
    after.failure?.code === 'CANCEL_UNCONFIRMED', JSON.stringify(after.failure?.code));
  t('★ 重发次数确实被限住（≤ 6 次，不是 12 次）',
    calls.cancel <= 6, `${calls.cancel} 次`);
}

/* ───────── 场景 6：进程失联那条老路不能被改坏 ───────── */
{
  const job = await makeCancellingJob('lost');
  const { restore } = scriptBridge({ cancel: () => ({}), probe: () => ({ status: 'running' }) });
  const pool = fakePool();
  pool.processes.get(PID).status = 'UNAVAILABLE';         // 进程失联
  const wd = new Watchdog({ pool });
  await runSweeps(wd, 1);
  restore();
  const after = await store.getJob(job.id);
  t('★ 进程失联 + 取消未确认 ⇒ 仍然 FAILED(CANCEL_UNCONFIRMED)',
    after.status === 'FAILED' && after.failure?.code === 'CANCEL_UNCONFIRMED',
    `status=${after.status}`);
}

/* ───────── 场景 7：还没到宽限期的不要动 ───────── */
{
  const sess = await store.createSession({
    userId: 'u1', mode: 'coding_to_video', workerId: 'w1',
    processInstanceId: PID, backendRef: 'ref-fresh', skillset: 's', skills: [],
  });
  const { job } = await store.createJob({
    userId: 'u1', sessionId: sess.id, workflowId: 'wf', mode: 'coding_to_video',
    prompt: 'p', workerId: 'w1', processInstanceId: PID,
    idempotencyKey: 'k-fresh', maxRuntimeSeconds: 3600,
  });
  await store.transition(job.id, 'ASSIGNED');
  await store.transition(job.id, 'RUNNING', { last_heartbeat_at: new Date().toISOString() });
  await store.transition(job.id, 'CANCEL_REQUESTED');
  await store.transition(job.id, 'CANCELLING', {
    cancellation: { requested_at: new Date().toISOString(), requested_by: 'user', reason: 'user' },
  });
  const { calls, restore } = scriptBridge({
    cancel: () => ({ already_gone: true }), probe: () => ({ status: 'running' }),
  });
  const wd = new Watchdog({ pool: fakePool() });
  await runSweeps(wd, 1);
  restore();
  const after = await store.getJob(job.id);
  t('★ 宽限期内不重发、不改状态（别把正常取消流程抢了）',
    after.status === 'CANCELLING' && calls.cancel === 0, `status=${after.status} cancel ${calls.cancel} 次`);
}

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`  —— 通过 ${pass} 失败 ${fail} ——`);
process.exit(fail ? 1 : 0);
