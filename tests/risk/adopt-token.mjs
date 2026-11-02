import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 认领闸门的判活回归（1.4.1 修）。
 *
 * 事故：`isSidecarProcessAlive` 重建状态时漏传 jobToken，procAlive 退回用
 * `job_dir`（rounds/<jid>）去比对进程里的 `CVW_JOB_TOKEN`（`<工作区>#<jobId>`），
 * 两者永远不等 ⇒ **活着的 cc 一律被判死**。
 *
 * 后果是整条恢复链反向：bridge 每次重启（热更新必然重启）都走
 * 「进程没了 → 补收尾」，把在跑任务标成 FAILED(E_CLAUDE_EXIT code=null
 * signal=null)，cc 却继续跑完、产物无人认领。实测复现过：kill -9 bridge 后
 * pid 还在，日志写「进程（pid=…）已不在，补收尾」。
 *
 * ★ 这里是【功能测试】，不是 grep：真起一个带 CVW_JOB_TOKEN 的子进程，
 *   拿真实边车形状去问 isSidecarProcessAlive。只断言源码里有 job_token
 *   这个词的话，下次换个写法照样能回归。
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// bridge 的 config 在 import 时就校验必需环境变量，所以要先铺好
// （与 adopt-unit.mjs 同一套假值；指向不存在的 gateway，本测试不发网络请求）
const R = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.CVW_REPO_ROOT ??= R;
process.env.CVW_WORKER_ID ??= 'cvw-dev-360';
process.env.CVW_GATEWAY_BASE_URL ??= 'http://127.0.0.1:1';
process.env.CVW_INTERNAL_TOKEN ??= 'x'.repeat(32);
process.env.CVW_MODEL_API_KEY ??= 'sk-test';
process.env.CVW_SESSIONS_ROOT ??= TEST_TMP_ROOT + '/fixture-devtest/adopt-token/sessions';
process.env.CVW_STORAGE_ROOT ??= TEST_TMP_ROOT + '/fixture-devtest/adopt-token/store';

let pass = 0, fail = 0;
const t = (n, c, e = '') => { c ? (pass++, console.log('  ✅', n, e)) : (fail++, console.log('  ❌', n, e)); };

const runner = await import(join(R, 'apps/worker-bridge/src/job-runner.mjs'));
const { isSidecarProcessAlive } = runner;
t('isSidecarProcessAlive 可导入', typeof isSidecarProcessAlive === 'function');

const AGENT_WS = TEST_TMP_ROOT + '/fixture-adopt-token-test/sessions/sess_x/workspace';
const JOB_DIR = TEST_TMP_ROOT + '/fixture-adopt-token-test/sessions/sess_x/rounds/job_y';
const JOB_ID = 'job_y';
const TOKEN = `${AGENT_WS}#${JOB_ID}`;

/** 起一个长命子进程，环境里带指定的 token */
function spawnWithToken(token) {
  const env = { ...process.env };
  if (token === null) delete env.CVW_JOB_TOKEN;
  else env.CVW_JOB_TOKEN = token;
  const ch = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    env, stdio: 'ignore', detached: false,
  });
  return ch;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── ① 真实 1.4.x 边车：token 是 <工作区>#<jobId> ── */
const good = spawnWithToken(TOKEN);
await sleep(300);
const scGood = {
  job_id: JOB_ID, session_id: 'sess_x', job_dir: JOB_DIR,
  agent_ws: AGENT_WS, job_token: TOKEN,
  log_path: '/dev/null', pid: good.pid, start_ticks: null,
};
t('★★ 1.4.x 边车 + 活着的进程 ⇒ 判活（这条红就等于每次热更新误杀在跑任务）',
  isSidecarProcessAlive(scGood) === true, `pid=${good.pid} token=${TOKEN.slice(-28)}`);

/* ── ② token 不是本轮的（上一轮残留进程占了同一个 pid 位置）⇒ 必须判死 ── */
const other = spawnWithToken(`${AGENT_WS}#job_OTHER`);
await sleep(300);
t('★ 别的轮次的进程 ⇒ 判死（防把上一轮残留认成本轮）',
  isSidecarProcessAlive({ ...scGood, pid: other.pid }) === false, `pid=${other.pid}`);

/* ── ③ 1.3.x 老边车：没有 job_token，进程 token 就是 job 目录 ⇒ 仍要判活 ── */
const legacy = spawnWithToken(JOB_DIR);
await sleep(300);
const scLegacy = {
  job_id: JOB_ID, session_id: 'sess_x', job_dir: JOB_DIR,
  log_path: '/dev/null', pid: legacy.pid, start_ticks: null,
};
t('★ 1.3.x 老边车（无 job_token）仍能判活', isSidecarProcessAlive(scLegacy) === true);

/* ── ④ 进程真的没了 ⇒ 判死（补收尾这条路本身是对的，不能一起改坏） ── */
const dead = spawnWithToken(TOKEN);
const deadPid = dead.pid;
dead.kill('SIGKILL');
await sleep(500);
t('进程真没了 ⇒ 判死', isSidecarProcessAlive({ ...scGood, pid: deadPid }) === false, `pid=${deadPid}`);

/* ── ⑤ 没有 pid 的边车 ⇒ 判死，且不能抛 ── */
let threw = false;
let r5;
try { r5 = isSidecarProcessAlive({ ...scGood, pid: null }); } catch { threw = true; }
t('边车没有 pid ⇒ 判死且不抛', !threw && r5 === false);

for (const c of [good, other, legacy]) { try { c.kill('SIGKILL'); } catch {} }

console.log(`  —— 通过 ${pass} 失败 ${fail} ——`);
process.exit(fail ? 1 : 0);
