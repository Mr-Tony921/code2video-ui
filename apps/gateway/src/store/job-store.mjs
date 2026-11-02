/**
 * Job / Session 的权威状态存储。
 *
 * 当前为文件驱动（jsonl 追加 + json 快照），与 Bridge 的 session-store 同构，
 * 因此没有 DB 也能完整跑联调；DATABASE_URL 到位后替换本模块的实现即可，
 * 上层 API 不受影响。
 *
 * 关键不变式（STATE_MACHINE.md）：
 *  I-1  一个 Job 有且仅有一个终态
 *  I-5  同一 (user_id, idempotency_key) 最多一个 Job
 *  I-6  同一 workflow_id 最多一个 Job
 *  I-9  过期 lease_epoch 的写入一律拒绝且不改变状态
 */
import { mkdir, writeFile, readFile, appendFile, readdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.mjs';

// OUT_OF_SCOPE 也是终态：非视频请求，不投产
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'OUT_OF_SCOPE']);
export const isTerminal = (s) => TERMINAL.has(s);

const root = () => join(config.storage.root, 'gateway');
const jobsDir = () => join(root(), 'jobs');
const sessDir = () => join(root(), 'sessions');
const idemFile = () => join(root(), 'idempotency.jsonl');
/** (user_id\0key) → 进行中的创建 Promise。防止并发提交绕过幂等（见 createJob）。 */
const idemLocks = new Map();
const eventsDir = () => join(root(), 'events');

function nowIso() { return new Date().toISOString(); }

export async function init() {
  for (const d of [root(), jobsDir(), sessDir(), eventsDir()]) await mkdir(d, { recursive: true });
}

/* ───────────────────────── Session ───────────────────────── */

export async function createSession({ userId, mode, workerId, processInstanceId, backendRef, skillset, skills, modelSelection, experimentalSkills }) {
  const id = `sess_${randomUUID()}`;
  const s = {
    id, user_id: userId, mode, status: 'ACTIVE',
    binding: {
      worker_id: workerId, process_instance_id: processInstanceId,
      backend_session_ref: backendRef, status: 'BOUND', bound_at: nowIso(),
    },
    skillset: skillset ?? null, skills: skills ?? [],
    model_selection: modelSelection ?? null, experimental_skills: experimentalSkills ?? null,
    created_at: nowIso(), last_activity_at: nowIso(),
  };
  await atomicWriteJson(join(sessDir(), `${id}.json`), s);
  return s;
}

export async function getSession(id) {
  const p = join(sessDir(), `${id}.json`);
  if (!existsSync(p)) return null;
  const txt = await readFile(p, 'utf8');
  try { return JSON.parse(txt); } catch { return null; }   // 会话读失败可降级，不致误杀任务
}

export async function updateSession(id, patch) {
  const s = await getSession(id);
  if (!s) return null;
  const next = { ...s, ...patch, last_activity_at: nowIso() };
  if (patch.binding) next.binding = { ...s.binding, ...patch.binding };
  await atomicWriteJson(join(sessDir(), `${id}.json`), next);
  return next;
}

export async function listSessionsByUser(userId) {
  if (!existsSync(sessDir())) return [];
  const out = [];
  for (const f of await readdir(sessDir())) {
    if (!f.endsWith('.json')) continue;
    const s = await getSession(f.replace(/\.json$/, ''));
    if (s && s.user_id === userId) out.push(s);
  }
  out.sort((a, b) => String(b.last_activity_at).localeCompare(String(a.last_activity_at)));
  return out;
}

/**
 * 只把租约的持有者改成新实例。
 *
 * ★ 绝不碰 epoch，也绝不换 token ★
 * 热更新后 cc 进程还活着，它手里拿的是原来的 lease_token，仍在用它上报心跳。
 * validateLease 只校验 token / revoked / released，【不看 holder】——
 * 所以换持有者不影响它继续上报，这正是「认领」能成立的前提。
 * 一旦误用 acquireLease（epoch+1 且换 token），它的下一次心跳就会 409
 * LEASE_INVALID → Bridge 自保停止 → 把刚救回来的任务亲手杀掉。
 */
