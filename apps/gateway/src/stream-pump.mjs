/**
 * 过程事件泵：从 Bridge 拉 claude 的 stream 事件，转成 job_events 扇出给前端。
 *
 * 为什么用拉取：claude 的事件频率可达每秒数条，Bridge 逐条 POST 会打爆 Gateway；
 * 改为 Gateway 按固定节奏增量拉取（after=已收 seq），背压天然可控。
 */
import * as store from './store/job-store.mjs';
import { bridge } from './bridge-client.mjs';

export class StreamPump {
  constructor({ pool, log = console, intervalMs = 1500 }) {
    this.pool = pool;
    this.log = log;
    this.intervalMs = intervalMs;
    this.cursors = new Map();     // jobId → 已拉到的最大 seq
    this.timer = null;
    this.busy = false;
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick().catch((e) =>
      this.log.warn(`[pump] ${e.message}`)), this.intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const jobs = await store.listJobs({ statuses: ['ASSIGNED', 'RUNNING', 'CANCEL_REQUESTED', 'CANCELLING'] });
      for (const j of jobs) await this.pumpOne(j).catch(() => {});
      // 终态 job 的游标清掉，避免无界增长
      for (const id of [...this.cursors.keys()]) {
        if (!jobs.some((j) => j.id === id)) this.cursors.delete(id);
      }
    } finally { this.busy = false; }
  }

  async pumpOne(job) {
    const base = this.pool.bridgeUrlFor(job.process_instance_id, job.worker_id);
    if (!base) return;
    const after = this.cursors.get(job.id) ?? 0;
    const sess = await store.getSession(job.session_id);
    const ref = sess?.binding?.backend_session_ref ?? job.session_id;
    const r = await bridge.jobStream(base, job.id, after, ref);
    const evs = r.events ?? [];
    if (!evs.length) return;

    for (const ev of evs) {
      // 过程事件单独一类，前端过程框消费；不混进 job.phase/job.progress
      await store.appendEvent(job.id, 'job.process', {
        process: ev,
        phase: r.phase ?? job.phase,
      });
    }
    this.cursors.set(job.id, Math.max(after, ...evs.map((e) => e.seq)));

    // cc 的最新文本回复：单独事件，前端在对话区显示（V2 需求 7）
    const texts = evs.filter((e) => e.kind === 'assistant_text');
    if (texts.length) {
      const text = texts[texts.length - 1].text;
      await store.appendEvent(job.id, 'job.assistant_text', { text });
      /**
       * ★ 同时把最后一条存到 job 记录上。
       *
       * 为什么需要：前端的「制作助手」原来只能靠订阅整条 SSE 自己攒，
       * 于是切换任务时必须从 seq=0 重放全部轨迹才能看到一句话
       * （品牌片任务 99975 行、一线万象 2335 个事件）——「从 0 开始加载慢」就是这么来的。
       * 存一份到快照里，前端零额外请求就能显示，过程框也就能默认折叠了。
       *
       * ⚠️ 这里是事件泵的热路径：
       *   · 只在文本【真的变了】才写盘，否则每轮泵都打一次盘；
       *   · 失败只告警，绝不往外抛 —— 事件泵一卡，所有在跑任务的过程框都会停。
       */
      if (text && text !== job.last_assistant_text) {
        try { await store.patchJob(job.id, { last_assistant_text: text }); }
        catch (e) { this.log?.warn?.(`[pump] 存 last_assistant_text 失败（不影响推送）: ${e.message}`); }
      }
    }
  }
}
