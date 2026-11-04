/** 与 Gateway 的 API 契约共享的类型。字段对齐 openapi/openapi.yaml。 */

export type Mode = 'coding_to_video' | 'blockout_3d' | 'experimental';
export type ExperimentalModel = {
  profile_id: string; name: string; model: string; revision: string;
};
export type ConfiguredSkill = {
  id: string; name: string; version: string; archive_sha256: string; description?: string; source?: unknown;
};
export type ExperimentalSkillsInput = {
  builtin: 'none' | 'coding_to_video' | 'blockout_3d'; text?: string;
  configured?: ConfiguredSkill[];
  archive_base64?: string; archive_name?: string; clear_archive?: boolean;
};
export type ExperimentalSkills = ExperimentalSkillsInput & { revision?: string; skills?: string[] };
export type SessionOptions = { model_id?: string; builtin_skills?: ExperimentalSkillsInput['builtin'] };


export type JobStatus =
  | 'ENHANCING'                                  // V2：正在理解需求（opus 增强）
  | 'QUEUED' | 'ASSIGNED' | 'RUNNING'
  | 'CANCEL_REQUESTED' | 'CANCELLING' | 'CANCELLED'
  | 'COMPLETED' | 'FAILED'
  | 'OUT_OF_SCOPE'                               // V2：非视频请求，不投产
  | 'UNKNOWN' | 'RECOVERING';

export type JobPhase = 'PREPARING' | 'GENERATING' | 'RENDERING' | 'FINALIZING' | null;

/** 对应任务书 §7.5 的五分类。前端据此选文案，不自行推断。 */
export type Assessment =
  | 'HEALTHY_RUNNING' | 'HEALTHY_STALLED' | 'HEARTBEAT_LOST'
  | 'CONFIRMED_FAILED' | 'STATE_UNKNOWN';

export const TERMINAL: JobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'OUT_OF_SCOPE'];
export const isTerminal = (s: JobStatus) => TERMINAL.includes(s);

export type User = {
  id: string;
  username: string;
  role: 'admin' | 'user';
  /** 与 role 独立：role='user' ∧ can_use_blockout_3d=true 是合法的"业务用户" */
  can_use_blockout_3d: boolean;
  can_use_experimental?: boolean;
  status?: 'active' | 'disabled';
  must_change_password?: boolean;
  created_at?: string;
  last_login_at?: string | null;
  /** 渠道：区分测试账户与外发账户（test/external/...） */
  channel?: string;
  /** 管理员备注，用于标注来源/用途 */
  note?: string | null;

};

export type InviteView = {
  id: string;
  code_prefix: string;
  max_uses: number;
  used_count: number;
  grants_blockout_3d: boolean;
  expires_at: string;
  valid_days: number;
  revoked_at: string | null;
  created_at: string;
  note: string | null;
  /** valid | exhausted | expired | revoked */
  status: string;
  used_by: { username: string; at: string }[];
  /** 完整邀请码。管理员接口返回，用于事后复制；老记录为 null */
  code?: string | null;
  expires_at_label?: string;

  /** 该码注册出的用户归属渠道 */
  channel?: string | null;

};

export type Permissions = { modes: Mode[]; is_admin: boolean };

export type SessionBinding = {
  worker_id: string;
  process_instance_id: string;
  status: 'BOUND' | 'SUSPECTED' | 'PROCESS_LOST' | 'RELEASED';
  bound_at?: string;
  health_note?: string | null;
};

export type SessionInfo = {
  model_selection?: ExperimentalModel | null;
  experimental_skills?: ExperimentalSkills | null;
  id: string;
  mode: Mode;
  status: 'ACTIVE' | 'DEGRADED' | 'CLOSED';
  created_at: string;
  last_activity_at: string;
};

