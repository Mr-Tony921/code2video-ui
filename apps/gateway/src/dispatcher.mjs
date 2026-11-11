/**
 * Dispatcher：亲和性队列出队 → 取并发槽 → 取租约 → 调 Bridge 启动。
 *
 * 关键约束：
 *  · 优先使用会话绑定的进程。dev 可为共享工作区配置备用执行进程。
 *  · 全局 8 / 单机 4 双层并发，两种 mode 共享（任务 10.3）
 *  · 投递后立即返回，绝不等待 1~2 小时的生成（任务 7.1）
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as store from './store/job-store.mjs';
import { config } from './config.mjs';
import { bridge } from './bridge-client.mjs';
import * as maintenance from './maintenance.mjs';

export class Dispatcher {
  constructor({ pool, log = console }) {
    this.pool = pool;
    const workers = config.concurrency?.shared_workspace_workers;
    const isolation = config.raw.isolation;
    this.sharedWorkers = new Set(config.environment === 'dev' &&
      config.raw.production?.allow_steering_during_job === false &&
      isolation?.enabled && isolation.fallback_to_soft === false && isolation.workspace_mount === '/workspace' &&
      Array.isArray(workers) ? workers : []);
    this.log = log;
    this.timer = null;
    this.running = false;
  }

  start(intervalMs = 2000) {
    this.stop();
    this.timer = setInterval(() => this.tick().catch((e) =>
      this.log.error(`[dispatcher] tick 异常: ${e.message}`)), intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** 一轮出队。按 queued_at 先到先服务，但受各自绑定进程的容量约束。 */
  async tick() {
    if (this.running) return;               // 防重入：避免同一 Job 被派两次
    // 维护期不派发：交给一个几秒后就要重启的 Bridge 没有意义，
    // 任务留在 QUEUED 里，更新完照常出队。
    if (maintenance.isActive()) return;
    this.running = true;
    try {
      const shared = this.sharedWorkers.size > 1;
      const jobs = await store.listJobs(shared ? {} : { statuses: ['QUEUED'] });
      const queued = jobs.filter(j => j.status === 'QUEUED')
        .sort((a, b) => String(a.queued_at).localeCompare(String(b.queued_at)));
      const activeSessions = new Set();
      const sessionJobs = new Map();
      if (shared) {
        for (const j of jobs) {
          const siblings = sessionJobs.get(j.session_id) ?? [];
          siblings.push(j);
          sessionJobs.set(j.session_id, siblings);
          if (j.status !== 'QUEUED' && !store.isTerminal(j.status)) activeSessions.add(j.session_id);
        }
      }
      for (const job of queued) {
        if (activeSessions.has(job.session_id)) continue;
        let admit = this.pool.canAdmit(job.process_instance_id);

        // 自愈：绑定的进程实例已不存在，但同一台机器有健康的新实例。
        //
        // Bridge 每次重启都会换 process_instance_id。会话会被改绑，
        // 但 job 自己的 process_instance_id 仍指向死实例 ——
        // canAdmit 永远回 PROCESS_UNKNOWN，这些 job 就【永远排队】，
        // 而机器其实是空的（线上「只有 2 个任务却在排队」正是这个）。
        //
        // 只对 QUEUED 这么做：它还没交给任何 Bridge，换绑是安全的。
        // RUNNING 的任务绝不在这里动 —— 那要走认领/对账。
        if (!admit.ok && admit.reason === 'PROCESS_UNKNOWN') {
          const live = this.pool.healthyForWorker(job.worker_id);
          if (live) {
            await store.patchJob(job.id, {
              process_instance_id: live.process_instance_id,
              rebound_at: new Date().toISOString(),
            });
            await store.appendEvent(job.id, 'job.queued', {
              status: 'QUEUED', reason: 'REBOUND_TO_NEW_PROCESS',
              note: `后端进程已重启，任务已改绑到 ${live.process_instance_id}`,
            });
            this.log.warn(`[dispatcher] ${job.id} 绑定的实例已消失，改绑到同机新实例 ${live.process_instance_id}`);
            job.process_instance_id = live.process_instance_id;
            admit = this.pool.canAdmit(job.process_instance_id);
          }
        }

        let target;
        if (!admit.ok && shared && ['PROCESS_CAPACITY', 'BRIDGE_BUSY_BACKOFF'].includes(admit.reason)) {
          target = await this.findSharedExecutor(job, sessionJobs.get(job.session_id));
        }
        if (!admit.ok && !target) continue;
        // A tick can spend time reading storage while a maintenance window starts.
        if (maintenance.isActive()) break;
        if (shared) activeSessions.add(job.session_id);
        await this.dispatch(job, target);
      }
    } finally { this.running = false; }
  }

  async findSharedExecutor(job, siblings) {
    if (!this.sharedWorkers.has(job.worker_id) || job.attempt !== 0 || job.lease || job.started_at ||
        siblings.some(other => other.id !== job.id && !store.isTerminal(other.status))) return null;
    const target = [...this.pool.processes.values()].find(p =>
      p.worker_id !== job.worker_id && this.sharedWorkers.has(p.worker_id) &&
      p.supported_modes.includes(job.mode) && p.active_sessions < p.max_sessions &&
      this.pool.canAdmit(p.process_instance_id).ok);
    if (!target) return null;

    const session = await store.getSession(job.session_id);
    if (!session || session.status !== 'ACTIVE' || session.user_id !== job.user_id || session.mode !== job.mode ||
        session.binding.status !== 'BOUND' || session.binding.worker_id !== job.worker_id ||
        session.binding.process_instance_id !== job.process_instance_id ||
        session.binding.backend_session_ref !== session.id ||
        !/^sess_[0-9a-f-]{36}$/.test(session.id)) return null;
    const ws = join(config.storage.sessionsRoot, config.storage.sessions_subdir, session.id, 'workspace');
    try {
      const dir = await stat(ws);
      if (!dir.isDirectory()) return null;
    } catch (e) {
      // An unstarted first round has no native workspace. Older layouts keep their original executor.
      return e.code === 'ENOENT' && siblings.length === 1 && !job.is_revision ? target : null;
    }
    try {
      const cc = await stat(join(ws, '.home', '.claude', 'projects', '-workspace', session.id.slice(5) + '.jsonl'));
      return cc.isFile() && cc.size > 0 ? target : null;
    } catch { return null; }
  }

  async dispatch(job, target) {
    const execution = target ?? job;
    if (!this.pool.canAdmit(execution.process_instance_id).ok) return;
    // Assignment and executor selection share the same locked job write.
    const boundWorker = job.worker_id;
    const assigned = await store.assignQueuedJob(job, execution);
    if (!assigned) return;
    job = assigned;

    const lease = await store.acquireLease(job.id, job.process_instance_id);
    if (!lease) return; // Cancellation/terminal settlement won after assignment.
    await store.appendEvent(job.id, 'job.assigned', {
      status: 'ASSIGNED',
      worker_id: job.worker_id,
      process_instance_id: job.process_instance_id,
      lease_epoch: lease.epoch,
      ...(target ? { session_worker_id: boundWorker, shared_workspace: true } : {}),
    });

    const base = this.pool.bridgeUrlFor(job.process_instance_id, job.worker_id);
    if (!base) {
      await this.failJob(job.id, 'E_NO_BRIDGE_URL', '找不到绑定进程的 Bridge 地址');
      return;
    }

    // 预留一个槽，覆盖「已派发、后端心跳还没报上来」的空窗。
    // 注意不要再去手动改 running_jobs：那个数以 Bridge 心跳为准，
    // 在这里加一下会被下一次心跳直接覆盖掉（实测会导致同一个槽重复发放）。
    this.pool.reserve(job.process_instance_id, job.id);

    try {
      const sess = await store.getSession(job.session_id);
      await bridge.startJob(base, {
        job_id: job.id,
        session_id: sess?.binding?.backend_session_ref ?? job.session_id,
        mode: job.mode,
        model_selection: job.model_selection, experimental_skills: job.experimental_skills,
        prompt: job.prompt,
        base_asset_path: job.base_asset_path,
        is_revision: job.is_revision === true,
        lease_token: lease.token,
        max_runtime_seconds: job.max_runtime_seconds,
      });
      // Bridge 已接单；RUNNING 由其首个 progress/heartbeat 推进
      this.log.log(`[dispatcher] ${job.id} 已投递到 ${job.process_instance_id}`);
    } catch (e) {
      this.pool.release(job.id);            // 没投出去，立刻归还预留
      if (e.code === 'WORKER_AT_CAPACITY' || e.status === 503) {
        // 后端满载或正在下线 → 退回队列，attempt 已记，不算失败
        this.pool.markBusy(job.process_instance_id);
        const queued = await store.requeueUnstarted(job.id, lease.token);
        if (!queued.ok) return;
        await store.appendEvent(job.id, 'job.queued', { status: 'QUEUED', reason: e.code ?? 'BRIDGE_BUSY' });
        this.log.warn(`[dispatcher] ${job.id} 后端忙，退回队列: ${e.message}`);
        return;
      }
      await this.failJob(job.id, 'E_BRIDGE_START_FAILED', e.message);
    }
  }

  async failJob(id, code, message) {
    this.pool.release(id);                  // 终态 → 预留必须归还，否则槽位泄漏
    await store.revokeLease(id);
    const t = await store.transition(id, 'FAILED', { failure: { code, message } });
    if (t.ok) await store.appendEvent(id, 'job.failed', { status: 'FAILED', failure: { code, message } });
    this.log.error(`[dispatcher] ${id} 失败: ${code} ${message}`);
  }
}
