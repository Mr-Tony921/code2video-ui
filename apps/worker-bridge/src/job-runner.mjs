/**
 * Job 执行器：隔离的 workspace 里 spawn claude，解析 stream-json，支持真正的单任务取消。
 *
 * 相对 V1 的改动（采纳同事 bench_runner 的做法）：
 *  · 每 job 独立自包含 workspace（job-workspace.mjs）
 *  · 挂载命名空间隔离：/tmp 换本 job 的 .tmp，遮蔽 /mnt
 *    —— 实测把 claude 的 `find /` 从 7 分钟降到 676ms，根治卡死
 *  · --output-format stream-json --verbose：阶段与过程事件都来自结构化事件，
 *    不再靠解析自由文本（实测后者滞后 250 秒）
 *  · 清残留按 CVW_JOB_TOKEN/cwd/cmdline 三重匹配，三轮 SIGKILL
 *
 * 不变的要求：
 *  · 每个 Job 一个 process group，可整树终止，绝不影响其他 Job 或 Bridge 自身
 *  · 失去租约的 Job 不得提交产物
 */
import { validateVideo } from '../../shared/video-validation.mjs';
import { resolveExperimentalModel } from '../../shared/experimental.mjs';
import { isManagedModel, resolveManagedModel } from '../../shared/model-settings.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, readdir, stat, appendFile, open, copyFile, rename, rm } from 'node:fs/promises';
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { prepareJobWorkspace } from './job-workspace.mjs';
import {
  resolveJobPaths, pinnedAssetPath, jobToken,
  trajectoryPath, stderrPath,
} from './job-paths.mjs';
import { appendTrace } from './session-store.mjs';
import { parseStreamLine, phaseFromEvent } from './stream-parser.mjs';
import { JsonlTailer } from './log-tailer.mjs';

const running = new Map();

export const listRunningJobIds = () => [...running.keys()];
export const runningCount = () => running.size;
export const getJob = (jobId) => running.get(jobId);

const nowIso = () => new Date().toISOString();
const VIDEO_RE = /\.(mp4|mov|webm)$/i;
/** 成品静置多久后判定 claude 卡住（隔离已大幅降低发生率，保留兜底） */
/**
 * 提前收尾阈值：成品静置这么久、cc 仍没退出，才认为它卡住了。
 *
 * ★ 两个阈值，必须【同时】满足才收尾：
 *
 *   1) 成品静置够久（ARTIFACT）—— 原来只有这一条，而它单独是错的：
 *      它衡量的是「文件多久没变」，不是「agent 还在不在干活」。
 *      cc 产出一版后常继续写代码、调参、重渲，期间根本不碰成品文件。
 *
 *   2) agent 本身静默够久（AGENT）—— 新增，这条才是真正的判据。
 *      st.lastProgressAt 由 stream-json 事件、stderr、工作区 mtime 共同刷新，
 *      只要 cc 还在说话或写盘就会前进。
 *
 * 事故（线上 job_fc8e0e14「鹈鹕骑车」，2026-10-25）：
 * final.mp4 在 07:01 落盘，cc 随后仍在调试 —— 轨迹末尾是
 * `noise() takes seconds, I passed sample counts` 外加三条 Bash 调试命令，
 * 它正要修一个物理参数 bug。90 秒后 bridge 判定「静置」把它 SIGKILL 了，
 * 97 秒后写 .done 收尾。用户看到的就是「跑一半结束」，而且交付的是
 * 那一版没修完的视频。agent 当时每几秒就有一条事件，第 2 条阈值能挡住。
 */
const EARLY_HARVEST_IDLE_MS = Number(
  process.env.CVW_EARLY_HARVEST_IDLE_MS ?? config.raw?.limits?.early_harvest_idle_ms ?? 600_000);
/** agent 完全静默多久才算真卡死。远大于单次工具调用耗时（渲染/编码可达数分钟）。 */
const EARLY_HARVEST_AGENT_SILENT_MS = Number(
  process.env.CVW_EARLY_HARVEST_AGENT_SILENT_MS ?? config.raw?.limits?.early_harvest_agent_silent_ms ?? 900_000);

/** 子进程环境。模型、代理、运行时二进制全部来自配置。 */
/**
 * 解析 config.claude_cli.env，把 ${model.xxx} 占位符换成真实值。
 *
 * 为什么要占位符：上下文长度既要给 CLAUDE_CODE_MAX_CONTEXT_TOKENS，
 * 又是 model.max_context_tokens 本身，两处手写必然哪天对不上。
 */
function resolveClaudeEnv(model = config.model) {
  const src = config.claudeCli.env ?? {};
  // 占位符白名单。新增 ${model.xxx} 时【必须】在这里登记 ——
  // 不登记会被替换成空串，而空串在下面被当作"不设该变量"直接丢掉，
  // 配置看着改了却完全没生效，且没有任何报错。
  const vars = {
    'model.max_context_tokens': model.maxContextTokens,
    'model.max_output_tokens': model.maxOutputTokens,
    'model.model': model.model,
    'model.autocompact_pct': model.autocompactPct,
  };
  const out = {};
  for (const [k, raw] of Object.entries(src)) {
    if (k.startsWith('$')) continue;                 // $note 之类的说明字段
    let v = String(raw ?? '');
    v = v.replace(/\$\{([\w.]+)\}/g, (_, name) => String(vars[name] ?? ''));
    if (v === '' || v === 'null' || v === 'undefined') continue;                          // 空串 = 不设该变量
    out[k] = v;
  }
  return out;
}

