/**
 * Dispatcher：亲和性队列出队 → 取并发槽 → 取租约 → 调 Bridge 启动。
 *
 * 关键约束：
 *  · Session 固定进程 ⇒ Job 只能在其绑定进程上跑，不可换机（任务 10.2）
 *  · 全局 8 / 单机 4 双层并发，两种 mode 共享（任务 10.3）
 *  · 投递后立即返回，绝不等待 1~2 小时的生成（任务 7.1）
 */
import * as store from './store/job-store.mjs';
import { bridge } from './bridge-client.mjs';
import * as maintenance from './maintenance.mjs';

export class Dispatcher {
  constructor({ pool, log = console }) {
    this.pool = pool;
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
      const queued = (await store.listJobs({ statuses: ['QUEUED'] }))
        .sort((a, b) => String(a.queued_at).localeCompare(String(b.queued_at)));
      for (const job of queued) {
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

        if (!admit.ok) continue;            // 容量不足或进程不健康 → 留在队列
        await this.dispatch(job);
      }
    } finally { this.running = false; }
  }

  async dispatch(job) {
    // 原子迁移 QUEUED → ASSIGNED，失败说明已被别处处理
    const t = await store.transition(job.id, 'ASSIGNED', {
      assigned_at: new Date().toISOString(),
      attempt: (job.attempt ?? 0) + 1,
    });
    if (!t.ok) { this.log.warn(`[dispatcher] ${job.id} 迁移被拒: ${t.reason}`); return; }

    const lease = await store.acquireLease(job.id, job.process_instance_id);
    await store.appendEvent(job.id, 'job.assigned', {
      status: 'ASSIGNED',
      worker_id: job.worker_id,
      process_instance_id: job.process_instance_id,
      lease_epoch: lease.epoch,
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
        await store.transition(job.id, 'QUEUED', { assigned_at: null }, { force: true });
        await store.revokeLease(job.id);
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
