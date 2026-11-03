'use client';
/**
 * 过程窗口（V2 需求 4）：滚动显示 cc 的工具调用与中间返回。
 *
 * 位于输入框下方，独立滚动；顶部把手跟随指针调整高度。
 * thinking_tokens 已在后端过滤；这里显示 thinking 内容（可折叠）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { copyText } from '@/lib/clipboard';
import { clean } from '@/lib/sanitize';
import type { ProcessEvent, WatchdogPrompt } from '@/lib/types';

async function copySid(id: string, setMsg: (s: string | null) => void) {
  const ok = await copyText(id);
  setMsg(ok ? '会话 ID 已复制' : '复制失败，请手动选中');
  setTimeout(() => setMsg(null), 2500);
}

const TOOL_ICON: Record<string, string> = {
  Bash: '$', Write: '✎', Edit: '✎', Read: '◎', Skill: '◈',
  Glob: '⌕', Grep: '⌕', Task: '⚙', WebFetch: '⇡',
};

function summarize(ev: ProcessEvent): string {
  const i = ev.input ?? {};
  if (ev.tool === 'Bash') return String(i.command ?? '');
  if (ev.tool === 'Write') return `${i.file_path ?? ''} (${i.bytes ?? 0}B)`;
  if (ev.tool === 'Edit' || ev.tool === 'Read') return String(i.file_path ?? '');
  if (ev.tool === 'Skill') return String(i.skill ?? '');
  if (ev.tool === 'Glob' || ev.tool === 'Grep') return String(i.pattern ?? '');
  const s = JSON.stringify(i);
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

export function ProcessPanel({
  events, prompts, phase, running, ccSessionId, sessionId, onHeight,
  open, onOpenChange, loadingEvents, height = 240,
}: {
  events: ProcessEvent[];
  prompts: WatchdogPrompt[];
  phase: string | null;
  running: boolean;
  ccSessionId?: string | null;
  /** 会话 ID：要让用户能看到并复制，便于报障时定位（用户要求） */
  sessionId?: string | null;
  /** 拖动改变高度时回传给父布局 */
  onHeight?: (px: number) => void;
  height?: number;
  /**
   * 是否展开。**受控** —— 由父组件决定默认值。
   *
   * 原来这是组件内部的 collapsed 状态，只影响显示、不影响订阅：
   * 哪怕收起着，SSE 也早已从 seq=0 把整条轨迹拉完了
   * （品牌片任务 99975 行）—— 这正是「切换卡、从 0 开始加载」的原因。
   * 提升为受控后，父组件用同一个值驱动 useJobStream 的 subscribe，
   * 折叠时真的不去拉。
   */
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 已订阅但首批事件未到 —— 显示进度条，让用户知道在加载而不是卡住 */
  loadingEvents?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const heightRef = useRef(height);
  heightRef.current = height;
  const [autoScroll, setAutoScroll] = useState(true);
  const [showThinking, setShowThinking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // 拖动把手调高度：过程多的时候想看更多，不该被固定死
  const drag = useRef<{ y: number; h: number } | null>(null);
  const clampHeight = useCallback((requested: number) => {
    const main = panelRef.current?.parentElement;
    const composer = main?.querySelector<HTMLElement>(':scope > .composer');
    const available = Math.max(0, (main?.clientHeight ?? window.innerHeight) - (composer?.getBoundingClientRect().height ?? 0));
    // Keep at least half the available space for the conversation, including after
    // viewport changes, textarea resizing or restoring an oversized old preference.
    const max = Math.max(48, Math.floor(available / 2));
    return Math.max(Math.min(120, max), Math.min(Math.round(requested), max));
  }, []);
  useEffect(() => {
    if (!open) return;
    const next = clampHeight(height);
    if (next !== height) onHeight?.(next);
  }, [height, open, clampHeight, onHeight]);
  useEffect(() => {
    if (!open) return;
    const main = panelRef.current?.parentElement;
    if (!main) return;
    const resize = () => {
      const next = clampHeight(heightRef.current);
      if (next !== heightRef.current) onHeight?.(next);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(main);
    const composer = main.querySelector(':scope > .composer');
    if (composer) observer.observe(composer);
    resize();
    return () => observer.disconnect();
  }, [open, clampHeight, onHeight]);
  const onGripDown = useCallback((e: React.PointerEvent) => {
    const el = panelRef.current;
    if (!el || !open || e.button !== 0) return;
    e.preventDefault();
    drag.current = { y: e.clientY, h: el.getBoundingClientRect().height };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [open]);
  const onGripMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    // 往上拖 → 变高
    const next = Math.round(drag.current.h + (drag.current.y - e.clientY));
    onHeight?.(clampHeight(next));
  }, [onHeight, clampHeight]);
  const onGripUp = useCallback(() => { drag.current = null; }, []);

  const shown = useMemo(
    () => events.filter((e) => (showThinking ? true : e.kind !== 'thinking')),
    [events, showThinking],
  );

  // 只滚动这个框，不动页面
  useEffect(() => {
    if (!autoScroll) return;
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, prompts.length, autoScroll]);

  const stats = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of events) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [events]);

  return (
    <aside className="procpanel" ref={panelRef}>
      {/* 拖动条：把过程区往上拉可以看更多 */}
      <div className="proc-grip" hidden={!open} onPointerDown={onGripDown}
           onPointerMove={onGripMove} onPointerUp={onGripUp}
           onPointerCancel={onGripUp} onLostPointerCapture={onGripUp}
           role="separator" aria-orientation="horizontal" aria-label="拖动调整执行过程区高度" />
      <div className="procpanel-head">
        <strong>执行过程</strong>
        {running && <span className="dot-live" aria-label="进行中" />}
        {phase && <span className="badge">{phase}</span>}
        {/* 加载期间不显示条数：它会从 0 一路往上跳，和进度条打架 */}
        {!loadingEvents && <span className="tiny" style={{ opacity: .7 }}>{shown.length} 条</span>}
        <span className="spacer" />
        <label className="tiny" style={{ cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={showThinking}
                 onChange={(e) => setShowThinking(e.target.checked)} />
          思考
        </label>
        <label className="tiny" style={{ cursor: 'pointer', userSelect: 'none' }}>
          <input type="checkbox" checked={autoScroll}
                 onChange={(e) => setAutoScroll(e.target.checked)} />
          跟随
        </label>
        <button className="linkbtn tiny" onClick={() => onOpenChange(!open)}
                aria-expanded={open}>
          <span aria-hidden>{open ? '▾' : '▸'}</span> {open ? '收起' : '展开'}
        </button>
      </div>

      {/* 折叠态：说明它为什么是空的，并告知展开才会加载 —— 否则用户会以为坏了 */}
      {!open && (
        <div className="tiny" style={{ padding: '6px 10px', opacity: .7 }}>
          执行过程已收起（不加载，省流量与等待）。需要看每一步时点上方「展开」。
        </div>
      )}
      {/*
        展开后正在加载：只显示进度条，**不渲染事件列表**（用户明确要求
        「未加载完成前不要展示或者影响上面的对话框」）。

        为什么必须整块藏掉、而不是边加载边显示：SSE 从 seq=0 回放，
        事件是一批批到的，边到边渲染就是列表不停变高、滚动位置不停跳 ——
        体感上就是「跳变」。等安静期结束一次性渲染，只跳一次。

        注意这里只能用 display:none 把 body 藏起来、不能把它卸载 ——
        boxRef 指向它，卸载后自动滚底的 effect 拿不到节点。
      */}
      {open && loadingEvents && (
        <div className="procloading">
          <div className="tiny" style={{ marginBottom: 6, opacity: .8 }}>
            正在加载执行过程…{shown.length > 0 && ` 已收到 ${shown.length} 条`}
          </div>
          <div className="procbar" role="progressbar" aria-busy="true"
               aria-label="正在加载执行过程"><span /></div>
          <div className="tiny" style={{ marginTop: 6, opacity: .6 }}>
            历史较长时需要几秒，加载完会一次性显示，不会边跳边刷。
          </div>
        </div>
      )}

      <div className="procpanel-body" ref={boxRef}
           style={open && !loadingEvents ? undefined : { display: 'none' }}
           onScroll={(e) => {
             const el = e.currentTarget;
             const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
             if (!atBottom && autoScroll) setAutoScroll(false);
           }}>
        {shown.length === 0 && prompts.length === 0 && (
          <p className="tiny" style={{ padding: 10, lineHeight: 1.7 }}>
            {running
              ? '已连接后端，正在等待第一条执行记录…'
              : '提交任务后，这里会实时显示后端的每一步工具调用与返回。'}
            {!showThinking && events.length > 0 && (
              <><br />（已隐藏 {events.length} 条思考内容，勾选上方「思考」可查看）</>
            )}
          </p>
        )}

        {shown.map((ev) => <EventRow key={`e${ev.seq}`} ev={ev} />)}

        {prompts.map((p, i) => (
          <div key={`p${i}`} className="pevent sys">
            <div className="pevent-head">
              <span className="ptag sys">系统</span>
              <span className="tiny">{p.trigger}</span>
            </div>
            <div className="pevent-body">{clean(p.text)}</div>
          </div>
        ))}
      </div>

      {open && !loadingEvents && (
        <div className="procpanel-foot tiny">
          <div className="row wrap" style={{ gap: 8 }}>
            <span>{Object.entries(stats).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}</span>
            <span className="spacer" />
            {/* 会话 ID 要能看见、能复制 —— 用户报障时我们靠它查轨迹 */}
            {sessionId && (
              <span className="mono" style={{ opacity: .8 }}>
                会话 {sessionId}
                <button className="linkbtn tiny" style={{ marginLeft: 6 }}
                        onClick={() => void copySid(sessionId, setCopied)}>复制</button>
              </span>
            )}
            {ccSessionId && (
              <span className="mono" style={{ opacity: .6 }}>引擎 {ccSessionId.slice(0, 8)}</span>
            )}
          </div>
          {copied && <div style={{ marginTop: 3, color: 'var(--green)' }}>{copied}</div>}
        </div>
      )}
    </aside>
  );
}

function EventRow({ ev }: { ev: ProcessEvent }) {
  const [open, setOpen] = useState(false);

  if (ev.kind === 'init') {
    return (
      <div className="pevent">
        <div className="pevent-head">
          <span className="ptag init">启动</span>
          <span className="tiny">{(ev.skills ?? []).length} 个 skill 可用</span>
        </div>
      </div>
    );
  }

  if (ev.kind === 'tool_use') {
    return (
      <div className="pevent">
        <div className="pevent-head">
          <span className="ptag tool">{TOOL_ICON[ev.tool ?? ''] ?? '•'} {ev.tool}</span>
        </div>
        <div className="pevent-body mono">{clean(summarize(ev))}</div>
      </div>
    );
  }

  if (ev.kind === 'tool_result') {
    const txt = ev.text ?? '';
    const long = txt.length > 400;
    return (
      <div className={`pevent ${ev.is_error ? 'err' : ''}`}>
        <div className="pevent-head">
          <span className={`ptag ${ev.is_error ? 'err' : 'ok'}`}>
            {ev.is_error ? '失败' : '返回'}
          </span>
          {long && (
            <button className="linkbtn tiny" onClick={() => setOpen((v) => !v)}>
              {open ? '收起' : '展开'}
            </button>
          )}
        </div>
        <div className="pevent-body mono">
          {clean(open || !long ? txt : `${txt.slice(0, 400)}…`)}
        </div>
      </div>
    );
  }

  if (ev.kind === 'thinking') {
    return (
      <div className="pevent think">
        <div className="pevent-head"><span className="ptag think">思考</span></div>
        <div className="pevent-body">{clean(ev.text)}</div>
      </div>
    );
  }

  if (ev.kind === 'assistant_text') {
    return (
      <div className="pevent say">
        <div className="pevent-head"><span className="ptag say">回复</span></div>
        <div className="pevent-body">{clean(ev.text)}</div>
      </div>
    );
  }

  if (ev.kind === 'result') {
    return (
      <div className="pevent">
        <div className="pevent-head">
          <span className="ptag ok">完成</span>
          <span className="tiny">
            {ev.duration_ms ? `${Math.round(ev.duration_ms / 1000)}s` : ''}
            {ev.num_turns ? ` · ${ev.num_turns} 轮` : ''}
          </span>
        </div>
      </div>
    );
  }
  return null;
}
