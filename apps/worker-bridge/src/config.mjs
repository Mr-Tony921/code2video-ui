/**
 * Bridge 配置。全部来自环境变量与 config/backend.json，代码中无硬编码地址。
 * 启动即校验，不合规直接退出——避免半配置状态下跑起来。
 */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { experimentalEnabled } from '../../shared/experimental.mjs';

function req(name, fallback = undefined) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`[config] 缺少必需环境变量 ${name}`);
  }
  return v;
}

const repoRoot = resolve(process.env.CVW_REPO_ROOT ?? join(import.meta.dirname, '../../..'));
const backendCfgPath = process.env.CVW_BACKEND_CONFIG ?? join(repoRoot, 'config/backend.json');
const backendCfg = JSON.parse(readFileSync(backendCfgPath, 'utf8'));

const workerId = req('CVW_WORKER_ID');
const self = backendCfg.workers.find((w) => w.worker_id === workerId);
if (!self) {
  throw new Error(`[config] config/backend.json 中没有 worker_id=${workerId}`);
}

/**
 * 从 /v1/models 读模型真实 max_model_len，覆盖配置里的静态值。
 *
 * 为什么要自动探测：模型换版本时 max_model_len 会变，手写的值必然滞后。
 * 配小了白白浪费上下文（实测配 262144 而模型支持 524288，少了一半，
 * 复杂任务因此提前触发压缩甚至失败）；配大了模型直接拒绝请求。
 * 探测失败就沿用静态值 —— 绝不能因为探测不到就起不来。
 */
export async function detectModelContext(log = console) {
  if (!config.model.autoDetectContext) return null;
  try {
    const u = `${String(config.model.baseUrl).replace(/\/$/, '')}/v1/models`;
    const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    const hit = (body.data ?? []).find((m) => m.id === config.model.model) ?? (body.data ?? [])[0];
    const len = hit?.max_model_len ?? hit?.max_context_length ?? null;
    if (!len || !Number.isFinite(Number(len))) throw new Error('响应里没有 max_model_len');
    const prev = config.model.maxContextTokens;
    config.model.maxContextTokens = String(len);
    if (String(prev) !== String(len)) {
      log.warn(`[config] 模型上下文按实测修正: ${prev} → ${len}（来自 /v1/models）`);
    } else {
      log.log(`[config] 模型上下文已核对: ${len}`);
    }
    return Number(len);
  } catch (e) {
    log.warn(`[config] 探测 max_model_len 失败（沿用配置值 ${config.model.maxContextTokens}）: ${e.message}`);
    return null;
  }
}

