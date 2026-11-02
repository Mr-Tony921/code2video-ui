'use client';
/**
 * 管理后台：邀请码 + 用户管理。
 *
 * 白模权限在这里改 —— 登录/注册页不出现该选项。
 * 撤权只影响后续新建会话与新提交任务；已运行任务继续执行（任务书 §4.3）。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { GalleryTab } from './GalleryTab';
import { ExamplesTab } from './ExamplesTab';
import type { InviteView, User } from '@/lib/types';

type AdminUser = User & {
  status: string; running_jobs_count: number;
  must_change_password: boolean; created_at: string; last_login_at: string | null;
};

const CHANNEL_LABEL: Record<string, string> = {
  test: '测试', external: '外发', internal: '内部', demo: '演示',
};

const INVITE_STATUS: Record<string, { label: string; cls: string }> = {
  valid: { label: '有效', cls: 'ok' },
  exhausted: { label: '已用', cls: '' },
  expired: { label: '过期', cls: 'err' },
  revoked: { label: '已撤销', cls: 'err' },
};

export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'invites' | 'users' | 'gallery' | 'examples'>('invites');
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [channels, setChannels] = useState<string[]>(['test', 'external']);
  const [defChannel, setDefChannel] = useState('test');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 新建的邀请码明文 —— 仅此一次可见 */
  const [fresh, setFresh] = useState<{ code: string; expires_at: string; hint: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [i, u, c] = await Promise.all([
        api.adminInvites(), api.adminUsers(), api.adminChannels().catch(() => null),
      ]);
      setInvites(i.invites);
      setUsers(u.users as AdminUser[]);
      if (c) { setChannels(c.channels); setDefChannel(c.default); }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /** 复制并如实反馈 —— HTTP 下 navigator.clipboard 不存在，必须走兜底 */
  async function copy(text: string, what: string) {
    const ok = await copyText(text);
    setNotice(ok ? `已复制${what}` : `复制失败，请手动选中${what}后按 Ctrl+C`);
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : '操作失败'); }
    finally { setBusy(false); }
  }

  return (
    <div className="admin-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="admin-panel">
        <div className="procpanel-head">
          <strong>管理后台</strong>
          <div className="seg" style={{ marginLeft: 10 }}>
            <button aria-pressed={tab === 'invites'} onClick={() => setTab('invites')}>邀请码</button>
            <button aria-pressed={tab === 'users'} onClick={() => setTab('users')}>用户</button>
            <button aria-pressed={tab === 'gallery'} onClick={() => setTab('gallery')}>画廊</button>
            <button aria-pressed={tab === 'examples'} onClick={() => setTab('examples')}>示例</button>
          </div>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>关闭</button>
        </div>

        <div className="admin-body">
          {error && <div className="note bad">{error}</div>}
          {notice && <div className="note info">{notice}</div>}

          {fresh && (
            <div className="card" style={{ borderLeft: '3px solid var(--green)' }}>
              <strong>邀请码已生成 —— 请立即复制，关闭后无法再查看</strong>
              <div className="mono" style={{ fontSize: 18, margin: '8px 0', letterSpacing: 1 }}>
                {fresh.code}
              </div>
              <div className="tiny">有效至 {new Date(fresh.expires_at).toLocaleString('zh-CN')}</div>
              <div className="row wrap" style={{ marginTop: 10 }}>
                <button className="btn primary" onClick={() => void copy(fresh.hint, '邀请码与有效期')}>
                  复制码与有效期
                </button>
                <button className="btn" onClick={() => void copy(fresh.code, '邀请码')}>
                  仅复制邀请码
                </button>
                <button className="btn" onClick={() => setFresh(null)}>我已保存</button>
              </div>
              <p className="tiny" style={{ marginTop: 6 }}>
                也可直接选中上面的码手动复制。
              </p>
            </div>
          )}

          {tab === 'examples' ? <ExamplesTab /> : tab === 'gallery' ? <GalleryTab /> : tab === 'invites' ? (
            <InvitesTab invites={invites} busy={busy}
              channels={channels} defaultChannel={defChannel}
              onCreate={(opts) => run(async () => {
                const r = await api.adminCreateInvite(opts);
                setFresh({ code: r.code, expires_at: r.expires_at, hint: r.hint });
              })}
              onRevoke={(id) => run(async () => { await api.adminRevokeInvite(id); })}
              onCopy={(t, w) => void copy(t, w)} />
          ) : (
            <UsersTab users={users} busy={busy} channels={channels}
              onSetChannel={(u, channel, note) => run(async () => {
                await api.adminSetChannel(u.username, { channel, note });
              })}
              onToggleBlockout={(u) => run(async () => {
                const r = await api.adminSetBlockout(u.username, !u.can_use_blockout_3d);
                setNotice(r.note);
              })}
              onToggleExperimental={(u) => run(async () => {
                const r = await api.adminSetExperimental(u.username, !u.can_use_experimental);
                setNotice(r.note);
              })}
              onToggleStatus={(u) => run(async () => {
                await api.adminSetStatus(u.username, u.status === 'active' ? 'disabled' : 'active');
              })}
              onReset={(u) => run(async () => {
                const r = await api.adminResetPassword(u.username);
                setNotice(r.hint);
              })} />
          )}
        </div>
      </div>
    </div>
  );
}