function buildChildEnv(jobWs, agentWsPath, jobId, model = config.model) {
  const { proxy, runtimeBinaries, videokit } = config;
  const inherited = { ...process.env };
  const configuredProxy = inherited.CVW_CLAUDE_HTTP_PROXY;
  const httpProxy = configuredProxy || proxy.http_proxy;
  delete inherited.CVW_CLAUDE_HTTP_PROXY;
  if (configuredProxy) {
    delete inherited.ALL_PROXY;
    delete inherited.all_proxy;
  }
  if (model !== config.model) {
    // API profiles use their own limits, never the intranet model's process defaults.
    for (const key of ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      'CLAUDE_CODE_SUBAGENT_MODEL', 'ANTHROPIC_AUTH_TOKEN',
      'CVW_INTERNAL_TOKEN', 'CVW_SESSION_SECRET']) delete inherited[key];
  }
  if (isManagedModel(model.snapshot)) {
    // Managed user/C2V jobs receive only their selected API credential below.
    for (const key of Object.keys(inherited))
      if (/^CVW_.*(?:KEY|TOKEN|SECRET)$/.test(key)) delete inherited[key];
  }
  // ★ HOME 必须指向【命名空间内可写】的路径。
  //
  // 事故（线上 job_356f7a34）：HOME=/mnt/afs_toolcall/codevideo，而隔离把整个
  // /mnt 用 tmpfs 遮蔽了 → claude 想自动压缩上下文时写不了会话文件，
  // 报 "automatic compaction failed: ENOSPC: no space left on device"，
  // 于是本该被压缩救回的任务直接失败（跑了 47 分钟，产物全丢）。
  //
  // 放在工作区内的 .home：随 job 走、随 job 清理，且一定在命名空间内可见可写。
  const ws = agentWsPath ?? jobWs;
  const home = `${ws}/.home`;

  // ★ 「HOME 下的缓存」是一类反复出现的坑，不是一次性 bug。
  //
  //   遮蔽 /mnt 是必须的：实测不遮蔽时 agent 跑一次 `find / -maxdepth 6`
  //   要 120 秒以上（afs_toolcall 150T），maxdepth 5 也要 28 秒 —— 复杂任务
  //   里 agent 搜几次文件就白烧几分钟上下文和时间。
  //
  //   代价是：任何默认落在 $HOME 下的缓存，在每任务新建的 .home 里都是空的。
  //   已经踩过两次 —— HOME 本身（ENOSPC，job_356f7a34）、whisper 模型（HF_HOME）。
  //   所以这里统一把【已知的大缓存】显式钉到本地盘的共享位置，
  //   新增依赖时按同样的方式加一条，不要指望它自己找得到。
  const sharedCaches = config.raw?.shared_caches ?? {};

  return {
    ...inherited,
    HOME: home,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_CACHE_HOME: `${home}/.cache`,
    // claude 的配置与会话目录也跟着走，避免它回退到被遮蔽的默认位置
    CLAUDE_CONFIG_DIR: `${home}/.claude`,
    ANTHROPIC_BASE_URL: model.baseUrl,
    ANTHROPIC_API_KEY: model.apiKey,
    ANTHROPIC_MODEL: model.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model.model,
    // cc 的启动参数来自 config.claude_cli.env（见 resolveClaudeEnv），
    // 不在代码里写死 —— 调上下文/输出上限不需要改代码。
    ...resolveClaudeEnv(model),
    CLAUDE_CODE_SUBAGENT_MODEL: model.model,
    ANTHROPIC_AUTH_TOKEN: '',
    HTTP_PROXY: httpProxy,
    HTTPS_PROXY: httpProxy,
    http_proxy: httpProxy,
    https_proxy: httpProxy,
    NO_PROXY: proxy.no_proxy,
    no_proxy: proxy.no_proxy,
    // 清残留靠它精确匹配本 job 的进程
    // ★ 必须每轮唯一。1.4.0 起工作区按会话共用，若仍只用工作区路径，
    //   各轮 token 完全相同 → isSidecarProcessAlive 的防 pid 复用校验失效，
    //   上一轮残留的进程会被认成本轮的。所以带上 jobId（见 job-paths.jobToken）。
    CVW_JOB_TOKEN: jobId ? jobToken(jobWs, jobId) : jobWs,
    IS_SANDBOX: '1',
    ...(runtimeBinaries.chromeBin ? { CHROME_BIN: runtimeBinaries.chromeBin, CHROME_PATH: runtimeBinaries.chromeBin } : {}),
    ...(runtimeBinaries.previsDependencyRoot
      ? { PREVIS_DEPENDENCY_ROOT: runtimeBinaries.previsDependencyRoot } : {}),
    ...(videokit?.nodeModules ? { NODE_PATH: videokit.nodeModules } : {}),
    // 已知大缓存的落点（见上方注释）。放最后，配置里显式写的优先级最高。
    ...Object.fromEntries(
      Object.entries(sharedCaches)
        .filter(([k, v]) => !k.startsWith('$') && v && existsSync(String(v)))
        .map(([k, v]) => [k, String(v)]),
    ),
  };
}

/**
 * 组装启动命令。隔离可用时套一层 unshare + isolate.sh。
 * 隔离内 cwd 是浅路径 /workspace，但产物仍写在宿主的真实 job 目录（bind mount）。
 */
/** 探测挂载命名空间是否可用（非 root 需要 --user --map-root-user） */
function probeIsolation(iso) {
  const args = iso.unshare_args ?? ['--user', '--map-root-user', '--mount', '--propagation', 'private'];
  const r = spawnSync('unshare', [...args, 'true'], { timeout: 10_000 });
  if (r.status !== 0 && iso.fallback_to_soft === false) {
    throw new Error('[runner] 隔离不可用且未允许降级');
  }
  if (r.status !== 0) {
    console.warn('[runner] 挂载命名空间不可用，降级为软隔离（独立 TMPDIR + 进程组 + 清残留）');
  }
  return r.status === 0;
}

function buildCommand({ jobWs, isoAvailable, mountPoint, ccSessionId, resume, experimental }) {
  const iso = config.isolation ?? {};
  // ★ prompt 【不】进 argv，改从 stdin 送。
  //
  // 事故（线上 job_dc9fd3ab「鹈鹕骑车」）：prompt 里出现 "chrome-linux64/chrome"，
  // 而整段 prompt 原样进了 cc 的命令行，于是 agent 自己执行
  //   for p in $(pgrep -f "chrome-linux64"); do kill -9 $p; done
  // 清理残留浏览器时，pgrep 把【自己】也匹配上了 —— 任务当场 SIGKILL 自杀，
  // 表现为 "制作引擎异常退出 code=null signal=SIGKILL"。
  // 实测 pgrep 命中 "claude -p Create a 2-second MP4 ... chrome-linux64/chrome"。
  // 只要 prompt 不在命令行里，任何 pgrep -f 模式都不可能再误伤 cc 本体。
  //
  // ★ 1.4.0 新增 --session-id / --resume：两者的值都是**纯 uuid**。
  //   这不违反上面那条规矩 —— uuid 里不含 prompt、不含任何路径、更不含
  //   "chrome" 这种会被 agent 的清理命令匹配到的字样。
  //   tests/risk/argv-safety.mjs 专门断言 argv 里没有 prompt / 路径 / chrome。
  const claudeArgs = [
    '-p',
    '--permission-mode', config.claudeCli.permissionMode,
    '--output-format', 'stream-json',
    '--verbose',
    ...(experimental ? [] : ['--disallowedTools', 'WebSearch']),
    // 续跑：带上一轮的 cc 会话，历史与上下文由 cc 自己从磁盘恢复。
    // 首轮：显式指定 id，使 cc 会话 id ≡ 我们的会话 id，后续轮次才找得到它。
    // ccSessionId 为 null（会话 id 形状异常）时两个都不加 —— 退化成 1.3.x 行为。
    ...(ccSessionId ? (resume ? ['--resume', ccSessionId] : ['--session-id', ccSessionId]) : []),
    ...(config.claudeCli.extraArgs ?? []),
  ];

  if (!isoAvailable) {
    return { cmd: config.claudeCli.bin, args: claudeArgs, cwd: jobWs, isolated: false };
  }
  const isoScript = join(config.repoRoot, 'apps/worker-bridge/scripts/isolate.sh');
  const unshareArgs = iso.unshare_args ?? ['--user', '--map-root-user', '--mount', '--propagation', 'private'];
  const hide = (iso.hide_paths ?? ['/mnt']).join(',');
  // 运行时依赖 bind：chrome / previs-deps 装在被遮蔽的 /mnt 下，
  // 必须显式挂进命名空间，否则白模任务找不到 chrome，只能自行下载 250MB。
  const binds = (iso.bind_paths ?? [])
    .filter((b) => b?.src && b?.dst)
    .map((b) => `${b.src}:${b.dst}`)
    .join(',');
  return {
    cmd: 'unshare',
    args: [...unshareArgs, 'bash', isoScript, jobWs, hide, mountPoint, binds, '--',
           config.claudeCli.bin, ...claudeArgs],
    cwd: jobWs,
    isolated: true,
  };
}

/**
 * 启动生成 Job。立即返回，不等待（可能跑 12 小时）。
 */
