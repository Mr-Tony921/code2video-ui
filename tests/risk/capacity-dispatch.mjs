import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 并发口径与会话分配的回归（1.4.6）。
 *
 * 线上 1.4.5 排查报告的两条：
 *
 * 1. **管理页显示「并发 3/20」，而各机实际上限之和只有 18。**
 *    `capacitySnapshot` 报的是配置声明值 `global_max_concurrent_jobs`，
 *    但单台可以在 `workers[].max_concurrent_jobs` 里下调（跑 Gateway 的那台压到 2），
 *    于是声明的天花板**永远到不了** —— 多报了 2 个不存在的槽。
 *    （不影响功能：每个任务除全局槽还必须过它那台机器的上限，
 *      所以 globalUsed 的上界就是 18，第 19/20 个全局槽永远发不出去。）
 *
 * 2. **`pickForSession` 完全不看 `max_concurrent_jobs`** —— 这条是会真实影响
 *    用户等待时间的。线上 cvw-700 的 `max_sessions` 仍是 8（和其他四台一样），
 *    `max_concurrent_jobs` 却只有 2，于是它照常分到约 1/5 的会话，
 *    却只能同时跑 2 个：**那台上第 3 个会话提交时就要排队，哪怕集群还有 15 个空槽。**
 *
 * ★ 行为测试：造临时 config、真 `new WorkerPool()`、真 register/heartbeat，
 *   断言算出来的数。`tests/risk/` 此前对这两处是**零覆盖**。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const R = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let pass = 0, fail = 0;
const t = (n, c, e = '') => { c ? (pass++, console.log('  ✅', n, e)) : (fail++, console.log('  ❌', n, e)); };

const SANDBOX = mkdtempSync(join(tmpdir(), 'cap-disp-'));
mkdirSync(join(SANDBOX, 'config'), { recursive: true });
const MODES = ['coding_to_video', 'blockout_3d'];
writeFileSync(join(SANDBOX, 'config/backend.json'), JSON.stringify({
  concurrency: { global_max_concurrent_jobs: 20, per_machine_max_concurrent_jobs: 4 },
  workers: [
    { worker_id: 'small', bridge: { host: '10.0.0.1', port: 18080 }, max_concurrent_jobs: 2, max_sessions: 4, supported_modes: MODES, enabled: true },
    { worker_id: 'big',   bridge: { host: '10.0.0.2', port: 18080 }, max_concurrent_jobs: 4, max_sessions: 8, supported_modes: MODES, enabled: true },
  ],
}), 'utf8');

const { WorkerPool } = await import(join(R, 'apps/gateway/src/worker-pool.mjs'));
const pool = new WorkerPool({ repoRoot: SANDBOX, log: { warn() {}, log() {} } });
const reg = (id, caps) => pool.register({
  worker_id: id, process_instance_id: `${id}:1`, supported_modes: MODES, ...caps,
});
reg('small', { max_concurrent_jobs: 2, max_sessions: 4 });
reg('big', { max_concurrent_jobs: 4, max_sessions: 8 });

/* ───── 1. capacity 报实际可用，而不是配置声明值 ───── */
let snap = pool.capacitySnapshot();
const sumCaps = () => [...pool.processes.values()]
  .filter((s) => s.status === 'HEALTHY')
  .reduce((n, s) => n + s.max_concurrent_jobs, 0);
t('★ capacity = 各 HEALTHY 机器上限之和（2+4=6），不是声明的 20',
  snap.global.capacity === 6, `capacity=${snap.global.capacity}`);
t('★ capacity 不超过 Σ(各进程 max_concurrent_jobs)',
  snap.global.capacity <= sumCaps(), `${snap.global.capacity} <= ${sumCaps()}`);
t('declared_capacity 保留配置天花板（排查要能看出差异）',
  snap.global.declared_capacity === 20, `=${snap.global.declared_capacity}`);
t('used 仍然如实报', snap.global.used === pool.globalUsed);

// 声明值更小时取声明值（别反过来超过天花板）
const pool2 = new WorkerPool({ repoRoot: SANDBOX, log: { warn() {}, log() {} } });
pool2.globalMax = 3;
pool2.register({ worker_id: 'small', process_instance_id: 'small:1', supported_modes: MODES, max_concurrent_jobs: 2, max_sessions: 4 });
pool2.register({ worker_id: 'big', process_instance_id: 'big:1', supported_modes: MODES, max_concurrent_jobs: 4, max_sessions: 8 });
t('声明值(3) 小于实际和(6) 时取声明值', pool2.capacitySnapshot().global.capacity === 3);

/* ───── 2. 一台失联 ⇒ 分母自动变小 ───── */
pool.processes.get('small:1').status = 'UNAVAILABLE';
snap = pool.capacitySnapshot();
t('★ 一台失联后 capacity 变小（那台的槽确实用不了）',
  snap.global.capacity === 4, `capacity=${snap.global.capacity}`);
t('失联后仍不超过 Σ(HEALTHY 上限)', snap.global.capacity <= sumCaps());
pool.processes.get('small:1').status = 'HEALTHY';