export const config = {
  appVersion: readFileSync(join(repoRoot, 'VERSION'), 'utf8').trim(),
  repoRoot,
  backendCfgPath,
  raw: backendCfg,   // 原始配置，供需要读新增节的模块使用

  worker: {
    id: workerId,
    // Gateway 回调本 Bridge 时用的地址。本机联调可用 CVW_BRIDGE_HOST 覆盖为 127.0.0.1
    host: process.env.CVW_BRIDGE_HOST ?? self.bridge.host,
    port: Number(process.env.CVW_BRIDGE_PORT ?? self.bridge.port),
    maxConcurrentJobs: Number(process.env.CVW_MAX_CONCURRENT_JOBS ?? self.max_concurrent_jobs),
    maxSessions: Number(process.env.CVW_MAX_SESSIONS ?? self.max_sessions),
    supportedModes: [...new Set([...self.supported_modes, ...(experimentalEnabled(backendCfg) ? ['experimental'] : [])])],
  },

  gateway: {
    // Bridge 主动注册与心跳的目标。生产通路就是这条 HTTP，不经 SSH。
    baseUrl: req('CVW_GATEWAY_BASE_URL'),
    internalToken: req('CVW_INTERNAL_TOKEN'),
  },

  model: {
    baseUrl: process.env.CVW_MODEL_BASE_URL ?? backendCfg.model.base_url,
    apiKey: req(backendCfg.model.api_key_env, 'sk-local-proxy'),
    model: process.env.CVW_MODEL ?? backendCfg.model.model,
    maxContextTokens: String(backendCfg.model.max_context_tokens),
    maxOutputTokens: Number(process.env.CVW_MAX_OUTPUT_TOKENS ?? backendCfg.model.max_output_tokens ?? 32000),

    autoDetectContext: backendCfg.model.auto_detect_context === true,
    /**
     * 自动压缩触发阈值（百分比）→ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE。
     * 环境变量可临时覆盖，便于不改配置就验证。
     */
    autocompactPct: Number(process.env.CVW_AUTOCOMPACT_PCT ?? backendCfg.model.autocompact_pct ?? 80),
  },

  proxy: backendCfg.proxy,

  skills: {
    // 每个 mode 一组独立 skill 目录（与同事 benchmark 结构一致）
    skillsetsRoot: join(repoRoot, backendCfg.skills.skillsets_root),
    byMode: backendCfg.skills.by_mode,
    targetDirInSession: backendCfg.skills.target_dir_in_session,
    whiteboxSkillName: backendCfg.skills.whitebox_skill_name,
  },

  videokit: {
    root: backendCfg.runtime_binaries.videokit_root,
    nodeModules: backendCfg.runtime_binaries.videokit_node_modules,
    venvPython: backendCfg.runtime_binaries.videokit_venv_python,
  },

  isolation: backendCfg.isolation ?? { enabled: false },

  storage: {
    root: process.env.CVW_STORAGE_ROOT ?? backendCfg.storage.root,
    /**
     * 会话工作区与产物的落盘根目录。体积大（job 工作区、渲染中间文件、输出 mp4），
     * 单独放在存储充足的卷上。未配置则回退 root，保持旧行为。
     */
    sessionsRoot: process.env.CVW_SESSIONS_ROOT
      ?? backendCfg.storage.sessions_root
      ?? process.env.CVW_STORAGE_ROOT
      ?? backendCfg.storage.root,
    sessionsSubdir: backendCfg.storage.sessions_subdir,
    assetsSubdir: backendCfg.storage.assets_subdir,
  },

  claudeCli: {
    bin: process.env.CVW_CLAUDE_BIN ?? backendCfg.claude_cli.bin,
    settingsFileName: backendCfg.claude_cli.settings_file_name,
    permissionMode: backendCfg.claude_cli.permission_mode,
    extraArgs: backendCfg.claude_cli.extra_args ?? [],
    /** 传给 claude 进程的环境变量（config 可调，不用改代码） */
    env: backendCfg.claude_cli.env ?? {},
  },

  runtimeBinaries: {
    chromeBin: process.env.CHROME_BIN ?? backendCfg.runtime_binaries.chrome_bin,
    previsDependencyRoot:
      process.env.PREVIS_DEPENDENCY_ROOT ?? backendCfg.runtime_binaries.previs_dependency_root,
    ffmpeg: process.env.CVW_FFMPEG ?? backendCfg.runtime_binaries.ffmpeg,
    ffprobe: process.env.CVW_FFPROBE ?? backendCfg.runtime_binaries.ffprobe,
  },

  timing: {
    // 以 Gateway 注册响应下发的值为准；这里只是注册成功前的初始值。
    processHeartbeatSeconds: 12,
    jobHeartbeatSeconds: 20,
    leaseTtlSeconds: 120,
    cancelGraceSeconds: 60,
    sigtermToSigkillSeconds: 20,
    /**
     * 会话空闲多久后不再占用 max_sessions 名额。
     *
     * 会话在 bridge 上不持有进程/内存，只是一个工作区目录，所以"占名额"
     * 应该按【最近是否还在用】算。超过它只是不再计数，目录还在，
     * 用户回来继续用会自动重新计入（touchSession）。
     * 不设回收的话会话槽只增不减，机器闲着却建不了新对话（1.3.8 修）。
     */
    sessionIdleTtlMs: Number(process.env.CVW_SESSION_IDLE_TTL_MS ?? 30 * 60 * 1000),
  },
};

export function describeConfig() {
  return {
    worker_id: config.worker.id,
    bridge: `${config.worker.host}:${config.worker.port}`,
    gateway: config.gateway.baseUrl,
    model: config.model.model,
    model_base_url: config.model.baseUrl,
    max_concurrent_jobs: config.worker.maxConcurrentJobs,
    supported_modes: config.worker.supportedModes,
    storage_root: config.storage.root,
    claude_bin: config.claudeCli.bin,
  };
}
