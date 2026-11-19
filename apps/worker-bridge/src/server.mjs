#!/usr/bin/env node
import { whiteboxResponse } from '../../shared/whitebox-response.mjs';
import { validateVideo } from '../../shared/video-validation.mjs';
import { json, err, readJsonStrict as readJson, matchRoute } from '../../shared/http.mjs';
/**
 * Worker Bridge —— 后端机器上的常驻 HTTP 服务。
 *
 * 这是【生产数据通路】：Gateway 通过 HTTP 调本服务来起会话、投任务、取消、对账。
 * SSH 仅用于部署与调试（scripts/deploy-bridge.sh、scripts/ssh-debug.sh），
 * 前端上线后的任何请求都不经过 SSH。
 *
 * 启动：
 *   CVW_WORKER_ID=cvw-131 CVW_GATEWAY_BASE_URL=http://gw:9999 \
 *   CVW_INTERNAL_TOKEN=... CVW_MODEL_API_KEY=... node src/server.mjs
 */
import { createWhiteboxProxy } from './whitebox-proxy.mjs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { config, describeConfig, detectModelContext } from './config.mjs';
import * as runner from './job-runner.mjs';
import { adoptRunningJobs } from './job-adopter.mjs';
import * as sup from './supervisor.mjs';
import { gateway, withRetry } from './gateway-client.mjs';
import { prepareSessionWorkspace, verifySkillIsolation, sessionDir } from './session-workspace.mjs';
import * as store from './session-store.mjs';
import * as refs from './references.mjs';

const PROCESS_INSTANCE_ID = `${config.worker.id}:${randomUUID()}`;
sup.setProcessInstanceId(PROCESS_INSTANCE_ID);

/**
 * 无需鉴权的路由白名单。
 * 只有探活在内 —— 它要能被监控无凭证访问，且不含任何敏感信息、无副作用。
 * 往这里加路由前先想清楚：分发层的鉴权是会话名额的唯一防线。
 */
const PUBLIC_ROUTES = new Set(['GET /health']);

/** 内部鉴权：与 Gateway 共享同一 token。 */
function authed(req) {
  const t = req.headers['x-internal-token'];
  return typeof t === 'string' && t.length >= 16 && t === config.gateway.internalToken;
}

