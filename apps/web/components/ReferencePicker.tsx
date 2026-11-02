'use client';
/**
 * Reference 附件（V2 需求 1）：图片/视频/音频，每 session 最多 10 个。
 * 页面明确提示上限与已用数量（用户要求）。
 */
import { useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { Collapsible } from './Collapsible';
import type { ReferenceManifest } from '@/lib/types';

const TYPE_ICON = { image: '🖼', video: '🎬', audio: '🎵' } as const;

export function ReferencePicker({
  sessionId, manifest, disabled, onChanged,
}: {
  sessionId: string | null;
  manifest: ReferenceManifest | null;
  disabled: boolean;
  onChanged: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = manifest?.items ?? [];
  const max = manifest?.max_per_session ?? 10;
  const remaining = manifest?.remaining ?? max;
  const frozen = manifest?.frozen === true;
  const blocked = disabled || frozen || remaining <= 0 || !sessionId;

  async function pick(files: FileList | null) {
    if (!files?.length || !sessionId) return;
    setBusy(true); setError(null);
    try {
      for (const f of Array.from(files).slice(0, remaining)) {
        await api.uploadReference(sessionId, f);
      }
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '上传失败');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function remove(name: string) {
    if (!sessionId) return;
    setBusy(true); setError(null);
    try { await api.deleteReference(sessionId, name); onChanged(); }
    catch (e) { setError(e instanceof ApiError ? e.message : '删除失败'); }
    finally { setBusy(false); }
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
                 accept="image/*,video/*,audio/*"
                 onChange={(e) => void pick(e.target.files)} />
          <button className="btn full" disabled={blocked || busy}
                  onClick={() => fileRef.current?.click()}>
            {busy ? '上传中…' : `+ 添加素材（还可 ${remaining} 个）`}
          </button>
          <p className="tiny" style={{ marginTop: 6 }}>
            支持图片 / 视频 / 音频，每个会话最多 {max} 个。
            素材会交给后端用于理解你的创作意图。
          </p>
        </>
      )}
      {error && <div className="note bad" style={{ fontSize: 12, marginTop: 6 }}>{error}</div>}
    </Collapsible>
  );
}
