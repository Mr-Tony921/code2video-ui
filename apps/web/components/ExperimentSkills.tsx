'use client';
import { useEffect, useRef, useState } from 'react';
import type { ExperimentalSkillsInput } from '@/lib/types';

export function ExperimentSkills({ value, onChange, disabled, canBlockout, archiveName }: {
  value: ExperimentalSkillsInput; onChange: (value: ExperimentalSkillsInput) => void;
  disabled: boolean; canBlockout: boolean; archiveName?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (open && el && !el.open) el.showModal();
    if (!open && el?.open) el.close();
  }, [open]);
  return <>
    <button type="button" className="btn tiny" aria-label="实验 skill 设置"
            aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      实验 skill 设置 · {value.builtin === 'none' ? '无内置 skill' : value.builtin}
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
