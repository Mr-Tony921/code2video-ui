'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ModelConnectionForm } from './ModelConnectionForm';
import type { ExperimentalModel, ModelConnectionView } from '@/lib/types';

export function ExperimentModelPicker({ models, value, onChange, userId }: {
  models: ExperimentalModel[]; value: string; onChange: (id: string) => void; userId: string;
}) {
  const [personal, setPersonal] = useState<ModelConnectionView | null>(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const custom = value === '__custom__' || value.startsWith('managed-');
  useEffect(() => {
    let active = true;
    setLoaded(false); setPersonal(null); setError('');
    api.personalModel().then(r => { if (active) { setPersonal(r.model); setLoaded(true); } })
      .catch(e => { if (active) { setError(e.message); setLoaded(true); } });
    return () => { active = false; };
  }, [userId]);
  return <div style={{ marginBottom: 12 }}>
    <label className="tiny">实验模型<select className="input" value={custom ? '__custom__' : value} onChange={e => onChange(e.target.value === '__custom__' ? personal?.profile_id ?? '__custom__' : e.target.value)}>
      {models.filter(m => !m.custom).map(m => <option key={m.profile_id} value={m.profile_id}>{m.name} · {m.model}</option>)}
      <option value="__custom__">自行填写模型</option>
    </select></label>
    {custom && <div className="card compact" style={{ marginTop: 10 }}>
      <p className="tiny">仅保存你自己的上一次配置。Tokenhub 需要 Key，内网模型无需 Key。保存后即可新建对话。</p>
      {error && <p className="note bad">{error}</p>}
      {loaded ? <ModelConnectionForm initial={personal} onSave={api.savePersonalModel} onCheck={api.checkPersonalModel}
        onDirty={() => onChange('__custom__')} onSaved={model => { setPersonal(model); onChange(model.profile_id!); }} />
        : <p className="muted">正在读取个人配置…</p>}
    </div>}
  </div>;
}