/** 把 Gateway 需要的回调挂到 job 上。全部经 HTTP，不经 SSH。 */
function hooksFor(jobId) {
  return {
    onPhase: ({ phase }) =>
      withRetry(() => gateway.jobProgress(jobId, {
        lease_token: runner.getJob(jobId)?.leaseToken,
        phase, phase_changed: true, progress_percent: null,
        reported_at: new Date().toISOString(),
      }), { label: `progress ${jobId}`, tries: 3 }).catch((e) =>
        console.warn(`[bridge] progress 上报失败 ${jobId}: ${e.message}`)),

    onComplete: (meta) =>
      withRetry(() => gateway.jobComplete(jobId, {
        lease_token: jobLeases.get(jobId),
        asset: meta.response ? null : {
          kind: 'video',
          storage_path: meta.storage_path,
          completion_marker: meta.completion_marker,
          mime_type: 'video/mp4',
          size_bytes: meta.size_bytes,
          /**
           * ★ 画面元信息要带上。这里原来是**固定字段列表**，
           * job-runner 探到的 width/height/duration_ms 全被丢在这一步 ——
           * 于是 result_asset 里这三项永远是 null，界面上「分辨率 · 时长」
           * 两项一直不显示（实测 12 个成片无一例外）。
           * 用条件展开：探不到就不带这个键，不要塞 null 覆盖掉已有值
           * （对账补判可能先写过一次）。
           */
          ...(meta.width ? { width: meta.width } : {}),
          ...(meta.height ? { height: meta.height } : {}),
          ...(meta.duration_ms ? { duration_ms: meta.duration_ms } : {}),
        },
        response: meta.response,
        last_assistant_text: meta.last_assistant_text,
        finished_at: meta.finished_at,
      }), { label: `complete ${jobId}`, tries: 8 })
        .then(() => { jobLeases.delete(jobId); console.log(`[bridge] job ${jobId} 完成已上报`); })
        .catch((e) => console.error(`[bridge] complete 上报最终失败 ${jobId}: ${e.message}（产物与 .done 标记已在共享存储，Gateway 可对账补判）`)),

    onFail: (failure) =>
      withRetry(() => gateway.jobFail(jobId, {
        lease_token: jobLeases.get(jobId),
        failure, partial_artifacts: [], failed_at: new Date().toISOString(),
      }), { label: `fail ${jobId}`, tries: 5 })
        .then(() => jobLeases.delete(jobId))
        .catch((e) => console.error(`[bridge] fail 上报失败 ${jobId}: ${e.message}`)),

    onCancelled: (ack) =>
      withRetry(() => gateway.jobCancelAck(jobId, {
        lease_token: jobLeases.get(jobId), ...ack,
      }), { label: `cancel-ack ${jobId}`, tries: 5 })
        .then(() => jobLeases.delete(jobId))
        .catch((e) => console.error(`[bridge] cancel-ack 上报失败 ${jobId}: ${e.message}`)),

    /** 过程事件 → Gateway（V2 需求 4 的过程框 / 需求 7 的 cc 回复） */
    onStreamEvent: (ev) => {
      streamBuf.set(jobId, [...(streamBuf.get(jobId) ?? []), ev].slice(-5000));
      // 不逐条 POST（高频会打爆 Gateway）；Gateway 用 /jobs/:id/stream 拉取
    },

    onLeaseLostExit: () => {
      jobLeases.delete(jobId);
      console.warn(`[bridge] job ${jobId} 因租约失效退出，已放弃结果（未提交任何产物）`);
    },
  };
}

/** 本实例启动时认领到的任务（供 /health 自检）。 */
const ADOPTED = { ids: [], at: null };

const jobLeases = new Map();   // jobId → leaseToken
/** jobId → 过程事件缓冲。Gateway 轮询 /jobs/:id/stream 拉走。 */
const streamBuf = new Map();

