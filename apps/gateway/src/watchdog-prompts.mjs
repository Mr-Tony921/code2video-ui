/**
 * 前端自发的后端监控话术（V2 需求 7）。
 *
 * 不是用户发的 —— 是系统在特定条件下自动追问后端，显示在过程框并标为「系统」。
 * 触发条件与文案来自 config.backend.json 的 watchdog_prompts。
 *
 * 注意：生产期禁止 steering（V2 需求 3），所以这些话术【不会】注入 claude 的会话，
 * 而是记录为系统事件推给前端过程框 —— 它们是给用户与排障看的诊断信息。
 * 真要让 agent 改变行为，需要后端支持 steering 通道（当前明确关闭）。
 */
import * as store from './store/job-store.mjs';
import { config } from './config.mjs';

export class WatchdogPrompts {
  constructor({ pool, log = console }) {
    this.pool = pool;
    this.log = log;
    this.fired = new Map();     // `${jobId}:${trigger}` → 已触发时间
    this.timer = null;
  }

  cfg() { return config.raw.watchdog_prompts ?? { enabled: false, prompts: [] }; }

  start(intervalMs = 30_000) {
    this.stop();
    this.timer = setInterval(() => this.sweep().catch((e) =>
      this.log.warn(`[wdprompt] ${e.message}`)), intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async sweep() {
    const c = this.cfg();
    if (!c.enabled) return;
    const jobs = await store.listJobs({ statuses: ['ASSIGNED', 'RUNNING'] });
    for (const j of jobs) {
      for (const p of c.prompts ?? []) {
        if (await this.shouldFire(j, p)) await this.fire(j, p);
      }
    }
  }

  async shouldFire(job, p) {
    const key = `${job.id}:${p.trigger}`;
    if (this.fired.has(key)) {
      // 同一触发条件不重复刷屏；no_events 允许每 10 分钟再提醒一次
      const again = p.trigger === 'no_events_seconds' ? 600_000 : Infinity;
      if (Date.now() - this.fired.get(key) < again) return false;
    }
    const now = Date.now();
    switch (p.trigger) {
      case 'no_events_seconds': {
        const base = job.last_progress_at ?? job.started_at ?? job.created_at;
        return now - new Date(base).getTime() > (p.threshold_seconds ?? 300) * 1000;
      }
      case 'approaching_max_runtime': {
        if (!job.started_at) return false;
        const ran = (now - new Date(job.started_at).getTime()) / 1000;
        const limit = p.threshold_seconds ?? (job.max_runtime_seconds - 3600);
        return ran > limit;
      }
      case 'consecutive_tool_failures': {
        // Bridge 在 stream 响应里给 tool_fail_streak；这里读最近一次拉取的值
        return (job._tool_fail_streak ?? 0) >= (p.threshold ?? 3);
      }
      case 'completed_without_artifact':
        // 由 job 失败路径直接触发（见 fireCompletedWithoutArtifact）
        return false;
      default:
        return false;
    }
  }

  async fire(job, p) {
    this.fired.set(`${job.id}:${p.trigger}`, Date.now());
    this.log.warn(`[wdprompt] job ${job.id} 触发 ${p.trigger}`);
    await store.appendEvent(job.id, 'job.watchdog_prompt', {
      trigger: p.trigger,
      text: p.text,
      role: 'system',
      note: '系统自动诊断（非用户输入）',
    });
  }

  /** Job 报完成但没找到产物时由失败路径调用 */
  async fireCompletedWithoutArtifact(jobId) {
    const p = (this.cfg().prompts ?? []).find((x) => x.trigger === 'completed_without_artifact');
    if (!p) return;
    await store.appendEvent(jobId, 'job.watchdog_prompt', {
      trigger: p.trigger, text: p.text, role: 'system',
      note: '系统自动诊断（非用户输入）',
    });
  }
}
