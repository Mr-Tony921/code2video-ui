'use client';
/**
 * 底部输入区。
 *
 * 防重复提交（任务书 §11.1）：
 *  · 幂等键在【首次渲染时】生成并缓存 —— 若在点击时生成，双击会产生两个不同 key，绕过幂等
 *  · 提交后立即禁用按钮
 *  · 服务端 (user_id, key) UNIQUE 兜底
 */
import { useEffect, useRef, useState } from 'react';
import { loadDraft, saveDraft } from '@/lib/local-state';
import { uuid } from '@/lib/uuid';

export function Composer({
  sessionId, disabled, disabledReason, onSubmit, injected, onInjected,
  enhance, onEnhanceChange, basedOn, enhanceLocked, experimental,
}: {
  sessionId: string | null;
  disabled: boolean;
  disabledReason?: string;
  /**
   * 本次提交会「基于哪个对话继续」。
   * 用户明确要求显示它 —— 之前续跑起来的会话和新对话长得一模一样，
   * 看不出是在改哪一个，配合「看 A 提交进 B」的串台就更难发现。
   * 为 null 表示这是全新创作，不显示（不该假装是续跑）。
   */
  basedOn?: { summary: string; round: number } | null;
  /**
   * 非 null 表示扩写被锁定（当前是续写轮），值是给用户看的原因。
   *
   * 为什么要锁而不是只改默认值：后端对续写轮是**一律跳过扩写**的
   * （`enhancer.mjs` 的 `isRevision && skipForRevision`，配置默认 true）。
   * 勾选框还能勾、还显示勾着，就是在骗用户 —— 他以为扩写了，其实没有。
   * 用户实测反馈过这一点。
   */
  enhanceLocked?: string | null;
  experimental?: boolean;
  onSubmit: (text: string, idempotencyKey: string) => Promise<void>;
  /** 是否做 prompt 增强（默认开）。点击示例会自动关闭 —— 示例本身已是增强结果 */
  enhance: boolean;
  onEnhanceChange: (v: boolean) => void;
  /** 外部回填的文本（停止并修改 / 用这段重新创作） */
  injected?: string | null;
  onInjected?: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // ★ 幂等键在渲染时生成，不在点击时生成
  const idemKey = useRef<string>(uuid());
  const ta = useRef<HTMLTextAreaElement>(null);

  // 草稿按会话隔离，切换会话不丢失
  useEffect(() => {
    if (sessionId) setText(loadDraft(sessionId));
  }, [sessionId]);

  // 外部回填：把要改写的 prompt 放进输入框并聚焦到末尾
  useEffect(() => {
    if (!injected) return;
    setText(injected);
    onInjected?.();
    requestAnimationFrame(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.scrollTop = el.scrollHeight;
    });
  }, [injected]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (sessionId) saveDraft(sessionId, text);
  }, [sessionId, text]);

  async function submit() {
    const t = text.trim();
    if (!t || busy || disabled) return;
    setBusy(true);
    try {
      await onSubmit(experimental ? text : t, idemKey.current);
      setText('');
      if (sessionId) saveDraft(sessionId, '');
      idemKey.current = uuid();   // 成功后换新 key，供下次提交
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="composer">
      {/* 输入区要最小：发送按钮与字数内联在右侧，不再单独占一行；
          禁用原因只用一行小字，不用占三行的 note 块。 */}
      <div className="row wrap" style={{ marginBottom: 6, gap: 10 }}>
        <label className="tiny" style={{
          cursor: enhanceLocked ? 'not-allowed' : 'pointer', userSelect: 'none',
          display: 'flex', alignItems: 'center', gap: 4, opacity: enhanceLocked ? .55 : 1,
        }}>
          {/* 锁定时强制显示未勾选 —— 后端确实不会扩写，显示勾着就是说谎 */}
          <input type="checkbox" checked={enhanceLocked ? false : enhance}
                 disabled={disabled || busy || !!enhanceLocked}
                 onChange={(e) => onEnhanceChange(e.target.checked)} />
          智能扩写需求
        </label>
        <span className="tiny" style={{ opacity: .7 }}>
          {enhanceLocked
            ? enhanceLocked
            : enhance
              ? '会先把你的描述扩写成详细制作方案（约半分钟）'
              : '直接按你写的内容制作，不做改写'}
        </span>
      </div>

      {/* 续跑提示：放输入框【上方】，紧贴着它 —— 用户是在这里打字的，
          提示放侧栏（原来那条「正在查看另一个对话」）太容易被忽略。 */}
      {basedOn && (
        <div className="tiny" style={{
          marginBottom: 6, padding: '5px 9px', borderRadius: 6,
          background: 'var(--bg2, rgba(127,127,127,.10))',
          color: 'var(--mute)', display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span aria-hidden="true">↻</span>
          <span>
            基于「{basedOn.summary.slice(0, 24)}{basedOn.summary.length > 24 ? '…' : ''}」继续
            <span style={{ opacity: .75 }}>（第 {basedOn.round} 轮）</span>
          </span>
        </div>
      )}

      <div className="composer-row">
        <textarea
          ref={ta}
          className="input"
          rows={2}
          placeholder={disabled ? (disabledReason ?? '当前不可输入') : '描述你想生成的视频…（换行请直接回车，写完点右侧「发送」）'}
          value={text}
          disabled={disabled || busy}
          onChange={(e) => setText(e.target.value)}
          /*
           * 回车【不】发送，只换行。
           *
           * 用户反馈：创作型 prompt 往往要分几行写，回车即发很容易把半截内容
           * 提交出去 —— 一次误发就是一个几十分钟的任务和一次排队。
           * 宁可多点一下按钮，也不要误触发。
           */
        />
        <div className="composer-side">
          <button className="btn primary" onClick={submit} disabled={disabled || busy || !text.trim()}>
            {busy ? '提交中…' : '发送 ↑'}
          </button>
          <span className="tiny">{text.length}{experimental ? '' : '/8000'}</span>
        </div>
      </div>
      {disabled && disabledReason && (
        <div className="tiny" style={{ marginTop: 5, color: 'var(--amber)' }}>{disabledReason}</div>
      )}
    </div>
  );
}