const routes = {
  /** 探活。必须轻量，繁忙时也要秒回（P0-20）。 */
  'GET /health': async (req, res) => json(res, 200, {
    version: config.appVersion,
    process_instance_id: PROCESS_INSTANCE_ID,
    status: sup.draining ? 'draining' : 'healthy',
    worker_id: config.worker.id,
    running_jobs: runner.runningCount(),
    running_job_refs: runner.listRunningJobIds(),
    adopted_jobs: ADOPTED.ids,           // 本实例启动时认领下来的（热更新自检用）
    adopted_at: ADOPTED.at,
    supports_adoption: true,             // 部署脚本据此判断能否真热更
    max_concurrent_jobs: config.worker.maxConcurrentJobs,
    registered: sup.isRegistered(),
    uptime_seconds: Math.round(process.uptime()),
    server_time: new Date().toISOString(),
  }),

  /** 配置自检：给排障用，不含密钥。 */
  'GET /debug/config': async (req, res) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    return json(res, 200, {
      ...describeConfig(),
      process_instance_id: PROCESS_INSTANCE_ID,
      runtime_binaries: {
        chrome_bin: config.runtimeBinaries.chromeBin,
        previs_dependency_root: config.runtimeBinaries.previsDependencyRoot,
        ffmpeg: config.runtimeBinaries.ffmpeg,
      },
      skills_available: {
        coding_to_video: existsSync(`${config.skills.sourceRoot}/code-video-base`),
        blockout_3d: existsSync(`${config.skills.sourceRoot}/code-video-whitebox`),
      },
      storage_writable: existsSync(config.storage.root),
    });
  },

  /** 创建会话：按 mode 挂物理隔离的 skill。 */
  'POST /sessions': async (req, res) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const b = await readJson(req);
    if (!b.session_id || !b.mode) return err(res, 400, 'VALIDATION_FAILED', '缺少 session_id 或 mode');
    if (!config.worker.supportedModes.includes(b.mode))
      return err(res, 400, 'MODE_UNSUPPORTED', `本 Worker 不支持 mode=${b.mode}`);
    if (sup.draining) return err(res, 503, 'DRAINING', '本进程正在下线，不接新会话');

    try {
      const ws = await prepareSessionWorkspace({ sessionId: b.session_id, mode: b.mode, modelSelection: b.model_selection, builtinSkills: b.builtin_skills });
      sup.activeSessions.add(b.session_id);
      // 持久化会话元信息：便于按用户恢复与导出轨迹
      await store.upsertSessionMeta({
        sessionId: b.session_id,
        userId: b.user_id ?? null,
        mode: b.mode,
        workerId: config.worker.id,
        processInstanceId: PROCESS_INSTANCE_ID,
        skill: ws.skillsetName,
        status: 'ACTIVE',
        // 渠道写进 meta：按渠道（测试/外发）汇总或导出用户轨迹时用
        extra: { channel: b.channel ?? null, user_note: b.user_note ?? null, model_selection: b.model_selection ?? null, builtin_skills: b.builtin_skills ?? null },
      });
      await store.appendTrace(b.session_id, {
        kind: 'session_created', mode: b.mode, skillset: ws.skillsetName, skills: ws.skills,
        process_instance_id: PROCESS_INSTANCE_ID, user_id: b.user_id ?? null,
        extra: { model_selection: b.model_selection ?? null, builtin_skills: b.builtin_skills ?? null },
      });
      return json(res, 200, {
        accepted: true,
        backend_session_ref: b.session_id,
        process_instance_id: PROCESS_INSTANCE_ID,
        skillset: ws.skillsetName,
        skills: ws.skills,
        workspace: ws.dir,
        isolation: verifySkillIsolation(b.session_id, b.mode, b.builtin_skills),
      });
    } catch (e) {
      return err(res, 500, 'SESSION_INIT_FAILED', e.message);
    }
  },

  /** 投递生成任务。立即返回，不等 1~2 小时的生成。 */
  'POST /jobs': async (req, res) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const b = await readJson(req);
    // 派任务 ⇒ 这个会话确实在用，【登记】而不只是刷新。
    // 用 touchSession 不行：bridge 重启后 sessionSeen 是空的，老会话来派任务
    // 会 touch 失败 ⇒ 名额算不上 ⇒ 超卖（实际在用的会话没占名额）。
    // 本路由已鉴权（分发层统一拦过），登记是安全的。
    if (b.session_id) sup.registerSession(b.session_id);
    for (const f of ['job_id', 'session_id', 'mode', 'prompt', 'lease_token']) {
      if (!b[f]) return err(res, 400, 'VALIDATION_FAILED', `缺少 ${f}`);
    }
    if (!config.worker.supportedModes.includes(b.mode)) return err(res, 400, 'MODE_UNSUPPORTED', '本 Worker 不支持该任务模式');
    if (sup.draining) return err(res, 503, 'DRAINING', '本进程正在下线，不接新任务');

    jobLeases.set(b.job_id, b.lease_token);
    try {
      const r = await runner.startJob({
        jobId: b.job_id,
        sessionId: b.session_id,
        mode: b.mode,
        modelSelection: b.model_selection, experimentalSkills: b.experimental_skills,
        prompt: b.prompt,
        leaseToken: b.lease_token,
        baseAssetPath: b.base_asset_path ?? null,
        isRevision: b.is_revision === true,
        maxRuntimeSeconds: b.max_runtime_seconds ?? 10800,
        hooks: hooksFor(b.job_id),
      });
      await store.appendTrace(b.session_id, {
        kind: 'job_created', job_id: b.job_id, mode: b.mode,
        prompt_length: String(b.prompt).length,
        prompt_summary: String(b.prompt).slice(0, 300),
        base_asset_path: b.base_asset_path ?? null,
        max_runtime_seconds: b.max_runtime_seconds ?? 10800,
      });
      return json(res, 202, { ...r, backend_job_ref: b.job_id, process_instance_id: PROCESS_INSTANCE_ID });
    } catch (e) {
      jobLeases.delete(b.job_id);
      if (e.code === 'WORKER_AT_CAPACITY')
        return err(res, 503, 'WORKER_AT_CAPACITY', `本机并发已满 (${config.worker.maxConcurrentJobs})`);
      return err(res, 500, 'JOB_START_FAILED', e.message);
    }
  },

  /** 取消单个任务。只杀该 Job 的进程组，绝不影响其他任务或本服务。 */
  'POST /jobs/:id/cancel': async (req, res, { id }) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const b = await readJson(req);
    const r = await runner.cancelJob(id, b.reason ?? 'user', b.grace_seconds);
    return json(res, 202, { acked: true, ...r });
  },

  /** 对账：Gateway 在 Job 状态未知时查询真实情况。明确回答，不沉默。 */
  'GET /jobs/:id': async (req, res, { id }) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const st = runner.getJob(id);
    if (st) {
      return json(res, 200, {
        status: 'running',
        phase: st.phase,
        started_at: st.startedAt,
        last_progress_at: st.lastProgressAt,
        pid: st.pid,
      });
    }
    // 不在内存里 → 查共享存储的终态标记
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    for (const [marker, status] of [['.done', 'completed'], ['.cancelled', 'cancelled'],
                                    ['.failed', 'failed'], ['.aborted', 'failed']]) {
      // 需要 session_id 才能定位；Gateway 对账时应带上
      const sid = new URL(req.url, 'http://x').searchParams.get('session_id');
      if (!sid) continue;
      // ★ 1.4.0：标记落在按轮次的簿记目录（老会话回退到 jobs/<jid>/）
      const { resolveJobPaths } = await import('./job-paths.mjs');
      const p = join(resolveJobPaths(sid, id).bookDir, marker);
      if (existsSync(p)) {
        const meta = JSON.parse(await readFile(p, 'utf8'));
        if (status === 'completed') {
          const response = whiteboxResponse(meta.mode, meta.response);
          if (response) return json(res, 200, { status, response, finished_at: meta.finished_at });
          try {
            const verified = await validateVideo(meta.storage_path, {
              expectedSize: meta.size_bytes, fullDecode: meta.validation?.full_decode !== true,
            });
            Object.assign(meta, verified);
          } catch (e) {
            return json(res, 200, { status: 'failed', failure: { code: 'E_INVALID_VIDEO', message: e.message } });
          }
          return json(res, 200, {
            status,
            asset: {
              storage_path: meta.storage_path, completion_marker: p, size_bytes: meta.size_bytes,
              // 与 onComplete 同一套：对账补判走的是这条路，字段不能比它少
              ...(meta.width ? { width: meta.width } : {}),
              ...(meta.height ? { height: meta.height } : {}),
              ...(meta.duration_ms ? { duration_ms: meta.duration_ms } : {}),
            },
          });
        }
        if (status === 'cancelled') {
          return json(res, 200, { status, cancelled_at: meta.at, reason: meta.reason });
        }
        // .failed / .aborted —— 明确回答失败，不让 Gateway 停在 UNKNOWN 等心跳超时
        return json(res, 200, {
          status: 'failed',
          failure: {
            code: meta.code ?? 'E_ABORTED',
            message: meta.note ?? meta.reason ?? '执行中止',
            phase: meta.phase ?? null,
          },
          failed_at: meta.at,
        });
      }
    }
    return json(res, 200, { status: 'not_found' });
  },

  /** 校验某 session 的 skill 隔离是否正确——权限审计用。 */
  'GET /sessions/:id/isolation': async (req, res, { id }) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const mode = new URL(req.url, 'http://x').searchParams.get('mode');
    if (!mode) return err(res, 400, 'VALIDATION_FAILED', '缺少 mode 查询参数');
    const meta = await store.readSessionMeta(id);
    return json(res, 200, verifySkillIsolation(id, mode, meta?.builtin_skills));
  },

  /** 会话元信息 + 轨迹 + Job 列表：用于按用户恢复会话。 */
  'GET /sessions/:id/trace': async (req, res, { id }) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const e = await store.exportSession(id, { includeClaudeLogs: false });
    if (!e) return err(res, 404, 'NOT_FOUND', `session ${id} 无持久化记录`);
    return json(res, 200, e);
  },

  /** 按用户列出会话：localStorage 丢失时的服务端兜底。 */
  'GET /users/:id/sessions': async (req, res, { id }) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const limit = Number(new URL(req.url, 'http://x').searchParams.get('limit') ?? 50);
    const sessions = await store.listSessionsByUser(id, { limit });
    return json(res, 200, { user_id: id, count: sessions.length, sessions });
  },

  /** 导出用户完整轨迹。含 Prompt 原文，对外分享前需脱敏。 */
  'GET /users/:id/export': async (req, res, { id }) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const q = new URL(req.url, 'http://x').searchParams;
    const data = await store.exportUserTrajectory(id, {
      includeClaudeLogs: q.get('logs') === '1',
      limit: Number(q.get('limit') ?? 50),
    });
    return json(res, 200, data);
  },

  /* ───────── Reference 附件（V2 需求 1）───────── */

  'GET /sessions/:id/references': async (req, res, { id }) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const m = await refs.readManifest(id);
    const max = config.raw.references?.max_per_session ?? 10;
    return json(res, 200, { ...m, max_per_session: max, remaining: Math.max(0, max - m.items.length) });
  },

  /** 给增强模型用的 assets JSON（含 ffprobe 实测 meta） */
  'GET /sessions/:id/references/assets-json': async (req, res, { id }) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    return json(res, 200, { assets: await refs.assetsJsonForEnhance(id) });
  },

  /** 上传：Gateway 已把文件落到临时路径，这里只负责校验与入位 */
  'POST /sessions/:id/references': async (req, res, { id }) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const b = await readJson(req);
    if (!b.filename || !b.tmp_path) {
      return err(res, 400, 'VALIDATION_FAILED', '缺少 filename 或 tmp_path');
    }
    try {
      const r = await refs.addReference(id, { filename: b.filename, tmpPath: b.tmp_path, note: b.note });
      await store.appendTrace(id, {
        kind: 'reference_added', name: r.item.stored_name,
        type: r.item.type, size_bytes: r.item.size_bytes,
      });
      return json(res, 201, r);
    } catch (e) {
      const code = e.code ?? 'REFERENCE_FAILED';
      const status = code === 'REFERENCE_LIMIT_EXCEEDED' || code === 'REFERENCES_FROZEN' ? 409
        : code === 'REFERENCE_TYPE_UNSUPPORTED' ? 415
        : code === 'REFERENCE_TOO_LARGE' ? 413 : 500;
      return err(res, status, code, e.message);
    }
  },

  'DELETE /sessions/:id/references/:name': async (req, res, { id, name }) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    try {
      const m = await refs.removeReference(id, name);
      await store.appendTrace(id, { kind: 'reference_removed', name });
      return json(res, 200, m);
    } catch (e) {
      return err(res, e.code === 'NOT_FOUND' ? 404 : 409, e.code ?? 'REFERENCE_FAILED', e.message);
    }
  },

  'POST /sessions/:id/references/freeze': async (req, res, { id }) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    return json(res, 200, await refs.freezeReferences(id));
  },

  /**
   * 过程事件（V2 需求 4）。Gateway 按 after 增量拉取后扇出给前端。
   * 用拉取而非 push：claude 的事件频率高，逐条 POST 会打爆 Gateway。
   */
  'GET /jobs/:id/stream': async (req, res, { id }) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const after = Number(new URL(req.url, 'http://x').searchParams.get('after') ?? 0);
    const live = runner.getEvents(id, after);
    if (live !== null) {
      const st = runner.getJob(id);
      return json(res, 200, {
        events: live, running: true,
        phase: st?.phase ?? null,
        last_assistant_text: st?.lastAssistantText ?? null,
        cc_session_id: st?.ccSessionId ?? null,
        tool_fail_streak: st?.toolFailStreak ?? 0,
        last_progress_at: st?.lastProgressAt ?? null,
      });
    }
    // 已结束：优先内存缓冲，缺失时从磁盘 claude.jsonl 回放
    let buf = (streamBuf.get(id) ?? []).filter((e) => e.seq > after);
    let ccSession = null;
    const sid = new URL(req.url, 'http://x').searchParams.get('session_id');
    if (sid) {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      // ★ 1.4.0：两份东西不在一个目录了 ——
      //   .cc-session 在【本轮簿记目录】，claude.jsonl 在【会话共享工作区】。
      //   轨迹各轮追加到同一个文件，所以第 2 轮回放时会把第 1 轮的事件也带出来，
      //   正是"接着之前的执行轨迹继续显示"想要的效果；seq 用文件内绝对行号，
      //   与实时推送同源，不会错位。
      const { resolveJobPaths } = await import('./job-paths.mjs');
      const { agentWs, bookDir } = resolveJobPaths(sid, id);
      try {
        ccSession = JSON.parse(await readFile(join(bookDir, '.cc-session'), 'utf8')).cc_session_id;
      } catch {}
      if (!buf.length) {
        try {
          const raw = await readFile(join(agentWs, 'claude.jsonl'), 'utf8');
          const { parseStreamLine } = await import('./stream-parser.mjs');
          let seq = 0;
          const all = [];
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            for (const ev of parseStreamLine(line)) all.push({ seq: ++seq, ...ev });
          }
          buf = all.filter((e) => e.seq > after);
        } catch {}
      }
    }
    return json(res, 200, { events: buf, running: false, cc_session_id: ccSession });
  },

  /**
   * 释放会话名额。Gateway 在确定会话不再使用时调用（用户新建对话、会话降级等）。
   *
   * 只释放【名额】，不删工作区 —— 产物与轨迹要留着给用户回看。
   * 名额立刻还给 max_sessions，排队/新用户马上能用上，不必等 TTL 到期。
   */
  'DELETE /sessions/:id': async (req, res, { id }) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const freed = sup.releaseSession(id);
    if (freed) console.log(`[bridge] 会话 ${id} 名额已释放（当前占用 ${sup.activeSessionCount()}）`);
    return json(res, 200, {
      released: freed, active_sessions: sup.activeSessionCount(), server_time: new Date().toISOString(),
    });
  },

  /** 优雅下线。 */
  'POST /drain': async (req, res) => {
    if (!authed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    sup.setDraining(true);
    return json(res, 200, { draining: true, running_jobs: runner.listRunningJobIds() });
  },
};