export async function reassignLeaseHolder(id, newProcessInstanceId) {
  return mutateLease(id, lease => ({
    ...lease, holder_process_instance_id: newProcessInstanceId, reassigned_at: nowIso(),
  }));
}

/**
 * Worker 重新注册时，把绑在该 worker 旧实例上的【任务】改绑到新实例。
 *
 * 为什么单独需要它：rebindSessionsToNewProcess 只改了 Session 的 binding，
 * 而 Job 自己也存了一份 process_instance_id。不改它的话：
 *   · QUEUED 的任务 canAdmit 永远回 PROCESS_UNKNOWN ⇒ 永远排队（机器却是空的）
 *   · RUNNING 的任务在心跳对账里被判为「不属于此进程实例」⇒ 被 abort 掉
 *
 * adoptedJobIds 是新实例启动时真正认领下来的任务 —— 这些任务的执行者还活着，
 * 要连租约持有者一起改过去。
 */
export async function rebindJobsToNewProcess(workerId, newProcessInstanceId, { adoptedJobIds = [] } = {}) {
  const rebound = [];
  const orphaned = [];
  for (const j of await listJobs({})) {
    if (isTerminal(j.status)) continue;
    if (j.worker_id !== workerId) continue;
    if (j.process_instance_id === newProcessInstanceId) continue;
    await patchJob(j.id, {
      process_instance_id: newProcessInstanceId,
      rebound_at: nowIso(),
    });
    if (adoptedJobIds.includes(j.id)) {
      await reassignLeaseHolder(j.id, newProcessInstanceId);
      rebound.push(j.id);
    } else {
      // 没被认领：可能是排队中（改绑即可派发），也可能执行者已经没了
      // （留给 watchdog 对账定论，这里不擅自判死）。
      orphaned.push(j.id);
    }
  }
  return { rebound, orphaned };
}

/** 绑定进程失联 → Session 转 DEGRADED。绝不自动迁移（任务 5 / I-8）。 */
/**
 * Worker 重新注册时：把绑在【该 worker 其它实例】上的会话收口。
 *
 * 为什么需要它：worker-pool.register 只能看见 Gateway 内存里已知的旧实例。
 * Gateway 自己重启后进程表是空的，于是"旧实例"一个都找不到，
 * 那些会话会永远 BOUND 在一个已死的 process_instance_id 上 ——
 * bridgeUrlFor 返回 null，素材读不到、任务也派不出去，且表现为静默空列表。
 *
 * 处置原则：没有在跑的任务就直接改绑到新实例（用户无感知）；
 * 有在跑的任务则转 DEGRADED，因为那个进程确实已经没了。
 *
 * 例外（热更新）：adoptedJobIds 里的任务已被新实例认领，执行者还活着 ——
 * 这种会话要照常改绑，不能转 DEGRADED，否则热更新后用户的输入框被永久锁死
 * （前端 degraded ⇒ Composer disabled，只能新建对话）。
 */
export async function rebindSessionsToNewProcess(workerId, newProcessInstanceId, { adoptedJobIds = [] } = {}) {
  if (!existsSync(sessDir())) return { rebound: [], degraded: [] };
  const rebound = [];
  const degraded = [];
  for (const f of await readdir(sessDir())) {
    if (!f.endsWith('.json')) continue;
    let s;
    try { s = await getSession(f.replace(/\.json$/, '')); } catch { continue; }
    if (!s || s.status === 'CLOSED') continue;
    const b = s.binding ?? {};
    if (b.worker_id !== workerId) continue;
    if (b.process_instance_id === newProcessInstanceId) continue;

    // 该会话还有非终态任务吗？有就不能当作"无痛改绑"
    let live = [];
    try {
      live = (await listJobs({ sessionId: s.id })).filter((j) => !isTerminal(j.status));
    } catch { live = []; }

    if (live.length) {
      // 活着的任务是否【全部】被新实例认领下来了？是则执行者仍在，照常改绑。
      const allAdopted = live.every((j) => adoptedJobIds.includes(j.id));
      if (allAdopted) {
        rebound.push(await updateSession(s.id, {
          status: 'ACTIVE',
          binding: {
            ...b, status: 'BOUND',
            process_instance_id: newProcessInstanceId,
            rebound_at: nowIso(),
            health_note: null, lost_at: null,
          },
        }));
        continue;
      }
      degraded.push(await updateSession(s.id, {
        status: 'DEGRADED',
        binding: {
          status: 'PROCESS_LOST', lost_at: nowIso(),
          health_note: `原进程已消失（新实例 ${newProcessInstanceId}），运行中的任务无法继续`,
        },
      }));
    } else {
      rebound.push(await updateSession(s.id, {
        status: 'ACTIVE',
        binding: {
          ...b, status: 'BOUND',
          process_instance_id: newProcessInstanceId,
          rebound_at: nowIso(),
          health_note: null, lost_at: null,
        },
      }));
    }
  }
  return { rebound, degraded };
}