export async function startJob(p) {
  if (running.has(p.jobId)) return { accepted: true, already_running: true };
  /**
   * ★ 同一会话绝不允许两个任务同时跑（bridge 侧第二道防线）。
   *
   * 原来只按 jobId 去重。1.4.0 起同会话各轮【共用工作区】并 `--resume` 同一个
   * cc 会话，所以两个进程并存的后果从「各写各的目录」变成：
   *   · 同一份 cc 会话 jsonl 被两个进程写 → 对话记录损坏
   *   · 同一个 output/final.mp4 被两个进程写 → 产物损坏
   * Gateway 侧有 allow_steering_during_job=false 挡着（server.mjs:710），
   * 但它依赖内存里的在跑视图 —— Gateway 重启、或认领的任务叠加新派发时会漏。
   * 这一层不依赖任何内存状态，只看本进程正在跑什么。
   */
  for (const [, st] of running) {
    if (st.sessionId === p.sessionId) {
      const e = new Error('SESSION_BUSY');
      e.code = 'SESSION_BUSY';
      e.details = { running_job_id: st.jobId, session_id: p.sessionId };
      throw e;
    }
  }
  if (running.size >= config.worker.maxConcurrentJobs) {
    const e = new Error('WORKER_AT_CAPACITY');
    e.code = 'WORKER_AT_CAPACITY';
    throw e;
  }

  // 先判定隔离是否可用：contract 里的交付路径必须是 agent 自己视图里的路径。
  // 隔离开启时工作区 bind 到浅挂载点，宿主的 /mnt/... 在隔离内被遮蔽。
  const iso = config.isolation ?? {};
  const isoAvailable = iso.enabled === true && probeIsolation(iso);
  const mountPoint = iso.workspace_mount ?? '/workspace';
  // ★ 1.4.0：工作区按【会话】解析，同一会话各轮共用（老会话回退到 jobs/<jid>/）。
  //   续跑因此不需要拷任何东西 —— 上一轮的 src/ build/ output/ 本来就在这里，
  //   .home 也在这里，所以 cc --resume 找得到上一轮的对话。
  const { agentWs: hostWs, bookDir } = resolveJobPaths(p.sessionId, p.jobId);

  const ws = await prepareJobWorkspace({
    sessionId: p.sessionId, jobId: p.jobId, mode: p.mode, prompt: p.prompt,
    agentWsPath: isoAvailable ? mountPoint : hostWs,
    experimentalSkills: p.experimentalSkills, modelSelection: p.modelSelection,
  });

  // 轨迹与 stderr 跟【工作区】走：各轮追加到同一个文件，
  // 这样第 2 轮的过程框能接着第 1 轮显示（用户明确要求）。
  const logPath = trajectoryPath(ws.ws);
  const errPath = stderrPath(ws.ws);
  // ★ stdout/stderr 直接给文件 fd，不走管道。
  //
  // 管道的读端在 Bridge 手里：Bridge 一退出，cc 下次写 stdout 就会被
  // SIGPIPE 杀掉（实测：管道模式下父进程退出，子进程立刻死；
  // 重定向到文件则无限存活）。热更新要让任务活过 Bridge 重启，
  // 这一步是地基。文件内容与原来逐行转写的完全一致。
  const outFh = await open(logPath, 'a');
  const errFh = await open(errPath, 'a');

  // resume 的前提是会话文件真的在（prepareJobWorkspace 已查过）。
  // 查不到就当首轮 —— 带着不存在的 id 去 --resume 会让 cc 直接启动失败，整轮白丢。
  const { cmd, args, cwd, isolated } = buildCommand({
    jobWs: ws.ws, isoAvailable, mountPoint,
    ccSessionId: ws.ccSessionId,
    resume: ws.isContinuation === true, experimental: p.mode === 'experimental',
  });
  if (ws.ccSessionId) {
    console.log(`[runner] job ${p.jobId} cc 会话 ${ws.ccSessionId} ` +
      `${ws.isContinuation ? '→ --resume（接上一轮对话）' : '→ --session-id（首轮）'}`);
  } else {
    console.warn(`[runner] job ${p.jobId} 会话 id 形状异常，不指定 cc 会话（续跑将无历史）`);
  }
  // prompt 全文（含 contract）由 stdin 送入，不进命令行
  const { readFile } = await import('node:fs/promises');
  const fullPrompt = await readFile(ws.promptPath, 'utf8');

  const child = spawn(cmd, args, {
    cwd,
    env: buildChildEnv(ws.ws, ws.viewPath, p.jobId, p.mode === 'experimental' ? resolveExperimentalModel(config.raw, p.modelSelection)
      : p.mode === 'coding_to_video' && isManagedModel(p.modelSelection) ? resolveManagedModel(config.raw, p.modelSelection) : config.model),
    detached: true,                 // ★ 独立 process group，可整树终止
    stdio: ['pipe', outFh.fd, errFh.fd],   // stdin 用来送 prompt
  });
  // 子进程已经 dup 了自己的 fd，父进程这两个可以关掉了
  await outFh.close().catch(() => {});
  await errFh.close().catch(() => {});

  // 送 prompt。必须关闭 stdin，否则 cc 会一直等输入。
  // 注意：写失败不能让整个任务静默卡住，要走正常失败路径。
  child.stdin.on('error', () => {});          // EPIPE：子进程已退出，交给 exit 处理
  child.stdin.end(fullPrompt, 'utf8');

  const pgid = resolvePgid(child.pid);
  const startTicks = readStartTicks(child.pid);
  const st = {
    jobId: p.jobId, sessionId: p.sessionId, mode: p.mode,
    leaseToken: p.leaseToken,
    pid: child.pid, pgid, startTicks, child,
    phase: 'PREPARING', phaseStartedAt: nowIso(), startedAt: nowIso(),
    lastProgressAt: nowIso(),
    maxRuntimeSeconds: p.maxRuntimeSeconds,
    cancelRequested: false, cancelReason: null, leaseValid: true,
    // ★ jobDir = 本轮【簿记】目录（.done/.failed/.running.json/.cc-session/钉住的成片）。
    //   agentWs = agent 的工作区，同一会话各轮共用。
    //   老会话里两者是同一个目录（legacy 回退），所以现有扫标记的代码无需改动。
    jobDir: ws.bookDir, agentWs: ws.ws,
    // 存下来给 procAlive 做归属校验：必须与子进程环境里的 CVW_JOB_TOKEN 一致
    jobToken: jobToken(ws.ws, p.jobId),
    outDir: join(ws.ws, 'output'),
    viewPath: ws.viewPath,
    continued: ws.isContinuation === true,
    logPath, errPath, isolated,
    skills: ws.skills, skillsetName: ws.skillsetName, assetFiles: ws.assetFiles,
    hooks: p.hooks ?? {}, settled: false,
    events: [],                     // 内存中的最近事件（过程框快速拉取）
    eventSeq: 0,
    toolFailStreak: 0,
    ccSessionId: null,
    lastAssistantText: null,
  };
  running.set(p.jobId, st);

  console.log(`[runner] job ${p.jobId} 启动 pid=${child.pid} pgid=${pgid} ` +
    `isolated=${isolated} mode=${p.mode} skills=${ws.skills.length} assets=${ws.assetFiles.length} ` +
    `${ws.isContinuation ? '续跑(resume)' : '首轮'} ws=${ws.ws}`);

  // stdout 已经直接落 claude.jsonl，这里从文件增量读，解析链完全不变
  st.tailer = new JsonlTailer({
    path: logPath,
    onLine: (line) => handleStreamLine(st, line),
    onError: (e) => console.warn(`[runner] job ${p.jobId} 读轨迹失败: ${e.message}`),
  });
  st.tailer.start();

  await writeRunningSidecar(st, ws);

  st.fsTimer = setInterval(() => {
    detectFromFs(st).then((ready) => (ready ? maybeHarvestEarly(st) : false)).catch(() => {});
  }, 5000);
  st.fsTimer.unref?.();

  // 退出检测有两条路：child 事件（本进程起的，快）与 pid 轮询（认领来的，没有句柄）。
  // 两条都汇到 onProcessGone，由它保证只收尾一次。
  child.on('exit', (code, signal) => { void onProcessGone(st, code, signal); });
  startReaper(st);

  child.on('error', async (e) => {
    if (st.fsTimer) clearInterval(st.fsTimer);
    st.tailer?.stop();
    stopReaper(st);
    await clearRunningSidecar(st).catch(() => {});
    st.settled = true;
    running.delete(p.jobId);
    st.hooks.onFail?.({
      code: 'E_SPAWN_FAILED',
      message: `无法启动 ${cmd}: ${e.message}`,
      phase: st.phase, retryable: false,
    });
  });

  return {
    accepted: true, already_running: false,
    pid: st.pid, pgid, isolated,
    skillset: ws.skillsetName, skills: ws.skills,
    assets: ws.assetFiles,
    job_dir: ws.ws,
  };
}


