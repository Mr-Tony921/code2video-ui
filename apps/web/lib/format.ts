/**
 * 时间与状态文案。
 *
 * 铁律：耗时一律基于【服务端时间戳】计算，不用前端定时器伪造进度。
 * progress_percent 为 null 时绝不显示百分比。
 */
import type { Assessment, Job, JobStatus } from './types';

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

export function formatAge(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.floor(m / 60)} 小时前`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export const STATUS_LABEL: Record<JobStatus, string> = {
  ENHANCING: '正在理解需求',
  OUT_OF_SCOPE: '超出范围',
  QUEUED: '排队中',
  ASSIGNED: '正在启动',
  RUNNING: '正在生成',
  CANCEL_REQUESTED: '正在请求停止',
  CANCELLING: '正在停止',
  CANCELLED: '已取消',
  COMPLETED: '生成完成',
  FAILED: '生成失败',
  UNKNOWN: '正在确认状态',
  RECOVERING: '正在核对状态',
};

export const PHASE_LABEL: Record<string, string> = {
  PREPARING: '准备中',
  GENERATING: '生成中',
  RENDERING: '渲染中',
  FINALIZING: '收尾中',
};

export const STATUS_COLOR: Record<JobStatus, string> = {
  ENHANCING: 'var(--violet)',
  OUT_OF_SCOPE: 'var(--amber)',
  QUEUED: 'var(--slate)',
  ASSIGNED: 'var(--blue)',
  RUNNING: 'var(--blue)',
  CANCEL_REQUESTED: 'var(--amber)',
  CANCELLING: 'var(--amber)',
  CANCELLED: 'var(--slate)',
  COMPLETED: 'var(--green)',
  FAILED: 'var(--red)',
  UNKNOWN: 'var(--violet)',
  RECOVERING: 'var(--violet)',
};

/**
 * 健康状态文案。对应任务书 §11.10 的四种区分：
 * 正常无阶段更新 / Worker 心跳异常 / Job 心跳异常 / 对账中 / 确定失败。
 * 绝不把"停滞"说成失败。
 */
export function healthNote(job: Job): { text: string; tone: 'ok' | 'warn' | 'bad' } | null {
  const a: Assessment = job.health.assessment;
  const hb = formatAge(job.health.job_heartbeat_age_ms);
  const pg = formatAge(job.health.progress_age_ms);
  switch (a) {
    case 'HEALTHY_RUNNING':
      return job.status === 'RUNNING'
        ? { text: `后端正常执行，最后状态更新于 ${hb}`, tone: 'ok' }
        : null;
    case 'HEALTHY_STALLED':
      return {
        text: `当前阶段暂时没有新增进度。后端 Worker 心跳正常（${hb}），最后进度更新于 ${pg}。复杂场景渲染耗时较长属正常现象。`,
        tone: 'warn',
      };
    case 'HEARTBEAT_LOST':
      return { text: `正在确认后端机器状态…（最后心跳 ${hb}）`, tone: 'warn' };
    case 'STATE_UNKNOWN':
      return { text: `系统正在与后端核对任务真实状态，请稍候。任务可能仍在运行，请勿重复提交。`, tone: 'warn' };
    case 'CONFIRMED_FAILED':
      return { text: job.failure.message ?? '生成失败', tone: 'bad' };
    default:
      return null;
  }
}
