'use client';
/**
 * 管理员画廊：看全部用户跑了什么、prompt 是什么、结果如何。
 *
 * 两块：上面是用户活跃度（谁在用、成功率、平均耗时），
 * 下面是任务流水（可按用户过滤，可直接播放产物）。
 *
 * prompt 展示的是【用户原话】而非扩写后的 —— 管理员要看的是真实需求。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { withBase } from '@/lib/base-path';
import { clean } from '@/lib/sanitize';
import { formatBytes, formatDuration } from '@/lib/format';
import type { GalleryBrief, GalleryItem, GalleryUser } from '@/lib/types';

const MODE_LABEL: Record<string, string> = {
  coding_to_video: 'Coding→Video', blockout_3d: '3D Blockout', experimental: '实验模式',
};

export function GalleryTab() {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [users, setUsers] = useState<GalleryUser[]>([]);
  const [totals, setTotals] = useState({ jobs: 0, completed: 0, users: 0 });
  const [loadInfo, setLoadInfo] = useState<{
    capacity: number; used: number; queued: number; enhancing: number; utilization: number;
    running: GalleryBrief[]; queued_: GalleryBrief[]; enhancing_: GalleryBrief[];
    workers: { worker_id: string; processes: { status: string; running_jobs: number; max_concurrent_jobs: number }[] }[];
  } | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (user?: string | null) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.adminGallery({ limit: 200, user: user ?? undefined });
      setItems(r.items); setUsers(r.users); setTotals(r.totals);
      if (r.load) {
        setLoadInfo({
          capacity: r.load.capacity, used: r.load.used, queued: r.load.queued,
          enhancing: r.load.enhancing, utilization: r.load.utilization,
          running: r.load.running_list ?? [], queued_: r.load.queued_list ?? [],
          enhancing_: r.load.enhancing_list ?? [], workers: r.load.workers ?? [],
        });
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '加载失败');
    } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(filter); }, [load, filter]);

  return (
    <>
      {/* ── 实时压力：先看现在忙不忙，再看历史 ── */}
      {loadInfo && (
        <div className="card" style={{ borderLeft: `3px solid ${loadInfo.utilization >= 80 ? 'var(--amber)' : 'var(--green)'}` }}>
          <div className="row wrap" style={{ gap: 14 }}>
            <strong style={{ fontSize: 14 }}>实时运行压力</strong>
            <span className="badge">并发 {loadInfo.used}/{loadInfo.capacity}</span>
            {loadInfo.queued > 0 && <span className="badge violet">排队 {loadInfo.queued}</span>}
            {loadInfo.enhancing > 0 && <span className="badge cyan">理解需求 {loadInfo.enhancing}</span>}
            <span className={`ptag ${loadInfo.utilization >= 80 ? 'err' : loadInfo.utilization >= 50 ? '' : 'ok'}`}>
              负载 {loadInfo.utilization}%
            </span>
            <span className="spacer" />
            {loadInfo.workers.map((w) => (
              <span key={w.worker_id} className="tiny" style={{ opacity: .8 }}>
                {w.worker_id}: {w.processes.map((p) => `${p.running_jobs}/${p.max_concurrent_jobs}`).join(' ')}
                {w.processes.some((p) => p.status !== 'HEALTHY') && ' ⚠'}
              </span>
            ))}
          </div>

          {loadInfo.running.length > 0 && (
            <>
              <div className="tiny" style={{ marginTop: 10, fontWeight: 600 }}>正在执行 ({loadInfo.running.length})</div>
              {loadInfo.running.map((j) => (
                <div key={j.id} className="row wrap tiny" style={{ gap: 8, marginTop: 4 }}>
                  <span style={{ color: 'var(--green)' }}>⟳</span>
                  <span style={{ minWidth: 70 }}>{j.user_id}</span>
                  <span className="badge">{MODE_LABEL[j.mode] ?? j.mode}</span>
                  <span style={{ opacity: .8 }}>{j.phase ?? j.status}</span>
                  {j.running_ms != null && <span style={{ opacity: .7 }}>{formatDuration(j.running_ms)}</span>}
                  <span style={{ opacity: .65, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {clean(j.prompt)}
                  </span>
                </div>
              ))}
            </>
          )}

          {loadInfo.queued_.length > 0 && (
            <>
              <div className="tiny" style={{ marginTop: 10, fontWeight: 600 }}>排队等待 ({loadInfo.queued_.length})</div>
              {loadInfo.queued_.map((j) => (
                <div key={j.id} className="row wrap tiny" style={{ gap: 8, marginTop: 4 }}>
                  <span style={{ color: 'var(--blue)' }}>#{j.queue_position ?? '?'}</span>
                  <span style={{ minWidth: 70 }}>{j.user_id}</span>
                  <span className="badge">{MODE_LABEL[j.mode] ?? j.mode}</span>
                  {j.queued_ms != null && <span style={{ opacity: .7 }}>已等 {formatDuration(j.queued_ms)}</span>}
                  <span style={{ opacity: .65, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {clean(j.prompt)}
                  </span>
                </div>
              ))}
            </>
          )}

          {loadInfo.running.length === 0 && loadInfo.queued_.length === 0 && loadInfo.enhancing === 0 && (
            <div className="tiny" style={{ marginTop: 8, opacity: .7 }}>当前无任务在跑，算力空闲。</div>
          )}
        </div>
      )}

      <div className="card">
        <div className="row wrap" style={{ gap: 14 }}>
          <strong style={{ fontSize: 14 }}>用户活跃度</strong>
          <span className="tiny">
            共 {totals.users} 个用户 · {totals.jobs} 个任务 · 成功 {totals.completed}
            {totals.jobs > 0 && `（${Math.round((totals.completed / totals.jobs) * 100)}%）`}
          </span>
          <span className="spacer" />
          {filter && (
            <button className="linkbtn tiny" onClick={() => setFilter(null)}>
              ← 返回全部用户
            </button>
          )}
          <button className="btn" disabled={busy} onClick={() => void load(filter)}>刷新</button>
        </div>
      </div>

      {err && <div className="note bad">{err}</div>}

      <table className="atable">
        <thead><tr>
          <th>用户</th><th>任务数</th><th>成功</th><th>失败</th><th>放弃</th>
          <th>成功率</th><th>平均耗时</th><th>模式</th><th>最近活动</th><th></th>
        </tr></thead>
        <tbody>
          {users.length === 0 && <tr><td colSpan={10} className="tiny">暂无数据</td></tr>}
          {users.map((u) => (
            <tr key={u.user_id} style={filter === u.user_id ? { background: '#eff6ff' } : undefined}>
              <td><strong>{u.user_id}</strong></td>
              <td>{u.total}</td>
              <td style={{ color: 'var(--green)' }}>{u.completed}</td>
              <td>{u.failed || '—'}</td>
              <td>{u.cancelled || '—'}</td>
              <td>
                <span className={`ptag ${u.success_rate >= 60 ? 'ok' : u.success_rate >= 30 ? '' : 'err'}`}>
                  {u.success_rate}%
                </span>
              </td>
              <td className="tiny">{u.avg_duration_ms ? formatDuration(u.avg_duration_ms) : '—'}</td>
              <td className="tiny">
                {Object.entries(u.modes).map(([m, n]) => `${MODE_LABEL[m] ?? m}×${n}`).join(' ')}
              </td>
              <td className="tiny">{u.last_at ? new Date(u.last_at).toLocaleString('zh-CN') : '—'}</td>
              <td>
                <button className="linkbtn tiny" onClick={() => setFilter(u.user_id)}>只看他</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="card" style={{ marginTop: 12 }}>
        <strong style={{ fontSize: 14 }}>
          任务流水 {filter ? `（${filter}）` : ''}
          <span className="tiny" style={{ marginLeft: 8, opacity: .7 }}>最近 {items.length} 条</span>
        </strong>
      </div>

      <div className="gallery-grid">
        {items.map((it) => (
          <div key={it.id} className="card compact">
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="badge">{MODE_LABEL[it.mode] ?? it.mode}</span>
              <span className={`ptag ${it.success ? 'ok' : it.status === 'FAILED' ? 'err' : ''}`}>
                {it.success ? '出片' : it.status === 'FAILED' ? '失败' : it.status}
              </span>
              <span className="spacer" />
              <span className="tiny" style={{ opacity: .7 }}>{it.user_id}</span>
            </div>

            {it.playback_url ? (
              <video controls preload="none" style={{ marginTop: 6, maxHeight: 150 }}
                     src={withBase(it.playback_url)} />
            ) : (
              <div className="tiny" style={{ marginTop: 6, opacity: .6 }}>
                无产物{it.failure_code ? ` · ${clean(it.failure_code)}` : ''}
              </div>
            )}

            <div className="tiny" style={{ marginTop: 6, lineHeight: 1.55, maxHeight: 76, overflow: 'hidden' }}>
              {clean(it.prompt) || '—'}
            </div>

            <div className="tiny" style={{ marginTop: 5, opacity: .7 }}>
              {new Date(it.created_at).toLocaleString('zh-CN')}
              {it.duration_ms ? ` · ${formatDuration(it.duration_ms)}` : ''}
              {it.size_bytes ? ` · ${formatBytes(it.size_bytes)}` : ''}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
