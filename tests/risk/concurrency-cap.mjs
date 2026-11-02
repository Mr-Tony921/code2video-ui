import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 单机并发上限的回归（1.4.4）。
 *
 * 背景：跑 Gateway 的那台机器要把并发压到 2（其余 4）—— Gateway 要处理所有 SSE、
 * 视频 Range 下发、增强与派发，和 4 个 cc 抢资源时它一卡，所有在跑任务的
 * 过程框和视频都跟着卡。
 *
 * 原来的实现只信 Bridge 自报：
 *     max_concurrent_jobs: Math.min(p.max_concurrent_jobs ?? perMachineMax, perMachineMax)
 * 配置里的 `workers[].max_concurrent_jobs` 对 Gateway 等于作废 —— 改配置必须重启
 * 那台 Bridge 才生效，而且 Bridge 侧 `CVW_MAX_CONCURRENT_JOBS` 一覆盖就能悄悄抬回去。
 *
 * ★ 行为测试，不是正则守卫：造一份临时 config，真的 new 一个 WorkerPool 并 register，
 *   断言算出来的 max_concurrent_jobs。正则守卫挡不住"换种写法又把 declared 丢掉"。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const R = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let pass = 0, fail = 0;
const t = (n, c, e = '') => { c ? (pass++, console.log('  ✅', n, e)) : (fail++, console.log('  ❌', n, e)); };

const SANDBOX = mkdtempSync(join(tmpdir(), 'conc-cap-'));
mkdirSync(join(SANDBOX, 'config'), { recursive: true });
writeFileSync(join(SANDBOX, 'config/backend.json'), JSON.stringify({
  concurrency: { global_max_concurrent_jobs: 8, per_machine_max_concurrent_jobs: 4 },
  workers: [
    { worker_id: 'gw-host', bridge: { host: '10.0.0.1', port: 18080 }, max_concurrent_jobs: 2, max_sessions: 8, enabled: true },
    { worker_id: 'plain',   bridge: { host: '10.0.0.2', port: 18080 }, max_concurrent_jobs: 4, max_sessions: 8, enabled: true },
    { worker_id: 'nodecl',  bridge: { host: '10.0.0.3', port: 18080 }, max_sessions: 8, enabled: true },
  ],
}), 'utf8');

const { WorkerPool } = await import(join(R, 'apps/gateway/src/worker-pool.mjs'));
const pool = new WorkerPool({ repoRoot: SANDBOX, log: { warn() {}, log() {} } });
const cap = (worker_id, selfReport, i) => {
  const pid = `${worker_id}:inst${i}`;
  pool.register({
    worker_id, process_instance_id: pid,
    ...(selfReport === undefined ? {} : { max_concurrent_jobs: selfReport }),
  });
  return pool.processes.get(pid).max_concurrent_jobs;
};

// ★ 核心：配置说 2，Bridge 自报 4（没重启 / 被 env 覆盖）⇒ 必须是 2
t('配置声明 2 而 Bridge 自报 4 → 取 2', cap('gw-host', 4, 1) === 2, `得到 ${cap('gw-host', 4, 11)}`);
t('配置声明 2 而 Bridge 自报 2 → 2', cap('gw-host', 2, 2) === 2);
t('配置声明 2 而 Bridge 不报 → 2', cap('gw-host', undefined, 3) === 2);
// 不能被抬高
t('Bridge 自报 99 也不能超过天花板 4', cap('plain', 99, 4) === 4, `得到 ${cap('plain', 99, 14)}`);
t('配置声明 4 + 自报 4 → 4（普通机器不受影响）', cap('plain', 4, 5) === 4);
// 没有声明时沿用天花板（老行为不变）
t('无声明 + 自报 4 → 4', cap('nodecl', 4, 6) === 4);
t('无声明 + 不自报 → 天花板 4', cap('nodecl', undefined, 7) === 4);
// Bridge 自报更低时听 Bridge（它才知道自己的真实状况）
t('Bridge 自报 1（比声明低）→ 1', cap('plain', 1, 8) === 1);
// 异常值不能把上限变成 0 / NaN / Infinity —— 那会让这台机器永远派不出或无限派
t('自报 0 被忽略，不会变成 0', cap('plain', 0, 9) > 0, `得到 ${cap('plain', 0, 19)}`);
t('自报 NaN 被忽略', Number.isFinite(cap('plain', Number.NaN, 10)) && cap('plain', Number.NaN, 20) === 4);

// 未知 worker（配置里没有）仍按天花板，不能因为找不到声明就崩
pool.register({ worker_id: 'ghost', process_instance_id: 'ghost:1', max_concurrent_jobs: 3 });
t('配置里没有的 worker 也能注册（取 3）', pool.processes.get('ghost:1').max_concurrent_jobs === 3);

// 真实配置自检：跑 Gateway 的那台必须 ≤2，其余 4
const real = JSON.parse((await import('node:fs')).readFileSync(join(R, 'config/backend.json'), 'utf8'));
const gwHost = real.deployment.gateway.host;
const gwWorker = real.workers.find((w) => w.bridge.host === gwHost);
t('Gateway 跑在某台 worker 机器上（不在前端机）', !!gwWorker,
  gwWorker ? `${gwWorker.worker_id}` : `gateway.host=${gwHost} 不在 workers 里`);
if (gwWorker) {
  t('该机器并发已压到 ≤2', (gwWorker.max_concurrent_jobs ?? 9) <= 2, `=${gwWorker.max_concurrent_jobs}`);
  for (const w of real.workers.filter((x) => x !== gwWorker)) {
    t(`其余机器 ${w.worker_id} 仍为 4`, w.max_concurrent_jobs === 4, `=${w.max_concurrent_jobs}`);
  }
}

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n  并发上限: 通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
