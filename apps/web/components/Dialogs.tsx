'use client';
/** 首次使用说明 与 新建会话确认（旧任务仍会继续执行）。 */
import { useEffect, useRef } from 'react';
import { formatDuration } from '@/lib/format';
import type { Job } from '@/lib/types';

function useDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return ref;
}

export function WelcomeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useDialog(open);
  return (
    <dialog ref={ref} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 19 }}>🧪 测试版本</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        本站由 <strong>SenseNova 6.8 Code2Video</strong> 驱动，
        仅支持 AI 视频生成、视频修改及相关创作讨论。请勿输入无关内容或敏感信息。
      </p>
      <ul style={{ fontSize: 14, paddingLeft: 20, lineHeight: 1.85 }}>
        <li>单次生成可能需要 <strong>1~2 小时</strong>，属于正常现象</li>
        <li><strong>可以关闭网页</strong>：生成在后端继续，重新打开本页即可查看进度</li>
        <li>切换标签页、最小化都不受影响，可以放在后台</li>
        <li>支持上传图片 / 视频 / 音频作为参考素材，单次对话最多 10 个</li>
        <li>发错了可以「停止并修改」，不必新建对话；历史创作可在顶栏「创作历史」回看</li>
      </ul>
      <div className="row" style={{ marginTop: 16 }}>
        <span className="spacer" />
        <button className="btn primary" onClick={onClose}>我知道了</button>
      </div>
    </dialog>
  );
}

export function NewSessionDialog({
  open, runningJobs, onConfirm, onCancel,
}: {
  open: boolean; runningJobs: Job[];
  onConfirm: () => void; onCancel: () => void;
}) {
  const ref = useDialog(open);
  return (
    <dialog ref={ref} onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      <h2 style={{ margin: '0 0 10px', fontSize: 18 }}>确认新建对话</h2>
      {runningJobs.length > 0 ? (
        <>
          <p style={{ margin: '0 0 8px', fontSize: 14 }}>
            当前有 {runningJobs.length} 个正在执行的生成任务：
          </p>
          {runningJobs.map((j) => (
            <div key={j.id} className="card compact" style={{ marginBottom: 6, fontSize: 13 }}>
              ⟳ {j.prompt_summary.slice(0, 40) || j.id.slice(0, 16)}
              {j.elapsed.running_ms != null && ` · 已运行 ${formatDuration(j.elapsed.running_ms)}`}
            </div>
          ))}
          <div className="note warn" style={{ marginTop: 10 }}>
            新建对话不会中断它们，但请保持页面开启，否则运行中的任务会被停止。
          </div>
        </>
      ) : (
        <p className="muted" style={{ fontSize: 14, marginBottom: 0 }}>
          新对话将使用独立的后端上下文，不延续当前对话历史。
        </p>
      )}
      <div className="row" style={{ marginTop: 16 }}>
        <span className="spacer" />
        <button className="btn" onClick={onCancel}>取消</button>
        <button className="btn primary" onClick={onConfirm}>新建对话</button>
      </div>
    </dialog>
  );
}