/* ───── 3. pickForSession 按并发容量归一分配 ───── */
/**
 * 真实链路里 active_sessions 只靠 Bridge 心跳更新（worker-pool.mjs:98），
 * 派发侧没有像任务槽那样的"预留"。这里每挑一次就手动加一，
 * 模拟"心跳已经报上来"的稳态 —— 这也是分配比例真正体现出来的状态。
 */
const tally = { 'small:1': 0, 'big:1': 0 };
for (let i = 0; i < 12; i++) {
  const p = pool.pickForSession('coding_to_video');
  if (!p) break;
  tally[p.process_instance_id]++;
  p.active_sessions++;
}
t('★ cap=4 的机器拿到约 2 倍于 cap=2 的会话',
  tally['big:1'] === 2 * tally['small:1'],
  `big=${tally['big:1']} small=${tally['small:1']}`);
t('两台都分到了（没有把一台饿死）', tally['small:1'] > 0 && tally['big:1'] > 0);

/* ───── 4. max_sessions 硬上限不能被新排序绕过 ───── */
const pool3 = new WorkerPool({ repoRoot: SANDBOX, log: { warn() {}, log() {} } });
pool3.register({ worker_id: 'small', process_instance_id: 'small:1', supported_modes: MODES, max_concurrent_jobs: 2, max_sessions: 1 });
pool3.processes.get('small:1').active_sessions = 1;      // 已满
t('★ active_sessions 达到 max_sessions 的机器不再被选中',
  pool3.pickForSession('coding_to_video') === null);

/* ───── 5. 并发容量为 0 ───── */
/**
 * 先说清楚：**cap=0 通过 register 是产生不出来的**。
 * 1.4.4 的 register 把 `0` 当异常自报值过滤掉、回退到天花板
 * （见 concurrency-cap.mjs 的「自报 0 被忽略，不会变成 0」）——
 * 否则一台机器自报 0 就会让它永远派不出任务。
 * 所以 pickForSession 里的 `max_concurrent_jobs > 0` 是**防御性**的：
 * 这里直接改进程状态来验证那道防御，而不是假装 register 能产出 0。
 */
const pool4 = new WorkerPool({ repoRoot: SANDBOX, log: { warn() {}, log() {} } });
pool4.register({ worker_id: 'zero', process_instance_id: 'zero:1', supported_modes: MODES, max_concurrent_jobs: 0, max_sessions: 8 });
t('自报 0 被 register 忽略，回退到天花板（不会变成 0）',
  pool4.processes.get('zero:1').max_concurrent_jobs > 0,
  `=${pool4.processes.get('zero:1').max_concurrent_jobs}`);
pool4.processes.get('zero:1').max_concurrent_jobs = 0;        // 绕过 register 验证防御
t('★ 防御：容量为 0 的进程不被选中（拿到也跑不了任务）',
  pool4.pickForSession('coding_to_video') === null);
t('容量为 0 时 capacity 报 0，不是负数/NaN',
  pool4.capacitySnapshot().global.capacity === 0,
  `=${pool4.capacitySnapshot().global.capacity}`);

/* ───── 6. mode 过滤与 HEALTHY 过滤仍然生效 ───── */
const pool5 = new WorkerPool({ repoRoot: SANDBOX, log: { warn() {}, log() {} } });
pool5.register({ worker_id: 'only2d', process_instance_id: 'only2d:1', supported_modes: ['coding_to_video'], max_concurrent_jobs: 4, max_sessions: 8 });
t('不支持该 mode 的机器不被选中', pool5.pickForSession('blockout_3d') === null);
t('支持该 mode 的会被选中', pool5.pickForSession('coding_to_video')?.worker_id === 'only2d');
pool5.processes.get('only2d:1').status = 'SUSPECTED_UNAVAILABLE';
t('非 HEALTHY 的机器不被选中', pool5.pickForSession('coding_to_video') === null);

/* ───── 7. 真实配置自检 ───── */
const real = JSON.parse((await import('node:fs')).readFileSync(join(R, 'config/backend.json'), 'utf8'));
// Session quota is independently configurable (dev permits a 50-task batch).
// Verify registered session quota and execution ceilings independently.
const realPool = new WorkerPool({ repoRoot: R, log: { warn() {} } });
for (const w of real.workers.filter(w => w.enabled !== false)) {
  realPool.register({ worker_id: w.worker_id, process_instance_id: w.worker_id + ':quota-fixture',
    max_sessions: w.max_sessions, max_concurrent_jobs: 99999, supported_modes: w.supported_modes });
  const st = realPool.processes.get(w.worker_id + ':quota-fixture');
  t(`${w.worker_id} 会话配额按配置注册，独立于执行并发`, st.max_sessions === w.max_sessions);
  t(`${w.worker_id} 放大会话配额不会放大运行并发`, st.max_concurrent_jobs ===
    Math.min(w.max_concurrent_jobs, real.concurrency.per_machine_max_concurrent_jobs));
}

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n  并发口径与会话分配: 通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
