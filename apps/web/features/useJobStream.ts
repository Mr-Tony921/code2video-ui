'use client';
/**
 * Job 状态订阅：SSE 优先 + 轮询兜底。
 *
 * 核心原则：
 *  · 服务端快照是权威来源，SSE 只负责加速
 *  · 重连时先取快照，再按 Last-Event-ID 续流
 *  · 按 seq 去重，容忍乱序与重复
 *  · 页面隐藏时降低轮询频率；重新可见立即同步一次
 *  · 轮询与 SSE 都只负责展示，【不负责保持 Job 存活】
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribeJob } from '@/lib/api';
import { withBase } from '@/lib/base-path';
import { isTerminal, type Job, type JobEvent, type ProcessEvent, type WatchdogPrompt } from '@/lib/types';
import { uuid } from '@/lib/uuid';

const POLL_VISIBLE_MS = 5000;
const POLL_HIDDEN_MS = 60000;
/**
 * 回放结束的判定。
 *
 * ★ 主判据是**确定信号**，不是时间：
 *   · 进行中的任务 → 后端在回放完、接实时流之前发 `job.replay_done` 哨兵
 *   · 终态任务     → 回放里命中终态事件，后端直接**关闭连接**
 * 下面这两个时间只是兜底（万一后端版本旧、没有哨兵）。
 * 之前用 600ms 安静期当主判据是错的：轨迹几千条时事件一阵一阵来，
 * 中间的空档会让前端提前以为放完了 —— 用户实测到的就是「条数 0 → 几百
 * 一路往上跳、旁边 phase 也在变」。
 */
const SETTLE_FALLBACK_MS = 2500;
/** 一条事件都没来时的等待上限（队列中的任务本来就没有轨迹） */
const SETTLE_EMPTY_MS = 2500;

/**
 * @param subscribe 是否订阅过程事件（SSE）。
 *   false 时只保留 job 轮询 —— 状态/阶段/产物照常实时，但【不拉轨迹】。
 *   切换任务时 SSE 会从 seq=0 回放整条轨迹（实测品牌片 99975 行），
 *   这是「切换卡、从 0 开始加载」的根源；过程框折叠时就不该付这个代价。
 *   「制作助手」已改为从 job 快照读 last_assistant_text，所以不订阅也不丢信息。
 */
