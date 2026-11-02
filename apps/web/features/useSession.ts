'use client';
/**
 * 会话与恢复。
 *
 * 恢复流程（任务书 §8.3）：
 *  1. 查登录  2. 读 localStorage 候选 ID  3. active-context 服务端兜底
 *  4. 校验归属  5. 拉快照  6. 恢复 UI  7. 订阅事件
 *
 * 永不相信浏览器关闭前缓存的状态 —— 本地只提供候选 ID。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { hashScope, loadContext, saveContext } from '@/lib/local-state';
import type { Job, Maintenance, Mode, Permissions, SessionBinding, SessionInfo, SessionOptions, User } from '@/lib/types';

export type Boot = {
  loading: boolean;
  user: User | null;
  permissions: Permissions | null;
  session: SessionInfo | null;
  binding: SessionBinding | null;
  jobs: Job[];
  activeJob: Job | null;
  runningJobs: Job[];
  recentJobs: Job[];
  /** 热更新中：横幅 + 禁用输入。随 active-context 下发，不额外轮询。 */
  maintenance: Maintenance;
  error: string | null;
};

const EMPTY: Boot = {
  loading: true, user: null, permissions: null, session: null, binding: null,
  jobs: [], activeJob: null, runningJobs: [], recentJobs: [],
  maintenance: { active: false }, error: null,
};

/** api.getSession 的返回形状（reload 复用预取快照时要用） */
type SessionSnapshot = {
  session: SessionInfo;
  binding: SessionBinding | null;
  jobs: Job[];
  active_job: Job | null;
};

