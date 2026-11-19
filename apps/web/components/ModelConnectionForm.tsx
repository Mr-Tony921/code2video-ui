'use client';
import { useEffect, useState } from 'react';
import type { ModelConnectionInput, ModelConnectionView, ModelConnectionCheck } from '@/lib/types';

export function ModelConnectionForm({ initial, onSave, onCheck, onSaved, onDirty }: {
  initial: ModelConnectionView | null;
  onSave: (input: ModelConnectionInput) => Promise<{ model: ModelConnectionView }>;
  onCheck: (input: ModelConnectionInput) => Promise<ModelConnectionCheck>;
  onSaved: (model: ModelConnectionView) => void;
  onDirty?: () => void;
}) {
  const [form, setForm] = useState<ModelConnectionInput>({ kind: 'tokenhub', endpoint: 'https://tokenhub.sensetime.com', model: '', api_key: '' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ModelConnectionCheck | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setForm({ kind: initial?.kind ?? 'tokenhub', endpoint: initial?.endpoint ?? 'https://tokenhub.sensetime.com',
      model: initial?.model ?? '', api_key: '', reference_id: initial?.profile_id });
    setResult(null); setMessage(''); setError('');
  }, [initial]);
  function change(patch: Partial<ModelConnectionInput>) {
    setForm(f => ({ ...f, ...patch })); setResult(null); setMessage(''); setError(''); onDirty?.();
  }
  async function run(save: boolean) {
    setBusy(true); setError(''); setMessage('');
    try {
      if (save) {
        const r = await onSave(form);
        setForm(f => ({ ...f, api_key: '', reference_id: r.model.profile_id }));
        onSaved(r.model); setMessage('已保存');
      } else setResult(await onCheck(form));
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  }
  return <div>
    <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0, display: 'grid', gap: 10 }}>
      <label className="tiny">渠道类型<select className="input" value={form.kind} onChange={e => change({ kind: e.target.value as ModelConnectionInput['kind'],
        endpoint: e.target.value === 'tokenhub' ? 'https://tokenhub.sensetime.com' : '', api_key: '' })}>
        <option value="tokenhub">Tokenhub</option><option value="intranet">内网模型（无需 Key）</option>
      </select></label>
      <label className="tiny">模型地址<input className="input" value={form.endpoint} autoComplete="off"
        placeholder={form.kind === 'tokenhub' ? 'https://tokenhub.sensetime.com' : 'http://IP:端口 或内网服务名（默认 8000）'} onChange={e => change({ endpoint: e.target.value })} /></label>
      <label className="tiny">模型名称<input className="input" value={form.model} autoComplete="off" placeholder="填写渠道提供的完整模型名称" onChange={e => change({ model: e.target.value })} /></label>
      {form.kind === 'tokenhub' && <label className="tiny">API Key<input className="input" type="password" value={form.api_key ?? ''} autoComplete="new-password"
        placeholder={initial?.has_key ? `已保存 ${initial.key_mask}；留空保留同一地址的 Key` : '请输入此渠道的 Key'} onChange={e => change({ api_key: e.target.value })} />
        {initial?.has_key && <span>已保存：{initial.key_mask}</span>}
      </label>}
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn" type="button" onClick={() => void run(false)} disabled={!form.endpoint.trim() || !form.model.trim()}>检测连通性</button>
        <button className="btn primary" type="button" onClick={() => void run(true)} disabled={!form.endpoint.trim() || !form.model.trim()}>保存配置</button>
        <span role="status" aria-live="polite" style={{ color: busy ? 'var(--muted)' : result ? result.ok ? 'var(--green, #16803a)' : 'var(--red, #c53030)' : 'var(--muted)' }}>
          {busy ? '处理中…' : result ? `${result.ok ? '● 连通' : '● 不通'} · ${result.ok ? `${result.latency_ms} ms` : result.error}` : '○ 未检测'}
        </span>
      </div>
    </fieldset>
    {message && <p className="tiny" role="status">{message}</p>}
    {error && <p className="note bad" role="alert">{error}</p>}
  </div>;
}