export function useJobStream(jobId: string | null, subscribe = true) {
  const [job, setJob] = useState<Job | null>(null);
  const [sseOk, setSseOk] = useState(true);
  /** 过程事件（V2 需求 4）：右侧过程框消费 */
  const [processEvents, setProcessEvents] = useState<ProcessEvent[]>([]);
  /** 系统自发话术（V2 需求 7） */
  const [wdPrompts, setWdPrompts] = useState<WatchdogPrompt[]>([]);
  /** cc 的最新文本回复 —— 要在对话区显示，不止过程框（V2 需求 7） */
  const [assistantText, setAssistantText] = useState<string | null>(null);
  /**
   * 正在加载轨迹 —— 过程框据此显示进度条、并在此期间**不渲染事件列表**。
   *
   * ★ 原来它在【首批事件到达】时就置 false，这是错的：SSE 从 seq=0 回放，
   *   第一条到得很快、后面还有成百上千条在路上（品牌片 99975 行轨迹）。
   *   于是进度条一闪就没、列表却继续一批批涨 —— 用户看到的就是持续跳变。
   *   现在改为「安静期」判定：每来一条事件就把计时器往后推，
   *   连续 SETTLE_MS 没有新事件才算回放结束。
   */
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [ccSessionId, setCcSessionId] = useState<string | null>(null);
  const maxSeq = useRef(0);
  /** 上一次 effect 跑的是哪个 job —— 用来区分「换任务」与「只是开合过程框」 */
  const lastJobId = useRef<string | null>(null);
  const procSeq = useRef(0);
  const pendingProc = useRef<ProcessEvent[]>([]);
  const stopped = useRef(false);

  /** 取权威快照。任何不确定时都以它为准。 */
  const sync = useCallback(async () => {
    if (!jobId) return null;
    try {
      const { job: j } = await api.getJob(jobId);
      setJob(j);
      if (isTerminal(j.status)) stopped.current = true;
      return j;
    } catch {
      return null;
    }
  }, [jobId]);

  useEffect(() => {
    if (!jobId) {
      lastJobId.current = null;                  // 下次有 job 时要当成"换了任务"
      setJob(null); setProcessEvents([]); setWdPrompts([]);
      setAssistantText(null); setCcSessionId(null);
      return;
    }
    stopped.current = false;
    /**
     * ★ 只有【真的换了任务】才清空状态。
     *
     * 本 effect 的依赖里有 subscribe —— 展开/收起过程框也会让它重跑。
     * 原来不分情况地 `setJob(null)`，于是点一下「展开」就把当前状态清掉，
     * 界面退回 `_workspace` 的 `boot.jobs` 兜底快照（那份来自侧栏列表，
     * 比实时状态旧），阶段于是**先倒退再追上来** ——
     * 实测点开一个 RENDERING 的任务，阶段先闪回「生成中」再回到「渲染中」，
     * 用户看到的就是「phase 在变、对话框跟着变」。
     *
     * 换任务时仍然必须清：不清的话新数据到达前 liveJob 还是旧任务的，
     * 而 processEvents 已空 —— 界面先显示"旧卡片 + 空过程框"，再跳成
     * 新任务的旧快照，最后 HTTP 回来才定格，连跳三次。
     *
     * 顺带一个好处：收起再展开时 maxSeq 得以保留，SSE 从上次的位置续传，
     * 不再把整条轨迹重放第二遍。
     */
    const jobChanged = lastJobId.current !== jobId;
    lastJobId.current = jobId;
    if (jobChanged) {
      maxSeq.current = 0;
      procSeq.current = 0;
      setJob(null);
      pendingProc.current = [];
      setProcessEvents([]); setWdPrompts([]); setAssistantText(null); setCcSessionId(null);
    }

    let unsub: (() => void) | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    /** 过程事件的微批缓冲：同一帧内到达的合并成一次 setState。 */
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * 回放阶段的「安静期」判定与 assistant 文本缓冲。
     *
     * ★ 为什么 assistant 文本在回放期间不能逐条 setState：
     *   它显示在【对话区】的「制作助手」卡片里，而 SSE 会把历史上**每一条**
     *   assistant_text 依次推过来。逐条 setState 就是让那张卡片把历史回复
     *   挨个闪一遍，每条长度还不一样 —— 对话区于是反复重排，
     *   就是用户反馈的「展开执行过程后对话框还是跳变、好像没完全解耦」。
     *   回放期间只记住最后一条，安静期到了再提交一次。
     */
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let sawEvent = false;
    let replaying = true;
    let lastAssistant: string | null = null;
    /**
     * ★ 回放期间【不把历史 status/phase/progress 合进当前状态】。
     *
     * 这是用户实测那个「点开已完成任务，阶段又走一遍 GENERATING/FINALIZING、
     * 对话框跟着跳」的根因：历史事件带着当时的 status 与 phase，
     * 逐条合并就等于让 JobCard 把整个任务生命周期重演一遍 ——
     * 「生成完成」闪回「正在生成」、「阶段：」那一整块出现又消失，
     * 卡片高度一变，上面的对话区就重排。
     *
     * 回放结束后只做【一次】sync()：快照是权威来源，一次就对齐到真状态，
     * 不需要把历史重放到界面上。
     * 顺带治掉另一个问题：原来每条 job.phase / job.heartbeat_status 都
     * `void sync()`，回放时就是一串 HTTP ——实测 4.8 秒里发了 19 次。
     */
    const settleNow = () => {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      if (!replaying) return;                    // 幂等：哨兵与关闭可能都到
      replaying = false;
      if (lastAssistant !== null) { setAssistantText(lastAssistant); lastAssistant = null; }
      setLoadingEvents(false);
      void sync();                               // 一次对齐，替代回放期间的一串 sync
    };
    const bumpSettle = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(settleNow, sawEvent ? SETTLE_FALLBACK_MS : SETTLE_EMPTY_MS);
    };
    const flushProc = () => {
      if (flushTimer) return;                      // 已排好，等它一次性提交
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const batch = pendingProc.current;
        if (!batch.length) return;
        pendingProc.current = [];
        setProcessEvents((prev) => [...prev, ...batch].slice(-800));
      }, 50);                                      // 50ms 足够把回放的几百条收在一起
    };
    /**
     * 本次 effect 是否已被清理（切 session / 换 job）。
     *
     * 必须有它：订阅是在 sync() 的【异步】回调里才建立的，而 React 的 cleanup 是
     * 【同步】执行的。用户快速切 session 时时序是
     *   effect(A) → sync(A) 发出 → 切到 B → cleanup(A) 跑（此时 unsub 还是 null，
     *   什么也没断）→ sync(A) 返回 → subscribeJob(A) 建连 ⇒ 这条连接永远没人关。
     * 线上实测：sse.open 255 次、close 仅 139 次，净泄漏 116 条，连接数一路爬到 55。
     * 僵尸连接的 onEvent 闭包持有【旧 job 的 setState】，会把别的任务的状态
     * 盖到当前界面上 —— 表现为切 session 后页面来回跳变、显示别的任务的产物、
     * 以及当前任务明明在跑却不滚动。
     */
    let cancelled = false;

    const startPolling = (intervalMs: number) => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => { if (!stopped.current) void sync(); }, intervalMs);
    };

    const onEvent = (e: JobEvent & {
      process?: ProcessEvent; text?: string; trigger?: string; at?: string;
      job_id?: string;
    }) => {
      // 第二道防线：这次 effect 已清理，或事件不属于当前 job ⇒ 一律丢弃。
      // 竞态已由 cancelled 挡住，但残留连接一旦出现（比如浏览器自动重连到
      // 旧地址），这里能保证别的任务的事件绝不会污染当前界面。
      if (cancelled) return;
      if (e.job_id && e.job_id !== jobId) return;
      /**
       * ★ 回放结束哨兵：必须在去重【之前】处理 ——
       * 它不是真事件、没有有效 seq，会被下面那行 `seq <= maxSeq` 直接丢掉。
       */
      if (e.type === 'job.replay_done') { settleNow(); return; }
      if (e.seq <= maxSeq.current) return;        // 去重：丢弃已见过的
      maxSeq.current = e.seq;
      // 任何一条事件都把「回放结束」往后推 —— 判据是安静期，不是第一条
      sawEvent = true;
      bumpSettle();

      // 过程事件：单独累积，不混进 job 状态。
      //
      // ★ 微批合并，不要逐条 setState。
      // 切换对话时 SSE 从 seq=0 回放【全部】历史（实测单个任务可达 280 条），
      // 逐条 setState 就是逐条渲染 —— 实测主区域 DOM 变更 94~164 次，
      // 肉眼就是「刷」一下来回跳。合并成一次提交后只渲染一次。
      if (e.type === 'job.process' && e.process) {
        const pe = e.process;
        if (pe.seq > procSeq.current) {
          procSeq.current = pe.seq;
          pendingProc.current.push(pe);
          if (pe.kind === 'init' && pe.cc_session_id) setCcSessionId(pe.cc_session_id);
          flushProc();
        }
        return;
      }
      if (e.type === 'job.assistant_text' && e.text) {
        // 回放期间只记住最后一条（见上面 lastAssistant 的说明）；
        // 回放结束后的实时推送才直接落到界面上。
        if (replaying) lastAssistant = e.text;
        else setAssistantText(e.text);
        return;
      }
      // 非视频请求：立刻落终态，否则输入框会被当成"仍在执行"一直锁住
      if (e.type === 'job.out_of_scope') {
        stopped.current = true;
        void sync();
        return;
      }
      if (e.type === 'job.watchdog_prompt' && e.text && e.trigger) {
        const wp: WatchdogPrompt = {
          trigger: e.trigger, text: e.text,
          role: 'system', at: e.at ?? new Date().toISOString(),
        };
        setWdPrompts((prev) => [...prev, wp].slice(-20));
        return;
      }
      /**
       * ★ 回放期间【一律不合并】状态字段，也不 sync()。
       *
       * 快照已经在建连之前取过了，界面上的 status/phase 就是当前真值；
       * 历史事件带的是当时的值，合进去就是让界面把生命周期重演一遍
       * （见 settleNow 上面的说明）。回放结束时统一 sync() 一次对齐。
       *
       * 唯一要记住的是「回放里出现过终态」：那说明任务已经结束，
       * 可以停掉兜底轮询，具体字段仍由 settleNow 的那次 sync 补齐。
       */
      if (replaying) {
        /**
         * 回放里出现终态 ⇒ 历史到头了（终态之后不会再有事件），
         * 这本身就是确定的结束点，不用等兜底计时器。
         * 已完成任务走的就是这条 —— 后端在回放里命中终态就 finish() 关连接，
         * 哨兵根本发不出来。
         */
        if (e.status && isTerminal(e.status)) { stopped.current = true; settleNow(); }
        return;
      }

      // 以下是【实时】事件：带完整状态字段，可直接合并
      setJob((prev) => prev ? {
        ...prev,
        status: e.status ?? prev.status,
        phase: e.phase !== undefined ? e.phase : prev.phase,
        progress_percent: e.progress_percent !== undefined ? e.progress_percent : prev.progress_percent,
        health: e.health ?? prev.health,
      } : prev);
      // 终态或健康状态变化时拉一次快照，确保字段完整
      if (e.status && isTerminal(e.status)) { stopped.current = true; void sync(); }
      else if (e.type === 'job.heartbeat_status' || e.type === 'job.phase') void sync();
    };

    // 先快照，再订阅（任务书 §12.1）
    void sync().then((j) => {
      // ★ 回调回来时这次 effect 可能已经被清理了（用户切走了）。
      // 不判这一下就会建出一条没人能关的僵尸连接。
      if (cancelled || !j) return;
      const done = isTerminal(j.status);

      // 终态任务【也要订阅】：SSE 端点会先回放全部持久化事件再关闭，
      // 这是取回历史执行过程的唯一途径。此前直接 return，导致回看
      // 已完成任务时过程框永远空白（事件在服务端，但前端从不索取）。
      // ★ 不订阅时直接跳过建连（轮询仍然继续，状态不受影响）。
      //   判断必须放在 cancelled 之后、建连之前 —— 不能提前 return，
      //   否则下面的兜底轮询也被跳过，进行中任务的状态就不更新了。
      if (!subscribe) {
        if (!done) startPolling(document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
        return;
      }
      setLoadingEvents(true);
      bumpSettle();                                // 一条都不来时也要有个了结
      try {
        unsub = subscribeJob(jobId, onEvent, {
          lastEventId: maxSeq.current,
          onError: () => {
            /**
             * ★ 终态任务回放完会正常关闭连接 —— 这就是它的「回放结束」确定信号
             * （哨兵发不出来：回放里命中 job.completed 时后端已经 finish() 了）。
             * 不算故障，不必降级为轮询，但必须在这里收掉加载态，
             * 否则进度条要等兜底计时器超时才消失。
             */
            if (done) { settleNow(); return; }
            setSseOk(false);
            startPolling(document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
          },
        });
      } catch {
        if (!done) setSseOk(false);
      }

      // 只有进行中的任务需要兜底轮询
      if (!done) startPolling(document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
    });

    const onVis = () => {
      if (!document.hidden) void sync();          // 重新可见立即同步
      startPolling(document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      cancelled = true;                     // 先置位：挡住还在路上的 sync() 回调
      document.removeEventListener('visibilitychange', onVis);
      if (pollTimer) clearInterval(pollTimer);
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      pendingProc.current = [];
      setLoadingEvents(false);
      unsub?.();
      unsub = null;
    };
    // ★ subscribe 进依赖：展开过程框时重跑本 effect 从而建连。
    //   它复用同一套 cleanup —— cancelled 与 unsub 的竞态处理绝不能绕开，
    //   否则又会出现线上那次 SSE 泄漏（open 255 / close 139，净漏 116 条，
    //   僵尸连接的闭包会把别的任务的状态盖到当前界面上）。
  }, [jobId, sync, subscribe]);

  return {
    job, sseOk, refresh: sync,
    processEvents, wdPrompts, assistantText, ccSessionId, loadingEvents,
  };
}

/**
 * 前端心跳（V2 需求 5）。
 *
 * 关键：浏览器会节流隐藏页面的 setInterval（可能慢到每分钟一次），
 * 所以切标签页【不能】被判成离开。做法：
 *   · 心跳间隔 30s，服务端阈值 600s，留足节流余量
 *   · visibilitychange 恢复可见时立即补发
 *   · 关页时用 sendBeacon 通知（不可靠，仅作参考，真正判定靠服务端超时）
 */
export function usePresence(sessionIds: (string | null)[] | string | null, active: boolean) {
  // tabId 存 sessionStorage：同一标签页刷新后复用同一个 id。
  // 否则每次刷新都算一个"新标签页"，服务端会以为在线人数一直在涨
  // （实测攒到 15 个，其中 14 个早关了）。sessionStorage 天然按标签页隔离，
  // 新开标签页会拿到各自的新 id，正是我们要的语义。
  const tabId = useRef<string>('');
  if (!tabId.current) {
    let v = '';
    try {
      v = sessionStorage.getItem('cvw:tab') ?? '';
      if (!v) { v = uuid(); sessionStorage.setItem('cvw:tab', v); }
    } catch { v = uuid(); }    // 隐私模式：退回每次新建，不影响功能
    tabId.current = v;
  }
  // 依赖用稳定字符串，避免每次渲染新数组导致 effect 反复重建
  const ids = (Array.isArray(sessionIds) ? sessionIds : [sessionIds])
    .filter((x): x is string => !!x);
  const key = [...new Set(ids)].sort().join(',');

  useEffect(() => {
    const list = key ? key.split(',') : [];
    if (!list.length || !active) return;
    let alive = true;

    // ★ 必须给【所有有任务在跑的会话】发心跳，不只是当前聚焦的那个。
    // 之前只发 boot.session：用户一旦新建对话或切走，旧会话的任务
    // 就断了心跳，超过 presence 阈值后被 presence_lost 杀掉 —— 线上实测连杀 3 个会话
    // （sess_bda2cdd0 等），用户只看到"跑一半没了"。
    const beat = () => {
      if (!alive) return;
      for (const sid of list) api.presenceBeat(sid, tabId.current).catch(() => {});
    };
    beat();
    const t = setInterval(beat, 30_000);

    // 页面恢复可见 → 立即补一次，抵消隐藏期间的定时器节流
    const onVis = () => { if (!document.hidden) beat(); };
    document.addEventListener('visibilitychange', onVis);

    // 关页：尽力通知一次。不可靠，服务端仍靠 600s 超时判定。
    const onUnload = () => {
      try {
        for (const sid of list) {
          navigator.sendBeacon?.(
            withBase(`/api/sessions/${sid}/presence/leave`),
            new Blob([JSON.stringify({ tab_id: tabId.current })], { type: 'application/json' }),
          );
        }
      } catch { /* 尽力而为 */ }
    };
    window.addEventListener('pagehide', onUnload);

    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onUnload);
    };
  }, [key, active]);
}

/** 每秒重算一次「已运行多久」，基于服务端时间戳而非前端计数器。 */
export function useTick(active: boolean): number {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  return Date.now();
}
