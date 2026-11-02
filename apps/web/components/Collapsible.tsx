'use client';
/**
 * 可折叠分区（侧栏各块共用）。
 *
 * 用户要求：「左侧的已完成、示例等块要做成可折叠的，默认打开，
 * 用户可以折叠，加一个折叠符号」。
 *
 * 两个设计约束：
 *   · 折叠状态要**记住**（用户选定）—— 存 localStorage，键按 storageKey 区分。
 *     读写一律 try/catch：隐私模式下 localStorage 会抛，不能因此白屏
 *     （与 lib/local-state.ts 的既有做法一致）。
 *   · 标题行**折叠时也要显示数量** —— 否则把「进行中」收起来就看不出有没有任务在跑。
 */
import { useEffect, useState } from 'react';

export function Collapsible({
  title, count, storageKey, defaultOpen = true, children,
}: {
  title: string;
  /** 显示在标题后的数量角标；折叠时仍然可见 */
  count?: number | string | null;
  /** localStorage 的键后缀；不传则不持久化 */
  storageKey?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // 首帧用 defaultOpen 渲染，挂载后再读本地偏好 ——
  // 直接在 useState 里读会导致服务端渲染与客户端不一致（hydration mismatch）。
  useEffect(() => {
    if (!storageKey) return;
    try {
      const v = localStorage.getItem(`cvw:fold:${storageKey}`);
      if (v !== null) setOpen(v === '1');
    } catch { /* 隐私模式：用默认值 */ }
  }, [storageKey]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!storageKey) return;
    try { localStorage.setItem(`cvw:fold:${storageKey}`, next ? '1' : '0'); } catch {}
  };

  return (
    <section>
      {/* 整行可点：折叠符号本身太小，点不准 */}
      <h3 onClick={toggle}
          style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 5 }}
          role="button" tabIndex={0} aria-expanded={open}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
        <span aria-hidden style={{ opacity: .7, fontSize: 11, width: 9, display: 'inline-block' }}>
          {open ? '▾' : '▸'}
        </span>
        <span>{title}</span>
        {count != null && count !== '' && (
          <span style={{ opacity: .7, fontWeight: 400 }}>({count})</span>
        )}
      </h3>
      {open && children}
    </section>
  );
}