function InvitesTab({ invites, busy, channels, defaultChannel, onCreate, onRevoke, onCopy }: {
  invites: InviteView[]; busy: boolean;
  channels: string[]; defaultChannel: string;
  onCreate: (o: {
    max_uses: number; valid_days: number; grants_blockout_3d: boolean;
    note?: string; channel: string;
  }) => void;
  onRevoke: (id: string) => void;
  onCopy: (text: string, what: string) => void;
}) {
  const [maxUses, setMaxUses] = useState(1);
  const [days, setDays] = useState(7);
  const [blockout, setBlockout] = useState(false);
  const [note, setNote] = useState('');
  const [channel, setChannel] = useState(defaultChannel);

  return (
    <>
      <div className="card">
        <strong style={{ fontSize: 14 }}>生成邀请码</strong>
        <div className="row wrap" style={{ marginTop: 10, gap: 14 }}>
          <label className="tiny">使用次数
            <input className="tinput" type="number" min={1} max={100} style={{ width: 70, marginLeft: 6 }}
                   value={maxUses} onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value)))} />
          </label>
          <label className="tiny">有效天数
            <input className="tinput" type="number" min={1} max={365} style={{ width: 70, marginLeft: 6 }}
                   value={days} onChange={(e) => setDays(Math.max(1, Number(e.target.value)))} />
          </label>
          <label className="tiny">渠道
            <select className="tinput" style={{ marginLeft: 6 }}
                    value={channel} onChange={(e) => setChannel(e.target.value)}>
              {channels.map((c) => (
                <option key={c} value={c}>{CHANNEL_LABEL[c] ?? c}</option>
              ))}
            </select>
          </label>
          <label className="tiny row" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={blockout} onChange={(e) => setBlockout(e.target.checked)} />
            授予 3D Blockout 权限
          </label>
          <input className="tinput" placeholder="备注（可选）" style={{ flex: 1, minWidth: 140 }}
                 value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn primary" disabled={busy}
                  onClick={() => onCreate({
                    max_uses: maxUses, valid_days: days, grants_blockout_3d: blockout,
                    note: note || undefined, channel,
                  })}>
            生成
          </button>
        </div>
        <p className="tiny" style={{ marginTop: 8 }}>
          默认单次使用、7 天有效，注册后立即失效。历史邀请码可在下表查看与复制。
          渠道会写入注册用户，用于区分测试与外发账户的 session 轨迹。
        </p>
      </div>

      <table className="atable">
        <thead><tr>
          <th>邀请码</th><th>渠道</th><th>用量</th><th>白模</th><th>有效期至</th><th>状态</th><th>已用于</th><th>备注</th><th>操作</th>
        </tr></thead>
        <tbody>
          {invites.length === 0 && <tr><td colSpan={10} className="tiny">暂无邀请码</td></tr>}
          {invites.map((i) => {
            const st = INVITE_STATUS[i.status] ?? { label: i.status, cls: '' };
            return (
              <tr key={i.id}>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                  {i.code ?? `${i.code_prefix}…`}
                </td>
                <td className="tiny">{i.channel ? (CHANNEL_LABEL[i.channel] ?? i.channel) : '—'}</td>
                <td>{i.used_count}/{i.max_uses}</td>
                <td>{i.grants_blockout_3d ? '✓' : '—'}</td>
                <td className="tiny">{new Date(i.expires_at).toLocaleString('zh-CN')}</td>
                <td><span className={`ptag ${st.cls}`}>{st.label}</span></td>
                <td className="tiny">{i.used_by.map((x) => x.username).join(', ') || '—'}</td>
                <td className="tiny">{i.note ?? '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {i.code && (
                    <button className="linkbtn tiny" onClick={() =>
                      onCopy(
                        `邀请码：${i.code}\n有效期至：${new Date(i.expires_at).toLocaleString('zh-CN')}`,
                        '邀请码',
                      )}>复制</button>
                  )}
                  {i.status === 'valid' && (
                    <button className="linkbtn tiny" style={{ marginLeft: 8 }}
                            disabled={busy} onClick={() => onRevoke(i.id)}>撤销</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/** 备注单元格：点开编辑，失焦或回车保存。备注是给我们自己看的来源标记。 */
function NoteCell({ user, busy, onSave }: {
  user: AdminUser; busy: boolean; onSave: (note: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(user.note ?? '');
  if (!editing) {
    return (
      <button className="linkbtn tiny" disabled={busy}
              onClick={() => { setV(user.note ?? ''); setEditing(true); }}>
        {user.note ? user.note.slice(0, 20) : '＋ 备注'}
      </button>
    );
  }
  const commit = () => { setEditing(false); if (v !== (user.note ?? '')) onSave(v); };
  return (
    <input className="tinput" autoFocus style={{ fontSize: 12, width: 120, padding: '2px 4px' }}
           value={v} placeholder="来源/用途"
           onChange={(e) => setV(e.target.value)}
           onBlur={commit}
           onKeyDown={(e) => {
             if (e.key === 'Enter') commit();
             if (e.key === 'Escape') setEditing(false);
           }} />
  );
}

function UsersTab({ users, busy, channels, onSetChannel, onToggleBlockout, onToggleExperimental, onToggleStatus, onReset }: {
  users: AdminUser[]; busy: boolean; channels: string[];
  onSetChannel: (u: AdminUser, channel: string, note?: string) => void;
  onToggleBlockout: (u: AdminUser) => void;
  onToggleExperimental: (u: AdminUser) => void;
  onToggleStatus: (u: AdminUser) => void;
  onReset: (u: AdminUser) => void;
}) {
  return (
    <>
      <table className="atable">
        <thead><tr>
          <th>用户名</th><th>渠道</th><th>备注</th><th>角色</th><th>3D Blockout</th><th>实验模式</th><th>状态</th>
          <th>运行中</th><th>最近登录</th><th>操作</th>
        </tr></thead>
        <tbody>
          {users.length === 0 && <tr><td colSpan={9} className="tiny">暂无用户</td></tr>}
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.username}
                {u.must_change_password && <span className="ptag err" style={{ marginLeft: 6 }}>待改密</span>}
              </td>
              {/* 渠道可随时改：区分测试账户与外发账户 */}
              <td>
                <select className="tinput" style={{ fontSize: 12, padding: '2px 4px' }}
                        value={u.channel ?? 'test'} disabled={busy}
                        onChange={(e) => onSetChannel(u, e.target.value)}>
                  {channels.map((c) => (
                    <option key={c} value={c}>{CHANNEL_LABEL[c] ?? c}</option>
                  ))}
                </select>
              </td>
              <td><NoteCell user={u} busy={busy} onSave={(n) => onSetChannel(u, u.channel ?? 'test', n)} /></td>
              <td>{u.role === 'admin' ? <span className="badge">管理员</span> : '业务用户'}</td>
              <td>
                <label style={{ cursor: u.role === 'admin' ? 'default' : 'pointer' }}>
                  <input type="checkbox" checked={u.can_use_blockout_3d}
                         disabled={busy || u.role === 'admin'}
                         onChange={() => onToggleBlockout(u)} />
                  {u.role === 'admin' && <span className="tiny" style={{ marginLeft: 4 }}>（管理员默认有）</span>}
                </label>
              </td>
              <td><label><input type="checkbox" aria-label={`${u.username} 实验模式`}
                checked={u.can_use_experimental === true} disabled={busy}
                onChange={() => onToggleExperimental(u)} />启用</label></td>
              <td>
                <span className={`ptag ${u.status === 'active' ? 'ok' : 'err'}`}>
                  {u.status === 'active' ? '正常' : '已禁用'}
                </span>
              </td>
              <td>{u.running_jobs_count > 0 ? <strong>{u.running_jobs_count}</strong> : '—'}</td>
              <td className="tiny">
                {u.last_login_at ? new Date(u.last_login_at).toLocaleString('zh-CN') : '从未'}
              </td>
              <td>
                <button className="linkbtn tiny" disabled={busy} onClick={() => onReset(u)}>重置密码</button>
                {u.role !== 'admin' && (
                  <button className="linkbtn tiny" style={{ marginLeft: 8 }} disabled={busy}
                          onClick={() => onToggleStatus(u)}>
                    {u.status === 'active' ? '禁用' : '启用'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="tiny" style={{ marginTop: 10 }}>
        渠道与备注用于区分不同来源的账户（测试 / 外发等），会写入该用户的 session 元信息，
        便于后续按渠道导出轨迹。修改不影响已有 session。
      </p>
      <p className="tiny" style={{ marginTop: 6 }}>
        撤销 3D Blockout 权限后，该用户无法创建新的白模会话或提交新的白模任务；
        <strong>已在运行的任务会继续执行至完成</strong>，如需终止请单独操作。
        用户仍可访问自己已完成的产物。
      </p>
    </>
  );
}