export type Asset = {
  id: string;
  state: 'PENDING' | 'VERIFYING' | 'READY' | 'CORRUPT' | 'ABANDONED';
  kind: string;
  size_bytes: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  playable: boolean;
  /** 网页播放地址 —— 下发的是【降采样预览片】（见 config.preview） */
  playback_url: string;
  /** 显式「下载原片」地址 —— 永远是原片，不降采样 */
  download_url: string;
  /**
   * 预览片信息。`size_bytes` 顶上的那个是【原片】大小。
   * mode:'none' 表示原片本来就低于码率上限，播的就是原片（没有第二份文件）。
   */
  preview: {
    mode: 'reencode' | 'none';
    size_bytes: number | null;
    width: number | null;
    height: number | null;
  } | null;
};

export type Job = {
  model_selection?: ExperimentalModel | null;
  experimental_skills?: ExperimentalSkills | null;
  id: string;
  session_id: string;
  mode: Mode;
  status: JobStatus;
  phase: JobPhase;
  /** ⚠️ 可为 null —— 后端不提供时前端【绝不】显示百分比 */
  progress_percent: number | null;
  created_at: string;
  queued_at: string | null;
  started_at: string | null;
  phase_started_at: string | null;
  last_heartbeat_at: string | null;
  last_progress_at: string | null;
  finished_at: string | null;
  elapsed: {
    queued_ms: number | null;
    running_ms: number | null;
    current_phase_ms: number | null;
  };
  health: {
    worker_status: string;
    job_heartbeat_age_ms: number | null;
    progress_age_ms: number | null;
    stalled: boolean;
    assessment: Assessment;
  };
  cancellation: {
    requested_at: string | null;
    requested_by: string | null;
    reason: string | null;
    acked_at: string | null;
    effective: boolean | null;
    resources_released_at: string | null;
  };
  failure: { code: string | null; message: string | null };
  result_asset: Asset | null;
  attempt: number;
  max_runtime_seconds: number;
  prompt_summary: string;
  /**
   * cc 给用户看的最后一句话（随 job 快照下发）。
   * 有了它，「制作助手」不必为一句话去重放整条轨迹 ——
   * 过程框才能默认折叠而不丢信息。
   */
  last_assistant_text: string | null;
  /** 用户原始输入（完整） */
  original_prompt?: string | null;
  /** 增强后的制作方案；ENHANCING 阶段为 null */
  enhanced_prompt?: string | null;
  /** 排队位置；非 QUEUED 为 null */
  queue?: { position: number | null; total: number; ahead: number } | null;
  enhancement: Enhancement | null;
  notice: OutOfScopeNotice | null;
  presence_lost: boolean;
  poll_url: string;
  events_url: string;
};

export type JobEvent = {
  seq: number;
  type: string;
  job_id: string;
  at: string;
  status?: JobStatus;
  phase?: JobPhase;
  progress_percent?: number | null;
  health?: Job['health'];
  asset?: unknown;
  failure?: { code?: string; message?: string };
};

export type Capacity = {
  global: { capacity: number; used: number; queued: number };
  modes_share_capacity: boolean;
};

/* ───────── V2 新增 ───────── */

/** 过程事件（V2 需求 4）：claude 的工具调用与中间返回 */
export type ProcessEvent = {
  seq: number;
  at: string;
  kind: 'init' | 'tool_use' | 'tool_result' | 'thinking' | 'assistant_text' | 'result' | 'system';
  /** tool_use */
  tool?: string;
  tool_id?: string;
  input?: Record<string, unknown>;
  /** tool_result */
  is_error?: boolean;
  /** thinking / assistant_text / tool_result */
  text?: string;
  /** init */
  cc_session_id?: string;
  cwd?: string;
  skills?: string[];
  /** result */
  duration_ms?: number;
  num_turns?: number;
};

/** 系统自发的监控话术（V2 需求 7） */
export type WatchdogPrompt = {
  trigger: string;
  text: string;
  role: 'system';
  at: string;
};