const whiteboxProxy = createWhiteboxProxy(config, runner.getJob);
const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? 'x'}`);
  const modelRoute = /^\/whitebox-model\/(job_[a-f0-9-]{36})(\/v1\/messages(?:\/count_tokens)?)$/.exec(pathname);
  if (modelRoute && config.raw.whitebox?.enabled) {
    try { return await whiteboxProxy(req, res, modelRoute[1], modelRoute[2]); }
    catch (e) { if (!res.headersSent) return err(res, 502, 'WHITEBOX_MODEL_ERROR', e.message); return res.destroy(); }
  }
  const [handler, params] = matchRoute(routes, req.method, pathname);
  if (!handler) return err(res, 404, 'NOT_FOUND', `${req.method} ${pathname}`);

  // ★ 先鉴权，再做任何有副作用的事。
  //
  // 1.3.8/1.3.9 把打点放在鉴权【之前】，于是未鉴权请求也能占会话名额：
  // 发 8 个无 token 的 /sessions/:id 请求就能占满一台（max_sessions=8），
  // 真实用户随后新建对话拿到 503 —— 正是 1.3.8 要修的那个故障换了个入口回来。
  // dev 实测：5 个 401 请求让名额从 0 涨到 5。
  //
  // /health 必须保持无鉴权（监控在用），所以走白名单而不是一刀切。
  if (!PUBLIC_ROUTES.has(`${req.method} ${pathname}`) && !authed(req)) {
    return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
  }

  // 统一打点：带 session 的请求算这个会话「还在用」，刷新它的 TTL。
  // 放在分发层而不是逐个 handler 里，避免以后加接口漏打点 ——
  // 漏了会导致活跃会话被误回收，比不回收更糟。
  //
  // ★ 排除 DELETE /sessions/:id：它的语义是【释放】，不该先把会话 touch 回来，
  //   否则 releaseSession 永远返回 true，`released` 字段失去诊断价值。
  const isRelease = req.method === 'DELETE' && /^\/sessions\/[^/]+$/.test(pathname);
  if (params?.id && /^\/sessions\//.test(pathname) && !isRelease) {
    sup.touchSession(params.id);
  }
  try {
    await handler(req, res, params);
  } catch (e) {
    console.error(`[bridge] ${req.method} ${pathname} 处理异常:`, e);
    if (!res.headersSent) err(res, 500, 'INTERNAL', e.message);
  }
});

server.listen(config.worker.port, '0.0.0.0', async () => {
  console.log('='.repeat(72));
  console.log('Worker Bridge 已启动');
  console.table?.(describeConfig()) ?? console.log(describeConfig());
  console.log(`process_instance_id = ${PROCESS_INSTANCE_ID}`);
  console.log(`监听 0.0.0.0:${config.worker.port}  （生产通路：HTTP，不经 SSH）`);
  console.log('='.repeat(72));
  // ★ 认领必须在 register() 之前完成：注册请求要带上认领到的 job 列表，
  // Gateway 据此改绑任务与租约持有者。晚一步，这些任务就会在第一次心跳的
  // 归属校验里被判成「不属于此实例」而被 abort 掉。
  let adopted = { adopted: [], settled: [], dead: [], skipped: [] };
  try {
    adopted = await adoptRunningJobs((jobId, sc) => {
      // 认领来的任务要先把租约补回去，否则 complete/fail 上报没有 token
      if (sc?.lease_token) jobLeases.set(jobId, sc.lease_token);
      // 它的会话也要重新登记：任务还在跑就说明会话在用，
      // 不登记会造成【超卖】—— 正在跑的任务不占名额，新会话却照样进来。
      if (sc?.session_id) sup.registerSession(sc.session_id);
      return hooksFor(jobId);
    }, console);
  } catch (e) {
    console.error(`[bridge] 认领运行中任务失败（不影响新任务）: ${e.message}`);
  }
  ADOPTED.ids = adopted.adopted;
  ADOPTED.at = new Date().toISOString();
  try {
    // 先核对模型上下文长度，再注册 —— 之后派发的 job 才会用上正确的值
    await detectModelContext(console);
    await sup.register({ adoptedJobIds: adopted.adopted });
    sup.startHeartbeats();
  } catch (e) {
    console.error(`[bridge] 注册 Gateway 失败: ${e.message}`);
    console.error('[bridge] 服务继续运行，可稍后手动触发注册；不影响已在跑的任务');
  }
});

async function shutdown(sig) {
  console.log(`\n[bridge] 收到 ${sig}，开始 drain（不杀正在跑的任务）`);
  sup.setDraining(true);
  sup.stopHeartbeats();
  server.close();
  const left = runner.listRunningJobIds();
  if (left.length) {
    console.log(`[bridge] 仍有 ${left.length} 个任务在跑: ${left.join(', ')}`);
    console.log('[bridge] 它们会继续执行；产物与 .done 标记落共享存储，Gateway 可对账补判');
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