/**
 * 启动时收口：绑在【已下线 worker】上的会话标记为 DEGRADED。
 *
 * 换后端机器后，老会话的 worker_id 不在配置里了。不处理的话它仍是 ACTIVE，
 * 用户点进去只会看到素材 503、提交失败，却没有任何解释。
 * 标 DEGRADED 后前端会明确提示「请新建对话」，已完成产物仍可访问。
 */
export async function degradeSessionsOnRetiredWorkers(activeWorkerIds) {
  if (!existsSync(sessDir())) return [];
  const live = new Set(activeWorkerIds);
  const out = [];
  for (const f of await readdir(sessDir())) {
    if (!f.endsWith('.json')) continue;
    let s;
    try { s = await getSession(f.replace(/\.json$/, '')); } catch { continue; }
    if (!s || s.status === 'CLOSED' || s.status === 'DEGRADED') continue;
    const wid = s.binding?.worker_id;
    if (!wid || live.has(wid)) continue;
    out.push(await updateSession(s.id, {
      status: 'DEGRADED',
      binding: {
        status: 'PROCESS_LOST', lost_at: nowIso(),
        health_note: `原后端机器（${wid}）已下线，请新建对话；已完成产物仍可访问`,
      },
    }));
  }
  return out;
}

export async function degradeSessionsOnProcess(processInstanceId, note) {
  if (!existsSync(sessDir())) return [];
  const affected = [];
  for (const f of await readdir(sessDir())) {
    if (!f.endsWith('.json')) continue;
    const s = await getSession(f.replace(/\.json$/, ''));
    if (!s || s.binding?.process_instance_id !== processInstanceId) continue;
    if (s.status === 'CLOSED') continue;
    affected.push(await updateSession(s.id, {
      status: 'DEGRADED',
      binding: { status: 'PROCESS_LOST', lost_at: nowIso(), health_note: note },
    }));
  }
  return affected;
}

/* ───────────────────────── Job ───────────────────────── */

function jobPath(id) { return join(jobsDir(), `${id}.json`); }

/**
 * 读 Job。返回 null 仅表示【文件不存在】。
 * 读取/解析失败会抛错，绝不静默返回 null —— 否则调用方会把
 * 一次瞬时读失败误判成「任务不存在」，进而杀掉正在跑的任务。
 */
export async function getJob(id) {
  const p = jobPath(id);
  if (!existsSync(p)) return null;
  const txt = await readFile(p, 'utf8');
  try {
    return JSON.parse(txt);
  } catch (e) {
    const err = new Error(`job ${id} 记录解析失败（可能正在写入）: ${e.message}`);
    err.code = 'JOB_READ_FAILED';
    throw err;
  }
}

/** 容错读：读失败时重试，仍失败则抛。用于对账等不能误判的场景。 */
export async function getJobReliable(id, { tries = 3, delayMs = 60 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await getJob(id); } catch (e) { last = e; await new Promise((r) => setTimeout(r, delayMs)); }
  }
  throw last;
}