export type ReferenceItem = {
  stored_name: string;
  original_name: string;
  type: 'image' | 'video' | 'audio';
  size_bytes: number;
  note: string | null;
  meta: {
    duration_s?: number;
    width?: number;
    height?: number;
    fps?: number;
    has_audio?: boolean;
  };
  uploaded_at: string;
};

export type ReferenceManifest = {
  items: ReferenceItem[];
  frozen: boolean;
  frozen_at?: string;
  max_per_session: number;
  remaining: number;
};

export type Enhancement = {
  skipped: boolean;
  reason: string | null;
  /** 服务端已不下发模型名（避免暴露技术路线）；保留字段仅为兼容旧响应 */
  model?: string | null;
  duration_ms: number | null;
  dense_length: number | null;
  assets_count: number | null;
};

export type OutOfScopeNotice = {
  code: string;
  title: string;
  message: string;
  suggestions: string[];
};

export type ApiError = { error: { code: string; message: string; details?: unknown } };

/** 管理员画廊条目 */
export type GalleryItem = {
  id: string;
  user_id: string;
  session_id: string;
  mode: Mode;
  status: JobStatus;
  created_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  prompt: string;
  success: boolean;
  has_video: boolean;
  size_bytes: number | null;
  playback_url: string | null;
  failure_code: string | null;
  enhancement_chars: number | null;
};

/** 画廊里的用户活跃度 */
export type GalleryUser = {
  user_id: string;
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  success_rate: number;
  total_duration_ms: number;
  avg_duration_ms: number | null;
  last_at: string | null;
  modes: Record<string, number>;
};

/** 管理员画廊的实时压力 */
export type GalleryLoad = {
  capacity: number;
  used: number;
  queued: number;
  enhancing: number;
  utilization: number;
  workers: {
    worker_id: string;
    processes: {
      status: string; running_jobs: number; max_concurrent_jobs: number;
      active_sessions: number; heartbeat_age_ms: number | null;
    }[];
  }[];
  running_list?: GalleryBrief[];
  queued_list?: GalleryBrief[];
  enhancing_list?: GalleryBrief[];
};

export type GalleryBrief = {
  id: string; user_id: string; mode: Mode; status: JobStatus;
  phase: string | null; worker_id: string | null;
  created_at: string; started_at: string | null;
  running_ms: number | null; queued_ms: number | null;
  queue_position: number | null; prompt: string;
};

/** 示例 prompt（管理员维护，用户点击即用） */
/**
 * 示例片的元信息（管理员上传，gateway 侧已 ffprobe + 解码校验过）。
 * 刻意**不含磁盘路径** —— 播放走 /api/examples/:id/video。
 */
export type ExampleVideo = {
  size_bytes: number;
  duration_ms: number;
  width: number;
  height: number;
  mime_type?: string;
  uploaded_at?: string;
  /**
   * 上传时做过的「预览化」处理（见 gateway examples.optimizeForPreview）：
   *   'reencode'  —— 码率超标，已降码率并缩到 720p 内
   *   'faststart' —— 码率没问题，只把 moov 搬到文件头
   * 没处理过就没有这个字段。
   */
  optimized?: 'reencode' | 'faststart';
  optimized_at?: string;
  /** 处理前的原始体积，用来告诉管理员「为什么比我传的小」 */
  original_size_bytes?: number;
};

export type ExamplePrompt = {
  id: string;
  title: string;
  prompt: string;
  mode: Mode;
  note?: string | null;
  enabled?: boolean;
  use_count?: number;
  created_at?: string;
  last_used_at?: string | null;
  /** 可选的示例片；没有则 null/缺省 */
  video?: ExampleVideo | null;
};

/** 热更新期间的维护状态（随 active-context 一起下发，不额外轮询）。 */
export type Maintenance = {
  active: boolean;
  title?: string | null;
  message?: string | null;
  started_at?: string | null;
  expected_seconds?: number | null;
};