/** 处理一行 stream-json：转事件 → 记录 → 推进阶段 → 回调 */
function handleStreamLine(st, line) {
  for (const ev of parseStreamLine(line, {
    truncateBytes: config.raw?.process_stream?.tool_result_truncate_bytes ?? 2000,
  })) {
    st.lastProgressAt = nowIso();
    const seq = ++st.eventSeq;
    const full = { seq, at: nowIso(), ...ev };

    const cap = config.raw?.process_stream?.max_buffered_events ?? 2000;
    st.events.push(full);
    if (st.events.length > cap) st.events.shift();

    if (ev.kind === 'init') {
      st.ccSessionId = ev.cc_session_id;
      // 落盘：job 结束后内存状态已清，排障与对账仍需要它
      writeFile(join(st.jobDir, '.cc-session'), JSON.stringify({
        cc_session_id: ev.cc_session_id, cwd: ev.cwd,
        model: ev.model, skills: ev.skills, at: nowIso(),
      }, null, 2), 'utf8').catch(() => {});
      console.log(`[runner] job ${st.jobId} cc session=${ev.cc_session_id} ` +
        `cwd=${ev.cwd} skills=${(ev.skills ?? []).length}`);
    }
    if (ev.kind === 'tool_result') {
      st.toolFailStreak = ev.is_error ? st.toolFailStreak + 1 : 0;
    }
    if (ev.kind === 'assistant_text') {
      st.lastAssistantText = ev.text;                 // 供对话区显示（V2 需求 7）
    }
    if (ev.kind === 'result') {
      // 认领来的任务拿不到退出码，这条就是「成没成」的权威依据
      st.lastResult = ev;
    }

    const ph = phaseFromEvent(ev);
    if (ph) setPhase(st, ph);

    // 推给 Gateway → 前端过程框。
    // 重放历史时不推：认领一个跑了半小时的任务会有几百条历史事件，
    // 全推一遍既打爆 Gateway，也会让前端过程框重复一整段。
    if (!st.replaying) st.hooks.onStreamEvent?.(full);
  }
}

function setPhase(st, phase) {
  if (!phase || st.phase === phase) return;
  const prev = st.phase;
  st.phase = phase;
  st.phaseStartedAt = nowIso();
  if (!st.replaying) st.hooks.onPhase?.({ phase, previous: prev });
  appendTrace(st.sessionId, { kind: 'job_phase', job_id: st.jobId, phase, previous: prev })
    .catch(() => {});
}

/** 文件系统兜底：成品出现即判 FINALIZING，并刷新进度时间 */
async function detectFromFs(st) {
  let ready = false;
  try {
    const names = await readdir(st.outDir);
    ready = names.some((n) => VIDEO_RE.test(n));
  } catch { /* output 还没建 */ }
  if (ready) setPhase(st, 'FINALIZING');
  // claude.jsonl / claude.stderr 的 mtime 是 agent 还在干活最可靠的信号。
  // （stdout 改为直写文件后，原来 child.stderr 的 'data' 事件没有了，
  //   这两个文件的增长就是替代的活跃度来源。）
  for (const d of ['output', 'src', 'work', '.', 'claude.jsonl', 'claude.stderr']) {
    try {
      const m = statSync(join(st.agentWs ?? st.jobDir, d)).mtimeMs;
      if (m > (st.lastFsMtime ?? 0)) { st.lastFsMtime = m; st.lastProgressAt = nowIso(); }
    } catch {}
  }
  return ready;
}

/**
 * 中间产物目录：这些是制作过程的临时文件，【绝不能】当成交付物。
 *
 * 事故（线上 sess_09d06d8f）：用户看到的是中间版本。
 * 根因是原来按"文件体积最大"挑选，而 build/ 下的中间渲染常常比成片还大
 * （实测 build/video_v1.mp4 21.5MB vs output/final_v1.mp4 22.3MB，只差 3%，
 *  换个任务顺序就会挑错）。
 */
const INTERMEDIATE_DIRS = ['build', 'work', 'tmp', 'temp', 'cache', 'frames', 'chunks', 'parts'];

async function findArtifact(st) {
  const cands = [];
  /**
   * ★ 只认【本轮产出】的文件。
   *
   * 1.4.0 起同会话各轮共用工作区，上一轮的 output/final.mp4 还留在原地。
   * 本轮若没有覆盖它（agent 判定不用改、提前结束、或写到了别处），
   * 不加这道判断就会把【上一轮的片子】当成本轮交付物 ——
   * 对用户就是「两轮视频完全一样」。
   *
   * 这正是线上 1.3.x 那个 bug 的同胞：那时兜底扫描会扫到 previous/
   * （上一版成片的拷贝），续写轮的 result_asset 直接指向 previous/final.mp4
   * （实测 job_0ff42e58 与 job_4bd2a122，size 与上一轮一模一样）。
   * 1.4.0 删掉了 previous/，但共用工作区又把同样的风险从另一个方向带回来了。
   *
   * 判据用 mtime 不早于本轮启动（留 5 秒容差，防文件系统时间抖动）。
   * 本轮确实没产出时就应该判「完成但无产物」，而不是拿旧片子冒充。
   */
  const roundStart = new Date(st.startedAt ?? 0).getTime() - 5000;
  const fresh = (mtime) => mtime >= roundStart;

  async function walk(dir, depth = 0, insideOut = false) {
    if (depth > 3 || !existsSync(dir)) return;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const fp = join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.git', '.claude', '.tmp', '.home'].includes(e.name)) continue;
        // 中间目录一律不找：它们装的是过程产物
        if (INTERMEDIATE_DIRS.includes(e.name.toLowerCase())) continue;
        await walk(fp, depth + 1, insideOut);
      } else if (VIDEO_RE.test(e.name)) {
        const s = await stat(fp);
        // 同上：只收本轮产出的，否则会把上一轮的中间产物/成片当成本轮交付
        if (s.size > 0 && s.mtimeMs >= roundStart) {
          cands.push({ path: fp, size: s.size, mtime: s.mtimeMs, inOut: insideOut });
        }
      }
    }
  }
  // 1) output/final.mp4 —— output contract 指定的交付位置，最高优先
  const final = join(st.outDir, 'final.mp4');
  if (existsSync(final)) {
    const s = await stat(final);
    if (s.size > 0 && fresh(s.mtimeMs)) return { path: final, size: s.size, mtime: s.mtimeMs };
    if (s.size > 0) {
      console.warn(`[runner] job ${st.jobId} output/final.mp4 是上一轮的产物`
        + `（mtime ${new Date(s.mtimeMs).toISOString()} 早于本轮启动），不采用`);
    }
  }
  // 2) output/ 下的其他视频；3) 再退到工作区其他位置（已排除中间目录）
  await walk(st.outDir, 0, true);
  // ★ 兜底扫描 agent 的工作区，不是簿记目录 —— 1.4.0 起 jobDir 只放我们的记录
  await walk(st.agentWs ?? st.jobDir, 0, false);
  if (!cands.length) return null;

  // 排序原则（按重要性递减）：
  //   a. output/ 里的优先 —— 那是约定的交付目录
  //   b. 文件名像成片的优先（final/output/deliver/完成），像草稿的靠后（test/draft/tmp/preview）
  //   c. 最后才比时间：后产出的通常是改进版。【不再比体积】——
  //      体积大不等于更终版，中间渲染往往更大（本次事故主因）。
  const score = (c) => {
    const n = c.path.toLowerCase().split('/').pop();
    let v = c.inOut ? 100 : 0;
    if (/\bfinal\b|\bdeliver|\bmaster\b/.test(n)) v += 50;
    if (/\btest|\bdraft|\btmp\b|\bpreview|\bsample/.test(n)) v -= 50;
    return v;
  };
  cands.sort((a, b) => score(b) - score(a) || b.mtime - a.mtime);
  return cands[0];
}

