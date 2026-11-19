'use client';
import { useEffect, useRef, useState } from 'react';
import type { ConfiguredSkill, ExperimentalSkillsInput } from '@/lib/types';

export function WhiteboxSkills({ value, onChange, disabled, archiveName, catalog }: {
  value: ExperimentalSkillsInput; onChange: (value: ExperimentalSkillsInput) => void;
  disabled: boolean; archiveName?: string | null; catalog: ConfiguredSkill[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const uploaded = value.archive_name || (!value.clear_archive && archiveName);
  const selected = uploaded ? 'upload' : value.builtin === 'blockout_3d' ? 'legacy' : value.configured?.[0]?.id ?? '';
  return <>
    <button type="button" className="btn tiny" onClick={() => dialog.current?.showModal()}>
      白模 skill · {uploaded || (selected === 'legacy' ? '原版白模' : value.configured?.[0]?.name || '请选择')}
    </button>
    <dialog ref={dialog} className="experiment-skills-dialog" aria-label="白模 skill 设置">
      <div className="row"><h2 style={{ margin: 0, fontSize: 17 }}>白模 skill</h2><span className="spacer" />
        <button className="btn tiny" onClick={() => dialog.current?.close()}>完成</button></div>
      <p className="tiny">每次只使用一套 skill。上传文件包会替换当前选择，后续修改继续使用本对话的工作区。</p>
      <label className="tiny">选择 skill
        <select className="input" value={selected} disabled={disabled} onChange={e => {
          generation.current++;
          onChange({ builtin: e.target.value === 'legacy' ? 'blockout_3d' : 'none', text: '', clear_archive: true,
            configured: catalog.filter(s => s.id === e.target.value) });
        }}>
          {uploaded && <option value="upload">上传：{uploaded}</option>}
          {catalog.map(s => <option key={s.id} value={s.id}>{s.name} · {s.version}</option>)}
          <option value="legacy">原版白模 skill</option>
        </select>
      </label>
      <label className="tiny" style={{ display: 'block', marginTop: 12 }}>上传替换 skill ZIP（一个 SKILL.md，可含脚本和资源；≤8 MiB）
        <input type="file" accept=".zip,application/zip" disabled={disabled} onChange={async e => {
          const file = e.target.files?.[0]; if (!file) return;
          const token = ++generation.current; setError('');
          if (file.size > 8 * 1024 * 1024) { setError('文件包不能超过 8 MiB'); e.target.value = ''; return; }
          try {
            const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
            for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
            if (token !== generation.current) return;
            onChange({ builtin: 'none', text: '', configured: [], archive_name: file.name, archive_base64: btoa(binary), clear_archive: false });
          } catch { setError('读取文件失败，请重新上传'); }
        }} />
      </label>
      {error && <p role="alert" className="tiny">{error}</p>}
      <p className="tiny">每轮保存 skill 版本与实际耗时。600 秒仅作为对比目标，平台不按此时限停止任务。</p>
    </dialog>
  </>;
}