export function useBoot() {
  const [state, setState] = useState<Boot>(EMPTY);
  // 只读当前 state 用，不进回调依赖 —— 否则 reload/switchSession 每次 state 变就重建
  const stateRef = useRef<Boot>(state);
  stateRef.current = state;

  /**
   * 拉取全局快照。
   * @param silent 后台轮询用。【不】翻 loading —— 否则每次轮询整页都会被
   *   替换成「正在恢复会话…」，用户看到的是每 20 秒闪一次（实测反馈）。
   *   只有首次进入与显式重试才需要全屏 loading。
   */
  const reload = useCallback(async (silent = false, prefetch?: SessionSnapshot | null) => {
    setState((s) => (silent ? { ...s, error: null } : { ...s, loading: true, error: null }));
    try {
      /**
       * me 与 active-context 互不依赖 —— 并行发。
       *
       * 原来是串行：me → activeContext → getSession，一次 reload 三个往返。
       * 切换对话时 switchSession 又在前面串了两个，一共【五个串行请求】，
       * 其中两个还是重复的 —— 用户反馈「切 session 非常卡、跳来跳去」就是这个。
       * （loadContext 需要 user.username 算 scope，所以它只能排在 me 之后，
       *   但 activeContext 不需要，没理由等。）
       */
      const [meRes, ctx] = await Promise.all([api.me(), api.activeContext()]);
      const { user, permissions } = meRes;
      const scope = hashScope(user.username);
      const local = loadContext(scope);

      // 候选会话：本地优先，服务端兜底；归属由服务端校验
      let sessionId = local?.sessionId ?? ctx.active_session?.id ?? null;
      let session: SessionInfo | null = null;
      let binding: SessionBinding | null = null;
      let jobs: Job[] = [];
      let activeJob: Job | null = null;

      if (sessionId) {
        try {
          // switchSession 已经取过一次快照（它要用它校验归属）——直接复用，
          // 不要再发一次同样的请求。
          const snap = (prefetch && prefetch.session.id === sessionId)
            ? prefetch
            : await api.getSession(sessionId);
          session = snap.session;
          binding = snap.binding;
          jobs = snap.jobs;
          activeJob = snap.active_job;
        } catch (e) {
          // 本地候选已失效（他人会话/已删除）→ 退回服务端的活跃会话
          if (e instanceof ApiError && e.status === 404 && ctx.active_session) {
            const snap = await api.getSession(ctx.active_session.id);
            session = snap.session; binding = snap.binding;
            jobs = snap.jobs; activeJob = snap.active_job;
            sessionId = snap.session.id;
          } else {
            sessionId = null;
          }
        }
      }

      if (session) {
        saveContext({
          userScope: scope, sessionId: session.id, mode: session.mode,
          jobId: activeJob?.id ?? null,
        });
      }

      setState({
        loading: false, user, permissions, session, binding, jobs, activeJob,
        runningJobs: ctx.running_jobs, recentJobs: ctx.recent_completed_jobs ?? [],
        maintenance: ctx.maintenance ?? { active: false }, error: null,
      });
    } catch (e) {
      const msg = e instanceof ApiError
        ? (e.status === 401 ? 'UNAUTHENTICATED' : e.message)
        : '网络错误';
      // 静默刷新失败（网络抖动）不要清空已有状态，否则用户正看着的页面会突然变空。
      // 只有 401 必须立刻反映 —— 会话真的失效了。
      if (silent && msg !== 'UNAUTHENTICATED') {
        // 拉取失败时保留既有维护态：Gateway 重启期间本来就连不上，
        // 这时候把横幅撤掉反而让用户以为更新结束了。
        setState((s) => ({ ...s, loading: false }));
        return;
      }
      setState({ ...EMPTY, loading: false, error: msg });
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const createSession = useCallback(async (mode: Mode, options?: SessionOptions) => {
    const r = await api.createSession(mode, options);
    const { user } = await api.me();
    saveContext({
      userScope: hashScope(user.username), sessionId: r.session.id, mode, jobId: null,
    });
    await reload();
    return r;
  }, [reload]);

  /**
   * 切换当前对话。
   *
   * ★ 这是「续跑串台」的修复点（线上 yaotiankuo 反馈）。
   *
   * 原来点侧栏/创作历史里的任务只改 focusJobId —— 画面切到了 A，
   * 但输入框仍然提交到 boot.session（还是 B），于是续跑继承的是 B 的工作区。
   * 线上实测：用户以为在改 A，拿到的却是 B「一线万象」的 SPEC。
   * 1.4.0 起续跑是 cc --resume，提交错会话等于 resume 错对话，后果更重。
   *
   * 归属不需要前端校验：GET /api/sessions/:id 对非本人会话返回 404，
   * reload() 会把它当失效候选处理。
   */
  const switchSession = useCallback(async (sessionId: string) => {
    const snap = await api.getSession(sessionId);          // 不属于自己会抛 404
    // 不再重新 api.me()：用户名已经在 state 里，再要一次纯属多一个往返。
    // 首屏还没拿到 user 的极端情况下退回请求一次。
    const username = stateRef.current.user?.username ?? (await api.me()).user.username;
    saveContext({
      userScope: hashScope(username),
      sessionId: snap.session.id,
      mode: snap.session.mode,
      jobId: snap.active_job?.id ?? null,
    });
    // 把刚取到的快照传下去，reload 就不用再 getSession 一遍。
    // 切换一次的请求数：原来 5 个串行 → 现在 1 + 1 个并行往返。
    await reload(true, snap);
    return snap;
  }, [reload]);

  /** state.runningJobs 的镜像，供 refreshRunning 同步比较（见其中注释） */
  const runningIdsRef = useRef<string[]>([]);
  useEffect(() => {
    runningIdsRef.current = state.runningJobs.map((j) => j.id);
  }, [state.runningJobs]);

  /**
   * 侧栏「进行中」的轻量刷新 —— 给 20 秒定时器用。
   *
   * 和 reload 的区别（这就是本次的全部收益）：
   *   · 只打 **一个** 请求（brief 的 active-context），不调 me、不调 getSession；
   *   · 服务端不返回 recent_completed_jobs，所以**体积从 652 KB 降到约 1 KB**；
   *   · 只合并 runningJobs / maintenance，**绝不碰 recentJobs**
   *     —— 用空数组覆盖会让侧栏「已完成」整列消失。
   *
   * ★ 必须保留的回归点：别的会话里的任务完成时，「已完成」要能更新。
   *   brief 响应里没有历史，所以靠「running 集合变小」来发现：
   *   有 id 从 running 里消失 ⇒ 它落终态了 ⇒ 补**一次**完整 reload。
   *   这样每次完成最多多打一趟全量，而不是每 20 秒都打。
   *   （当前会话自己的任务另有 SSE 与「非终态→终态」跃迁那条路径，不依赖这里。）
   */
  const refreshRunning = useCallback(async () => {
    try {
      const ctx = await api.activeContext({ brief: true });
      const nextIds = new Set((ctx.running_jobs ?? []).map((j) => j.id));
      /**
       * ★ 判「有任务消失」必须用 ref，不能在 setState 的 updater 里给闭包变量赋值：
       *   React 18 的 updater 是**延后执行**的（StrictMode 下还会跑两次），
       *   同步读那个变量永远是初始值 —— 这条回归保护就等于没接上。
       */
      const vanished = runningIdsRef.current.some((id) => !nextIds.has(id));
      setState((s) => ({
        ...s,
        runningJobs: ctx.running_jobs ?? s.runningJobs,
        maintenance: ctx.maintenance ?? s.maintenance,
        error: null,
      }));
      if (vanished) await reload(true);
    } catch {
      /* 后台刷新失败不打扰用户，下一轮再试 */
    }
  }, [reload]);

  return { ...state, reload, refreshRunning, createSession, switchSession };
}