/** 两次采样大小一致才认为写入已停 —— "目录里出现文件" 不等于完成 */
async function confirmStable(path, waitMs = 1500) {
  const a = await stat(path);
  await new Promise((r) => setTimeout(r, waitMs));
  const b = await stat(path);
  return a.size === b.size && b.size > 0 ? b.size : null;
}

/**
 * 把本轮成片「钉」到按轮次的簿记目录，并返回那个不可变路径。
 *
 * ★ 为什么必须钉：1.4.0 起同一会话各轮**共用工作区**，agent 仍然按 output contract
 *   写 `output/final.mp4`（契约不变，agent 侧零感知）。如果直接把这个路径记成
 *   result_asset.storage_path，第 2 轮一覆盖，第 1 轮的成片就永久消失 ——
 *   而 `/api/assets/<jobId>/playback` 还按旧路径去取，用户再也播不出早先那版。
 *
 * ★ 必须是【拷贝】，不能用硬链。
 *   硬链只是给同一个 inode 多一个名字，而覆盖写普遍是 O_TRUNC 原地截断
 *   （`ffmpeg -y`、shell 重定向、fs.writeFile 默认都是），inode 不变 ——
 *   于是第 2 轮一写 output/final.mp4，第 1 轮"钉住"的那份内容跟着变了。
 *   这是静默的数据损坏，回归测试 tests/risk/round-isolation.mjs 专门守这一条。
 *
 * 落点在簿记目录（rounds/<jobId>/），它是 workspace/ 的兄弟目录、
 * 不在 findArtifact 的扫描范围内 —— 否则下一轮会把上一轮的归档当成本轮产物挑走。
 *
 * 归档失败必须报错：不能把可被下一轮覆盖的工作区路径当作历史成片。
 */
async function pinArtifact(st, art) {
  if (!art?.path) return art?.path ?? null;
  const ext = (art.path.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'mp4').toLowerCase();
  const dst = pinnedAssetPath(st.jobDir, ext);
  if (dst === art.path) return art.path;          // legacy 布局：本来就按轮次隔离
  try {
    await mkdir(st.jobDir, { recursive: true });
    await copyFile(art.path, dst);                // 覆盖写是幂等的（补判/重试会再来一次）
    // ★ 先拷贝保命，再【尝试】优化 —— 见 faststartInPlace 的说明
    if (ext === 'mp4') await faststartInPlace(st, dst);
    return dst;
  } catch (e) {
    throw Object.assign(new Error(`成片归档失败: ${e.message}`), { code: 'E_ASSET_PIN_FAILED' });
  }
}

/**
 * 把 mp4 的 `moov` 原子搬到文件头（faststart），原地替换。
 *
 * ★ 为什么要做：`moov` 是索引。ffmpeg 默认把它写在**文件尾部**，
 *   于是浏览器必须把整个文件下完才能出第一帧 —— 40MB 的片子在慢链路上
 *   就是长时间黑屏，用户的感受是「视频加载很慢」。
 *   实测 dev 上 8 个成片里 3 个是 `['ftyp','free','mdat','moov']`（moov 在尾部），
 *   最大的那个 40.3MB、moov 就在 40.3MB 处。
 *   搬到头部后首帧只需要几十 KB。
 *
 * ★ 只是 remux（`-c copy`），不重新编码：画质与码率完全不变，40MB 量级不到一秒。
 *
 * ★ 安全第一 —— 这是在【任务收尾路径】上，坏了就等于好不容易跑出来的片子丢了。
 *   所以顺序是：调用方**先把原文件拷到 dst**（已经钉住、可播），
 *   本函数只在旁边写临时文件，**校验通过才 rename 覆盖**。
 *   任何一步出问题（没装 ffmpeg、remux 失败、产物异常）都直接返回，
 *   dst 保持为原样的那份拷贝 —— 退化成改动前的行为，绝不丢数据。
 */
async function faststartInPlace(st, dst) {
  const tmp = `${dst}.fs.tmp`;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('ffmpeg', ['-v', 'error', '-y', '-i', dst,
      '-c', 'copy', '-map', '0', '-movflags', '+faststart', '-f', 'mp4', tmp],
      { timeout: 180_000, maxBuffer: 1 << 20 });
    // 校验：临时文件必须存在、不为空、且能被 ffprobe 读出时长
    const sz = (await stat(tmp)).size;
    if (!(sz > 0)) throw new Error('remux 产物为空');
    const { stdout } = await run('ffprobe', ['-v', 'error',
      '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', tmp],
      { timeout: 30_000 });
    if (!(Number(String(stdout).trim()) > 0)) throw new Error('remux 产物读不出时长');
    await rename(tmp, dst);
    console.log(`[runner] job ${st.jobId} 成片已 faststart（${sz} 字节，首帧不必等整片下载）`);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    console.warn(`[runner] job ${st.jobId} faststart 跳过（保留原拷贝，不影响交付）: ${e.message}`);
  }
}

async function maybeHarvestEarly(st) {
  if (st.settled || st.settling || st.cancelRequested || !st.leaseValid) return false;
  const art = await findArtifact(st);
  if (!art) return false;
  const idleMs = Date.now() - art.mtime;
  if (idleMs < EARLY_HARVEST_IDLE_MS) return false;

  // ★ agent 还在活动就绝不收尾 —— 成品不动不代表它没在干活（见上方事故）。
  const silentMs = Date.now() - new Date(st.lastProgressAt ?? 0).getTime();
  if (silentMs < EARLY_HARVEST_AGENT_SILENT_MS) return false;

  if (!(await confirmStable(art.path, 2000))) return false;
  try { await validateVideo(art.path); } catch { return false; }
  console.warn(`[runner] job ${st.jobId} 成品静置 ${Math.round(idleMs / 1000)}s ` +
    `且 agent 静默 ${Math.round(silentMs / 1000)}s → 判定卡死，提前收尾`);
  st.earlyHarvest = true;
  signalGroup(st, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 3000));
  signalGroup(st, 'SIGKILL');
  return true;
}

async function settle(st, code, signal) {
  if (st.settled || st.settling) return;
  st.settling = true;
  st.phase = 'FINALIZING';
  // Retain both in-memory ownership and the adoption sidecar until a durable
  // terminal marker exists. Otherwise watchdog sees not_found during slow I/O.
  try {
    await settleResult(st, code, signal);
  } catch (e) {
    if (!existsSync(join(st.jobDir, '.done'))) {
      if (!st.leaseValid || st.cancelRequested) await settleResult(st, code, signal);
      else await failJob(st, e.code ?? 'E_SETTLEMENT_FAILED', e.message, code, true);
    }
  } finally {
    st.settling = false;
    const durable = ['.done', '.failed', '.cancelled', '.aborted'].some(m => existsSync(join(st.jobDir, m)));
    if (durable) {
      st.settled = true;
      running.delete(st.jobId);
      await clearRunningSidecar(st).catch(() => {});
    } else {
      // Storage failure must not erase the last discoverable executor record.
      setTimeout(() => settle(st, code, signal).catch(console.error), 10_000).unref?.();
    }
  }
}

