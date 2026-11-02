'use client';
/**
 * 示例详情弹框。
 *
 * 用户要求：「用户点击示例时，不要直接引入 prompt 框，改成弹出弹框，
 * 把 prompt 和示例视频（如果有的话）展示出来，然后加个按钮引导，
 * 新建对话并把 prompt 导入让用户体验，并说明由于模型有随机性，
 * 无法强行还原视频，用户点击后再新建对话并导入 prompt，把扩写框去除勾选」。
 *
 * 为什么改成弹框：原来点一下就把上万字塞进输入框，用户既没看清示例是什么，
 * 也可能把自己正在写的内容冲掉。先看后用，导入这一步要显式确认。
 *
 * 几个必须守住的点：
 *   · 视频 `preload="metadata"` —— 示例片可能上百 MB，弹框一开就全量拉是灾难。
 *   · 维护期禁用导入按钮：导入要新建会话，维护期后端在挡写，点了必然 503。
 *   · prompt 过 clean() 再渲染，与 ExampleList/ExamplesTab 的既有做法一致。
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { formatBytes, formatDuration } from '@/lib/format';
import { clean } from '@/lib/sanitize';
import type { ExamplePrompt } from '@/lib/types';

export function ExampleDialog({
  example, busy, disabledReason, onImport, onClose,
}: {
  /** null 表示不显示 */
  example: ExamplePrompt | null;
  /** 导入进行中（建会话有网络往返，期间要禁用按钮防重复点） */
  busy?: boolean;
  /** 不为空则禁用导入并把原因显示出来（维护期、无会话等） */
  disabledReason?: string | null;
  onImport: (ex: ExamplePrompt) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = !!example;
  // 换示例时重置播放器：<video> 不会因为 src 变了就丢掉已缓冲的旧片段
  const [vidErr, setVidErr] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => { setVidErr(false); }, [example?.id]);

  if (!example) return <dialog ref={ref} />;
  const v = example.video ?? null;

  return (
    <dialog ref={ref} onCancel={(e) => { e.preventDefault(); onClose(); }}
            style={{ maxWidth: 'min(760px, 94vw)' }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>✦ {example.title}</h2>
          {example.note && (
            <div className="tiny" style={{ marginTop: 3, opacity: .8 }}>{example.note}</div>
          )}
        </div>
        <span className="spacer" />
        <button className="linkbtn tiny" onClick={onClose} aria-label="关闭">关闭</button>
      </div>

      {v && !vidErr && (
        <div style={{ marginTop: 12 }}>
          {/*
            preload="metadata"：只拉文件头，拿到时长与尺寸就够。
            示例片允许到 200MB，一打开弹框就整片下载会把带宽吃光。
          */}
          <video
            controls
            preload="metadata"
            src={api.exampleVideoUrl(example.id)}
            onError={() => setVidErr(true)}
            style={{ width: '100%', maxHeight: 360, background: '#000', borderRadius: 6 }}
          />
          <div className="tiny" style={{ marginTop: 4, opacity: .7 }}>
            示例片 · {formatDuration(v.duration_ms)} · {v.width}×{v.height} · {formatBytes(v.size_bytes)}
          </div>
        </div>
      )}
      {v && vidErr && (
        <div className="note warn" style={{ marginTop: 12 }}>
          示例片暂时加载不出来（不影响下面的 prompt 导入）。
        </div>
      )}

      <div className="note info" style={{ marginTop: 12 }}>
        模型有随机性，同一段 prompt <strong>不会还原出完全相同的视频</strong>；
        {v ? '上面的示例片仅供参考，' : ''}你拿到的会是同一思路下的另一个版本。
      </div>

      <div className="tiny" style={{ margin: '12px 0 4px', opacity: .75 }}>
        完整 prompt（{example.prompt.length} 字符）
      </div>
      <div style={{
        maxHeight: 240, overflowY: 'auto', whiteSpace: 'pre-wrap',
        fontSize: 12.5, lineHeight: 1.65, overscrollBehavior: 'contain',
        border: '1px solid var(--line)', borderRadius: 6, padding: 10,
      }}>{clean(example.prompt)}</div>

      <div className="row" style={{ marginTop: 14, gap: 10 }}>
        <span className="tiny" style={{ opacity: .75 }}>
          导入后会<strong>自动关闭「智能扩写」</strong> —— 示例已是完整方案。
        </span>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary"
                disabled={busy || !!disabledReason}
                title={disabledReason ?? undefined}
                onClick={() => onImport(example)}>
          {busy ? '正在新建…' : '新建对话并导入'}
        </button>
      </div>
      {disabledReason && (
        <div className="tiny" style={{ marginTop: 6, textAlign: 'right', opacity: .8 }}>
          {disabledReason}
        </div>
      )}
    </dialog>
  );
}
