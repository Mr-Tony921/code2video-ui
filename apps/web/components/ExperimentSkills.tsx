'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { ExperimentalSkillsInput, ConfiguredSkill } from '@/lib/types';

export function ExperimentSkills({ value, onChange, disabled, canBlockout, archiveName }: {
  value: ExperimentalSkillsInput; onChange: (value: ExperimentalSkillsInput) => void;
  disabled: boolean; canBlockout: boolean; archiveName?: string | null;
}) {
  const [catalog, setCatalog] = useState<ConfiguredSkill[]>([]);
  const [catalogError, setCatalogError] = useState('');
  const [loading, setLoading] = useState(false);
  const selected = value.configured ?? [];
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (open && el && !el.open) el.showModal();
    if (!open && el?.open) el.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let active = true; setLoading(true); setCatalogError('');
    api.experimentalSkills().then(r => { if (active) setCatalog(r.skills); })
      .catch(e => { if (active) { setCatalog([]); setCatalogError(e.message || '无法加载配置 skill'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open]);
  return <>
    <button type="button" className="btn tiny" aria-label="实验 skill 设置"
            aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      实验 skill 设置 · {value.builtin === 'none' ? '无内置 skill' : value.builtin}{selected.length ? ` + ${selected.map(s => s.name).join(', ')}` : ''}
    </button>
    <dialog ref={dialog} className="experiment-skills-dialog" aria-label="实验 skill 设置"
            onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
    <div className="row">
      <h2 style={{ margin: 0, fontSize: 17 }}>实验 skill 设置</h2>
      <span className="spacer" />
      <button type="button" className="btn tiny" aria-label="关闭实验 skill 设置" onClick={() => setOpen(false)}>完成</button>
    </div>
    <label className="tiny" style={{ display: 'block', marginTop: 10 }}>内置 skill
      <select className="tinput" value={value.builtin} disabled={disabled}
              onChange={e => onChange({ ...value, builtin: e.target.value as ExperimentalSkillsInput['builtin'] })}>
        <option value="none">不使用任何内置 skill</option>
        <option value="coding_to_video">Coding to Video</option>
        {canBlockout && <option value="blockout_3d">3D Blockout</option>}
      </select>
    </label>
    <fieldset disabled={disabled || loading} style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
      <legend className="tiny">可选 skill（默认不启用）</legend>
      {loading && <p className="tiny">加载中…</p>}
      {catalogError && <p className="tiny" role="alert">{catalogError}</p>}
      {!loading && !catalogError && catalog.length === 0 && <p className="tiny">服务端暂无启用的可选 skill。</p>}
      {catalog.map(skill => {
        const chosen = selected.find(s => s.id === skill.id);
        const stale = chosen && (chosen.version !== skill.version || chosen.archive_sha256 !== skill.archive_sha256);
        return <div key={skill.id} style={{ marginBottom: 8 }}>
          <label className="tiny" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" aria-label={`启用 ${skill.name}`} checked={!!chosen}
              onChange={e => onChange({ ...value, configured: e.target.checked ? [...selected, skill] : selected.filter(s => s.id !== skill.id) })} />
            <span>{skill.name} · {skill.version.slice(0, 12)}</span>
          </label>
          <div className="tiny muted">{skill.description}</div>
          {stale && <div className="tiny" role="alert">原选择版本已变更，发送前需确认。
            <button type="button" className="linkbtn" onClick={() => onChange({ ...value,
              configured: selected.map(s => s.id === skill.id ? skill : s) })}>改用当前版本</button>
          </div>}
        </div>;
      })}
      {selected.filter(s => !catalog.some(p => p.id === s.id)).map(s => <div key={s.id} className="tiny">
        {s.name} · {s.version.slice(0, 12)}（不可用，发送前需移除）
        <button type="button" className="linkbtn" onClick={() => onChange({ ...value, configured: selected.filter(p => p.id !== s.id) })}>移除选择</button>
      </div>)}
      <p className="tiny muted">Anatomy 负责造型，建议与上方 Coding to Video 组合，后者负责视频时间轴与逐帧导出。自定义 ZIP 和粘贴内容可继续添加，同名 skill 会提示冲突。</p>
    </fieldset>
    <label className="tiny" style={{ display: 'block', marginTop: 10 }}>粘贴 SKILL.md（可选）
      <textarea className="input" rows={5} value={value.text ?? ''} disabled={disabled}
                placeholder="粘贴你的 skill 内容，发送任务时保存本轮版本"
                onChange={e => onChange({ ...value, text: e.target.value })} />
    </label>
    <label className="tiny" style={{ display: 'block', marginTop: 10 }}>上传 skill ZIP（可含脚本、资源；压缩包 ≤8 MiB）
      <input type="file" accept=".zip,application/zip" disabled={disabled} onChange={async e => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) { alert('skill ZIP 不能超过 8 MiB'); e.target.value = ''; return; }
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 16384)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
        onChange({ ...value, archive_base64: btoa(binary), archive_name: file.name, clear_archive: false });
      }} />
    </label>
    {(value.archive_name || (archiveName && !value.clear_archive)) && <div className="tiny" style={{ marginTop: 8 }}>
      {value.archive_name || archiveName}
      <button className="linkbtn" disabled={disabled} onClick={() => onChange({ ...value,
        archive_base64: undefined, archive_name: undefined, clear_archive: true })}>移除文件包</button>
    </div>}
    <p className="tiny" style={{ marginBottom: 0 }}>按原始 prompt 执行，只追加视频交付位置：output/final.mp4。每轮 skill 版本均保留。</p>
    </dialog>
  </>;
}