/**
 * 原子写：先写临时文件再 rename。
 * 直接 writeFile 不是原子的 —— 并发 getJob 可能读到写了一半的 JSON，
 * 解析失败后若当成「记录不存在」，反向对账会误杀正在运行的任务。
 */
/** 临时文件名的唯一计数器。Date.now() 毫秒精度不够 —— 同毫秒内的两次写
 *  会撞同一个临时文件，互相截断，rename 出去就是半截 JSON 加残留括号。
 *  实测踩过：job 文件尾部多出一个 "}"，之后所有 getJob 都解析失败。 */
let tmpSeq = 0;

async function atomicWriteJson(path, obj) {
  const tmp = `${path}.${process.pid}.${Date.now()}.${tmpSeq++}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
    await rename(tmp, path);
  } catch (e) {
    // 失败要清掉临时文件，否则目录里会堆满 .tmp（listJobs 已跳过它们，但仍占空间）
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

// A single Gateway owns this store. Serialize the complete read/modify/write per job;
// atomic rename alone only prevents torn JSON, not concurrent lost updates.
const jobWrites = new Map();
async function withJobWrite(id, action) {
  const previous = jobWrites.get(id) ?? Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  jobWrites.set(id, tail);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (jobWrites.get(id) === tail) jobWrites.delete(id);
  }
}

const CANCELLING = new Set(['CANCEL_REQUESTED', 'CANCELLING']);
function mergeJobPatch(job, patch) {
  // Status/lease have dedicated mutation APIs. A stale whole-record metadata patch
  // must never rewind a state transition or restore a revoked fencing token.
  const next = { ...job, ...patch, id: job.id, status: job.status, lease: job.lease };
  if (patch.cancellation) {
    next.cancellation = { ...job.cancellation, ...patch.cancellation };
    for (const [key, value] of Object.entries(job.cancellation ?? {})) {
      if (value != null && (patch.cancellation[key] == null ||
          ['requested_at', 'requested_by', 'reason'].includes(key))) next.cancellation[key] = value;
    }
  } else if ('cancellation' in patch) next.cancellation = job.cancellation;
  if (patch.failure) next.failure = { ...job.failure, ...patch.failure };
  return next;
}

async function mutateLease(id, update) {
  return withJobWrite(id, async () => {
    const j = await getJob(id);
    if (!j?.lease) return null;
    const lease = update(j.lease);
    if (lease !== j.lease) await writeJob({ ...j, lease });
    return lease;
  });
}

async function writeJob(j) {
  await atomicWriteJson(jobPath(j.id), j);
  return j;
}

/** 幂等查找：同一 (user_id, key) 只能有一个 Job（I-5）。 */
export async function findByIdempotency(userId, key) {
  const p = idemFile();
  if (!existsSync(p)) return null;
  const txt = await readFile(p, 'utf8');
  for (const l of txt.split('\n')) {
    if (!l) continue;
    try {
      const r = JSON.parse(l);
      if (r.user_id === userId && r.key === key) return await getJob(r.job_id);
    } catch {}
  }
  return null;
}

export async function createJob({
  userId, sessionId, workflowId, mode, prompt, baseAssetPath, isRevision = false,
  workerId, processInstanceId, idempotencyKey, maxRuntimeSeconds,
  originalPrompt, enhancement, initialStatus, modelSelection, experimentalSkills,
}) {
  // I-5 / I-6：幂等重放返回同一个 Job，不产生第二个昂贵任务
  //
  // ⚠️ 并发：check-then-write 之间有窗口。两次几乎同时的提交（双击、两个标签页、
  // 公网重试）可能都查不到、都创建 —— 产生两个 1~2 小时的昂贵任务。
  // 用 per-(user,key) 的内存串行锁把整段收窄成临界区：单 Gateway 进程下足够；
  // 将来多实例要换成 DB 的 UNIQUE(user_id, idempotency_key)。
  const lockKey = idempotencyKey ? `${userId}\u0000${idempotencyKey}` : null;
  if (lockKey) {
    while (idemLocks.has(lockKey)) await idemLocks.get(lockKey);
  }
  let releaseLock = () => {};
  if (lockKey) {
    idemLocks.set(lockKey, new Promise((r) => { releaseLock = () => { idemLocks.delete(lockKey); r(); }; }));
  }
  try {
  if (idempotencyKey) {
    const existing = await findByIdempotency(userId, idempotencyKey);
    if (existing) return { job: existing, replayed: true };
  }
  const id = `job_${randomUUID()}`;
  const j = {
    id, user_id: userId, session_id: sessionId, workflow_id: workflowId ?? null,
    mode,
    prompt,                                   // 投产用（增强后的 dense prompt）
    model_selection: modelSelection ?? null, experimental_skills: experimentalSkills ?? null,
    original_prompt: originalPrompt ?? null,  // 用户原始指令，留档与轨迹导出
    enhancement: enhancement ?? null,         // 增强元信息（含 skipped 标记）
    base_asset_path: baseAssetPath ?? null,
    is_revision: isRevision === true,   // 微调：Bridge 据此继承上一轮工作区
    worker_id: workerId, process_instance_id: processInstanceId,
    status: initialStatus ?? 'QUEUED', phase: null, progress_percent: null,
    notice: null,
    idempotency_key: idempotencyKey ?? null, attempt: 0,
    created_at: nowIso(), queued_at: nowIso(),
    assigned_at: null, started_at: null, phase_started_at: null,
    last_heartbeat_at: null, last_progress_at: null, finished_at: null,
    cancellation: {
      requested_at: null, requested_by: null, reason: null,
      acked_at: null, effective: null, resources_released_at: null,
    },
    failure: { code: null, message: null },
    result_asset: null,
    lease: null,
    max_runtime_seconds: maxRuntimeSeconds ?? 10800,
  };
  await writeJob(j);
  if (idempotencyKey) {
    await appendFile(idemFile(),
      JSON.stringify({ user_id: userId, key: idempotencyKey, job_id: id, at: nowIso() }) + '\n', 'utf8');
  }
  await appendEvent(id, j.status === 'ENHANCING' ? 'job.enhancing' : 'job.queued',
    { status: j.status });
  return { job: j, replayed: false };
  } finally { releaseLock(); }
}

/**
 * 状态迁移。禁止从终态迁出（I-1），禁止 UNKNOWN 直接到 FAILED（I-7）。
 * 返回 null 表示迁移被拒绝。
 */
const FORBIDDEN = [
  (from, to) => isTerminal(from),                      // 终态不可变
  (from, to) => from === 'UNKNOWN' && to === 'FAILED', // 必须经 RECOVERING 对账
];

export async function transition(id, to, patch = {}, { force = false } = {}) {
  return withJobWrite(id, async () => {
    const j = await getJob(id);
    if (!j) return { ok: false, reason: 'NOT_FOUND' };
    // Force permits dispatch retries, never reopening a terminal job or undoing
    // an already persisted cancellation with a late heartbeat/requeue.
    const cancelRegression = CANCELLING.has(j.status) && !isTerminal(to) &&
      to !== 'CANCELLING' && !(j.status === 'CANCEL_REQUESTED' && to === 'CANCEL_REQUESTED');
    if (isTerminal(j.status) || cancelRegression ||
        (!force && FORBIDDEN.some(rule => rule(j.status, to)))) {
      return { ok: false, reason: 'FORBIDDEN_TRANSITION', from: j.status, to, job: j };
    }
    const next = { ...mergeJobPatch(j, patch), status: to };
    if (isTerminal(to) && !next.finished_at) next.finished_at = nowIso();
    await writeJob(next);
    return { ok: true, job: next, from: j.status };
  });
}

/** Metadata only; state and fencing changes go through transition/lease APIs. */
export async function patchJob(id, patch) {
  return withJobWrite(id, async () => {
    const j = await getJob(id);
    if (!j) return null;
    return writeJob(mergeJobPatch(j, patch));
  });
}

export async function listJobs({ userId, sessionId, statuses } = {}) {
  if (!existsSync(jobsDir())) return [];
  const out = [];
  for (const f of await readdir(jobsDir())) {
    if (!f.endsWith('.json')) continue;
    let j;
    try { j = await getJob(f.replace(/\.json$/, '')); } catch { continue; }  // 正在写入，下轮再看
    if (!j) continue;
    if (userId && j.user_id !== userId) continue;
    if (sessionId && j.session_id !== sessionId) continue;
    if (statuses && !statuses.includes(j.status)) continue;
    out.push(j);
  }
  out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return out;
}

/* ───────────────────────── Lease（fencing） ───────────────────────── */

/** 取得租约。epoch 单调递增：续约不变，重新分配才 +1（I-9）。 */
export async function acquireLease(id, processInstanceId) {
  return withJobWrite(id, async () => {
    const j = await getJob(id);
    if (!j || isTerminal(j.status) || CANCELLING.has(j.status)) return null;
    const lease = {
      epoch: (j.lease?.epoch ?? 0) + 1,
      token: `lt_${randomUUID().replace(/-/g, '')}`,
      holder_process_instance_id: processInstanceId,
      acquired_at: nowIso(), renewed_at: nowIso(),
      expires_at: new Date(Date.now() + config.timing.leaseTtlMs).toISOString(),
      released_at: null, revoked_at: null,
    };
    await writeJob({ ...j, lease });
    return lease;
  });
}

/** 校验 Bridge 带回的 token。失败即丢弃其上报，不改变 Job 状态。 */
export function validateLease(job, token) {
  const l = job?.lease;
  if (!l) return { valid: false, reason: 'NO_LEASE' };
  if (l.revoked_at) return { valid: false, reason: 'REVOKED' };
  if (l.released_at) return { valid: false, reason: 'RELEASED' };
  if (l.token !== token) return { valid: false, reason: 'TOKEN_MISMATCH' };
  return { valid: true, epoch: l.epoch };
}

export async function renewLease(id) {
  return mutateLease(id, lease => lease.revoked_at || lease.released_at ? lease : ({
    ...lease, renewed_at: nowIso(),
    expires_at: new Date(Date.now() + config.timing.leaseTtlMs).toISOString(),
  }));
}

export async function revokeLease(id) {
  return mutateLease(id, lease => ({ ...lease, revoked_at: lease.revoked_at ?? nowIso() }));
}

export async function releaseLease(id) {
  return mutateLease(id, lease => ({ ...lease, released_at: lease.released_at ?? nowIso() }));
}

/* ───────────────────────── 事件（SSE 的持久化来源） ───────────────────────── */

const seqCache = new Map();

export async function appendEvent(jobId, type, payload = {}) {
  await mkdir(eventsDir(), { recursive: true });
  const p = join(eventsDir(), `${jobId}.jsonl`);
  let seq = seqCache.get(jobId);
  if (seq === undefined) {
    seq = 0;
    if (existsSync(p)) {
      const txt = await readFile(p, 'utf8');
      seq = txt.split('\n').filter(Boolean).length;
    }
  }
  seq += 1;
  seqCache.set(jobId, seq);
  const ev = { seq, type, job_id: jobId, at: nowIso(), ...payload };
  await appendFile(p, JSON.stringify(ev) + '\n', 'utf8');
  emit(jobId, ev);
  return ev;
}

export async function readEvents(jobId, afterSeq = 0) {
  const p = join(eventsDir(), `${jobId}.jsonl`);
  if (!existsSync(p)) return [];
  const txt = await readFile(p, 'utf8');
  const out = [];
  for (const l of txt.split('\n')) {
    if (!l) continue;
    try { const e = JSON.parse(l); if (e.seq > afterSeq) out.push(e); } catch {}
  }
  return out;
}

/* 实时订阅（进程内；多实例时换 Redis Pub/Sub） */
const subs = new Map();
export function subscribe(jobId, fn) {
  if (!subs.has(jobId)) subs.set(jobId, new Set());
  subs.get(jobId).add(fn);
  return () => subs.get(jobId)?.delete(fn);
}
function emit(jobId, ev) {
  for (const fn of subs.get(jobId) ?? []) { try { fn(ev); } catch {} }
}