async function settleResult(st, code, signal) {
  if (st.fsTimer) clearInterval(st.fsTimer);
  stopReaper(st);
  st.tailer?.stop();
  if (!st.leaseValid) {
    await writeFile(join(st.jobDir, '.aborted'), JSON.stringify({
      reason: st.cancelReason ?? 'lease_lost', at: nowIso(),
      job_id: st.jobId, signal, exit_code: code,
      note: '执行者已失去租约，结果已放弃',
    }, null, 2), 'utf8').catch(() => {});
    await appendTrace(st.sessionId, {
      kind: 'job_aborted', job_id: st.jobId,
      reason: st.cancelReason ?? 'lease_lost', phase: st.phase, exit_code: code,
    });
    st.hooks.onLeaseLostExit?.({ jobId: st.jobId, reason: st.cancelReason ?? 'lease_lost' });
    return;
  }

  if (st.cancelRequested) {
    await writeFile(join(st.jobDir, '.cancelled'),
      JSON.stringify({ reason: st.cancelReason, at: nowIso() }, null, 2), 'utf8').catch(() => {});
    await appendTrace(st.sessionId, {
      kind: 'job_cancelled', job_id: st.jobId, reason: st.cancelReason,
      stop_method: st.stopMethod ?? 'cooperative', phase: st.phase,
      duration_ms: Date.now() - new Date(st.startedAt).getTime(),
    });
    st.hooks.onCancelled?.({
      stopped: true, stop_method: st.stopMethod ?? 'cooperative',
      resources_released: true,
      released: { gpu: true, subprocesses: true, temp_files: true },
      partial_artifacts: [], stopped_at: nowIso(),
    });
    return;
  }

  const art = await findArtifact(st);
  if ((exitedCleanly(st, code) || st.earlyHarvest) && art) {
    const size = await confirmStable(art.path);
    if (!size) {
      await failJob(st, 'E_ASSET_UNSTABLE', '产物文件仍在写入，无法确认完整性', code, true);
      return;
    }
    // 先钉住再记路径：记下去的必须是不会被下一轮覆盖的那个
    const pinned = await pinArtifact(st, art);
    /**
     * ★ size_bytes 要取【钉住后那个文件】的实际大小。
     *   faststart 重封装会让字节数略有变化（moov 搬位、可能去掉 free），
     *   而 playback 接口的 content-length 是按磁盘实际大小发的 ——
     *   记成源文件的大小就会和界面显示、以及下载的字节数对不上。
     *   读不到就退回用源文件那个 size（至少不是 0，网关要求 >0）。
     */
    let pinnedSize = size;
    try { pinnedSize = (await stat(pinned)).size || size; } catch { /* 用 size */ }
    const vmeta = await validateVideo(pinned, { expectedSize: pinnedSize });
    // A cancellation or lease directive can arrive during a long decode/copy.
    // Re-enter the terminal intent checks before publishing a result.
    if (!st.leaseValid || st.cancelRequested) return settleResult(st, code, signal);
    const marker = join(st.jobDir, '.done');
    const meta = {
      storage_path: pinned, size_bytes: pinnedSize, finished_at: nowIso(),
      job_id: st.jobId, mode: st.mode,
      ...vmeta,                                   // width / height / duration_ms（读不到就没有）
      cc_session_id: st.ccSessionId,
      last_assistant_text: st.lastAssistantText,
    };
    const markerTmp = `${marker}.${process.pid}.tmp`;
    await writeFile(markerTmp, JSON.stringify(meta, null, 2), 'utf8');
    await rename(markerTmp, marker);
    if (!st.leaseValid) { await rm(marker, { force: true }); return settleResult(st, code, signal); }
    await appendTrace(st.sessionId, {
      kind: 'job_completed', job_id: st.jobId, phase: st.phase,
      storage_path: pinned, size_bytes: pinnedSize,
      duration_ms: Date.now() - new Date(st.startedAt).getTime(),
    });
    st.hooks.onComplete?.({ ...meta, completion_marker: marker });
    return;
  }

  // 没找到成品：这是 V2 需求 7 的「completed_without_artifact」触发点
  //
  // 上下文耗尽要单独成码：它不是"引擎崩了"，而是任务本身太重（实测一次事故：
  // 读回 17 张渲染图，单张 30 万字符，57 分钟后 Prompt is too long）。
  // 用户需要的是"换个说法重试"，而不是以为系统坏了。
  const ctxBlown = /prompt is too long|context.{0,20}(?:too long|limit|exceed)|maximum context/i
    .test(st.lastAssistantText ?? '');
  const failCode = ctxBlown ? 'E_TASK_TOO_COMPLEX'
    : code === 0 ? 'E_NO_ARTIFACT' : 'E_CLAUDE_EXIT';
  const failMsg = ctxBlown
    ? '本次创作内容过于复杂，制作过程超出了单次处理上限。建议：缩短时长、减少镜头数量，或把需求拆成几段分别生成。'
    : code === 0
      ? '制作流程正常结束但未产出成品视频'
      : `制作引擎异常退出 code=${code} signal=${signal}`;
  if (ctxBlown) {
    console.warn(`[runner] job ${st.jobId} 上下文耗尽（任务过重）→ E_TASK_TOO_COMPLEX`);
  }
  await failJob(st, failCode, failMsg, code, false);
}

async function failJob(st, code, message, exitCode, retryable) {
  await writeFile(join(st.jobDir, '.failed'),
    JSON.stringify({ code, message, at: nowIso(), job_id: st.jobId, exit_code: exitCode }, null, 2),
    'utf8').catch(() => {});
  await appendTrace(st.sessionId, {
    kind: 'job_failed', job_id: st.jobId, failure_code: code, phase: st.phase,
    duration_ms: Date.now() - new Date(st.startedAt).getTime(),
  });
  st.hooks.onFail?.({ code, message, phase: st.phase, retryable });
}

/* ───────── 进程组管理 ───────── */

