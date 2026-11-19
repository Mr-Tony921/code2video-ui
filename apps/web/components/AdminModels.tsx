'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ModelConnectionForm } from './ModelConnectionForm';
import type { ModelConnectionView } from '@/lib/types';

export function AdminModels() {
  const [models, setModels] = useState<Record<'c2v' | 'enhancement', ModelConnectionView> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.adminModels().then(r => setModels(r.models)).catch(e => setError(e.message)); }, []);
  if (error) return <p className="note bad">{error}</p>;
  if (!models) return <p className="muted">正在读取模型配置…</p>;
  return <div>
    <p className="muted">配置对新对话生效，已有对话继续使用原推理模型。增强模型用于之后发起的增强请求。Key 仅保存于服务端。</p>
    {(['c2v', 'enhancement'] as const).map(purpose => <section className="card" key={purpose} style={{ marginBottom: 16 }}>
      <h3>{purpose === 'c2v' ? 'C2V 推理模型' : 'Prompt 增强模型'}</h3>
      <ModelConnectionForm initial={models[purpose]} onSave={input => api.adminSaveModel(purpose, input)}
        onCheck={input => api.adminCheckModel(purpose, input)} onSaved={model => setModels(old => old && ({ ...old, [purpose]: model }))} />
    </section>)}
  </div>;
}
