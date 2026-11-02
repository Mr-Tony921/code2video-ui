'use client';
/**
 * 会话历史：按时间倒序，分「进行中 / 已完成 / 已放弃」。
 *
 * 用户诉求是"切过去看视频，或复制 prompt 重新开始复现制作"，
 * 所以每条都给：回看（聚焦该任务）、播放、复制 prompt、用它重新创作。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { withBase } from '@/lib/base-path';
import { clean } from '@/lib/sanitize';
import { formatDuration, STATUS_LABEL } from '@/lib/format';
import type { Job } from '@/lib/types';

type Tab = 'running' | 'completed' | 'abandoned';
const TAB_LABEL: Record<Tab, string> = {
  running: '进行中', completed: '已完成', abandoned: '已放弃',
};

export function HistoryPanel({ onClose, onPick, onReuse }: {
  onClose: () => void;
  /**
   * 选中某个历史任务。
   * ★ 传整个 Job 而不是 jobId —— 调用方需要 session_id 才能把【当前对话】
   *   一起切过去。只给 id 的话调用方得自己去几个本地数组里找，
   *   而本面板的数据来自 /api/me/history（用户的【全部】任务，含失败/取消的），
   *   那些数组里根本没有 ⇒ 找不到就只改聚焦不切会话 ⇒ 串台又回来了。
   */
  onPick: (job: Job) => void;
  onReuse: (text: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('completed');
  const [data, setData] = useState<Record<Tab, Job[]>>({ running: [], completed: [], abandoned: [] });
  const [counts, setCounts] = useState({ running: 0, completed: 0, abandoned: 0 });
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.history();
      setData({ running: r.running, completed: r.completed, abandoned: r.abandoned });
      setCounts(r.counts);
      // 默认落在有内容的那一栏，避免打开就是空白
      if (r.counts.completed === 0 && r.counts.running > 0) setTab('running');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '加载失败');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const list = data[tab];

  return (
    <div className="admin-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="admin-panel">
        <div className="procpanel-head">
          <strong>我的创作历史</strong>
          <div className="seg" style={{ marginLeft: 10 }}>
            {(['running', 'completed', 'abandoned'] as Tab[]).map((t) => (
              <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
                {TAB_LABEL[t]} {counts[t] > 0 && <span style={{ opacity: .7 }}>{counts[t]}</span>}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <button className="btn" onClick={() => void load()}>刷新</button>
          <button className="btn" onClick={onClose}>关闭</button>
        </div>

        <div className="admin-body">
          {err && <div className="note bad">{err}</div>}
          {msg && <div className="note info">{msg}</div>}
          {list.length === 0 && <p className="tiny">该分类下暂无记录。</p>}

          {list.map((j) => (
            <div key={j.id} className="card" style={{ marginBottom: 10 }}>
              <div className="row wrap" style={{ gap: 8 }}>
                <span className="badge">{j.model_selection?.name ?? (j.mode === 'experimental' ? '实验模式' : j.mode === 'blockout_3d' ? '3D Blockout' : 'Coding→Video')}</span>
                <span className="tiny">{STATUS_LABEL[j.status] ?? j.status}</span>
                <span className="tiny" style={{ opacity: .75 }}>
                  {new Date(j.created_at).toLocaleString('zh-CN')}
                </span>
                {j.elapsed?.running_ms != null && (
                  <span className="tiny" style={{ opacity: .75 }}>
                    · 耗时 {formatDuration(j.elapsed.running_ms)}
                  </span>
                )}
                <span className="spacer" />
                {j.result_asset?.playable && <span className="badge violet">有视频</span>}
              </div>

              <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6 }}>
                {clean(j.original_prompt || j.prompt_summary) || '—'}
              </div>

              {j.result_asset?.playable && (
                <video controls preload="none" style={{ marginTop: 8, maxHeight: 220 }}
                       src={withBase(j.result_asset.playback_url)} />
              )}

              {j.status === 'FAILED' && j.failure?.message && (
                <div className="tiny" style={{ marginTop: 6, color: 'var(--amber)' }}>
                  {clean(j.failure.message)}
                </div>
              )}

              <div className="row wrap" style={{ marginTop: 8, gap: 8 }}>
                <button className="linkbtn tiny" onClick={() => { onPick(j); onClose(); }}>
                  回到该任务
                </button>
                <button className="linkbtn tiny" onClick={async () => {
                  const ok = await copyText(j.original_prompt || j.prompt_summary || '');
                  setMsg(ok ? '已复制原始描述' : '复制失败，请手动选中');
                  setTimeout(() => setMsg(null), 2500);
                }}>复制描述</button>
                <button className="linkbtn tiny" onClick={() => {
                  onReuse(j.original_prompt || j.prompt_summary || '');
                  onClose();
                }}>用它重新创作</button>
                {j.result_asset?.playable && (
                  <a className="linkbtn tiny" href={withBase(j.result_asset.download_url)} download
                     title="下载原片（未降采样）；受网络策略限制速度较慢，请耐心等待">
                    ⬇ 原片</a>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