/** /proc/<pid>/stat 第 22 个字段 starttime。用来识破 pid 复用。 */
function readStartTicks(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm 字段可能含空格和括号，必须从最后一个 ')' 之后再切
    const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
    const v = Number(rest[19]);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

/**
 * 进程是否还是【当初那个】进程。
 *
 * 只看 /proc/<pid> 在不在是不够的：Bridge 重启期间 pid 可能被别人复用，
 * 误判就会把陌生进程当成自己的任务去认领、甚至去 kill。
 * 两道校验：starttime 必须一致；环境里必须有本 job 的 CVW_JOB_TOKEN
 * （kill-leftovers.sh 用的也是这条规矩）。
 */
function procAlive(st) {
  if (!st.pid) return false;
  if (!existsSync(`/proc/${st.pid}`)) return false;
  if (st.startTicks != null) {
    const now = readStartTicks(st.pid);
    if (now != null && now !== st.startTicks) return false;    // pid 被复用了
  }
  try {
    const env = readFileSync(`/proc/${st.pid}/environ`, 'utf8');
    // ★ 1.4.0：token 不再等于 jobDir（工作区按会话共用了），改比 st.jobToken。
      //   老边车没有 job_token，认领时回退成 job_dir —— 与 1.3.x 的旧进程仍能对上。
      const want = st.jobToken ?? st.jobDir;
      if (env.includes('CVW_JOB_TOKEN=') && !env.includes(`CVW_JOB_TOKEN=${want}\0`)) return false;
  } catch { /* 读不到 environ 不能当作死亡证据（权限/时序） */ }
  return true;
}

/**
 * 边车记录的进程是否还活着（认领前的归属校验，防 pid 复用）。
 *
 * ★ 必须把 job_token 传进去。1.4.0 把 CVW_JOB_TOKEN 从「工作区路径」改成
 *   `<工作区>#<jobId>`（各轮共用工作区后，光靠路径分不出轮次），而这里
 *   【漏传了 jobToken】—— procAlive 于是退回拿 st.jobDir（也就是 rounds/<jid>）
 *   去比对，和进程里真正的 token 永远对不上，活着的 cc 一律被判死。
 *
 *   后果是整条恢复链反向：bridge 一重启（每次热更新都会），adopter 走
 *   「进程没了 → 补收尾」，把还在跑的任务标成 FAILED(E_CLAUDE_EXIT code=null
 *   signal=null)，而 cc 继续跑完、产物无人认领。实测复现：kill -9 bridge 后
 *   pid 828891 明明还在，日志却是「进程（pid=828891）已不在，补收尾」。
 *
 *   `?? sc.job_dir` 的回退只给 1.3.x 的老边车用 —— 它们没有 job_token，
 *   而那时的进程 token 确实就是 job 目录。
 */
export function isSidecarProcessAlive(sc) {
  return procAlive({
    pid: sc.pid, startTicks: sc.start_ticks ?? null, jobDir: sc.job_dir,
    jobToken: sc.job_token ?? sc.job_dir,
  });
}

/** 等进程真的消失。认领来的 job 没有 child 句柄，只能轮询。 */
async function waitGone(st, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!procAlive(st)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return !procAlive(st);
}

function startReaper(st) {
  stopReaper(st);
  st.reaper = setInterval(() => {
    if (st.settled) { stopReaper(st); return; }
    if (!procAlive(st)) { stopReaper(st); void onProcessGone(st, null, null); }
  }, 2000);
  st.reaper.unref?.();
}
function stopReaper(st) { if (st.reaper) clearInterval(st.reaper); st.reaper = null; }

/**
 * 进程消失后的统一收尾。child 事件与 pid 轮询都走这里，只会生效一次。
 *
 * 顺序很要紧：先把轨迹读到 EOF 再收尾 —— 末尾那条 result 事件决定
 * last_assistant_text 和「上下文爆了」的判定，拿不到就会误判。
 */
async function onProcessGone(st, code, signal) {
  if (st.settled || st.goneHandled) return;
  st.goneHandled = true;
  if (st.fsTimer) clearInterval(st.fsTimer);
  stopReaper(st);
  try { await st.tailer?.pump(); } catch {}      // 最后一次读到 EOF
  st.tailer?.stop();
  killLeftovers(st);
  await settle(st, code, signal);
}

/** 边车索引路径。按 worker_id 分目录：两台 Bridge 共用 sessions_root，
 *  不隔离的话会互相认领对方机器上的 pid。 */
function sidecarIndexPath(jobId) {
  return join(config.storage.root, 'bridge', config.worker.id, 'running', `${jobId}.json`);
}

/** 边车：Bridge 重启后靠它认领还活着的任务。 */
export async function writeRunningSidecar(st, ws) {
  const payload = {
    job_id: st.jobId, session_id: st.sessionId, mode: st.mode,
    lease_token: st.leaseToken,
    pid: st.pid, pgid: st.pgid, start_ticks: st.startTicks,
    job_dir: st.jobDir, out_dir: st.outDir, view_path: st.viewPath,
    agent_ws: st.agentWs, job_token: st.jobToken,
    log_path: st.logPath, err_path: st.errPath,
    isolated: st.isolated, started_at: st.startedAt,
    max_runtime_seconds: st.maxRuntimeSeconds,
    worker_id: config.worker.id,
    skillset: ws?.skillsetName ?? st.skillsetName ?? null,
    skills: ws?.skills ?? st.skills ?? [],
    assets: ws?.assetFiles ?? st.assetFiles ?? [],
    cc_session_id: st.ccSessionId ?? null,
  };
  try {
    await writeFile(join(st.jobDir, '.running.json'), JSON.stringify(payload, null, 2), 'utf8');
    const idx = sidecarIndexPath(st.jobId);
    await mkdir(join(idx, '..'), { recursive: true });
    await writeFile(idx, JSON.stringify({
      job_dir: st.jobDir, session_id: st.sessionId,
      pid: st.pid, started_at: st.startedAt,
    }, null, 2), 'utf8');
  } catch (e) {
    // 边车写不了不该影响任务本身，只是热更新时认领不到
    console.warn(`[runner] job ${st.jobId} 边车写入失败: ${e.message}`);
  }
}

export async function clearRunningSidecar(st) {
  const { rm } = await import('node:fs/promises');
  await rm(join(st.jobDir, '.running.json'), { force: true }).catch(() => {});
  await rm(sidecarIndexPath(st.jobId), { force: true }).catch(() => {});
}

/**
 * 这次执行算不算「正常收尾」。
 *
 * 认领来的任务没有退出码（没有 child 句柄），按 code===0 判会把成功的
 * 任务全判成失败。轨迹里的 result 事件才是权威：cc 自己说了成没成。
 */
function exitedCleanly(st, code) {
  if (st.lastResult) return st.lastResult.is_error !== true;
  return code === 0;
}

const OWN_PGID = (() => {
  const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' });
  const v = Number((r.stdout ?? '').trim());
  return Number.isFinite(v) && v > 0 ? v : null;
})();

/** 读子进程 pgid。null 表示没有可安全按组终止的进程组。 */
function resolvePgid(pid) {
  const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  const v = Number((r.stdout ?? '').trim());
  if (!Number.isFinite(v) || v <= 0) return null;
  if (OWN_PGID !== null && v === OWN_PGID) {
    console.error(`[runner] pid=${pid} 未获得独立进程组（与 Bridge 同组）→ 退化为单进程终止`);
    return null;
  }
  return v;
}

/** pgid 为 null 时只杀单进程，绝不按组杀（否则会连带杀死 Bridge） */
function signalGroup(st, sig) {
  const target = st.pgid === null ? st.pid : -st.pgid;
  try { process.kill(target, sig); return true; }
  catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}

/** 清残留：headless Chromium、脱离的渲染、后台 shell */
function killLeftovers(st) {
  const script = join(config.repoRoot, 'apps/worker-bridge/scripts/kill-leftovers.sh');
  if (!existsSync(script)) return;
  try {
    // ★ 两个参数：工作区（按 cwd/cmdline 匹配）+ token（按环境变量精确匹配）。
    //   1.4.0 起 CVW_JOB_TOKEN = <工作区>#<jobId>，不再等于工作区路径本身，
    //   只传工作区会让脚本里那条 `CVW_JOB_TOKEN=$DIR(/|$)` 永远匹配不上 —— 清残留就失效了。
    //   而清残留失效的后果是 headless Chromium 堆积（当年就是这条路径出的事）。
    const r = spawnSync('bash', [script, st.agentWs ?? st.jobDir, st.jobToken ?? ''],
      { encoding: 'utf8', timeout: 20_000 });
    const n = (() => { try { return JSON.parse(r.stdout ?? '{}').killed ?? 0; } catch { return 0; } })();
    if (n > 0) console.warn(`[runner] job ${st.jobId} 清理了 ${n} 个残留进程`);
  } catch (e) { console.warn(`[runner] 清残留失败: ${e.message}`); }
}

export async function cancelJob(jobId, reason = 'user', graceSeconds) {
  const st = running.get(jobId);
  if (!st) return { stopped: true, already_gone: true };
  st.cancelRequested = true;
  st.cancelReason = reason;
  const hardAfter = Math.min(
    (graceSeconds ?? config.timing.cancelGraceSeconds) * 1000,
    config.timing.sigtermToSigkillSeconds * 1000);

  signalGroup(st, 'SIGTERM');
  st.stopMethod = 'sigterm';
  // 用 pid 轮询而不是 child 事件：认领来的任务没有 child 句柄，
  // 等一个永不 resolve 的 Promise 会白白耗掉整个宽限期才升级到 SIGKILL。
  const exited = await waitGone(st, hardAfter);
  if (!exited) {
    signalGroup(st, 'SIGKILL');
    st.stopMethod = 'sigkill';
    await waitGone(st, 10_000);
  }
  killLeftovers(st);
  return { stopped: true, stop_method: st.stopMethod };
}

export async function abortForLease(jobId, kind = 'abort_stale_lease') {
  const st = running.get(jobId);
  if (!st) return { stopped: true, already_gone: true };
  st.leaseValid = false;
  st.cancelReason = kind;
  signalGroup(st, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 2000));
  signalGroup(st, 'SIGKILL');
  killLeftovers(st);
  return { stopped: true, stop_method: 'sigkill', lease_invalidated: true };
}

