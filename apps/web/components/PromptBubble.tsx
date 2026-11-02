'use client';
/**
 * 用户提示词气泡。
 *
 * 为什么要折叠：接口下发的 prompt_summary 只有 300 字符（服务端截断），
 * 长 prompt 会被从句子中间切断，用户看不到自己发了什么。
 * 完整内容在同一份响应的 original_prompt 里，这里按需展开即可，
 * 不需要再请求一次。
 */
import { useState } from 'react';

const FOLD_AT = 200;

export function PromptBubble({ summary, full }: { summary: string; full?: string | null }) {
  const [open, setOpen] = useState(false);
  const text = full && full.length > summary.length ? full : summary;
  const longer = text.length > FOLD_AT;
  const shown = !longer || open ? text : `${text.slice(0, FOLD_AT)}…`;

  return (
    <div className="msg user">
      <div className="bubble">
        <div style={{ whiteSpace: 'pre-wrap' }}>{shown}</div>
        {longer && (
          <button
            className="linkbtn tiny"
            style={{ marginTop: 6, color: 'inherit', opacity: .85 }}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '▾ 收起' : `▸ 展开全文（${text.length} 字符）`}
          </button>
        )}
      </div>
    </div>
  );
}
