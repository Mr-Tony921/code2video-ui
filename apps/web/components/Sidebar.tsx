'use client';
/**
 * 左栏：新建会话 · 当前会话 · 进行中的任务 / 最近结果。
 *
 * 「进行中的任务 / 最近结果」是最小任务恢复入口（任务书 §8.5）：
 * 不做完整历史 Session 列表，但必须保证算完的产物用户拿得到。
 */
import { useState } from 'react';
import { copyText } from '@/lib/clipboard';
import { Collapsible } from './Collapsible';
import { STATUS_LABEL, formatDuration } from '@/lib/format';
import type { Job, SessionBinding, SessionInfo } from '@/lib/types';

const MODE_LABEL = { coding_to_video: 'Coding→Video', blockout_3d: '3D Blockout', experimental: '实验模式' } as const;

/** 选中态：左侧高亮条 + 描边 + 轻微底色。不改布局，避免点一下整列表跳动。 */
function selStyle(on: boolean): React.CSSProperties {
  return on
    ? {
        marginBottom: 6,
        borderColor: 'var(--blue, #4a9eff)',
        boxShadow: 'inset 3px 0 0 var(--blue, #4a9eff)',
        background: 'color-mix(in srgb, var(--blue, #4a9eff) 8%, transparent)',
      }
    : { marginBottom: 6 };
}

export function Sidebar({
  session, binding, runningJobs, recentJobs, onNewSession, onPickJob, children,
  focusedSessionId, focusedJobId,
}: {
  session: SessionInfo | null;
  binding: SessionBinding | null;
  runningJobs: Job[];
  recentJobs: Job[];
  onNewSession: () => void;
  onPickJob: (job: Job) => void;
  /**
   * 当前正在看的那个任务所属的会话 ID。
   *
   * 用户切到别的对话（已完成或进行中）时，看到的必须是【那个】对话的 ID ——
   * 报障时他把 ID 发给我们，我们才能查对的轨迹。
   * 原来这里一直显示 boot.session.id（只有新建对话才变），
   * 用户切过去看到的还是旧 ID，报上来的 ID 和他说的现象对不上。
   */
  focusedSessionId?: string | null;
  /**
   * 当前正在查看的任务 id —— 用来画选中框。
   * 用户反馈：「已完成的 session 选中的时候最好加个框标注一下，
   * 不然点完后不知道是哪个」。多轮续写时同一会话有好几条，
   * 没有选中态就只能靠猜，于是「两轮的视频好像反了」这种错觉也跟着来。
   */
  focusedJobId?: string | null;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <aside className="sidebar">
      <button className="btn primary full" onClick={onNewSession}>+ 新建对话</button>

      {session && (
        <section>
          <h3>当前对话</h3>
          <div className="card compact">
            <div className="row">
              <span className={`badge ${session.mode === 'blockout_3d' ? 'violet' : 'cyan'}`}>
                {MODE_LABEL[session.mode]}{session.model_selection && ` · ${session.model_selection.name}`}
              </span>
            </div>
            {binding && binding.status !== 'BOUND' && (
              <div className="note warn" style={{ marginTop: 8, fontSize: 12 }}>
                {binding.status === 'PROCESS_LOST'
                  ? '后端进程已失联，请新建对话。已完成产物仍可访问。'
                  : '正在确认后端状态…'}
              </div>
            )}
            {/* 完整会话 ID + 复制：报障时用户把它发给我们就能查轨迹（用户要求）。
                截断显示没有意义 —— 拿不到完整 ID 就定位不了。
                显示的是【当前在看的那个任务】所属的会话，切换对话后会跟着变。 */}
            {focusedSessionId && focusedSessionId !== session.id && (
              <div className="tiny" style={{ marginTop: 6, color: 'var(--amber)' }}>
                正在查看另一个对话
              </div>
            )}
            <div className="tiny mono" style={{ marginTop: 6, wordBreak: 'break-all', lineHeight: 1.5 }}>
              {focusedSessionId ?? session.id}
            </div>
            <button className="linkbtn tiny" style={{ marginTop: 3 }}
                    onClick={async () => {
                      const ok = await copyText(focusedSessionId ?? session.id);
                      setCopied(ok ? '已复制会话 ID' : '复制失败，请手动选中');
                      setTimeout(() => setCopied(null), 2500);
                    }}>复制会话 ID</button>
            {copied && <div className="tiny" style={{ color: 'var(--green)' }}>{copied}</div>}
          </div>
        </section>
      )}

      {runningJobs.length > 0 && (
        <Collapsible title="进行中" count={runningJobs.length} storageKey="running">
          {/* 同样可滚动：多 session 并行时这里也会长 */}
          <div style={{ maxHeight: 300, overflowY: 'auto', overscrollBehavior: 'contain',
                        paddingRight: 2 }}>
          {runningJobs.map((j) => (
            <div key={j.id} className="card compact click" style={selStyle(j.id === focusedJobId)}
                 aria-current={j.id === focusedJobId ? 'true' : undefined}
                 onClick={() => onPickJob(j)}>
              <div className="row" style={{ fontSize: 13 }}>
                <span aria-hidden>⟳</span>
                <span>{STATUS_LABEL[j.status]}</span>
                {j.elapsed.running_ms != null && (
                  <span className="muted">{formatDuration(j.elapsed.running_ms)}</span>
                )}
              </div>
              <div className="tiny" style={{ marginTop: 3, opacity: .8 }}>
                {j.prompt_summary.slice(0, 40) || '—'}
              </div>
              {j.status === 'QUEUED' && j.queue?.position != null && (
                <div className="tiny" style={{ color: 'var(--blue)' }}>
                  排队第 {j.queue.position}/{j.queue.total} 位
                </div>
              )}
              {!j.result_asset && j.health.stalled && (
                <div className="tiny" style={{ color: 'var(--amber)' }}>当前阶段暂无新进度</div>
              )}
            </div>
          ))}
          </div>
        </Collapsible>
      )}

      {recentJobs.length > 0 && (
        <Collapsible title="已完成" count={recentJobs.length} storageKey="done">
          {/* 可滚动：历史多了也能翻到早先的成片。
              原来后端只返回 10 条、这里又不滚动，跑过十几个任务后
              早先的（比如一个跑了 2 小时的品牌片）直接找不到。 */}
          <div style={{ maxHeight: 420, overflowY: 'auto', overscrollBehavior: 'contain',
                        paddingRight: 2 }}>
          {recentJobs.map((j) => (
            <div key={j.id} className="card compact click" style={selStyle(j.id === focusedJobId)}
                 aria-current={j.id === focusedJobId ? 'true' : undefined}
                 onClick={() => onPickJob(j)}>
              <div className="row" style={{ fontSize: 13 }}>
                <span aria-hidden style={{ color: 'var(--green)' }}>▶</span>
                <span className="muted">{j.prompt_summary.slice(0, 32) || '已完成'}</span>
              </div>
              {/* 完成时间：列表是【新的在上】，同一对话的多轮靠它才分得清先后。
                  不自造「第 N 轮」—— 这里只有已完成的轮次，数出来会和
                  输入框那个（按已结束轮数算）对不上，两个数字打架更糟。 */}
              {j.finished_at && (
                <div className="tiny" style={{ marginTop: 2, opacity: .6 }}>
                  {new Date(j.finished_at).toLocaleString('zh-CN', {
                    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                  })}
                  {j.id === focusedJobId && <span style={{ marginLeft: 6, color: 'var(--blue, #4a9eff)' }}>· 正在查看</span>}
                </div>
              )}
            </div>
          ))}
          </div>
        </Collapsible>
      )}

      {children}
    </aside>
  );
}
