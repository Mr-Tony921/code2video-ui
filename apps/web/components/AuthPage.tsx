'use client';
/**
 * 登录 / 邀请码注册。
 *
 * 要点：
 *  · 登录要用户名 + 密码
 *  · 注册必须持有效邀请码
 *  · **白模权限由邀请码决定，用户不能自选** —— 注册页不出现该选项
 *  · 强制改密的用户登录后先改密
 */
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';

type Tab = 'login' | 'register';

export function AuthPage({ onDone }: { onDone: () => void }) {
  const [tab, setTab] = useState<Tab>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mustChange, setMustChange] = useState(false);

  async function submit() {
    setError(null);
    if (!username.trim() || !password) { setError('请输入用户名与密码'); return; }
    if (tab === 'register') {
      if (!invite.trim()) { setError('请输入邀请码'); return; }
      if (password !== confirm) { setError('两次输入的密码不一致'); return; }
      if (password.length < 10) { setError('密码至少 10 个字符'); return; }
    }
    setBusy(true);
    try {
      const r = tab === 'login'
        ? await api.login(username.trim(), password)
        : await api.register(invite.trim(), username.trim(), password);
      if (r.user.must_change_password) { setMustChange(true); return; }
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '请求失败，请稍后重试');
    } finally { setBusy(false); }
  }

  if (mustChange) return <ChangePassword onDone={onDone} />;

  return (
    <div className="center">
      <div className="card" style={{ width: 'min(430px, 100%)' }}>
        <div className="logo" style={{ marginBottom: 6 }}>
          <span className="dot" />SenseNova Coding Video
        </div>
        <div className="row" style={{ marginBottom: 14 }}>
          <span className="pill">Beta 测试版</span>
        </div>

        <div className="seg" style={{ marginBottom: 14 }}>
          <button aria-pressed={tab === 'login'} onClick={() => { setTab('login'); setError(null); }}>
            登录
          </button>
          <button aria-pressed={tab === 'register'} onClick={() => { setTab('register'); setError(null); }}>
            邀请码注册
          </button>
        </div>

        {tab === 'register' && (
          <Field label="邀请码">
            <input className="tinput mono" placeholder="SNV-XXXX-XXXX-XXXX"
                   value={invite} disabled={busy}
                   onChange={(e) => setInvite(e.target.value.toUpperCase())} />
          </Field>
        )}

        <Field label="用户名">
          <input className="tinput" autoComplete="username" placeholder="3~64 字符"
                 value={username} disabled={busy}
                 onChange={(e) => setUsername(e.target.value)} />
        </Field>

        <Field label="密码">
          <input className="tinput" type="password"
                 autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
                 placeholder={tab === 'register' ? '至少 10 位，含字母与数字' : ''}
                 value={password} disabled={busy}
                 onChange={(e) => setPassword(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter' && tab === 'login') void submit(); }} />
        </Field>

        {tab === 'register' && (
          <Field label="确认密码">
            <input className="tinput" type="password" autoComplete="new-password"
                   value={confirm} disabled={busy}
                   onChange={(e) => setConfirm(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
          </Field>
        )}

        {error && <div className="note bad" style={{ marginTop: 10 }}>{error}</div>}

        <button className="btn primary full" style={{ marginTop: 14 }} onClick={submit} disabled={busy}>
          {busy ? '请稍候…' : tab === 'login' ? '登录' : '注册并进入'}
        </button>

        {tab === 'register' && (
          <p className="tiny" style={{ marginTop: 10 }}>
            注册需要管理员发放的邀请码。3D Blockout（白模预演）权限由邀请码决定，
            也可由管理员在用户管理中调整。
          </p>
        )}
      </div>
    </div>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setError(null);
    if (next !== confirm) { setError('两次输入的新密码不一致'); return; }
    if (next.length < 10) { setError('新密码至少 10 个字符'); return; }
    setBusy(true);
    try { await api.changePassword(cur, next); onDone(); }
    catch (e) { setError(e instanceof ApiError ? e.message : '修改失败'); }
    finally { setBusy(false); }
  }

  return (
    <div className="center">
      <div className="card" style={{ width: 'min(430px, 100%)' }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>请先修改密码</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          管理员为你重置了密码，请设置新密码后继续。
        </p>
        <Field label="当前（临时）密码">
          <input className="tinput" type="password" value={cur} disabled={busy}
                 onChange={(e) => setCur(e.target.value)} />
        </Field>
        <Field label="新密码">
          <input className="tinput" type="password" value={next} disabled={busy}
                 onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="确认新密码">
          <input className="tinput" type="password" value={confirm} disabled={busy}
                 onChange={(e) => setConfirm(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} />
        </Field>
        {error && <div className="note bad" style={{ marginTop: 10 }}>{error}</div>}
        <button className="btn primary full" style={{ marginTop: 14 }} onClick={go} disabled={busy}>
          {busy ? '提交中…' : '修改并进入'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginTop: 10 }}>
      <span className="tiny" style={{ display: 'block', marginBottom: 4 }}>{label}</span>
      {children}
    </label>
  );
}
