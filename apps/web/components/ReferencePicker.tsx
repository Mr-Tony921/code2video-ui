'use client';
/**
 * Reference 附件（V2 需求 1）：白模最多 100 张参考图，其他模式最多 10 个素材。
 * 页面明确提示上限与已用数量（用户要求）。
 */
import { useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { Collapsible } from './Collapsible';
import type { Mode, ReferenceManifest } from '@/lib/types';

const TYPE_ICON = { image: '🖼', video: '🎬', audio: '🎵' } as const;

export function ReferencePicker({
  sessionId, mode, manifest, disabled, onChanged, onBusyChange,
}: {
  sessionId: string | null;
  mode: Mode;
  onBusyChange: (sessionId: string, busy: boolean) => void;
  manifest: ReferenceManifest | null;
  disabled: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const whitebox = mode === 'blockout_3d';

  const items = manifest?.items ?? [];
  const max = manifest?.max_per_session ?? (whitebox ? 100 : 10);
  const remaining = manifest?.remaining ?? max;
  const frozen = manifest?.frozen === true;
  const blocked = disabled || frozen || remaining <= 0 || !sessionId;

  async function pick(files: FileList | null) {
    if (!files?.length || !sessionId || blocked || busy) return;
    if (files.length > remaining) {
      setError(`本次选择了 ${files.length} 个素材，还可上传 ${remaining} 个。请减少选择后重试；本次尚未上传。`);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setBusy(true); onBusyChange(sessionId, true); setError(null);
    setProgress({ done: 0, total: files.length });
    try {
      for (const f of Array.from(files)) {
        await api.uploadReference(sessionId, f);
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '上传失败');
    } finally {
      try { await onChanged(); } // Refresh successful uploads even if a later file failed.
      finally {
        onBusyChange(sessionId, false);
        setBusy(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    }
  }

  async function remove(name: string) {
    if (!sessionId) return;
    setBusy(true); onBusyChange(sessionId, true); setError(null);
    setProgress({ done: 0, total: 0 });
    try { await api.deleteReference(sessionId, name); await onChanged(); }
    catch (e) { setError(e instanceof ApiError ? e.message : '删除失败'); }
    finally { onBusyChange(sessionId, false); setBusy(false); }
  }

  return (
    <Collapsible title="参考素材" count={`${items.length}/${max}`} storageKey="refs">

      {items.map((it) => (
        <div key={it.stored_name} className="card compact" style={{ marginBottom: 5 }}>
          <div className="row" style={{ fontSize: 12.5 }}>
            <span aria-hidden>{TYPE_ICON[it.type] ?? '📄'}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {it.original_name}
            </span>
            <span className="spacer" />
            {!frozen && !disabled && (
              <button className="linkbtn tiny" onClick={() => remove(it.stored_name)} disabled={busy}>
                删除
              </button>
            )}
          </div>
          <div className="tiny" style={{ opacity: .75 }}>
            {formatBytes(it.size_bytes)}
            {it.meta?.duration_s ? ` · ${it.meta.duration_s}s` : ''}
            {it.meta?.width ? ` · ${it.meta.width}×${it.meta.height}` : ''}
            {it.meta?.fps ? ` · ${it.meta.fps}fps` : ''}
          </div>
        </div>
      ))}

      {frozen ? (
        <div className="note info" style={{ fontSize: 12 }}>
          任务已提交，素材集合已锁定。新建会话可重新上传。
        </div>
      ) : (
        <>
          <input ref={fileRef} type="file" multiple hidden
                 accept={whitebox ? '.png,.jpg,.jpeg,.webp' : 'image/*,video/*,audio/*'}
                 onChange={(e) => void pick(e.target.files)} />
          <button className="btn full" disabled={blocked || busy}
                  onClick={() => fileRef.current?.click()}>
            {busy ? (progress.total ? `上传中 ${progress.done}/${progress.total}…` : '处理中…') : `+ 添加素材（还可 ${remaining} 个）`}
          </button>
          <p className="tiny" style={{ marginTop: 6 }}>
            {whitebox
              ? `支持 PNG / JPEG / WebP，每个会话最多 ${max} 张。原图保留，模型读取的图片长边超过 1024 时会自动压缩，也可自行压缩后上传。`
              : `支持图片 / 视频 / 音频，每个会话最多 ${max} 个。素材会交给后端用于理解你的创作意图。`}
          </p>
        </>
      )}
      {error && <div className="note bad" style={{ fontSize: 12, marginTop: 6 }}>{error}</div>}
    </Collapsible>
  );
}
