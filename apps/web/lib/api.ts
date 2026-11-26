/**
 * 类型化 API Adapter —— 前端唯一的出网口。
 * 组件不直接 fetch，也不含任何后端地址（走 next.config 的 rewrites 转发到 Gateway）。
 */
import { withBase } from './base-path';
import type {
  ModelConnectionInput, ModelConnectionView, ModelConnectionCheck, ExperimentalModel, ExperimentalSkillsInput, SessionOptions, Capacity, Enhancement, ExamplePrompt, GalleryBrief, GalleryItem, GalleryLoad, GalleryUser,
  InviteView, Job, JobEvent, Maintenance, Mode,
  OutOfScopeNotice, Permissions, ReferenceManifest, SessionBinding, SessionInfo, User,
} from './types';

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  // withBase：子路径部署（Kong）时补回被剥掉的前缀
  const res = await fetch(withBase(path), {
    ...init,
    credentials: 'same-origin',              // 会话 Cookie 由服务端管理
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = body?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'UNKNOWN', e.message ?? res.statusText, e.details);
  }
  return body as T;
}

export const api = {
  adminWhiteboxModel: () => call<{ model: ModelConnectionView }>('/api/admin/whitebox/model'),
  adminSaveWhiteboxModel: (input: ModelConnectionInput) => call<{ model: ModelConnectionView }>('/api/admin/whitebox/model', { method: 'PATCH', body: JSON.stringify(input) }),
  adminCheckWhiteboxModel: (input: ModelConnectionInput) => call<ModelConnectionCheck>('/api/admin/whitebox/model/check', { method: 'POST', body: JSON.stringify(input) }),
  adminModels: () => call<{ models: Record<'c2v' | 'enhancement', ModelConnectionView> }>('/api/admin/models'),
  adminSaveModel: (purpose: 'c2v' | 'enhancement', input: ModelConnectionInput) =>
    call<{ model: ModelConnectionView }>(`/api/admin/models/${purpose}`, { method: 'PATCH', body: JSON.stringify(input) }),
  adminCheckModel: (purpose: 'c2v' | 'enhancement', input: ModelConnectionInput) =>
    call<ModelConnectionCheck>(`/api/admin/models/${purpose}/check`, { method: 'POST', body: JSON.stringify(input) }),
  personalModel: () => call<{ model: ModelConnectionView | null }>('/api/experimental/custom-model'),
  savePersonalModel: (input: ModelConnectionInput) => call<{ model: ModelConnectionView }>('/api/experimental/custom-model', { method: 'POST', body: JSON.stringify(input) }),
  checkPersonalModel: (input: ModelConnectionInput) => call<ModelConnectionCheck>('/api/experimental/custom-model/check', { method: 'POST', body: JSON.stringify(input) }),
  /* 认证 */
  login: (username: string, password: string) =>
    call<{ user: User }>('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ username, password }),
    }),

  /** 邀请码注册。白模权限由邀请码决定，用户不能自选。 */
  register: (invite_code: string, username: string, password: string) =>
    call<{ user: User; invite_id: string }>('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ invite_code, username, password }),
    }),

  logout: () => fetch(withBase('/api/auth/logout'), { method: 'POST', credentials: 'same-origin' }),

  changePassword: (current_password: string, new_password: string) =>
    call<{ user: User }>('/api/auth/change-password', {
      method: 'POST', body: JSON.stringify({ current_password, new_password }),
    }),

  me: () => call<{ user: User; permissions: Permissions; server_time: string }>('/api/auth/me'),

  /* 管理后台 */
  adminUsers: () =>
    call<{ users: (User & { status: string; running_jobs_count: number; must_change_password: boolean; created_at: string; last_login_at: string | null })[] }>('/api/admin/users'),

  adminSetBlockout: (username: string, allowed: boolean) =>
    call<{ user: User; running_jobs_kept: string[]; note: string }>(
      `/api/admin/users/${encodeURIComponent(username)}/permissions`, {
        method: 'PATCH', body: JSON.stringify({ can_use_blockout_3d: allowed }),
      }),

  adminSetExperimental: (username: string, allowed: boolean) =>
    call<{ user: User; note: string }>(`/api/admin/users/${encodeURIComponent(username)}/permissions`, {
      method: 'PATCH', body: JSON.stringify({ can_use_experimental: allowed }),
    }),
  whiteboxSettings: () => call<{ default_model_id: string; default_skills: import('./types').ExperimentalSkillsInput; models: ExperimentalModel[]; skills: import('./types').ConfiguredSkill[] }>('/api/whitebox/settings'),
  experimentalSkills: () => call<{ skills: import('./types').ConfiguredSkill[] }>('/api/experimental/skills'),
  experimentalModels: () => call<{ models: ExperimentalModel[] }>('/api/experimental/models'),

  adminSetStatus: (username: string, status: 'active' | 'disabled') =>
    call<{ user: User }>(`/api/admin/users/${encodeURIComponent(username)}`, {
      method: 'PATCH', body: JSON.stringify({ status }),
    }),

  adminResetPassword: (username: string) =>
    call<{ user: User; temporary_password: string; hint: string }>(
      `/api/admin/users/${encodeURIComponent(username)}/reset-password`, { method: 'POST' }),

  adminInvites: () =>
    call<{ invites: InviteView[] }>('/api/admin/invites'),

  /** 我的历史：按时间倒序，分进行中/已完成/已放弃 */
  history: () =>
    call<{
      running: Job[]; completed: Job[]; abandoned: Job[];
      counts: { running: number; completed: number; abandoned: number };
    }>('/api/me/history'),

  adminGallery: (opts?: { limit?: number; user?: string }) =>
    call<{
      items: GalleryItem[];
      users: GalleryUser[];
      totals: { jobs: number; completed: number; users: number };
      load?: GalleryLoad & {
        running_list: GalleryBrief[]; queued_list: GalleryBrief[]; enhancing_list: GalleryBrief[];
      };
    }>(`/api/admin/gallery?limit=${opts?.limit ?? 200}${opts?.user ? `&user=${encodeURIComponent(opts.user)}` : ''}`),

  /* 示例 prompt */
  examples: () => call<{ examples: ExamplePrompt[] }>('/api/examples'),
  useExample: (id: string) =>
    call<{ ok: boolean }>(`/api/examples/${encodeURIComponent(id)}/use`, { method: 'POST' }),
  adminExamples: () => call<{ examples: ExamplePrompt[] }>('/api/admin/examples'),
  adminCreateExample: (b: { title: string; prompt: string; mode: Mode; note?: string }) =>
    call<{ example: ExamplePrompt }>('/api/admin/examples', {
      method: 'POST', body: JSON.stringify(b),
    }),
  adminUpdateExample: (id: string, b: Partial<ExamplePrompt>) =>
    call<{ example: ExamplePrompt }>(`/api/admin/examples/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify(b),
    }),
  adminDeleteExample: (id: string) =>
    call<{ ok: boolean }>(`/api/admin/examples/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * 上传示例片。
   *
   * 用 XMLHttpRequest 而不是 fetch：**fetch 拿不到上传进度**
   * （只有 ReadableStream 上传那套实验性 API 才行，Safari 不支持）。
   * 示例片可以上到 200MB，没有进度条的话管理员会以为页面卡死然后重复点。
   */
  adminUploadExampleVideo: (
    id: string, file: File, onProgress?: (pct: number) => void,
  ) => new Promise<{ example: ExamplePrompt }>((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', withBase(`/api/admin/examples/${encodeURIComponent(id)}/video`));
    xhr.withCredentials = true;
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      let body: { example?: ExamplePrompt; error?: { code?: string; message?: string } } = {};
      try { body = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && body.example) {
        resolve({ example: body.example });
      } else {
        reject(new ApiError(xhr.status, body.error?.code ?? 'UPLOAD_FAILED',
          body.error?.message ?? `上传失败（HTTP ${xhr.status}）`));
      }
    };
    // 网络层失败没有 body，给一句能看懂的话
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', '上传失败：网络中断'));
    xhr.onabort = () => reject(new ApiError(0, 'ABORTED', '上传已取消'));
    xhr.send(fd);
  }),

  adminDeleteExampleVideo: (id: string) =>
    call<{ example: ExamplePrompt }>(
      `/api/admin/examples/${encodeURIComponent(id)}/video`, { method: 'DELETE' }),

  /** 示例片的播放地址（给 <video src>，不经 call()） */
  exampleVideoUrl: (id: string) => withBase(`/api/examples/${encodeURIComponent(id)}/video`),

  adminChannels: () =>
    call<{ channels: string[]; default: string }>('/api/admin/channels'),

  adminSetChannel: (username: string, body: { channel?: string; note?: string }) =>
    call<{ user: User }>(`/api/admin/users/${encodeURIComponent(username)}/channel`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),

  adminCreateInvite: (opts: {
    max_uses?: number; valid_days?: number; grants_blockout_3d?: boolean;
    note?: string; channel?: string;
  }) =>
    call<{ invite: InviteView; code: string; expires_at: string; valid_days: number; hint: string }>(
      '/api/admin/invites', { method: 'POST', body: JSON.stringify(opts) }),

  adminRevokeInvite: (id: string) =>
    call<{ invite: InviteView }>(`/api/admin/invites/${encodeURIComponent(id)}/revoke`, {
      method: 'POST',
    }),

  /* 会话 */
  createSession: (mode: Mode, options?: SessionOptions) =>
    call<{ session: SessionInfo; binding: SessionBinding; skill: string }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ mode, ...options }),
    }),

  getSession: (id: string) =>
    call<{
      session: SessionInfo; binding: SessionBinding;
      jobs: Job[]; active_job: Job | null;
    }>(`/api/sessions/${id}`),

  /**
   * 提交生成任务。
   * idempotencyKey 必须在表单首次渲染时生成并缓存 —— 若在点击时生成，
   * 双击会产生两个不同 key，绕过幂等，导致两个昂贵任务。
   */
  submitJob: (
    sessionId: string,
    prompt: string,
    idempotencyKey: string,
    opts?: { is_revision?: boolean; enhance?: boolean; fast_mode?: boolean; experimental_skills?: ExperimentalSkillsInput },
  ) =>
    call<{
      job: Job | null;
      idempotent_replay: boolean;
      /** 非视频请求：不建 Job，前端显示提示（V2） */
      out_of_scope?: boolean;
      notice?: OutOfScopeNotice;
      enhancement?: Enhancement;
    }>(`/api/sessions/${sessionId}/jobs`, {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ prompt, ...opts }),
    }),

  /* ───────── Reference 附件（V2 需求 1）───────── */

  listReferences: (sessionId: string) =>
    call<ReferenceManifest>(`/api/sessions/${sessionId}/references`),

  /** 上传用 FormData，不能走 call()（它固定 JSON content-type） */
  uploadReference: async (sessionId: string, file: File, note?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    if (note) fd.append('note', note);
    const res = await fetch(withBase(`/api/sessions/${sessionId}/references`), {
      method: 'POST', credentials: 'same-origin', body: fd,
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const e = body?.error ?? {};
      throw new ApiError(res.status, e.code ?? 'UPLOAD_FAILED', e.message ?? res.statusText, e.details);
    }
    return body as { item: unknown; manifest: ReferenceManifest };
  },

  deleteReference: (sessionId: string, name: string) =>
    call<ReferenceManifest>(`/api/sessions/${sessionId}/references/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),

  /* ───────── 心跳（V2 需求 5）───────── */

  presenceBeat: (sessionId: string, tabId: string) =>
    call<{ ok: boolean; timeout_seconds: number }>(`/api/sessions/${sessionId}/presence`, {
      method: 'POST', body: JSON.stringify({ tab_id: tabId }),
    }),

  /* 任务 */
  getJob: (id: string) => call<{ job: Job }>(`/api/jobs/${id}`),

  cancelJob: (id: string) =>
    call<{ job: Job; already_requested?: boolean }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),

  /**
   * 恢复兜底：localStorage 丢失 / 换设备时按账号找回。
   *
   * ★ brief=true 时服务端【不返回】recent_completed_jobs（键直接不存在）。
   *   侧栏那个 20 秒定时器只需要 running_jobs，而全量响应 dev 实测 652 KB、
   *   99% 是不会变的已完成历史 —— 每 20 秒重发一遍把出口占满了。
   *   所以 recent_completed_jobs 这里是**可选**的，调用方必须按
   *   「键不存在 ⇒ 这趟没有历史」处理，不能当成空列表。
   */
  activeContext: (opts?: { brief?: boolean }) =>
    call<{
      active_session: SessionInfo | null;
      running_jobs: Job[];
      recent_completed_jobs?: Job[];
      maintenance?: Maintenance;
      brief?: boolean;
    }>(`/api/me/active-context${opts?.brief ? '?brief=1' : ''}`),

  myJobs: (status: 'active' | 'recent' | 'all' = 'active') =>
    call<{ jobs: Job[] }>(`/api/me/jobs?status=${status}`),

  capacity: () => call<Capacity>('/api/system/capacity'),
};

/** Gateway 发出的全部事件名（apps/gateway/src 中 'job.*' 字面量的全集）。 */
const EVENT_TYPES = [
  'job.queued', 'job.assigned', 'job.started', 'job.phase', 'job.progress',
  'job.heartbeat_status', 'job.cancel_requested', 'job.cancelling', 'job.cancelled',
  'job.completed', 'job.failed', 'job.state_unknown', 'job.recovering',
  // ↓ 以下四类此前全部漏注册
  'job.process',            // cc 的工具调用与中间返回（过程框的唯一数据来源）
  'job.assistant_text',     // cc 的文字回复
  'job.enhancing',          // 正在理解需求
  'job.out_of_scope',       // 非视频请求
  'job.watchdog_prompt',    // 系统自发的后端巡检话术
  'job.presence_lost',      // 心跳丢失
  'job.replay_done',        // ★ 历史回放结束的分界点（不是真事件，不带 seq）
] as const;

/**
 * 订阅 Job 事件（SSE）。断线后以 Last-Event-ID 续传，先取权威快照再接流。
 * 返回取消订阅函数。
 */
export function subscribeJob(
  jobId: string,
  onEvent: (e: JobEvent) => void,
  opts?: { lastEventId?: number; onError?: (e: unknown) => void },
): () => void {
  const url = `/api/jobs/${jobId}/events${opts?.lastEventId ? `?last_event_id=${opts.lastEventId}` : ''}`;
  const es = new EventSource(withBase(url), { withCredentials: true });
  const handler = (ev: MessageEvent) => {
    try { onEvent(JSON.parse(ev.data) as JobEvent); } catch { /* 忽略畸形事件 */ }
  };

  // ★ 必须与 Gateway 实际发出的 event: 名字完全一致。
  // 这里漏一个名字，对应的数据就【静默丢弃】—— 曾因漏掉 job.process
  // 导致 298 条过程事件全部收不到，过程框永远空白。
  // 新增后端事件类型时，这个列表必须同步。
  for (const t of EVENT_TYPES) es.addEventListener(t, handler as EventListener);

  // 兜底：若后端新增了未登记的事件名，仍能通过默认 message 收到
  es.onmessage = handler as (ev: MessageEvent) => void;
  es.onerror = (e) => opts?.onError?.(e);
  return () => es.close();
}