/** 取过程事件（过程框拉取 / 断线续传） */
export function getEvents(jobId, afterSeq = 0) {
  const st = running.get(jobId);
  if (!st) return null;
  return st.events.filter((e) => e.seq > afterSeq);
}

/**
 * 认领一个在上一个 Bridge 实例里启动、现在仍然活着的任务。
 *
 * 为什么可行：cc 的 stdout 直接写文件（不经管道），Bridge 退出不会带走它；
 * 轨迹 claude.jsonl 是完整的，重放一遍就能把状态恢复出来。
 *
 * 三个必须守住的点：
 *  · seq 必须等于「在 claude.jsonl 中的行序」——Gateway 的 StreamPump 按 seq
 *    增量拉取，编号对不上就会跳事件或重复。
 *  · 重放历史时不能触发 hooks，否则会把几百条历史事件重新 POST 给 Gateway。
 *  · lastProgressAt 必须按文件 mtime 重置。继承旧值的话，一个安静了 20 分钟的
 *    健康任务会在认领后立刻被「提前收尾」SIGKILL —— 正是 1.3.2 刚修掉的
 *    job_fc8e0e14 那个坑。
 */
export async function adoptJob(sc, hooks) {
  if (running.has(sc.job_id)) return { adopted: false, reason: 'ALREADY_RUNNING' };

  const st = {
    jobId: sc.job_id, sessionId: sc.session_id, mode: sc.mode,
    leaseToken: sc.lease_token,
    pid: sc.pid, pgid: sc.pgid, startTicks: sc.start_ticks ?? null,
    child: null, adopted: true,
    phase: 'GENERATING', phaseStartedAt: nowIso(), startedAt: sc.started_at ?? nowIso(),
    lastProgressAt: nowIso(),
    maxRuntimeSeconds: sc.max_runtime_seconds,
    cancelRequested: false, cancelReason: null, leaseValid: true,
    jobDir: sc.job_dir,
    agentWs: sc.agent_ws ?? sc.job_dir,
    jobToken: sc.job_token ?? sc.job_dir,
    outDir: sc.out_dir ?? join(sc.agent_ws ?? sc.job_dir, 'output'),
    viewPath: sc.view_path,
    logPath: sc.log_path, errPath: sc.err_path, isolated: sc.isolated,
    skills: sc.skills ?? [], skillsetName: sc.skillset ?? null, assetFiles: sc.assets ?? [],
    hooks: hooks ?? {}, settled: false,
    events: [], eventSeq: 0, toolFailStreak: 0,
    ccSessionId: sc.cc_session_id ?? null, lastAssistantText: null,
  };

  // 重放历史：只吃完整行，偏移量停在最后一个换行处
  let offset = 0;
  try {
    const raw = readFileSync(sc.log_path, 'utf8');
    const nl = raw.lastIndexOf('\n');
    if (nl >= 0) {
      offset = Buffer.byteLength(raw.slice(0, nl + 1), 'utf8');
      st.replaying = true;
      for (const line of raw.slice(0, nl).split('\n')) {
        if (line.trim()) handleStreamLine(st, line);
      }
      st.replaying = false;
    }
  } catch (e) {
    console.warn(`[runner] job ${sc.job_id} 轨迹重放失败（仍继续认领）: ${e.message}`);
    st.replaying = false;
  }

  // 活跃度按文件实际 mtime 重置，绝不继承重放出来的旧时间戳
  let newest = 0;
  for (const f of [sc.log_path, sc.err_path, sc.job_dir]) {
    try { newest = Math.max(newest, statSync(f).mtimeMs); } catch {}
  }
  st.lastProgressAt = new Date(Math.max(newest, Date.now() - 60_000)).toISOString();
  st.lastFsMtime = newest;

  running.set(sc.job_id, st);

  st.tailer = new JsonlTailer({
    path: sc.log_path, fromOffset: offset,
    onLine: (line) => handleStreamLine(st, line),
    onError: (e) => console.warn(`[runner] job ${sc.job_id} 读轨迹失败: ${e.message}`),
  });
  st.tailer.start();

  st.fsTimer = setInterval(() => {
    detectFromFs(st).then((ready) => (ready ? maybeHarvestEarly(st) : false)).catch(() => {});
  }, 5000);
  st.fsTimer.unref?.();
  startReaper(st);

  console.log(`[runner] 已认领 job ${sc.job_id} pid=${sc.pid} 事件=${st.eventSeq} 阶段=${st.phase}`);
  return { adopted: true, job_id: sc.job_id, pid: sc.pid, events: st.eventSeq, phase: st.phase };
}

/**
 * 用边车信息把一个【已经死掉】的任务收尾。
 *
 * 不做的话：Bridge 重启期间 cc 死了，没人写 .done/.failed，
 * 用户会永远看到「进行中」。
 */
export async function settleDeadJob(sc, hooks) {
  const st = {
    jobId: sc.job_id, sessionId: sc.session_id, mode: sc.mode,
    leaseToken: sc.lease_token, pid: sc.pid, pgid: sc.pgid, child: null,
    phase: 'GENERATING', startedAt: sc.started_at ?? nowIso(), lastProgressAt: nowIso(),
    jobDir: sc.job_dir,
    agentWs: sc.agent_ws ?? sc.job_dir,
    jobToken: sc.job_token ?? sc.job_dir,
    outDir: sc.out_dir ?? join(sc.agent_ws ?? sc.job_dir, 'output'),
    viewPath: sc.view_path, logPath: sc.log_path, errPath: sc.err_path,
    isolated: sc.isolated, skills: sc.skills ?? [], skillsetName: sc.skillset ?? null,
    assetFiles: sc.assets ?? [], hooks: hooks ?? {}, settled: false,
    events: [], eventSeq: 0, toolFailStreak: 0,
    ccSessionId: sc.cc_session_id ?? null, lastAssistantText: null,
    leaseValid: true, cancelRequested: false,
  };
  try {
    const raw = readFileSync(sc.log_path, 'utf8');
    const nl = raw.lastIndexOf('\n');
    if (nl >= 0) {
      st.replaying = true;
      for (const line of raw.slice(0, nl).split('\n')) {
        if (line.trim()) handleStreamLine(st, line);
      }
      st.replaying = false;
    }
  } catch { st.replaying = false; }
  running.set(sc.job_id, st);
  // 走正常收尾：有产物就补 .done，没有就按失败处理
  await settle(st, st.lastResult ? (st.lastResult.is_error ? 1 : 0) : null, null);
  return { settled: true, job_id: sc.job_id };
}

