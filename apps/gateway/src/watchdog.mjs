/**
 * Watchdog：心跳判定、停滞检测、对账、超时取消。
 *
 * 铁律（任务 7.5 / 9.1 / 9.4）：
 *  · 心跳正常但长时间无业务进度 ⇒ 只告警，【绝不取消】
 *  · 心跳缺失 ⇒ 先 probe 对账，确认后才判定；不立即判死
 *  · UNKNOWN 不得直接转 FAILED，必须经 RECOVERING 对账
 *  · 进程失联 ⇒ 不把 Job 分配到其他机器（Session 固定进程）
 */
import * as store from './store/job-store.mjs';
import * as maintenance from './maintenance.mjs';
import { bridge } from './bridge-client.mjs';
import { config } from './config.mjs';

/** 重发这么多次仍未确认 ⇒ 改去问 Bridge 的真实状态（它会读磁盘上的终态标记） */
const CANCEL_PROBE_AFTER = 2;
/** 重发上限。到顶仍无定论 ⇒ 落 FAILED(CANCEL_UNCONFIRMED)，不让它永远悬着 */
const CANCEL_MAX_RESENDS = 5;

export class Watchdog {
  constructor({ pool, log = console, onSlotFreed = null }) {
    this.pool = pool;
    this.log = log;
    /** 槽位释放后的回调（用来立刻唤醒 dispatcher 出队）。 */
    this.onSlotFreed = onSlotFreed;
    this.timer = null;
    this.probeBackoff = new Map();   // jobId → 下次 probe 时间
    /**
     * jobId → 已重发取消的次数。
     *
     * 放内存而不是写进 job 记录：这是每个 tick 都会动的计数，落盘等于
     * 给共享存储加一份无谓的写放大；而主判据（消费 Bridge 回复）在
     * **第一次重发**就能落终态，计数只是兜底。
     * Gateway 重启后计数归零，但每个 tick 仍会消费回复、仍会 probe，
     * 所以不会因此永久卡住。
     */
    this.cancelResends = new Map();
    this.cancelTimestampWarnings = new Set();
  }

