/**
 * Supervisor：心跳与控制指令，跑在与生成计算【完全独立】的定时器里。
 *
 * 对应 BACKEND_REQUIREMENTS P0-5 的硬要求：
 * 心跳绝不能被长时间阻塞的渲染/编码挡住，否则正常任务会被误判失联。
 * 本 Bridge 用 Node 事件循环 + 独立 setInterval 实现，
 * 生成计算在【子进程】里跑，天然不阻塞本进程的心跳。
 */
import { config } from './config.mjs';
import * as maintenance from './maintenance.mjs';
import { gateway, withRetry, LeaseInvalidError, JobNotFoundError } from './gateway-client.mjs';
import * as runner from './job-runner.mjs';

let processTimer = null;
let jobTimer = null;
let registered = false;
const failureStreak = new Map();   // jobId → 连续心跳失败次数

function nowIso() { return new Date().toISOString(); }

export async function register({ adoptedJobIds = [] } = {}) {
  const payload = {
    worker_id: config.worker.id,
    host: config.worker.host,
    port: config.worker.port,
    process_instance_id: PROCESS_INSTANCE_ID,
    os_pid: process.pid,
    supported_modes: config.worker.supportedModes,
    max_sessions: config.worker.maxSessions,
    max_concurrent_jobs: config.worker.maxConcurrentJobs,
    version: `bridge-${BRIDGE_VERSION}`,
    started_at: STARTED_AT,
    // ★ 本实例启动时认领下来的、仍在运行的任务。
    // Gateway 据此把这些任务与租约持有者改绑到新实例 ——
    // 不带这个字段，它们会在第一次心跳的归属校验里被 abort 掉。
    adopted_job_ids: adoptedJobIds,
    supports_adoption: true,
  };
  const res = await withRetry(() => gateway.registerProcess(payload), { label: 'register', tries: 8 });
  if (res?.config) {
    // 以 Gateway 下发为准，不在 Bridge 里写死
    const c = res.config;
    if (c.heartbeat_interval_seconds) config.timing.processHeartbeatSeconds = c.heartbeat_interval_seconds;
    if (c.job_heartbeat_interval_seconds) config.timing.jobHeartbeatSeconds = c.job_heartbeat_interval_seconds;
    if (c.lease_ttl_seconds) config.timing.leaseTtlSeconds = c.lease_ttl_seconds;
    if (c.cancel_grace_seconds) config.timing.cancelGraceSeconds = c.cancel_grace_seconds;
  }
  registered = true;
  console.log(`[supervisor] 已注册到 Gateway，心跳 ${config.timing.processHeartbeatSeconds}s / Job 心跳 ${config.timing.jobHeartbeatSeconds}s / 租约 TTL ${config.timing.leaseTtlSeconds}s`);
  return res;
}

async function sendProcessHeartbeat() {
  const payload = {
    worker_id: config.worker.id,
    process_instance_id: PROCESS_INSTANCE_ID,
    status: draining ? 'draining' : 'healthy',
    active_sessions: activeSessions.size,
    running_jobs: runner.runningCount(),
    running_job_ids: runner.listRunningJobIds(),   // ★ 供 Gateway 反向对账
    max_sessions: config.worker.maxSessions,
    max_concurrent_jobs: config.worker.maxConcurrentJobs,
    resources: {},
    reported_at: nowIso(),
  };
  try {
    const res = await gateway.processHeartbeat(payload);
    for (const d of res?.directives ?? []) await applyDirective(d);
  } catch (e) {
    // 心跳失败绝不影响正在跑的计算
    console.warn(`[supervisor] Worker 心跳失败（不影响生成）: ${e.message}`);
  }
}

async function applyDirective(d) {
  console.log(`[supervisor] 收到指令 ${d.type} job=${d.job_id ?? '-'}`);
  switch (d.type) {
    case 'cancel_job':
      if (d.job_id) await doCancel(d.job_id, d.reason ?? 'system');
      break;
    case 'abort_not_owner':
    case 'abort_stale_lease':
      if (d.job_id) await runner.abortForLease(d.job_id, d.type);
      break;
    case 'drain':
      draining = true;
      console.log('[supervisor] 进入 drain：不再接新任务，等现有任务跑完');
      break;
    case 'reregister':
      // Gateway 重启后进程表是空的（内存态），它会在心跳里要求重新注册。
      // 不处理这条指令的后果是：Bridge 自以为在线，Gateway 却看不到任何
      // 进程 ⇒ pickForSession/canAdmit 永远失败，所有任务卡在排队。
      // 必须重注册，且【不触碰正在运行的任务】。
      console.warn('[supervisor] Gateway 要求重新注册（它可能刚重启）');
      try {
        await register();
        console.log('[supervisor] 重新注册成功，运行中的任务不受影响');
      } catch (e) {
        console.error(`[supervisor] 重新注册失败，将在下次心跳重试: ${e.message}`);
        registered = false;
      }
      break;
    default:
      console.warn(`[supervisor] 未知指令类型: ${d.type}`);
  }
}

