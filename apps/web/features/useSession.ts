'use client';
/** Authentication opens an empty workspace; conversations load only after selection. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { hashScope, saveContext } from '@/lib/local-state';
import type { Job, Maintenance, Mode, Permissions, SessionBinding, SessionInfo, SessionOptions, User } from '@/lib/types';

export type Boot = {
  loading: boolean; switching: boolean;
  user: User | null; permissions: Permissions | null;
  session: SessionInfo | null; binding: SessionBinding | null;
  jobs: Job[]; activeJob: Job | null; runningJobs: Job[]; recentJobs: Job[];
  historyLoading: boolean; historyError: string | null;
  maintenance: Maintenance; error: string | null;
};
const EMPTY: Boot = {
  loading: true, switching: false, user: null, permissions: null, session: null,
  binding: null, jobs: [], activeJob: null, runningJobs: [], recentJobs: [],
  historyLoading: true, historyError: null,
  maintenance: { active: false }, error: null,
};
type SessionSnapshot = {
  session: SessionInfo; binding: SessionBinding | null; jobs: Job[]; active_job: Job | null;
};
const mergeCompleted = (previous: Job[], incoming: Job[]) =>
  [...new Map([...previous, ...incoming].filter(j => j.status === 'COMPLETED').map(j => [j.id, j])).values()]
    .sort((a, b) => String(b.finished_at ?? '').localeCompare(String(a.finished_at ?? ''))).slice(0, 200);

export function useBoot() {
  const [state, setState] = useState<Boot>(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;
  const navigation = useRef(0);
  const reloadId = useRef(0);
  const polling = useRef(false);
  const historyRequest = useRef(0);
  const unauthenticated = useCallback(() => {
    navigation.current++;
    reloadId.current++;
    historyRequest.current++;
    setState({ ...EMPTY, loading: false, error: 'UNAUTHENTICATED' });
  }, []);

  // Restore the sidebar automatically, independently of auth and navigation.
  // This endpoint lists jobs without scanning or restoring session snapshots.
  const refreshHistory = useCallback(async () => {
    const userId = stateRef.current.user?.id;
    if (!userId) return;
    const request = ++historyRequest.current;
    setState(s => ({ ...s, historyLoading: true, historyError: null }));
    try {
      const history = await api.history();
      if (request !== historyRequest.current || stateRef.current.user?.id !== userId) return;
      setState(s => ({ ...s, historyLoading: false, historyError: null,
        recentJobs: mergeCompleted(s.recentJobs, history.completed) }));
    } catch (e) {
      if (request !== historyRequest.current || stateRef.current.user?.id !== userId) return;
      if (e instanceof ApiError && e.status === 401) { unauthenticated(); return; }
      setState(s => ({ ...s, historyLoading: false, historyError: '历史加载失败，请重试。' }));
    }
  }, [unauthenticated]);

  // Background status never selects a conversation or loads full history.
  const refreshRunning = useCallback(async () => {
    const userId = stateRef.current.user?.id;
    if (!userId || polling.current) return;
    polling.current = true;
    try {
      const ctx = await api.activeContext({ brief: true });
      if (stateRef.current.user?.id !== userId) return;
      const nextIds = new Set(ctx.running_jobs.map(j => j.id));
      const vanished = stateRef.current.runningJobs.some(j => !nextIds.has(j.id));
      setState(s => ({ ...s, runningJobs: ctx.running_jobs,
        maintenance: ctx.maintenance ?? s.maintenance }));
      // A completion fetches only the bounded recent-jobs endpoint (at most 20).
      if (vanished) {
        const recent = await api.myJobs('recent');
        if (stateRef.current.user?.id === userId)
          setState(s => ({ ...s, recentJobs: mergeCompleted(s.recentJobs, recent.jobs) }));
      }
    } catch (e) {
      if (stateRef.current.user?.id === userId && e instanceof ApiError && e.status === 401)
        unauthenticated();
      // Transient failure keeps the editor and the previous maintenance status.
    } finally { polling.current = false; }
  }, [unauthenticated]);

  // Only authentication blocks startup. Later refreshes keep the explicitly
  // selected conversation; saved IDs and server active_session cannot select it.
  const reload = useCallback(async (silent = false) => {
    const request = ++reloadId.current, selection = navigation.current;
    const current = stateRef.current;
    if (!silent) setState(s => ({ ...s, loading: true, error: null }));
    try {
      const identity = current.user && current.permissions
        ? { user: current.user, permissions: current.permissions } : await api.me();
      const snap = current.session ? await api.getSession(current.session.id) : null;
      if (request !== reloadId.current || selection !== navigation.current) return;
      setState(s => ({ ...s, ...identity, loading: false, error: null,
        ...(snap ? { session: snap.session, binding: snap.binding, jobs: snap.jobs,
          activeJob: snap.active_job, recentJobs: mergeCompleted(s.recentJobs, snap.jobs) } : {}) }));
      if (current.user) void refreshRunning();
    } catch (e) {
      if (request !== reloadId.current || selection !== navigation.current) return;
      if (e instanceof ApiError && e.status === 401) { unauthenticated(); return; }
      if (silent) { setState(s => ({ ...s, loading: false })); return; }
      setState(s => ({ ...s, loading: false, error: e instanceof ApiError ? e.message : '网络错误' }));
    }
  }, [refreshRunning, unauthenticated]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { if (state.user) void refreshRunning(); }, [state.user?.id, refreshRunning]);
  useEffect(() => { if (state.user) void refreshHistory(); }, [state.user?.id, refreshHistory]);

  const adopt = useCallback((snap: SessionSnapshot) => {
    const user = stateRef.current.user;
    if (!user) return;
    saveContext({ userScope: hashScope(user.username), sessionId: snap.session.id,
      mode: snap.session.mode, jobId: snap.active_job?.id ?? null });
    setState(s => ({ ...s, loading: false, switching: false, error: null,
      session: snap.session, binding: snap.binding, jobs: snap.jobs, activeJob: snap.active_job,
      recentJobs: mergeCompleted(s.recentJobs, snap.jobs) }));
  }, []);

  const createSession = useCallback(async (mode: Mode, options?: SessionOptions) => {
    const request = ++navigation.current;
    setState(s => ({ ...s, switching: true }));
    try {
      const result = await api.createSession(mode, options);
      if (request !== navigation.current) return null;
      adopt({ session: result.session, binding: result.binding, jobs: [], active_job: null });
      return result;
    } catch (e) {
      if (request === navigation.current && e instanceof ApiError && e.status === 401) unauthenticated();
      throw e;
    } finally {
      if (request === navigation.current) setState(s => ({ ...s, loading: false, switching: false }));
    }
  }, [adopt, unauthenticated]);

  // Reuse the ownership-checked snapshot. No extra auth/history/session fetch.
  const switchSession = useCallback(async (sessionId: string) => {
    const request = ++navigation.current;
    setState(s => ({ ...s, switching: true }));
    try {
      const snap = await api.getSession(sessionId);
      if (request !== navigation.current) return null;
      adopt(snap);
      return snap;
    } catch (e) {
      if (request !== navigation.current) return null;
      if (e instanceof ApiError && e.status === 401) unauthenticated();
      throw e;
    } finally {
      if (request === navigation.current) setState(s => ({ ...s, loading: false, switching: false }));
    }
  }, [adopt, unauthenticated]);

  return { ...state, reload, refreshRunning, refreshHistory, createSession, switchSession };
}
