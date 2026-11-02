/**
 * Gateway 配置。集中读取 config/backend.json + 环境变量，启动即校验。
 * 不合规直接退出，避免半配置状态运行。
 */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const repoRoot = resolve(process.env.CVW_REPO_ROOT ?? join(import.meta.dirname, '../../..'));
const backendCfgPath = process.env.CVW_BACKEND_CONFIG ?? join(repoRoot, 'config/backend.json');
const raw = JSON.parse(readFileSync(backendCfgPath, 'utf8'));

function req(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`[gateway/config] 缺少必需配置 ${name}`);
  return v;
}

const internalToken = req('CVW_INTERNAL_TOKEN');
if (String(internalToken).length < 16) {
  throw new Error('[gateway/config] CVW_INTERNAL_TOKEN 长度必须 ≥ 16，拒绝启动');
}

export const config = {
  repoRoot,
  backendCfgPath,
  raw,

  server: {
    // 前端在另一台机器，所以 Gateway 要绑 0.0.0.0。
    // 浏览器仍不直连 Gateway —— /api/* 经前端的 rewrites 转发；
    // /internal/* 由 deployment.internal_allowed_cidrs 限制来源网段。
    port: Number(process.env.CVW_GATEWAY_PORT ?? raw.deployment?.gateway?.port ?? 9998),
    host: process.env.CVW_GATEWAY_HOST ?? raw.deployment?.gateway?.bind ?? '0.0.0.0',
  },

  auth: {
    // 内部 API（Bridge ↔ Gateway）的共享密钥
    internalToken,
    // 浏览器会话 Cookie 签名密钥
    sessionSecret: process.env.CVW_SESSION_SECRET ?? 'dev-only-insecure-secret-change-me',
    sessionCookieName: raw.auth?.session_cookie_name ?? 'cvw_session',
    sessionMaxAgeMs: 7 * 24 * 3600 * 1000,
  },

  // Prompt 增强策略；请求 enhance:false 可逐任务跳过。
  promptEnhancement: raw.prompt_enhancement ?? { enabled: false, provider: 'none' },

  concurrency: raw.concurrency,
  /** 版本号（仓库根 VERSION，前后端同号）。/healthz 返回，便于确认线上跑的是哪版。 */
  /**
   * 环境标识（dev / prod）。来自 config.environment.name。
   * /healthz 会返回它，前端显示角标 —— 避免把开发环境当线上用。
   */
  environment: raw.environment?.name ?? 'prod',
  environmentDisplay: raw.environment?.display ?? null,

  appVersion: (() => {
    try { return readFileSync(join(repoRoot, 'VERSION'), 'utf8').trim(); }
    catch { return 'unknown'; }
  })(),
  branding: raw.branding ?? {},

  storage: {
    ...raw.storage,
    // 控制面根目录。支持 env 覆盖 —— 否则单测/压测会直接写进生产 runtime
    // （踩过：幂等并发测试在真实目录里留下了 3 个假 job，出现在队列里）。
    root: process.env.CVW_STORAGE_ROOT ?? raw.storage.root,
    // 会话数据根目录（存储充足的卷）；未配置则回退 root
    sessionsRoot: process.env.CVW_SESSIONS_ROOT
      ?? raw.storage.sessions_root
      ?? process.env.CVW_STORAGE_ROOT
      ?? raw.storage.root,
  },
  sessionStore: raw.session_store,

  timing: {
    workerHeartbeatIntervalMs: 12_000,
    jobHeartbeatIntervalMs: 20_000,
    leaseTtlMs: 120_000,
    cancelGraceMs: 60_000,
    // Watchdog
    sweepIntervalMs: 10_000,
    suspectAfterMs: 36_000,
    unavailableAfterMs: 120_000,
    stallWarnMs: 600_000,
    jobMaxRuntimeMs: 3 * 3600 * 1000,
    unknownMaxMs: 1_800_000,
  },

  bridge: {
    // Gateway → Bridge 的出向调用超时。注意：投任务是异步的，不能按生成时长设超时
    requestTimeoutMs: 20_000,
  },
};

export function describeGatewayConfig() {
  return {
    listen: `${config.server.host}:${config.server.port}`,
    global_max_concurrent_jobs: config.concurrency.global_max_concurrent_jobs,
    per_machine_max_concurrent_jobs: config.concurrency.per_machine_max_concurrent_jobs,
    version: config.appVersion,
    environment: config.environment,
    model_display_name: config.branding?.model_display_name ?? null,
    storage_root: config.storage.root,
    sessions_root: config.storage.sessionsRoot,
    session_store_driver: config.sessionStore?.driver ?? 'file',
    prompt_enhancement: config.promptEnhancement.enabled
      ? `enabled (${config.promptEnhancement.provider})`
      : 'disabled — 用户输入直接投递',
    declared_workers: raw.workers.filter((w) => w.enabled !== false).map((w) => w.worker_id),
    model: raw.model.model,
  };
}