async function sendJobHeartbeats() {
  for (const jobId of runner.listRunningJobIds()) {
    const st = runner.getJob(jobId);
    if (!st) continue;

    // 超最大运行时间：交给 Gateway 走取消流程，Bridge 不自行判死
    const ranMs = Date.now() - new Date(st.startedAt).getTime();
    const overRuntime = st.maxRuntimeSeconds && ranMs > st.maxRuntimeSeconds * 1000;

    const payload = {
      session_id: st.sessionId,
      worker_id: config.worker.id,
      process_instance_id: PROCESS_INSTANCE_ID,
      lease_token: st.leaseToken,
      attempt: 1,
      phase: st.phase,
      progress_percent: null,     // 后端暂无真实百分比；绝不编造
      last_progress_at: st.lastProgressAt,
      heartbeat_at: nowIso(),
      ...(overRuntime ? { over_max_runtime: true } : {}),
    };

    try {
      const res = await gateway.jobHeartbeat(jobId, payload);
      failureStreak.delete(jobId);
      const ctrl = res?.control ?? 'continue';
      if (ctrl === 'cancel' || ctrl === 'abort_max_runtime') {
        await doCancel(jobId, ctrl === 'cancel' ? 'user' : 'max_runtime');
      } else if (ctrl === 'abort_stale_lease' || ctrl === 'abort_not_owner') {
        await runner.abortForLease(jobId, ctrl);
      }
    } catch (e) {
      if (e instanceof LeaseInvalidError) {
        console.warn(`[supervisor] job ${jobId} 租约失效 → 立即停止且不提交结果`);
        await runner.abortForLease(jobId, 'abort_stale_lease');
      } else if (e instanceof JobNotFoundError) {
        console.warn(`[supervisor] job ${jobId} Gateway 不认识 → 停止并清理`);
        await runner.abortForLease(jobId, 'abort_not_owner');
      } else {
        // 网络/5xx：绝不停止计算，只累计失败
        const n = (failureStreak.get(jobId) ?? 0) + 1;
        failureStreak.set(jobId, n);
        const lostMs = n * config.timing.jobHeartbeatSeconds * 1000;
        console.warn(`[supervisor] job ${jobId} 心跳连续失败 ${n} 次（${e.message}），计算继续`);
        if (lostMs >= config.timing.leaseTtlSeconds * 3000) {
          // ★ 热更新期间 Gateway 本来就是停的，心跳失败是预期内的。
          // 不加这个判断，Gateway 重启超过 6 分钟就会把所有在跑的任务杀光 ——
          // 而这正是热更新要保住的东西。维护结束后该安全网自动恢复。
          if (maintenance.isActive()) {
            console.warn(`[supervisor] job ${jobId} 心跳失联 ${Math.round(lostMs / 1000)}s，` +
              '但系统正在更新 → 不自保停止，继续计算');
          } else {
            console.error(`[supervisor] job ${jobId} 失联超过 lease_ttl×3 → 自保停止，避免成为孤儿`);
            await runner.abortForLease(jobId, 'self_preservation');
            failureStreak.delete(jobId);
          }
        }
      }
    }
  }
}

async function doCancel(jobId, reason) {
  const st = runner.getJob(jobId);
  if (!st) return;
  const r = await runner.cancelJob(jobId, reason, config.timing.cancelGraceSeconds);
  // cancel-ack 由 job-runner 的 onCancelled 钩子发出（exit 事件里），此处只记录
  console.log(`[supervisor] job ${jobId} 取消执行: ${JSON.stringify(r)}`);
}

