'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ModelConnectionForm } from './ModelConnectionForm';
import type { ModelConnectionView } from '@/lib/types';
export function WhiteboxAdminModel() {
  const [model,setModel]=useState<ModelConnectionView|null>(null);
  const [protocol,setProtocol]=useState<'chat'|'anthropic'>('chat');
  const [context,setContext]=useState(262144);
  const [error,setError]=useState('');
  useEffect(()=>{api.adminWhiteboxModel().then(r=>{setModel(r.model);setProtocol(r.model.protocol??'chat');setContext(r.model.max_context_tokens??262144);}).catch(e=>setError(e.message));},[]);
  return <section className="card" style={{marginBottom:16}}><h3>白模模型</h3>
    <p className="tiny">所有用户统一使用管理员配置。新对话使用新配置，已有新版白模对话保留原配置。固定 Seko skill；生成工程后另行渲染视频。</p>
    {error?<p className="note bad">{error}</p>:model?<>
      <label className="tiny">白模接口<select className="input" value={protocol} onChange={e=>setProtocol(e.target.value as 'chat'|'anthropic')}><option value="chat">OpenAI Chat Completions</option><option value="anthropic">Anthropic Messages</option></select></label>
      <label className="tiny">上下文上限（token）<input className="input" type="number" min={16384} max={2097152} value={context} onChange={e=>setContext(Number(e.target.value))}/></label>
      <ModelConnectionForm initial={model}
        onSave={input=>api.adminSaveWhiteboxModel({...input,protocol,max_context_tokens:context})}
        onCheck={input=>api.adminCheckWhiteboxModel({...input,protocol,max_context_tokens:context})}
        onSaved={m=>setModel(m)}/>
    </>:<p>正在读取白模配置…</p>}
  </section>;
}
