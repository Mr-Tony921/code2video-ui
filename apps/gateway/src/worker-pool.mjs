/**
 * Worker 池与调度：全局/单机双层并发 + Session 固定进程 + 亲和性队列。
 *
 * 对应设计要求：
 *  · 全局 8 / 单机 4（用户指定），两种 mode 共享，不可通过切 mode 突破
 *  · Session 绑定进程后永不迁移（STATE_MACHINE §2.2）
 *  · Worker 心跳缺失 → SUSPECTED（可逆）→ 对账 → UNAVAILABLE，不立即判死
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class WorkerPool {
  constructor({ repoRoot, now = () => Date.now(), log = console }) {
    this.log = log;
    const cfg = JSON.parse(readFileSync(join(repoRoot, 'config/backend.json'), 'utf8'));
    this.globalMax = cfg.concurrency.global_max_concurrent_jobs;
    this.perMachineMax = cfg.concurrency.per_machine_max_concurrent_jobs;
    this.now = now;
    /** process_instance_id → 进程状态 */
    this.processes = new Map();
    /**
     * 派发预留：job_id → {process_instance_id, at}。
     *
     * 为什么需要：并发计数以 Bridge 心跳为唯一真相，但心跳 12 秒一次，
     * 而 cc 启动有延迟 —— 「已派发、后端还没报上来」这段空窗里，
     * 心跳里看不到这个 job，槽位就会被重复发放（实测可超配）。
     * 预留只在这段空窗内生效：心跳一报出该 job，或超过 TTL，立即作废。
     * 绝不在这里加减 running_jobs —— 那正是原来被心跳覆盖掉的老毛病。
     */
    this.reservations = new Map();
    this.reservationTtlMs = 90_000;
    /** 配置里声明的机器（引导用；真实状态以注册与心跳为准） */
    this.declared = cfg.workers.filter((w) => w.enabled !== false);
  }

  /** Bridge 注册。同一 worker 重启会带来新的 process_instance_id。 */
  register(p) {
    // 同 worker 的旧实例标记为已替换——它的 Session 应转 PROCESS_LOST
    const superseded = [];
    for (const [pid, st] of this.processes) {
      if (st.worker_id === p.worker_id && pid !== p.process_instance_id) {
        st.status = 'UNAVAILABLE';
        st.superseded_at = this.now();
        superseded.push(pid);
      }
    }
    // 被替换的旧实例直接从表里删除，不要只标 UNAVAILABLE 就留着：
    // 每次 Bridge 重启都会留一条，processes 数只增不减（实测重启几次后 =4，
    // 实际只有 2 台机器），既误导运维，也让 pool 无界增长。
    // 删除是安全的：它们已不可达，globalUsed 与 pickForSession 本就跳过它们。
    for (const pid of superseded) {
      const old = this.processes.get(pid);
      if (old && (old.running_jobs ?? 0) > 0) {
        this.log?.warn?.(`[pool] 旧实例 ${pid} 仍记有 ${old.running_jobs} 个 job，已连同记录移除（watchdog 会对账）`);
      }
      this.processes.delete(pid);
    }

    const declared = this.declared.find((w) => w.worker_id === p.worker_id);
    /**
     * 单机并发上限 = 【所有已知上限的最小值】：Bridge 自报、配置里这台机器的声明、
     * 全局单机天花板。
     *
     * 为什么要把 declared 也算进来：原来只信 Bridge 自报（再用天花板夹一次），
     * 配置里的 workers[].max_concurrent_jobs 对 Gateway 等于作废 ——
     * 改配置必须重启那台 Bridge 才生效，而且 Bridge 侧的
     * CVW_MAX_CONCURRENT_JOBS 一覆盖就能悄悄抬回去。
     * 「跑 Gateway 的那台机器压到 2」这件事必须在 Gateway 侧说得上话。
     *
     * 取最小值的意义：任何一方说 2 就是 2，谁都【只能调低不能抬高】——
     * 派发入口宁可保守，超配会直接把那台机器压垮。
     */
    const caps = [p.max_concurrent_jobs, declared?.max_concurrent_jobs, this.perMachineMax]
      .filter((n) => Number.isFinite(n) && n > 0);
    this.processes.set(p.process_instance_id, {
      worker_id: p.worker_id,
      process_instance_id: p.process_instance_id,
      host: p.host ?? declared?.bridge.host,
      port: p.port ?? declared?.bridge.port,
      supported_modes: p.supported_modes ?? declared?.supported_modes ?? [],
      max_sessions: p.max_sessions ?? declared?.max_sessions ?? 8,
      max_concurrent_jobs: caps.length ? Math.min(...caps) : 1,
      status: 'HEALTHY',
      last_heartbeat_at: this.now(),
      registered_at: this.now(),
      active_sessions: 0,
      running_jobs: 0,
      running_job_ids: [],
      version: p.version,
    });
    return { superseded };
  }

  heartbeat(hb) {
    const st = this.processes.get(hb.process_instance_id);
    if (!st) return { known: false };
    st.last_heartbeat_at = this.now();
    st.active_sessions = hb.active_sessions ?? st.active_sessions;
    st.running_jobs = hb.running_jobs ?? st.running_jobs;
    // ⚠️ 只在字段真的带来时才覆盖。原来写死 `?? []`，任何不带该字段的局部心跳
    // （例如 Dispatcher 派发后的乐观更新）都会把列表清空 —— 而反向对账
    // （heartbeat 处理里的「归属校验」）正是靠它判断后端在跑哪些 job。
    if (hb.running_job_ids) st.running_job_ids = hb.running_job_ids;
    st.resources = hb.resources;
    // 心跳是并发计数的唯一真相：它一到，派发时的短期预留就该让位。
    if (hb.running_job_ids) {
      for (const jid of hb.running_job_ids) this.reservations.delete(jid);
    }
    if (hb.status === 'draining') st.status = 'DRAINING';
    else if (st.status === 'SUSPECTED_UNAVAILABLE') st.status = 'HEALTHY'; // 心跳恢复 → 可逆
    return { known: true, process: st };
  }

  /** Watchdog：按心跳新鲜度推进健康状态。不立即判死（任务 9.1）。 */
  sweepHealth({ suspectAfterMs = 36_000, unavailableAfterMs = 120_000 } = {}) {
    const changed = [];
    for (const st of this.processes.values()) {
      if (st.status === 'DRAINING' || st.status === 'OFFLINE') continue;
      const age = this.now() - st.last_heartbeat_at;
      const prev = st.status;
      if (age > unavailableAfterMs) st.status = 'UNAVAILABLE';
      else if (age > suspectAfterMs) st.status = 'SUSPECTED_UNAVAILABLE';
      if (st.status !== prev) changed.push({ ...st, previous: prev, heartbeat_age_ms: age });
    }
    return changed;
  }

  /** 派发前预留一个槽（见 reservations 的说明）。 */
  reserve(processInstanceId, jobId) {
    this.reservations.set(jobId, { process_instance_id: processInstanceId, at: this.now() });
  }

  /** 派发失败或 job 已终态 → 立刻归还预留。 */
  release(jobId) { this.reservations.delete(jobId); }

  /** 某进程上仍然有效的预留数（过期的顺手清掉）。 */
  reservedOn(processInstanceId) {
    let n = 0;
    for (const [jid, r] of this.reservations) {
      if (this.now() - r.at > this.reservationTtlMs) { this.reservations.delete(jid); continue; }
      if (r.process_instance_id === processInstanceId) n += 1;
    }
    return n;
  }

  /**
   * 全局在跑任务数。
   *
   * 只统计【还可能真的在算】的进程：UNAVAILABLE / OFFLINE 的进程上那些 job
   * 已经由 watchdog 对账去定论，它们不该继续占着全局容量 ——
   * 否则一台机器失联就会把 8 个槽锁死，另一台健康机器永远接不到活
   * （实测：161 失联后 globalUsed 仍为 8/8，175 全被挡住）。
   */
  get globalUsed() {
    let n = 0;
    for (const st of this.processes.values()) {
      if (st.status === 'UNAVAILABLE' || st.status === 'OFFLINE') continue;
      n += st.running_jobs + this.reservedOn(st.process_instance_id);
    }
    return n;
  }

  /**
   * 同一台机器当前的健康实例。
   *
   * Bridge 重启会换 process_instance_id，但活儿还在那台机器上。
   * 拿它来把绑在旧实例上的 job 改绑过去，否则这些 job 永远派不出去
   * （实测：canAdmit 回 PROCESS_UNKNOWN，dispatcher 每轮 continue）。
   */
  healthyForWorker(workerId) {
    for (const st of this.processes.values()) {
      if (st.worker_id === workerId && st.status === 'HEALTHY') return st;
    }
    return null;
  }

  /** 进程确认失联/下线时清零它的在跑计数，避免槽位泄漏。 */
  releaseSlotsOf(processInstanceId) {
    const st = this.processes.get(processInstanceId);
    if (!st) return 0;
    const freed = st.running_jobs;
    st.running_jobs = 0;
    st.running_job_ids = [];
    return freed;
  }

  /** 为新 Session 选进程。只选 HEALTHY 且支持该 mode 的。 */
  pickForSession(mode) {
    const cands = [...this.processes.values()].filter(
      (st) =>
        st.status === 'HEALTHY' &&
        st.supported_modes.includes(mode) &&
        st.active_sessions < st.max_sessions &&
        // 并发容量为 0 的机器不该拿到会话 —— 拿到也一个任务都跑不了
        st.max_concurrent_jobs > 0,
    );
    if (!cands.length) return null;
    /**
     * ★ 按【并发容量归一】的负载排序，而不是按绝对会话数。
     *
     * 原来是 `a.active_sessions - b.active_sessions || a.running_jobs - b.running_jobs`
     * —— 完全不看 max_concurrent_jobs。而「Session 固定进程」意味着会话一旦落在
     * 某台机器上就永不迁移，于是：
     *   线上 cvw-700 的 max_sessions 仍是 8（和其他四台一样），
     *   但它同机跑 Gateway，max_concurrent_jobs 从 1.4.4 起压到了 2。
     *   结果它照常分到约 1/5 的会话，却只能同时跑 2 个 ——
     *   **那台上第 3 个会话提交时就要排队，哪怕集群还有 15 个空槽。**
     * 不是正确性问题（任务只是等，不会失败），但用户感知就是「别人都在跑，我排队」。
     *
     * 归一之后，cap=2 的机器分到的会话数自然是 cap=4 的一半，
     * 排队点与各机真实吞吐对齐。tie-break 同样归一。
     */
    cands.sort(
      (a, b) =>
        a.active_sessions / a.max_concurrent_jobs - b.active_sessions / b.max_concurrent_jobs ||
        a.running_jobs / a.max_concurrent_jobs - b.running_jobs / b.max_concurrent_jobs,
    );
    return cands[0];
  }

  /**
   * 能否为某 Session 的 Job 取得并发槽。
   * Session 固定进程 ⇒ 只能用它绑定的那个进程的槽，不可换机（任务 10.2）。
   */
  canAdmit(processInstanceId) {
    const st = this.processes.get(processInstanceId);
    if (!st) return { ok: false, reason: 'PROCESS_UNKNOWN' };
    if (st.status !== 'HEALTHY') return { ok: false, reason: `PROCESS_${st.status}` };
    if (this.globalUsed >= this.globalMax)
      return { ok: false, reason: 'GLOBAL_CAPACITY', global_used: this.globalUsed, global_capacity: this.globalMax };
    const used = st.running_jobs + this.reservedOn(processInstanceId);
    if (used >= st.max_concurrent_jobs)
      return { ok: false, reason: 'PROCESS_CAPACITY', used, capacity: st.max_concurrent_jobs };
    return { ok: true };
  }

  bridgeUrlFor(processInstanceId, workerId = null) {
    const st = this.processes.get(processInstanceId);
    if (st) return `http://${st.host}:${st.port}`;
    // 实例 id 已消失（Bridge 重启 / Gateway 冷启动，进程表还空着）。
    // 退回配置里声明的地址：机器还是那台机器，活儿可能还在上面跑。
    // 不这么做的话 watchdog 的 reconcile 拿不到 base，会直接走
    // 「进程不存在 ⇒ 判死」分支，把其实活着的任务判成 ORPHAN_NO_EXECUTOR。
    if (workerId) {
      const d = this.declared.find((w) => w.worker_id === workerId);
      if (d?.bridge?.host) return `http://${d.bridge.host}:${d.bridge.port}`;
    }
    return null;
  }

  capacitySnapshot({ includeWorkers = false } = {}) {
    /**
     * ★ 「可用容量」要报各机实际上限之和，不是配置声明值。
     *
     * globalMax 是 config.concurrency.global_max_concurrent_jobs（线上 20），
     * 而单台可以在 workers[].max_concurrent_jobs 里下调（跑 Gateway 的那台压到 2），
     * 于是**声明的全局天花板可能永远到不了**：线上各机之和只有 2+4+4+4+4 = 18，
     * 管理页却显示「并发 3/20」——多报了 2 个不存在的槽。
     * （不是功能问题：每个任务除全局槽还必须过它那台机器的上限，
     *   所以 globalUsed 的上界就是 18，第 19/20 个全局槽永远发不出去。）
     *
     * 只统计 HEALTHY 的进程 ⇒ 一台失联时分母会自动变小，这是对的：
     * 那台的槽确实用不了。前端角标是「并发 {used}/{capacity}」的动态措辞，
     * 不要改成「总资源 20」这类静态说法。
     */
    const effective = [...this.processes.values()]
      .filter((st) => st.status === 'HEALTHY')
      .reduce((n, st) => n + (st.max_concurrent_jobs ?? 0), 0);
    const out = {
      global: {
        capacity: Math.min(this.globalMax, effective),
        declared_capacity: this.globalMax,   // 配置天花板，排查时要能看出两者差异
        used: this.globalUsed,
        queued: 0,
      },
      modes_share_capacity: true,
      server_time: new Date(this.now()).toISOString(),
    };
    if (includeWorkers) {
      const byWorker = new Map();
      for (const st of this.processes.values()) {
        if (!byWorker.has(st.worker_id)) byWorker.set(st.worker_id, []);
        byWorker.get(st.worker_id).push({
          process_instance_id: st.process_instance_id,
          status: st.status,
          supported_modes: st.supported_modes,
          active_sessions: st.active_sessions,
          max_sessions: st.max_sessions,
          running_jobs: st.running_jobs,
          max_concurrent_jobs: st.max_concurrent_jobs,
          last_heartbeat_age_ms: this.now() - st.last_heartbeat_at,
        });
      }
      out.workers = [...byWorker].map(([worker_id, processes]) => ({ worker_id, processes }));
    }
    return out;
  }
}