export let draining = false;
/**
 * 本实例"持有"的会话。
 *
 * ★ 必须反映【真实占用】，不能只增不减。
 *
 * 1.3.8 之前这是个只有 add、没有 delete 的 Set —— 会话槽只增不减，
 * 只能靠重启 bridge 清零。满了之后新建会话报 503 PROCESS_UNAVAILABLE，
 * 而那时任务槽往往是空的（线上实测：DB 里 73 个 ACTIVE 会话、每台 13~17 个，
 * 远超 max_sessions=8，只因五台 bridge 近期都重启过才没出故障）。
 * 对用户就是"机器明明闲着却建不了新对话"。
 *
 * 会话在 bridge 上【不持有进程/内存/连接】，只准备了一个工作区目录
 * （prepareSessionWorkspace 只做 mkdir + 拷 skill）。所以"占用"的判据
 * 应该是【最近是否还在用】，而不是"历史上建过"。
 *
 * 现在改为 sessionId → lastSeenAt，并按 TTL 回收空闲会话。
 */
const sessionSeen = new Map();

/** 会话活跃窗口。超过它没有任何动作就不再占名额（目录仍在，随时可恢复）。 */
const SESSION_TTL_MS = (config.timing?.sessionIdleTtlMs ?? 30 * 60 * 1000);

/**
 * 刷新【已有】会话的活跃时间。不存在则不创建。
 *
 * ★ 第二道防线：占名额只能走 registerSession 这一个入口。
 * 1.3.8/1.3.9 这里用的是无条件 set，于是任何陌生 id 一碰就变成占名额的会话 ——
 * 配合分发层把打点放在鉴权之前，未鉴权请求就能耗尽 max_sessions。
 * 鉴权已上提修掉了主因，这里再堵一道：就算以后哪条路由漏了鉴权，
 * 陌生 id 也不该凭空占住名额。
 */
export function touchSession(sessionId) {
  if (sessionId && sessionSeen.has(sessionId)) {
    sessionSeen.set(sessionId, Date.now());
    return true;
  }
  return false;
}

/** 明确登记一个新会话。只有 POST /sessions 建好工作区后才调。 */
export function registerSession(sessionId) {
  if (sessionId) sessionSeen.set(sessionId, Date.now());
}

/** 明确释放（会话确定不再用时）。 */
export function releaseSession(sessionId) {
  return sessionSeen.delete(sessionId);
}

/** 清掉过了 TTL 的，返回当前真实占用数。 */
export function sweepSessions(now = Date.now()) {
  let removed = 0;
  for (const [sid, at] of sessionSeen) {
    if (now - at > SESSION_TTL_MS) { sessionSeen.delete(sid); removed += 1; }
  }
  return { active: sessionSeen.size, removed };
}

export function activeSessionCount() { return sweepSessions().active; }
export function activeSessionIds() { sweepSessions(); return [...sessionSeen.keys()]; }

/**
 * 兼容旧调用点（server.mjs 里的 sup.activeSessions.add(...)）。
 * 只保留 add/delete/size/has，语义转发到上面的带时间戳实现。
 */
export const activeSessions = {
  // add 的语义是「登记新会话」，必须走 registerSession ——
  // 指向 touchSession 的话 POST /sessions 就登记不上了（touch 不再凭空创建）。
  add: (sid) => { registerSession(sid); return activeSessions; },
  delete: (sid) => releaseSession(sid),
  has: (sid) => sessionSeen.has(sid),
  get size() { return activeSessionCount(); },
  [Symbol.iterator]: () => activeSessionIds()[Symbol.iterator](),
};
export let PROCESS_INSTANCE_ID = null;
export const BRIDGE_VERSION = '1.0.0';
export const STARTED_AT = new Date().toISOString();

export function setProcessInstanceId(id) { PROCESS_INSTANCE_ID = id; }
export function setDraining(v) { draining = v; }

export function startHeartbeats() {
  stopHeartbeats();
  processTimer = setInterval(sendProcessHeartbeat, config.timing.processHeartbeatSeconds * 1000);
  jobTimer = setInterval(sendJobHeartbeats, config.timing.jobHeartbeatSeconds * 1000);
  processTimer.unref?.();
  jobTimer.unref?.();
  sendProcessHeartbeat();
}

export function stopHeartbeats() {
  if (processTimer) clearInterval(processTimer);
  if (jobTimer) clearInterval(jobTimer);
  processTimer = jobTimer = null;
}

export function isRegistered() { return registered; }
export { doCancel };