  start(intervalMs = config.timing.sweepIntervalMs) {
    this.stop();
    this.timer = setInterval(() => this.sweep().catch((e) =>
      this.log.error(`[watchdog] sweep 异常: ${e.message}`)), intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async sweep() {
    // 维护期不对账：Bridge 正在逐台重启，心跳本来就是断的。
    if (maintenance.isActive()) return;
    // 启动宽限：Gateway 刚起来时进程表是空的、job 的 last_heartbeat_at 还是旧的，
    // 立刻对账会把一批健康任务刷成 UNKNOWN（前端显示「状态不明」）。
    // 等够一轮注册 + 心跳再说。
    if (process.uptime() * 1000 < 90_000) return;
    await this.sweepProcesses();
    await this.sweepJobs();
  }

  /** 进程健康：HEALTHY ⇄ SUSPECTED（可逆）→ UNAVAILABLE。 */
  async sweepProcesses() {
    const changed = this.pool.sweepHealth({
      suspectAfterMs: config.timing.suspectAfterMs,
      unavailableAfterMs: config.timing.unavailableAfterMs,
    });
    for (const st of changed) {
      this.log.warn(`[watchdog] 进程 ${st.process_instance_id} ${st.previous} → ${st.status}` +
        ` (心跳 ${Math.round(st.heartbeat_age_ms / 1000)}s 前)`);
      if (st.status === 'UNAVAILABLE') {
        // Session 转 DEGRADED，但【不迁移】；其 Job 转 UNKNOWN 走对账
        const sessions = await store.degradeSessionsOnProcess(
          st.process_instance_id, `后端进程 ${st.process_instance_id} 已失联`);
        this.log.warn(`[watchdog] ${sessions.length} 个会话转 DEGRADED（不迁移，需新建会话）`);
        for (const j of await store.listJobs({ statuses: ['ASSIGNED', 'RUNNING'] })) {
          if (j.process_instance_id !== st.process_instance_id) continue;
          const t = await store.transition(j.id, 'UNKNOWN');
          if (t.ok) await store.appendEvent(j.id, 'job.state_unknown', {
            status: 'UNKNOWN', reason: 'PROCESS_UNAVAILABLE',
          });
        }
      }
    }
  }

  async sweepJobs() {
    const now = Date.now();
    const jobs = await store.listJobs({
      statuses: ['ASSIGNED', 'RUNNING', 'UNKNOWN', 'RECOVERING', 'CANCEL_REQUESTED', 'CANCELLING'],
    });
    const cancelling = new Set(jobs.filter(j => ['CANCEL_REQUESTED', 'CANCELLING'].includes(j.status)).map(j => j.id));
    for (const tracked of [this.cancelResends, this.cancelTimestampWarnings]) {
      for (const id of tracked.keys()) if (!cancelling.has(id)) tracked.delete(id);
    }
    for (const j of jobs) {
      // 1) 超最大运行时间 → 走取消流程（不是直接 FAILED）
      if (j.started_at && (j.status === 'RUNNING' || j.status === 'ASSIGNED')) {
        const ran = now - new Date(j.started_at).getTime();
        if (ran > (j.max_runtime_seconds ?? 10800) * 1000) {
          this.log.warn(`[watchdog] ${j.id} 超最大运行时间 ${Math.round(ran / 60000)}min → 请求取消`);
          const requested = await store.transition(j.id, 'CANCEL_REQUESTED', {
            cancellation: { requested_at: new Date().toISOString(), requested_by: 'system', reason: 'max_runtime' },
          });
          if (requested.ok) await store.appendEvent(j.id, 'job.cancel_requested', { status: 'CANCEL_REQUESTED', reason: 'max_runtime' });
          continue;
        }
      }

      // 2) 停滞检测：心跳正常但无进度 → 仅告警，绝不取消
      if (j.status === 'RUNNING' && j.last_heartbeat_at) {
        const hbAge = now - new Date(j.last_heartbeat_at).getTime();
        const progAge = now - new Date(j.last_progress_at ?? j.started_at ?? j.created_at).getTime();
        const hbFresh = hbAge < config.timing.leaseTtlMs;
        if (hbFresh && progAge > config.timing.stallWarnMs && !j._stall_warned) {
          await store.patchJob(j.id, { _stall_warned: true });
          await store.appendEvent(j.id, 'job.heartbeat_status', {
            health: {
              worker_status: 'HEALTHY', job_heartbeat_age_ms: hbAge,
              progress_age_ms: progAge, stalled: true, assessment: 'HEALTHY_STALLED',
            },
          });
          this.log.warn(`[watchdog] ${j.id} 停滞 ${Math.round(progAge / 60000)}min 但心跳正常 —— 不取消`);
        }
        // 3) Job 心跳超时 → probe 对账，不直接判死
        if (!hbFresh) {
          await this.reconcile(j, 'JOB_HEARTBEAT_LOST');
          continue;
        }
      }

      // 4) UNKNOWN / RECOVERING → 退避 probe 对账
      if (j.status === 'UNKNOWN' || j.status === 'RECOVERING') {
        await this.reconcile(j, 'STATE_UNKNOWN');
      }

      // 5) 取消宽限超时
      if (j.status === 'CANCELLING' || j.status === 'CANCEL_REQUESTED') {
        // State itself proves cancellation intent. A missing/invalid timestamp must
        // not disable every retry/probe/final-settlement safeguard.
        const requestedAt = Date.parse(j.cancellation?.requested_at);
        const age = Number.isFinite(requestedAt) ? now - requestedAt : Infinity;
        if (!Number.isFinite(requestedAt) && !this.cancelTimestampWarnings.has(j.id)) {
          this.cancelTimestampWarnings.add(j.id);
          this.log.warn(`[watchdog] ${j.id} ${j.status} cancellation.requested_at 缺失或无效，按超过宽限处理`);
        }
        if (age > config.timing.cancelGraceMs) {
          const st = this.pool.processes.get(j.process_instance_id);
          if (st?.status === 'HEALTHY') {
            /**
             * ★ 必须【消费 Bridge 的回复】。
             *
             * 原来这里是 `await bridge.cancelJob(...).catch(() => {})` ——
             * 连返回值都不接。而唯一能落终态的 else 分支要求「进程失联」，
             * Bridge 健康时永远走不到，于是 CANCELLING 永久卡住、
             * watchdog 每个 tick 重发一次、无限循环。
             * 线上实测：208 个 job 里 2 个中招（≈4%），其中一个真实用户的
             * 任务卡了 24 小时以上；界面一直显示「正在停止」。
             * （不占并发槽，所以能悄悄卡这么久没人发现。）
             *
             * Bridge 其实每次都给了明确答案（job-runner.cancelJob）：
             *   · `already_gone: true` —— 它内存里已经没有这个 job 了
             *   · `stopped: true`     —— 本次调用真把它停了
             * 两者都意味着计算已终止，都要 settle。
             * **不能只判 already_gone**：正常路径第一次 cancel 返回的是
             * stopped 而没有 already_gone。
             */
            const n = (this.cancelResends.get(j.id) ?? 0) + 1;
            this.cancelResends.set(j.id, n);
            const base = this.pool.bridgeUrlFor(j.process_instance_id, j.worker_id);
            this.log.warn(`[watchdog] ${j.id} 取消宽限超时，重发取消（第 ${n} 次）`);
            const r = base
              ? await bridge.cancelJob(base, j.id, { reason: j.cancellation?.reason ?? 'user' })
                  .catch(() => null)
              : null;

            if (r?.already_gone || r?.stopped) {
              await this.settleCancelled(j,
                r.already_gone ? 'Bridge 内存中已无此任务' : 'Bridge 确认已停止');
              continue;
            }

            /**
             * 兜底一：回复丢了（网络抖动 / Bridge 正在重启）就去问真实状态。
             * probeJob 在任务不在内存时会读共享存储的终态标记
             * （.cancelled / .done / .failed），这是现成的路。
             * ★ 必须带 session_id —— Bridge 要靠它定位簿记目录。
             */
            if (n >= CANCEL_PROBE_AFTER && base && await this.settleCancelByProbe(j, base)) {
              continue;
            }

            /**
             * 兜底二：重发到上限仍无定论 ⇒ 给用户一个明确的失败。
             * 宁可说「无法确认」，也不要让它永远悬着、日志永远刷。
             */
            if (n >= CANCEL_MAX_RESENDS) {
              this.log.error(`[watchdog] ${j.id} 重发取消 ${n} 次仍无法确认 → 判 CANCEL_UNCONFIRMED`);
              const tf = await store.transition(j.id, 'FAILED', {
                failure: {
                  code: 'CANCEL_UNCONFIRMED',
                  message: '已请求停止，但多次重试后仍无法确认计算是否终止，请新建对话',
                },
              });
              if (tf.ok) {
                await store.releaseLease(j.id);
                this.releaseSlot(j);
                await store.appendEvent(j.id, 'job.failed', {
                  status: 'FAILED', failure: { code: 'CANCEL_UNCONFIRMED' },
                });
              }
              this.cancelResends.delete(j.id);
            }
          } else {
            // An unavailable instance may still have a definitive on-disk result.
            const base = this.pool.bridgeUrlFor(j.process_instance_id, j.worker_id);
            if (base && await this.settleCancelByProbe(j, base)) continue;
            // 进程失联 + 取消未确认 ⇒ 不谎称取消成功
            const tc = await store.transition(j.id, 'FAILED', {
              failure: { code: 'CANCEL_UNCONFIRMED', message: '已请求停止，但后端进程失联，无法确认计算是否终止' },
            });
            if (tc.ok) {
              await store.releaseLease(j.id);
              this.releaseSlot(j);
              await store.appendEvent(j.id, 'job.failed', {
                status: 'FAILED', failure: { code: 'CANCEL_UNCONFIRMED' },
              });
            }
            this.cancelResends.delete(j.id);
          }
        }
      }
    }
  }

  /**
   * 把一个 CANCELLING 的 job 落成 CANCELLED。
   *
   * 与 reconcile 里 `truth.status === 'cancelled'` 那段同一套写法：
   * 迁移 → 放租约 → 还并发槽 → 发事件。顺序不能换：
   * 迁移失败（比如已经被别的路径落了终态）就不该再放租约与槽，
   * 否则并发账目会被扣两次。
   */
  async settleCancelled(job, why) {
    const t = await store.transition(job.id, 'CANCELLED', {
      cancellation: { acked_at: new Date().toISOString(), effective: true },
    });
    if (t.ok) {
      await store.releaseLease(job.id);
      this.releaseSlot(job);
      await store.appendEvent(job.id, 'job.cancelled', { status: 'CANCELLED' });
      this.log.log(`[watchdog] ${job.id} 取消已确认（${why}）→ CANCELLED`);
    }
    this.cancelResends.delete(job.id);
    return t.ok;
  }

  /**
   * 回复丢了时的兜底：问 Bridge 的真实状态并据此落终态。
   *
   * 返回 true 表示已经定论（调用方可以 continue），false 表示仍无定论。
   * 任何异常都返回 false —— 对账失败只是这一轮没结论，绝不能把
   * sweep 整个带崩（它还要照看别的任务）。
   */
  async settleCancelByProbe(job, base) {
    let truth = null;
    try {
      const sess = await store.getSession(job.session_id);
      truth = await bridge.probeJob(base, job.id,
        sess?.binding?.backend_session_ref ?? job.session_id);
    } catch (e) {
      this.log.warn(`[watchdog] ${job.id} 取消对账 probe 失败: ${e.message}`);
      return false;
    }
    if (truth?.status === 'cancelled') {
      return this.settleCancelled(job, '磁盘上有 .cancelled 标记');
    }
    /**
     * 取消来晚了：它其实已经做完。按完成处理 ——
     * 用户点了停止但成片已经出来了，丢掉产物才是真的损失。
     */
    if (truth?.status === 'completed' && truth.asset?.storage_path) {
      const t = await store.transition(job.id, 'COMPLETED', { result_asset: truth.asset });
      if (t.ok) {
        await store.releaseLease(job.id);
        this.releaseSlot(job);
        await store.appendEvent(job.id, 'job.completed', { status: 'COMPLETED', asset: truth.asset });
        this.log.log(`[watchdog] ${job.id} 取消前已完成，补判 COMPLETED（产物保留）`);
      }
      this.cancelResends.delete(job.id);
      return t.ok;
    }
    if (truth?.status === 'failed') {
      const t = await store.transition(job.id, 'FAILED', {
        failure: truth.failure ?? { code: 'E_BACKEND_FAILED' },
      });
      if (t.ok) {
        await store.releaseLease(job.id);
        this.releaseSlot(job);
        await store.appendEvent(job.id, 'job.failed', { status: 'FAILED', failure: truth.failure });
      }
      this.cancelResends.delete(job.id);
      return t.ok;
    }
    return false;                       // running / not_found：留给下一轮
  }

  /** 对账：向 Bridge 查 Job 真实状态，据此定论。绝不盲目重跑。 */
  async reconcile(job, reason) {
    const next = this.probeBackoff.get(job.id) ?? 0;
    if (Date.now() < next) return;

    if (job.status !== 'RECOVERING' && job.status !== 'UNKNOWN') {
      const t = await store.transition(job.id, 'UNKNOWN');
      if (!t.ok) return;
      await store.appendEvent(job.id, 'job.state_unknown', { status: 'UNKNOWN', reason });
    }

    const base = this.pool.bridgeUrlFor(job.process_instance_id, job.worker_id);
    if (!base) {
      // 进程实例已不存在（Bridge 重启/换机器）。无限 bump 会让 job 永远卡在
      // UNKNOWN，既占并发槽、又让用户看到"进行中"却永不结束。
      // 没有执行者就不可能再有结果：等足够久后判死。
      const ref = job.last_heartbeat_at ?? job.started_at ?? job.created_at;
      const age = Date.now() - new Date(ref).getTime();
      if (age > config.timing.unknownMaxMs) {
        // UNKNOWN → FAILED 被 FORBIDDEN 规则挡住（必须经 RECOVERING 对账，
        // 防止"状态不明"被草率判死）。这里确实已完成对账：进程实例不存在
        // ⇒ 不可能再有执行者。所以先合法地过一次 RECOVERING，再判死。
        const recovering = await store.transition(job.id, 'RECOVERING');
        if (!recovering.ok) return;
        await store.appendEvent(job.id, 'job.recovering', {
          status: 'RECOVERING', probe: 'process_gone',
        });
        const t = await store.transition(job.id, 'FAILED', {
          failure: {
            code: 'ORPHAN_NO_EXECUTOR',
            message: '执行该任务的后端进程已不存在（可能已重启或下线），任务无法继续，请重新提交',
          },
        });
        if (t.ok) {
          await store.releaseLease(job.id);
          this.releaseSlot(job);
          await store.appendEvent(job.id, 'job.failed', {
            status: 'FAILED', failure: { code: 'ORPHAN_NO_EXECUTOR' },
          });
          this.log.warn(`[watchdog] ${job.id} 的进程实例已消失且超过 ${Math.round(age / 60000)}min → 判 FAILED 并释放槽`);
        }
        return;
      }
      this.bump(job.id);
      return;
    }

    let truth;
    try {
      const sess = await store.getSession(job.session_id);
      truth = await bridge.probeJob(base, job.id, sess?.binding?.backend_session_ref ?? job.session_id);
    } catch (e) {
      this.log.warn(`[watchdog] ${job.id} probe 失败: ${e.message}`);
      this.bump(job.id);
      // 超过 unknown 上限仍无定论 → FAILED（经 RECOVERING，满足 I-7）
      const age = Date.now() - new Date(job.last_heartbeat_at ?? job.created_at).getTime();
      if (age > config.timing.unknownMaxMs) {
        const recovering = await store.transition(job.id, 'RECOVERING');
        if (!recovering.ok) return;
        const t = await store.transition(job.id, 'FAILED', {
          failure: { code: 'STATE_UNRESOLVED', message: '长时间无法确认后端任务状态' },
        });
        if (t.ok) {
          await store.releaseLease(job.id);
          this.releaseSlot(job);
          await store.appendEvent(job.id, 'job.failed', {
            status: 'FAILED', failure: { code: 'STATE_UNRESOLVED' },
          });
        }
      }
      return;
    }

    this.probeBackoff.delete(job.id);
    const recovering = await store.transition(job.id, 'RECOVERING');
    if (!recovering.ok) return;
    await store.appendEvent(job.id, 'job.recovering', { status: 'RECOVERING', probe: truth.status });

    if (truth.status === 'running') {
      const t = await store.transition(job.id, 'RUNNING', { last_heartbeat_at: new Date().toISOString() });
      if (t.ok) this.log.log(`[watchdog] ${job.id} 对账确认仍在运行，恢复 RUNNING`);
    } else if (truth.status === 'completed' && truth.asset?.storage_path) {
      // 弥补「产物已写但完成事件丢失」
      const t = await store.transition(job.id, 'COMPLETED', { result_asset: truth.asset });
      if (t.ok) {
        await store.releaseLease(job.id);
        this.releaseSlot(job);
        await store.appendEvent(job.id, 'job.completed', { status: 'COMPLETED', asset: truth.asset });
        this.log.log(`[watchdog] ${job.id} 对账发现已完成，补判 COMPLETED`);
      }
    } else if (truth.status === 'cancelled') {
      const t = await store.transition(job.id, 'CANCELLED', {
        cancellation: { acked_at: new Date().toISOString(), effective: true },
      });
      if (t.ok) {
        await store.releaseLease(job.id);
        this.releaseSlot(job);
        await store.appendEvent(job.id, 'job.cancelled', { status: 'CANCELLED' });
      }
    } else if (truth.status === 'failed') {
      const t = await store.transition(job.id, 'FAILED', { failure: truth.failure ?? { code: 'E_BACKEND_FAILED' } });
      if (t.ok) {
        await store.releaseLease(job.id);
        this.releaseSlot(job);
        await store.appendEvent(job.id, 'job.failed', { status: 'FAILED', failure: truth.failure });
      }
    } else {
      // not_found：后端不认识 → 孤儿 Job
      const t = await store.transition(job.id, 'FAILED', {
        failure: { code: 'ORPHAN_NO_EXECUTOR', message: '后端查无此任务' },
      });
      if (t.ok) {
        await store.releaseLease(job.id);
        this.releaseSlot(job);
        await store.appendEvent(job.id, 'job.failed', {
          status: 'FAILED', failure: { code: 'ORPHAN_NO_EXECUTOR' },
        });
      }
    }
  }

  /**
   * Watchdog 自己把 job 判成终态时，也要把并发槽还回去。
   * 正常路径（complete/fail/cancel-ack）由 Bridge 回调释放；
   * 但 watchdog 介入的场景恰恰是 Bridge 不会再回调的那些 ——
   * 不在这里减，槽就永久泄漏，队列会越堵越死。
   */
  releaseSlot(job) {
    this.pool.release(job.id);              // 派发预留（若还在）一并归还
    const p = this.pool.processes.get(job.process_instance_id);
    if (p) p.running_jobs = Math.max(0, p.running_jobs - 1);
    // ★ 槽位腾出来就立刻出队。watchdog 有 7 个释放点（对账判死、取消超时、
    // 孤儿清理…），在这一处收口最不容易漏；漏了就是排队任务白等一个 tick。
    try { this.onSlotFreed?.(); } catch { /* 唤醒失败不影响释放本身 */ }
  }

  bump(jobId) {
    const prev = this.probeBackoff.get(jobId) ?? Date.now();
    const step = Math.min((prev - Date.now()) * 2 || 10_000, 300_000);
    this.probeBackoff.set(jobId, Date.now() + step);
  }
}
