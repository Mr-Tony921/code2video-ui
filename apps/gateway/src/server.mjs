#!/usr/bin/env node
import { sekoPublicResult, sekoDownload } from '../../shared/seko-artifact.mjs';
import { isSeko, sekoSelection, sekoSettings, sekoConnection } from '../../shared/seko-model.mjs';
import { whiteboxResponsePatch } from '../../shared/whitebox-response.mjs';
import { validateVideo } from '../../shared/video-validation.mjs';
/**
 * Gateway —— 调度与对外 API 的常驻服务。默认端口 9999。
 *
 * 两套物理隔离的 API 面：
 *   /api/*       浏览器公开 API（会话 Cookie）
 *   /internal/*  Bridge 回调（共享密钥，仅内网）
 *
 * 独立于 Next.js：Web 发版/重启不影响调度与心跳监测，
 * 1~2 小时的任务不绑在短生命周期的 Web Handler 上。
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { json, err, readJson, matchRoute } from '../../shared/http.mjs';
import { internalAuthed, setSessionCookie, currentUser } from './auth.mjs';
import { config, describeGatewayConfig } from './config.mjs';
import { WorkerPool } from './worker-pool.mjs';
import { Dispatcher, compareQueuedJobs } from './dispatcher.mjs';
import * as maintenance from './maintenance.mjs';
import { whiteboxEnabled } from '../../shared/whitebox.mjs';
import { agentStatus } from './enhance-agent.mjs';
import { Watchdog } from './watchdog.mjs';
import { StreamPump } from './stream-pump.mjs';
import { PresenceTracker } from './presence.mjs';
import { WatchdogPrompts } from './watchdog-prompts.mjs';
import { bridge } from './bridge-client.mjs';
import * as store from './store/job-store.mjs';
import { enhance, enhancementStatus } from './enhancer.mjs';
import * as invites from './invites.mjs';
import * as examples from './examples.mjs';
import { ensurePreview, previewPathFor, previewIsFresh, initPreviews } from './asset-preview.mjs';
import * as users from './users.mjs';
import { bridgeRefs } from './refs-proxy.mjs';
import { experimentalEnabled, experimentalModels, resolveExperimentalModel, validateBuiltinSkills } from '../../shared/experimental.mjs';
import { configuredSkills } from '../../shared/experimental-catalog.mjs';
import { prepareSkillRevision } from '../../shared/experimental-skills.mjs';
import { streamSessionArchive } from '../../shared/session-archive.mjs';
import { modelSettingsRoutes } from './model-settings-routes.mjs';
import { isManagedModel, canUsePersonalModel, lastPersonalModel, c2vModelSnapshot } from '../../shared/model-settings.mjs';

async function experimentalUser(req) {
  const signed = currentUser(req);
  if (!signed) throw Object.assign(new Error('未登录'), { status: 401, code: 'UNAUTHENTICATED' });
  const user = signed ? await users.get(signed.username) : null;
  if (!experimentalEnabled(config.raw) || !user?.can_use_experimental || user.status !== 'active')
    throw Object.assign(new Error('需管理员授予 dev 实验模式权限'), { status: 403, code: 'EXPERIMENTAL_FORBIDDEN' });
  return user;
}
function builtinPermission(user, builtin) {
  if (builtin === 'blockout_3d' && !(user.can_use_blockout_3d || user.role === 'admin'))
    throw Object.assign(new Error('加载白模内置 skill 还需白模权限'), { status: 403, code: 'BLOCKOUT_3D_FORBIDDEN' });
}

function canUseExperimentalModel(user, selection) {
  if (isManagedModel(selection)) return canUsePersonalModel(config.raw, selection, user.id);
  const profileId = selection?.profile_id ?? selection;
  const profile = config.raw.experimental.models?.find(p => p.id === profileId && p.enabled !== false);
  if (!profile || !Object.hasOwn(profile, 'allowed_user_ids')) return true;
  return Array.isArray(profile.allowed_user_ids) && profile.allowed_user_ids.includes(user.id);
}

function requireExperimentalModel(user, selection) {
  if (!canUseExperimentalModel(user, selection))
    throw Object.assign(new Error('该账号无权使用此实验模型'), { status: 403, code: 'EXPERIMENTAL_MODEL_FORBIDDEN' });
}


const pool = new WorkerPool({ repoRoot: config.repoRoot, backendConfig: config.raw });
const dispatcher = new Dispatcher({ pool });
const watchdog = new Watchdog({ pool, onSlotFreed: () => dispatcher.tick().catch(() => {}) });
const pump = new StreamPump({ pool });
const wdPrompts = new WatchdogPrompts({ pool });

/** 心跳断够久 → 停止任务（V2 需求 5） */
const presence = new PresenceTracker({
  onTimeout: async (job, ageMs) => {
    const requested = await store.transition(job.id, 'CANCEL_REQUESTED', {
      cancellation: {
        requested_at: nowIso(), requested_by: 'system', reason: 'presence_lost',
      },
    });
    if (!requested.ok) return;
    await store.appendEvent(job.id, 'job.cancel_requested', {
      status: 'CANCEL_REQUESTED', reason: 'presence_lost',
      note: `用户已离开页面超过 ${Math.round(ageMs / 60000)} 分钟，自动停止`,
    });
    await store.revokeLease(job.id);
    const base = pool.bridgeUrlFor(job.process_instance_id, job.worker_id);
    if (base) {
      bridge.cancelJob(base, job.id, { reason: 'presence_lost' })
        .then(async () => {
          const cancelling = await store.transition(job.id, 'CANCELLING');
          if (!cancelling.ok) return;
          await store.appendEvent(job.id, 'job.cancelling', { status: 'CANCELLING' });
        })
        .catch((e) => console.warn(`[presence] 下达停止失败: ${e.message}`));
    }
  },
});

/* ───────── 工具 ───────── */
const nowIso = () => new Date().toISOString();
/* ───────── 认证 ───────── */
/**
 * 结构化调试日志。压测/排障时按 user 或 session 过滤：
 *   grep '"u":"dengjianbin"' runtime/logs/gateway.log
 *   grep '"sid":"sess_xxx"'  runtime/logs/gateway.log
 * 默认开启（量不大：只记关键动作，不记每次轮询）。CVW_DEBUG=0 可关。
 */
const DEBUG_ON = process.env.CVW_DEBUG !== '0';
/** 当前打开的 SSE 连接数。并发排障用：同账号多地址会看到 >1。 */
let sseOpen = 0;
function dbg(evt, fields = {}) {
  if (!DEBUG_ON) return;
  try {
    console.log(`[dbg] ${JSON.stringify({ t: nowIso(), evt, ...fields })}`);
  } catch { /* 日志绝不能影响主流程 */ }
}

/* ───────── 公开 API ───────── */
const routes = {
  ...modelSettingsRoutes({ config, currentUser, experimentalUser, users, json, readJson }),
  'GET /healthz': async (req, res) => json(res, 200, {
    ok: true, ...describeGatewayConfig(),
    maintenance: maintenance.read(),
    processes: pool.processes.size,
    enhancement: enhancementStatus(),
    enhance_agent: agentStatus(),   // 运维可见：增强 agent 并发占用
    presence_sessions: presence.snapshot().length,
    global_used: pool.globalUsed,
    server_time: nowIso(),
  }),

  /* ───────── 邀请码（V2 需求 6）───────── */

  /** 生成邀请码。响应含完整码与有效期时间点 —— 发给用户时一并告知。 */
  'POST /api/admin/invites': async (req, res) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    if (u.role !== 'admin') return err(res, 403, 'FORBIDDEN', '需要管理员权限');
    const b = await readJson(req);
    const r = await invites.create({
      createdBy: u.id,
      maxUses: b.max_uses, validDays: b.valid_days,
      grantsBlockout3d: b.grants_blockout_3d, note: b.note,
      channel: b.channel,                      // 测试 / 外发 等渠道，注册时写进用户记录
    });
    return json(res, 201, {
      ...r,
      hint: `请把邀请码与有效期一并发给用户：${r.code}（有效至 ${r.expires_at}，${r.valid_days} 天）`,
      server_time: nowIso(),
    });
  },

  'GET /api/admin/invites': async (req, res) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    if (u.role !== 'admin') return err(res, 403, 'FORBIDDEN', '需要管理员权限');
    return json(res, 200, { invites: await invites.list(), server_time: nowIso() });
  },

  'POST /api/admin/invites/:id/revoke': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    if (u.role !== 'admin') return err(res, 403, 'FORBIDDEN', '需要管理员权限');
    try { return json(res, 200, { invite: await invites.revoke(id) }); }
    catch (e) { return err(res, 404, e.code ?? 'NOT_FOUND', e.message); }
  },

  /** 邀请码注册。用完即踢（max_uses=1 时注册一次就失效）。 */
  'POST /api/auth/register': async (req, res) => {
    const b = await readJson(req);
    for (const f of ['invite_code', 'username', 'password']) {
      if (!b[f]) return err(res, 400, 'VALIDATION_FAILED', `缺少 ${f}`);
    }
    if (String(b.password).length < 10) {
      return err(res, 400, 'VALIDATION_FAILED', '密码至少 10 个字符');
    }
    let redeemed;
    try {
      redeemed = await invites.redeem(b.invite_code, b.username);
    } catch (e) {
      const status = e.code === 'INVITE_EXPIRED' ? 410
        : e.code === 'INVITE_EXHAUSTED' || e.code === 'INVITE_REVOKED' ? 422 : 400;
      return err(res, status, e.code ?? 'INVITE_INVALID', e.message);
    }
    let user;
    try {
      user = await users.create({
        username: b.username, password: b.password,
        role: 'user',
        canUseBlockout3d: redeemed.grants_blockout_3d,   // 由邀请码决定，不由用户自选
        inviteId: redeemed.invite_id,
        channel: redeemed.channel,                        // 渠道随邀请码带入（测试/外发）
        note: redeemed.note,
      });
    } catch (e) {
      // 用户创建失败：邀请码已扣减，这里要提示用户联系管理员（不自动退还，避免并发漏洞）
      const status = e.code === 'USERNAME_TAKEN' ? 409 : 400;
      return err(res, status, e.code ?? 'REGISTER_FAILED',
        e.code === 'USERNAME_TAKEN'
          ? `${e.message}（该邀请码已被消耗，请联系管理员重新发码）`
          : e.message);
    }
    // 注册即登录：必须记一次登录时间，否则管理后台显示"从未登录"
    const withLogin = (await users.touchLogin(user.username)) ?? user;
    setSessionCookie(res, withLogin);
    return json(res, 201, { user: withLogin, invite_id: redeemed.invite_id, server_time: nowIso() });
  },

  /** 密码登录 */
  'POST /api/auth/login': async (req, res) => {
    const b = await readJson(req);
    if (!b.username || !b.password) {
      return err(res, 400, 'VALIDATION_FAILED', '请输入用户名与密码');
    }
    let u;
    try {
      u = await users.authenticate(b.username, b.password);
    } catch (e) {
      const status = e.code === 'ACCOUNT_DISABLED' ? 403 : 401;
      return err(res, status, e.code ?? 'UNAUTHENTICATED', e.message);
    }
    setSessionCookie(res, u);
    return json(res, 200, { user: u, server_time: nowIso() });
  },

  'POST /api/auth/logout': async (req, res) => {
    res.setHeader('set-cookie',
      `${config.auth.sessionCookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    res.writeHead(204); res.end();
  },

  /** 改密码。强制改密的用户登录后必须先走这里。 */
  'POST /api/auth/change-password': async (req, res) => {
    const me = currentUser(req);
    if (!me) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const b = await readJson(req);
    if (!b.current_password || !b.new_password) {
      return err(res, 400, 'VALIDATION_FAILED', '请输入当前密码与新密码');
    }
    try {
      const u = await users.changePassword(me.username, b.current_password, b.new_password);
      setSessionCookie(res, u);                      // 刷新会话，清掉 must_change_password
      return json(res, 200, { user: u, server_time: nowIso() });
    } catch (e) {
      return err(res, e.code === 'UNAUTHENTICATED' ? 401 : 400,
        e.code ?? 'CHANGE_PASSWORD_FAILED', e.message);
    }
  },

  /* ───────── 用户管理（管理员）───────── */

  /**
   * 上传/替换示例视频（管理员）。
   *
   * 校验「格式与完整性」分四步，任一不过即拒并删临时文件：
   *   1. 文件名后缀必须是 .mp4（白名单；不信 content-type —— 那是客户端说的）
   *   2. ffprobe 读元信息（gateway 所在机器自带 /usr/bin/ffprobe，实测可用）
   *   3. 必须有 video 流、h264、时长 > 0、宽高 > 0
   *   4. ★ 解码校验：`ffmpeg -v error -i <file> -f null -` 跑完整解码，有任何错误即拒。
   *
   * ⚠️ 第 4 步原本写的是「比对实际字节数与 ffprobe 的 format.size」，**实测无效**：
   *    `format.size` 就是 ffprobe stat 出来的文件大小，不是容器内部声明的值，
   *    两者恒等 —— 把一个 mp4 砍掉一半，它照样报 size=18701（实际也是 18701）、
   *    duration 照样 1.0（moov 在前半段里），streams 也齐全。那条判据拦不住任何东西。
   *    解码校验才真的能发现：截断文件会报
   *    `partial file` / `Invalid NAL unit size` / `Invalid data found`，
   *    且实读 16 帧而非应有的 30 帧。
   */
  'POST /api/admin/examples/:id/video': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u || u.role !== 'admin') return err(res, 403, 'FORBIDDEN', '需要管理员权限');
    const ex = await examples.getOne(id);
    if (!ex) return err(res, 404, 'NOT_FOUND', '示例不存在');

    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.includes('multipart/form-data')) {
      return err(res, 400, 'VALIDATION_FAILED', '需要 multipart/form-data');
    }
    const bm = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
    if (!bm) return err(res, 400, 'VALIDATION_FAILED', 'multipart boundary 缺失');

    let parsed;
    try {
      // 示例是展示用，200MB 足够；不用 parseMultipart 默认的 500MB
      parsed = await parseMultipart(req, bm[1] ?? bm[2], 200 * 1024 * 1024);
    } catch (e) {
      return err(res, 413, 'UPLOAD_FAILED', e.message);
    }
    if (!parsed.file) return err(res, 400, 'VALIDATION_FAILED', '未找到 file 字段');
    if (!/\.mp4$/i.test(parsed.file.filename ?? '')) {
      return err(res, 400, 'VALIDATION_FAILED', '只接受 .mp4 文件');
    }

    const { writeFile, mkdir, rename, unlink, stat, copyFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const tmpDir = join(config.storage.root, 'uploads');
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `exvid_${randomUUID()}.mp4`);
    const bail = async (msg) => {
      await unlink(tmp).catch(() => {});
      return err(res, 400, 'VALIDATION_FAILED', msg);
    };
    await writeFile(tmp, parsed.file.data);

    let info;
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      const { stdout } = await run('ffprobe', [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name,width,height',
        '-show_entries', 'format=duration,size',
        '-of', 'json', tmp,
      ], { timeout: 30_000, maxBuffer: 1 << 20 });
      info = JSON.parse(stdout);
    } catch (e) {
      return bail(`无法解析为视频：${String(e.stderr ?? e.message).slice(0, 200)}`);
    }

    const vs = (info.streams ?? []).find((x) => x.codec_type === 'video');
    if (!vs) return bail('文件里没有视频流');
    if (String(vs.codec_name) !== 'h264') {
      return bail(`视频编码必须是 h264，当前是 ${vs.codec_name}`);
    }
    const w = Number(vs.width), h = Number(vs.height);
    if (!(w > 0 && h > 0)) return bail('读不出有效的画面尺寸');
    const dur = Number(info.format?.duration);
    if (!(dur > 0)) return bail('读不出有效的时长');

    const actual = (await stat(tmp)).size;

    /**
     * ★ 完整性：整文件解码一遍，有任何错误就拒。
     *
     * 这是唯一可靠的办法（见本路由顶部的说明：比对 format.size 是无效判据）。
     * 代价是要真解码一遍 —— 示例片通常只有几秒到一分钟，200MB 上限下最坏几十秒，
     * 对「管理员上传」这种低频操作可以接受；给 120 秒超时兜底。
     */
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      const { stderr } = await run('ffmpeg', ['-v', 'error', '-i', tmp, '-f', 'null', '-'],
        { timeout: 120_000, maxBuffer: 1 << 20 });
      if (String(stderr ?? '').trim()) {
        return bail(`文件不完整或已损坏：${String(stderr).trim().split('\n')[0].slice(0, 180)}`);
      }
    } catch (e) {
      // execFile 在 ffmpeg 退出码非 0 时 reject —— 截断文件正是走这条
      const msg = String(e.stderr ?? e.message ?? '').trim().split('\n')[0];
      return bail(`文件不完整或已损坏：${msg.slice(0, 180) || '解码校验未通过'}`);
    }

    await examples.initAssets();
    const dst = examples.videoPathFor(id);

    /**
     * ★ 校验通过后做「预览化」处理（见 examples.optimizeForPreview 的说明）。
     *
     * 用户反馈「示例里面的视频加载也很卡」。实测线上那个示例片是
     * 40.33MB / 61s = **5.3 Mbps、1080p**，而它在弹框里最大只显示 360px 高。
     * 分档实测：不限 / 20 / 8 / 5 Mbps 都 0 卡顿，**1.5 Mbps 卡 3 次** ——
     * 它需要稳定 5~6 Mbps 才流畅。所以要降码率，顺带 faststart。
     * （这跟对话区那个 `loop` 不是一回事 —— 弹框里的 video 没有 loop。）
     *
     * 处理失败就**用原文件**：宁可存一个偏大的片子，也不能让管理员的上传失败。
     */
    const opt = join(tmpDir, `exvid_opt_${randomUUID()}.mp4`);
    let stored = tmp;
    let optResult = { applied: false, reason: '未处理', mode: 'none' };
    try {
      optResult = await examples.optimizeForPreview(tmp, opt);
      if (optResult.applied) stored = opt;
    } catch (e) {
      optResult = { applied: false, reason: `处理异常：${e.message}`, mode: 'none' };
    }
    if (!optResult.applied) {
      console.warn(`[examples] 示例片未优化（用原文件）${id}: ${optResult.reason}`);
    } else {
      console.log(`[examples] 示例片已优化 ${id}（${optResult.mode}）：${optResult.reason}`);
    }

    try { await rename(stored, dst); }
    catch { await copyFile(stored, dst); await unlink(stored).catch(() => {}); }
    // 两个临时文件都要清，不管用了哪个
    await unlink(tmp).catch(() => {});
    await unlink(opt).catch(() => {});

    // 元信息要取【最终落盘那一份】的 —— 重新编码后分辨率/大小/时长都会变
    const fin = optResult.after ?? await examples.probeVideo(dst);
    const meta = {
      size_bytes: fin?.size_bytes ?? actual,
      duration_ms: fin?.duration_ms ?? Math.round(dur * 1000),
      width: fin?.width ?? w, height: fin?.height ?? h,
      mime_type: 'video/mp4',
      uploaded_at: nowIso(),
      ...(optResult.applied ? {
        optimized: optResult.mode,
        optimized_at: nowIso(),
        original_size_bytes: actual,
      } : {}),
    };
    const rec = await examples.setVideo(id, meta);
    dbg('example.video.upload', { u: u.id, ex: id, size: actual, dur_ms: meta.duration_ms });
    return json(res, 201, { example: rec, server_time: nowIso() });
  },

  'DELETE /api/admin/examples/:id/video': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u || u.role !== 'admin') return err(res, 403, 'FORBIDDEN', '需要管理员权限');
    try { return json(res, 200, { example: await examples.clearVideo(id), server_time: nowIso() }); }
    catch (e) { return err(res, e.code === 'NOT_FOUND' ? 404 : 400, e.code ?? 'DELETE_FAILED', e.message); }
  },

  /**
   * 下发示例视频（登录用户）。Range 流式，照搬产物那套（见 /api/assets/:id/playback）。
   * 不下发磁盘路径；白模示例沿用 /api/examples 的权限规则。
   */
  'GET /api/examples/:id/video': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const ex = await examples.getOne(id);
    if (!ex || !ex.enabled || !ex.video) return err(res, 404, 'NOT_FOUND', '示例视频不存在');
    if (ex.mode === 'blockout_3d' && !(u.can_use_blockout_3d || u.role === 'admin')) {
      return err(res, 403, 'FORBIDDEN', '需要白模预演权限');
    }
    const p = examples.videoPathFor(id);
    if (!existsSync(p)) return err(res, 404, 'NOT_FOUND', '示例视频文件已不可读');

    const total = statSync(p).size;
    const base = {
      'content-type': ex.video.mime_type ?? 'video/mp4',
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
    };
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : total - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
          res.writeHead(416, { 'content-range': `bytes */${total}` });
          return res.end();
        }
        res.writeHead(206, {
          ...base,
          'content-range': `bytes ${start}-${end}/${total}`,
          'content-length': end - start + 1,
        });
        return pipeWithCleanup(createReadStream(p, { start, end }), res);
      }
    }
    res.writeHead(200, { ...base, 'content-length': total });
    return pipeWithCleanup(createReadStream(p), res);
  },

  'GET /api/admin/users': async (req, res) => {
    const me = currentUser(req);
    if (!me) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    if (me.role !== 'admin') return err(res, 403, 'FORBIDDEN', '需要管理员权限');
    const list = await users.list();
    // 附上每个用户运行中的任务数，便于管理员判断撤权影响
    const all = await store.listJobs({});
    const withJobs = list.map((u) => ({
      ...u,
      running_jobs_count: all.filter((j) => j.user_id === u.id && !store.isTerminal(j.status)).length,
    }));
    return json(res, 200, { users: withJobs, server_time: nowIso() });
  },

  /**
   * 改白模权限（任务书 §4.3）。
   * 只影响后续新建会话与新提交任务；**已运行 Job 继续执行至完成**。
   * 权限管理与任务取消严格分离 —— 要终止需另调 terminate。
   */
  'PATCH /api/admin/users/:id/permissions': async (req, res, { id }) => {
    const me = currentUser(req);
    if (!me) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    if (me.role !== 'admin') return err(res, 403, 'FORBIDDEN', '需要管理员权限');
    const b = await readJson(req);
    if (!['can_use_blockout_3d', 'can_use_experimental'].some(k => typeof b[k] === 'boolean') ||
        ['can_use_blockout_3d', 'can_use_experimental'].some(k => k in b && typeof b[k] !== 'boolean')) {
      return err(res, 400, 'VALIDATION_FAILED', '权限字段必须是布尔值');
    }
    try {
      let u;
      if ('can_use_blockout_3d' in b) u = await users.setBlockout3d(id, b.can_use_blockout_3d);
      if ('can_use_experimental' in b) u = await users.setExperimental(id, b.can_use_experimental);
      const kept = (await store.listJobs({})).filter(
        (j) => j.user_id === u.id && !store.isTerminal(j.status)).map((j) => j.id);
      return json(res, 200, {
        user: u,
        running_jobs_kept: kept,
        note: kept.length
          ? `已变更权限。${kept.length} 个正在运行的任务将继续执行至完成；如需终止请单独操作。`
          : '已变更权限。',
        server_time: nowIso(),
      });
    } catch (e) {
      return err(res, e.code === 'NOT_FOUND' ? 404 : 400, e.code ?? 'UPDATE_FAILED', e.message);
    }
  },

  'PATCH /api/admin/users/:id': async (req, res, { id }) => {
    const me = currentUser(req);
    if (!me) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    if (me.role !== 'admin') return err(res, 403, 'FORBIDDEN', '需要管理员权限');
    const b = await readJson(req);
    try {
      const u = await users.setStatus(id, b.status);
      return json(res, 200, { user: u, server_time: nowIso() });
    } catch (e) {
      return err(res, e.code === 'NOT_FOUND' ? 404 : 400, e.code ?? 'UPDATE_FAILED', e.message);
    }
  },

  /**
   * 管理员画廊：全部用户的任务概览 + 活跃度。
   * 看得到谁在用、跑了什么、花多久、是否出片。
   * ⚠️ 只给 prompt 与结果元信息，不泄露 storage_path。
   */
  'GET /api/admin/gallery': async (req, res) => {
    const u = currentUser(req);
    if (!u || u.role !== 'admin') return err(res, 403, 'FORBIDDEN', '需要管理员权限');
    const q = new URL(req.url, 'http://x').searchParams;
    const limit = Math.min(Number(q.get('limit') ?? 200), 500);
    const onlyUser = q.get('user');

    const all = (await store.listJobs({}))
      .filter((j) => !onlyUser || j.user_id === onlyUser)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    const ms = (a, b) => (a && b ? new Date(b).getTime() - new Date(a).getTime() : null);
    const items = all.slice(0, limit).map((j) => ({
      id: j.id,
      user_id: j.user_id,
      session_id: j.session_id,
      mode: j.mode,
      status: j.status,
      created_at: j.created_at,
      finished_at: j.finished_at,
      /** 实际制作耗时（排队不计） */
      duration_ms: ms(j.started_at, j.finished_at),
      /** 用户原话 —— 管理员要看真实需求，不是扩写后的 */
      prompt: String(j.original_prompt ?? j.prompt ?? '').slice(0, 500),
      success: j.status === 'COMPLETED' && !!j.result_asset,
      has_video: !!j.result_asset && j.result_asset.state === 'READY',
      size_bytes: j.result_asset?.size_bytes ?? null,
      // 产物只在【对话真正结束】后才给出链接。只判 state==='READY' 是不够的：
      // 任务跑着的时候工作区里就可能已经有一版可播放的 mp4，放出去用户会当成成品，
      // 可是 agent 后面还会继续改（线上 sess_09d06d8f 就是这么出的事）。
      // publicJob 已经按终态门控过，这里是同一条规则，之前漏了。
      playback_url: (store.isTerminal(j.status) && j.result_asset?.state === 'READY')
        ? `/api/assets/${j.id}/playback` : null,
      failure_code: j.failure?.code ?? null,
      enhancement_chars: j.enhancement?.dense_length ?? null,
    }));

    // 活跃度：按用户聚合
    const byUser = new Map();
    for (const j of all) {
      const k = j.user_id ?? '-';
      const e = byUser.get(k) ?? {
        user_id: k, total: 0, completed: 0, failed: 0, cancelled: 0,
        total_duration_ms: 0, last_at: null, modes: {},
      };
      e.total += 1;
      if (j.status === 'COMPLETED') e.completed += 1;
      else if (j.status === 'FAILED') e.failed += 1;
      else if (j.status === 'CANCELLED') e.cancelled += 1;
      const d = ms(j.started_at, j.finished_at);
      if (d) e.total_duration_ms += d;
      if (!e.last_at || String(j.created_at) > String(e.last_at)) e.last_at = j.created_at;
      e.modes[j.mode] = (e.modes[j.mode] ?? 0) + 1;
      byUser.set(k, e);
    }
    const users = [...byUser.values()]
      .map((e) => ({
        ...e,
        success_rate: e.total ? Math.round((e.completed / e.total) * 100) : 0,
        avg_duration_ms: e.completed ? Math.round(e.total_duration_ms / e.completed) : null,
      }))
      .sort((a, b) => b.total - a.total);

    // ── 实时压力：管理员要一眼看出"现在跑着几个、排着几个、还能接多少" ──
    const qids = await refreshQueue();
    const liveStatuses = new Set(['ENHANCING','QUEUED','ASSIGNED','RUNNING','CANCEL_REQUESTED','CANCELLING','UNKNOWN','RECOVERING']);
    const live = all.filter((j) => liveStatuses.has(j.status));
    const cap = pool.capacitySnapshot({ includeWorkers: true });
    const brief = (j) => ({
      id: j.id, user_id: j.user_id, mode: j.mode, status: j.status,
      phase: j.phase, worker_id: j.worker_id,
      created_at: j.created_at, started_at: j.started_at,
      running_ms: j.started_at ? Date.now() - new Date(j.started_at).getTime() : null,
      queued_ms: j.queued_at && !j.started_at ? Date.now() - new Date(j.queued_at).getTime() : null,
      queue_position: j.status === 'QUEUED' ? (qids.indexOf(j.id) + 1 || null) : null,
      prompt: String(j.original_prompt ?? j.prompt ?? '').slice(0, 120),
    });
    const running = live.filter((j) => ['ASSIGNED','RUNNING','CANCEL_REQUESTED','CANCELLING'].includes(j.status));
    const queued = live.filter(j => j.status === 'QUEUED').sort(compareQueuedJobs);
    const enhancing = live.filter((j) => j.status === 'ENHANCING');

    return json(res, 200, {
      items, users,
      totals: {
        jobs: all.length,
        completed: all.filter((j) => j.status === 'COMPLETED').length,
        users: users.length,
      },
      /** 整体运行压力 */
      load: {
        capacity: cap.global.capacity,
        used: cap.global.used,
        queued: queued.length,
        enhancing: enhancing.length,
        // 真实负载率：排队的也算压力，只看 used 会低估
        utilization: cap.global.capacity
          ? Math.round((cap.global.used / cap.global.capacity) * 100) : 0,
        workers: (cap.workers ?? []).map((w) => ({
          worker_id: w.worker_id,
          processes: (w.processes ?? []).map((p) => ({
            status: p.status, running_jobs: p.running_jobs,
            max_concurrent_jobs: p.max_concurrent_jobs,
            active_sessions: p.active_sessions,
            heartbeat_age_ms: p.last_heartbeat_age_ms,
          })),
        })),
        // ⚠️ 列表字段必须另起名：queued/enhancing 已经是计数，
        //    同名会被列表覆盖，前端拿到数组当数字用就炸了。
        running_list: running.map(brief),
        queued_list: queued.map(brief),
        enhancing_list: enhancing.map(brief),
      },
      server_time: nowIso(),
    });
  },

  /* ───────── 示例 prompt ───────── */

  /** 所有登录用户可见。只给启用的，按模式过滤。 */
  'GET /api/examples': async (req, res) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const all = await examples.list({ onlyEnabled: true });
    // 没有白模权限的看不到白模示例 —— 否则点了也用不了
    const canBlockout = u.can_use_blockout_3d || u.role === 'admin';
    const items = all.filter((e) => e.mode !== 'blockout_3d' || canBlockout)
      .map((e) => ({
        id: e.id, title: e.title, prompt: e.prompt, mode: e.mode, note: e.note,
        // 示例视频的元信息（没有则 null）。只给时长/尺寸/大小，
        // 不给磁盘路径 —— 播放走 /api/examples/:id/video。
        video: e.video ?? null,
      }));
    return json(res, 200, { examples: items, server_time: nowIso() });
  },

  /** 记一次使用（前端点击示例时调），用于管理员看哪些示例有用 */
  'POST /api/examples/:id/use': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    await examples.touchUse(id);
    return json(res, 200, { ok: true });
  },

  'GET /api/admin/examples': async (req, res) => {
    const u = currentUser(req);
    if (!u || u.role !== 'admin') return err(res, 403, 'FORBIDDEN', '需要管理员权限');
    return json(res, 200, { examples: await examples.list(), server_time: nowIso() });
  },

  'POST /api/admin/examples': async (req, res) => {
    const u = currentUser(req);
    if (!u || u.role !== 'admin') return err(res, 403, 'FORBIDDEN', '需要管理员权限');
    const b = await readJson(req);
    try {
      const r = await examples.create({ ...b, createdBy: u.id });
      return json(res, 201, { example: r, server_time: nowIso() });
    } catch (e) {
      return err(res, 400, e.code ?? 'CREATE_FAILED', e.message);
    }
  },

  'PATCH /api/admin/examples/:id': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u || u.role !== 'admin') return err(res, 403, 'FORBIDDEN', '需要管理员权限');
    const b = await readJson(req);
    try {
      return json(res, 200, { example: await examples.update(id, b), server_time: nowIso() });
    } catch (e) {
      return err(res, e.code === 'NOT_FOUND' ? 404 : 400, e.code ?? 'UPDATE_FAILED', e.message);
    }
  },

  'DELETE /api/admin/examples/:id': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u || u.role !== 'admin') return err(res, 403, 'FORBIDDEN', '需要管理员权限');
    try {
      return json(res, 200, await examples.remove(id));
    } catch (e) {
      return err(res, e.code === 'NOT_FOUND' ? 404 : 400, e.code ?? 'DELETE_FAILED', e.message);
    }
  },

  /** 可用渠道清单（前端下拉用） */
  'GET /api/admin/channels': async (req, res) => {
    const u = currentUser(req);
    if (!u || u.role !== 'admin') return err(res, 403, 'FORBIDDEN', '需要管理员权限');
    return json(res, 200, { ...users.channels(), server_time: nowIso() });
  },

  /** 改渠道 / 备注。随时可改，不影响已有 session。 */
  'PATCH /api/admin/users/:id/channel': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u || u.role !== 'admin') return err(res, 403, 'FORBIDDEN', '需要管理员权限');
    const b = await readJson(req);
    try {
      const t = await users.setChannel(decodeURIComponent(id), {
        channel: b.channel, note: b.note,
      });
      return json(res, 200, { user: t, server_time: nowIso() });
    } catch (e) {
      return err(res, e.code === 'NOT_FOUND' ? 404 : 400, e.code ?? 'UPDATE_FAILED', e.message);
    }
  },

  'POST /api/admin/users/:id/reset-password': async (req, res, { id }) => {
    const me = currentUser(req);
    if (!me) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    if (me.role !== 'admin') return err(res, 403, 'FORBIDDEN', '需要管理员权限');
    try {
      const r = await users.resetPassword(id);
      return json(res, 200, {
        ...r,
        hint: `临时密码仅此一次显示：${r.temporary_password}（用户下次登录后必须修改）`,
        server_time: nowIso(),
      });
    } catch (e) {
      return err(res, e.code === 'NOT_FOUND' ? 404 : 400, e.code ?? 'RESET_FAILED', e.message);
    }
  },

  'GET /api/auth/me': async (req, res) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录或会话过期');
    // 权限以【存储里的最新值】为准，不信 Cookie —— 管理员改权限后应立即生效
    const fresh = await users.get(u.username).catch(() => null);
    const eff = fresh ?? u;
    if (fresh && fresh.status !== 'active') {
      return err(res, 403, 'ACCOUNT_DISABLED', '账号已被禁用，请联系管理员');
    }
    const modes = ['coding_to_video'];
    if (eff.can_use_experimental && experimentalEnabled(config.raw)) modes.push('experimental');
    if (eff.can_use_blockout_3d || eff.role === 'admin') modes.push('blockout_3d');
    return json(res, 200, {
      user: {
        id: eff.id, username: eff.username, role: eff.role,
        can_use_blockout_3d: eff.can_use_blockout_3d,
        can_use_experimental: eff.can_use_experimental === true,
        must_change_password: eff.must_change_password === true,
      },
      permissions: { modes, is_admin: eff.role === 'admin' },
      server_time: nowIso(),
    });
  },

  'GET /api/whitebox/settings': async (req, res) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const live = await users.get(u.username);
    if (!whiteboxEnabled(config.raw) || live?.status !== 'active' || !(live?.can_use_blockout_3d || live?.role === 'admin'))
      return err(res, 403, 'BLOCKOUT_3D_FORBIDDEN', '需管理员授予白模预演权限');
    return json(res, 200, sekoSettings(config.raw));
  },

  'GET /api/experimental/models': async (req, res) => {
    const user = await experimentalUser(req);
    const models = experimentalModels(config.raw).filter(p => canUseExperimentalModel(user, p.profile_id))
      .map(({ endpoint, ...p }) => p);
    const personal = lastPersonalModel(config.raw, user.id);
    return json(res, 200, { models: personal ? [...models, personal] : models });
  },

  'GET /api/experimental/skills': async (req, res) => {
    await experimentalUser(req);
    return json(res, 200, { skills: configuredSkills(config.raw) });
  },

  'GET /api/sessions/:id/archive': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const s = await store.getSession(id);
    if (!s || s.user_id !== u.id) return err(res, 404, 'NOT_FOUND', '会话不存在或无权访问');
    return streamSessionArchive(config.storage.sessionsRoot, config.raw.storage.sessions_subdir, id, req, res);
  },

  /** 创建会话并绑定进程。绑定后永不迁移。 */
  'POST /api/sessions': async (req, res) => {
    // 维护期只挡写，不挡读 —— 正在跑的任务要能继续看进度
    if (maintenance.isActive())
      return err(res, 503, 'MAINTENANCE', '系统正在更新，请稍候再新建对话');
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const b = await readJson(req);
    const mode = b.mode;
    if (!['coding_to_video', 'blockout_3d', 'experimental'].includes(mode))
      return err(res, 400, 'VALIDATION_FAILED', 'mode 必须是 coding_to_video 或 blockout_3d');

    // ★ 权限校验点 1/4：白模权限在服务端验，前端传什么都不作数
    const currentPermissions = mode === 'blockout_3d' ? await users.get(u.username) : u;
    if (mode === 'blockout_3d' && (currentPermissions?.status !== 'active' || !(currentPermissions?.can_use_blockout_3d || currentPermissions?.role === 'admin')))
      return err(res, 403, 'BLOCKOUT_3D_FORBIDDEN', '需管理员授予白模预演权限');

    let modelSelection = mode === 'coding_to_video' ? c2vModelSnapshot(config.raw) : null, experimentalSkills = null;
    if (mode === 'experimental') {
      const liveUser = await experimentalUser(req);
      requireExperimentalModel(liveUser, b.model_id);
      modelSelection = resolveExperimentalModel(config.raw, b.model_id).snapshot;
      const builtin = validateBuiltinSkills(b.builtin_skills);
      builtinPermission(liveUser, builtin);
      experimentalSkills = { builtin };
    }
    if (mode === 'blockout_3d' && whiteboxEnabled(config.raw)) {
      modelSelection = sekoSelection(config.raw);
      if (b.model_id && b.model_id !== modelSelection.profile_id) return err(res, 400, 'WHITEBOX_FIXED_MODEL', '白模模型由管理员统一配置');
      experimentalSkills = { builtin: 'none' };
    }
    const proc = pool.pickForSession(mode);
    if (!proc) return err(res, 503, 'PROCESS_UNAVAILABLE', '当前无健康后端进程可分配，请稍后重试');

    dbg('session.create', { u: u.id, mode });
    const sess = await store.createSession({
      userId: u.id, mode,
      workerId: proc.worker_id, processInstanceId: proc.process_instance_id,
      backendRef: null, skillset: null, skills: [], modelSelection, experimentalSkills,
    });

    try {
      const base = pool.bridgeUrlFor(proc.process_instance_id);
      // channel 一并下传：落进 session meta，导出用户轨迹时能按渠道区分。
      // 必须读【当前】用户记录 —— 会话 Cookie 里不存 channel，且管理员改过渠道后
      // Cookie 里的旧值会是错的（用户不会为此重新登录）。
      const live = await users.get(u.username).catch(() => null);
      const r = await bridge.initSession(base, {
        session_id: sess.id, mode, user_id: u.id,
        channel: live?.channel ?? null,
        user_note: live?.note ?? null,
        model_selection: modelSelection, builtin_skills: experimentalSkills?.builtin,
      });
      // Bridge 返回 skillset（组名）+ skills（组内 skill 列表）
      const updated = await store.updateSession(sess.id, {
        skillset: r.skillset ?? r.skill ?? null,
        skills: r.skills ?? [],
        binding: { backend_session_ref: r.backend_session_ref },
      });
      proc.active_sessions += 1;
      return json(res, 201, {
        session: {
          id: updated.id, mode: updated.mode, status: updated.status,
          model_selection: updated.model_selection, experimental_skills: updated.experimental_skills,
          created_at: updated.created_at, last_activity_at: updated.last_activity_at,
        },
        binding: {
          worker_id: updated.binding.worker_id,
          process_instance_id: updated.binding.process_instance_id,
          status: updated.binding.status, bound_at: updated.binding.bound_at,
        },
        skillset: updated.skillset,
        skills: updated.skills,
        isolation: r.isolation,
        server_time: nowIso(),
      });
    } catch (e) {
      await store.updateSession(sess.id, { status: 'DEGRADED', binding: { status: 'PROCESS_LOST', health_note: e.message } });
      return err(res, 503, 'BACKEND_UNAVAILABLE', `后端初始化会话失败: ${e.message}`);
    }
  },

  'GET /api/sessions/:id': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const s = await store.getSession(id);
    if (!s || s.user_id !== u.id) return err(res, 404, 'NOT_FOUND', '会话不存在或无权访问');
    const jobs = await store.listJobs({ sessionId: id });
    const qids = await refreshQueue();
    return json(res, 200, {
      session: s, binding: s.binding,
      jobs: jobs.map((j) => publicJob(j, qids)),
      // 只有真正占用后端的任务才算 active_job。
      // OUT_OF_SCOPE 已是终态（见 job-store 的 TERMINAL），isTerminal 已排除它；
      // 这里额外保证顺序：取最新的非终态任务，而不是列表里碰到的第一个。
      active_job: (() => {
        const live = jobs.filter((j) => !store.isTerminal(j.status));
        return live.length ? publicJob(live[0], qids) : null;
      })(),
      server_time: nowIso(),
    });
  },

  /** 直接创建生成 Job（简化版：跳过 Prompt Workflow，便于联调）。 */
  'POST /api/sessions/:id/jobs': async (req, res, { id }) => {
    if (maintenance.isActive())
      return err(res, 503, 'MAINTENANCE', '系统正在更新，请稍候再提交任务');
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const s = await store.getSession(id);
    if (!s || s.user_id !== u.id) return err(res, 404, 'NOT_FOUND', '会话不存在或无权访问');
    if (s.status !== 'ACTIVE')
      return err(res, 409, 'SESSION_NOT_ACTIVE', `会话状态为 ${s.status}，无法提交新任务`);

    // ★ 权限校验点 4/4：提交 Job 时以 DB 中 session.mode 为准，忽略请求体
    const currentPermissions = s.mode === 'blockout_3d' ? await users.get(u.username) : u;
    if (s.mode === 'blockout_3d' && (currentPermissions?.status !== 'active' || !(currentPermissions?.can_use_blockout_3d || currentPermissions?.role === 'admin')))
      return err(res, 403, 'BLOCKOUT_3D_FORBIDDEN', '白模权限已变更，无法提交此任务');

    if (s.mode === 'blockout_3d' && !isSeko(s.model_selection))
      return err(res, 409, 'WHITEBOX_LEGACY_READ_ONLY', '历史白模对话已只读保留，请新建对话使用新版白模');

    let liveExperimentalUser = null;
    if (s.mode === 'experimental') {
      liveExperimentalUser = await experimentalUser(req);
      requireExperimentalModel(liveExperimentalUser, s.model_selection);
      resolveExperimentalModel(config.raw, s.model_selection);
    }
    const b = await readJson(req);
    if (!b.prompt) return err(res, 400, 'VALIDATION_FAILED', '缺少 prompt');
    const idemKey = req.headers['idempotency-key'] ?? b.idempotency_key;
    if (!idemKey) return err(res, 400, 'VALIDATION_FAILED', '缺少 Idempotency-Key（防重复提交昂贵任务）');

    // 幂等重放：先查，避免重复花钱调增强模型
    const dup = await store.findByIdempotency(u.id, idemKey);
    if (dup) {
      return json(res, 200, { job: publicJob(dup), idempotent_replay: true, server_time: nowIso() });
    }

    // 生产期禁止 steering（V2 需求 3）：该会话有非终态 Job 时拒绝新提交
    const live = (await store.listJobs({ sessionId: id }))
      .filter((j) => !store.isTerminal(j.status));
    if (live.length && config.raw.production?.allow_steering_during_job === false) {
      dbg('job.submit.busy', { u: u.id, sid: id, running: live[0].id, st: live[0].status });
      return err(res, 409, 'SESSION_BUSY',
        '当前会话有生成任务正在执行，完成后才能提交新的生成或修改请求',
        { running_job_id: live[0].id, running_status: live[0].status });
    }

    // Prompt 增强（V2 需求 2）必须【异步】：实测 opus 要 37~56 秒，
    // 同步等待会让 HTTP 连接挂死（Next.js 转发实测 socket hang up），
    // 也违反"提交立即返回"的要求。
    // 做法：先建 ENHANCING 状态的 Job 并秒回，增强在后台推进。
    /**
     * ★ 1.4.0：不再信任客户端传来的 base_asset_path。
     *
     * 它原来被原样塞进 createJob，而 bridge 只做
     * `match(/^(.*\/jobs\/[^/]+)\//)` + existsSync 就当成基准工作区，
     * 随后把该目录的 src/ 整个拷进新工作区、成片拷进 previous/ ——
     * 任何已登录用户带上【别人】的 job 路径，就能继承别人的源码与成片。
     * 全程没有 user_id 校验，也没有路径包含性校验。
     *
     * 现在续跑改为「同一会话共用工作区 + cc --resume」，根本不需要外部路径：
     * 继承什么由会话自己决定，客户端无从指定，这个洞结构上消失了。
     * 字段保留但【不再参与任何判断】—— 留个名字是为了让下次有人想接回来时先读到这段。
     */
    let experimentalSkills = null;
    if (s.mode === 'experimental') {
      builtinPermission(liveExperimentalUser, b.experimental_skills?.builtin ?? s.experimental_skills?.builtin);
      try {
        experimentalSkills = await prepareSkillRevision(
          join(config.storage.sessionsRoot, config.raw.storage.sessions_subdir), id,
          b.experimental_skills ?? {}, s.experimental_skills, { raw: config.raw, repoRoot: config.repoRoot });
      } catch (e) { return err(res, 400, 'SKILL_INVALID', e.message); }
    }
    const whitebox = s.mode === 'blockout_3d' && whiteboxEnabled(config.raw);
    const modelSelection = s.model_selection;
    if (whitebox) {
      sekoConnection(config.raw, modelSelection); // immutable saved model; validate before queueing
      if (b.experimental_skills && (b.experimental_skills.builtin && b.experimental_skills.builtin !== 'none' || b.experimental_skills.text?.trim() || b.experimental_skills.archive_base64 || b.experimental_skills.configured?.length))
        return err(res, 400, 'WHITEBOX_FIXED_SKILL', '白模使用平台固定 skill，不能替换');
      experimentalSkills = { builtin: 'none' };
    }
    const isRevision = b.is_revision === true;
    // 用户可在发送处关闭增强（默认开启）。示例 prompt 本身已是增强结果，
    // 再过一遍只会偏离原意，所以点击示例时前端会自动关掉。
    const skipEnhance = b.enhance === false;

    const { job, replayed } = await store.createJob({
      userId: u.id, sessionId: id, workflowId: b.workflow_id, mode: s.mode,
      prompt: b.prompt,                             // 暂存原始；增强完成后替换
      originalPrompt: b.prompt,
      enhancement: null,
      baseAssetPath: null,                          // ★ 见上：客户端不得指定基准路径
      isRevision,                                   // 微调：后端据此继承上一轮工作区
      workerId: s.binding.worker_id, processInstanceId: s.binding.process_instance_id,
      idempotencyKey: idemKey,
      maxRuntimeSeconds: whitebox ? 0 : b.max_runtime_seconds ?? config.raw.production?.max_runtime_seconds,
      initialStatus: s.mode === 'experimental' || whitebox ? 'QUEUED' : 'ENHANCING',
      modelSelection, experimentalSkills,
    });
    if (replayed) {
      dbg('job.submit.replay', { u: u.id, sid: id, job: job.id, key: idemKey });
      return json(res, 200, { job: publicJob(job), idempotent_replay: true, server_time: nowIso() });
    }
    dbg('job.submit', { u: u.id, sid: id, job: job.id, mode: s.mode, key: idemKey, rev: isRevision, enh: !skipEnhance });

    bridgeRefs.freeze(pool, s, id).catch(() => {});   // 提交即冻结附件集合
    if (s.mode === 'experimental' || whitebox) {
      await store.updateSession(id, { experimental_skills: experimentalSkills, model_selection: modelSelection });
      await store.patchJob(job.id, { enhancement: { skipped: true, reason: whitebox ? 'whitebox' : 'experimental', model: null } });
      return json(res, 202, { job: publicJob(await store.getJob(job.id)), idempotent_replay: false, enhancing: false, server_time: nowIso() });
    }
    runEnhancement({ job, session: s, instruction: b.prompt, isRevision, skipRequested: skipEnhance })
      .catch((e) => console.error(`[gateway] 增强流程异常: ${e.message}`));

    return json(res, 202, {
      job: publicJob(job), idempotent_replay: false,
      enhancing: true, server_time: nowIso(),
    });
  },

  /**
   * Prompt Workflow 端点占位。
   * 当前 config.promptEnhancement.enabled=false —— skill 里无增强实现，
   * 上游 bundle 待确认。开启后在此实现 API_CONTRACT §6.2 的
   * revise / approve 流程（增强 → Review Card → 用户确认 → 建 Job）。
   */
  'POST /api/sessions/:id/messages': async (req, res, { id }) => {
    if (config.promptEnhancement.enabled) {
      return err(res, 501, 'NOT_IMPLEMENTED',
        'Prompt 增强已启用但 provider 尚未实现，请检查 config/backend.json 的 prompt_enhancement');
    }
    return err(res, 409, 'PROMPT_ENHANCEMENT_DISABLED',
      'Prompt 增强当前关闭，请直接用 POST /api/sessions/:id/jobs 提交生成任务',
      { submit_url: `/api/sessions/${id}/jobs`, reason: 'skill 中无增强实现，上游 bundle 待确认' });
  },

  'GET /api/jobs/:id': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const j = await store.getJob(id);
    if (!j || j.user_id !== u.id) return err(res, 404, 'NOT_FOUND', '任务不存在或无权访问');
    return json(res, 200, { job: publicJob(j, await refreshQueue()), server_time: nowIso() });
  },

  /** 请求取消。返回 CANCEL_REQUESTED，不是 CANCELLED。 */
  'POST /api/jobs/:id/cancel': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const j = await store.getJob(id);
    if (!j || j.user_id !== u.id) return err(res, 404, 'NOT_FOUND', '任务不存在或无权访问');
    if (store.isTerminal(j.status))
      return err(res, 409, 'JOB_ALREADY_TERMINAL', `任务已处于终态 ${j.status}`,
        { status: j.status, result_asset: j.result_asset });

    // 幂等：已请求过就直接返回当前状态，不重复触发副作用
    if (j.cancellation?.requested_at)
      return json(res, 202, { job: publicJob(j), already_requested: true, server_time: nowIso() });

    // ① 先持久化取消意图，再做任何外部调用
    const requested = await store.transition(j.id, 'CANCEL_REQUESTED', {
      cancellation: { requested_at: nowIso(), requested_by: u.id, reason: 'user' },
    });
    if (!requested.ok) {
      const current = requested.job ?? await store.getJob(j.id);
      if (current && ['CANCEL_REQUESTED', 'CANCELLING'].includes(current.status))
        return json(res, 202, { job: publicJob(current), already_requested: true, server_time: nowIso() });
      return err(res, 409, current && store.isTerminal(current.status) ? 'JOB_ALREADY_TERMINAL' : 'FORBIDDEN_TRANSITION',
        '任务状态已变化，取消请求未应用', { status: current?.status });
    }
    await store.appendEvent(j.id, 'job.cancel_requested', { status: 'CANCEL_REQUESTED', reason: 'user' });

    // ② 撤租约：立刻阻止旧执行者提交结果
    await store.revokeLease(j.id);

    // ③ 通知 Bridge（失败则靠心跳 control 兜底）
    if (requested.from === 'QUEUED') {
      const cancelled = await store.transition(j.id, 'CANCELLED', {
        cancellation: { acked_at: nowIso(), effective: true, resources_released_at: nowIso() },
      });
      if (cancelled.ok) await store.appendEvent(j.id, 'job.cancelled', { status: 'CANCELLED', note: '排队中取消，无需联系后端' });
    } else {
      const base = pool.bridgeUrlFor(j.process_instance_id, j.worker_id);
      if (base) {
        bridge.cancelJob(base, j.id, { reason: 'user', grace_seconds: config.timing.cancelGraceMs / 1000 })
          .then(async () => {
            const cancelling = await store.transition(j.id, 'CANCELLING');
            if (!cancelling.ok) return;
            await store.appendEvent(j.id, 'job.cancelling', { status: 'CANCELLING' });
          })
          .catch((e) => console.warn(`[gateway] 下达取消失败（将靠心跳兜底）: ${e.message}`));
      }
    }
    return json(res, 202, { job: publicJob(await store.getJob(j.id)), server_time: nowIso() });
  },

  /** Job 事件 SSE。支持 Last-Event-ID 断点续传。 */
  'GET /api/jobs/:id/events': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const j = await store.getJob(id);
    if (!j || j.user_id !== u.id) return err(res, 404, 'NOT_FOUND', '任务不存在或无权访问');

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    const last = Number(req.headers['last-event-id'] ?? new URL(req.url, 'http://x').searchParams.get('last_event_id') ?? 0);
    sseOpen += 1;
    dbg('sse.open', { u: u.id, job: id, last, open: sseOpen });

    // 先声明清理句柄：send 在回放阶段就可能命中终态事件并触发关闭，
    // 此时 keepalive/订阅可能尚未建立，必须用可空变量而非 const（TDZ 会抛 ReferenceError）
    let keepalive = null;
    let unsub = null;
    let closed = false;
    let sentCount = 0;
    const finish = () => {
      if (closed) return;
      closed = true;
      sseOpen -= 1;
      dbg('sse.close', { u: u.id, job: id, sent: sentCount, open: sseOpen });
      if (keepalive) clearInterval(keepalive);
      if (unsub) unsub();
      res.end();
    };
    const send = (ev) => {
      if (closed) return;
      sentCount += 1;
      res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      if (['job.completed', 'job.failed', 'job.cancelled'].includes(ev.type)) finish();
    };

    // 先回放持久化事件（权威快照），再接实时流
    for (const ev of await store.readEvents(id, last)) send(ev);
    if (closed) return;                       // 回放已命中终态，无需订阅

    /**
     * ★ 回放结束哨兵。
     *
     * 前端必须能分清「这条事件是历史回放」还是「这是刚发生的」——
     * 不分清就会把历史的 status/phase 当成当前状态合进界面：
     * 点开一个【已完成】任务的执行过程，阶段徽章会把 GENERATING /
     * FINALIZING 再走一遍，JobCard 跟着从「生成完成」闪回「正在生成」，
     * 对话区于是反复重排（用户实测反馈）。
     *
     * 靠时间猜（安静期）不可靠：轨迹几千条时事件是一阵一阵来的，
     * 中间的空档会让前端提前以为放完了（实测表现为条数 0 → 几百 一路往上跳）。
     * 这里给一个确定的分界点。
     *
     * 两个细节：
     *   · **不带 `id:`** —— 它不是一条真事件，不能污染 Last-Event-ID，
     *     否则断线重连会从这个假 seq 续传。
     *   · 终态任务在上面的回放里就命中终态并 finish() 了，走不到这里 ——
     *     那种情况前端靠【连接关闭】判定回放结束，同样是确定信号。
     */
    res.write(`event: job.replay_done\ndata: ${JSON.stringify({ type: 'job.replay_done', seq: 0 })}\n\n`);

    unsub = store.subscribe(id, send);
    // SSE 保活仅表示连接可用，不代表后端在算
    keepalive = setInterval(() => res.write(`: keepalive ${nowIso()}\n\n`), 15_000);
    req.on('close', () => {
      if (!closed) { sseOpen -= 1; dbg('sse.disconnect', { u: u.id, job: id, sent: sentCount, open: sseOpen }); }
      closed = true;
      if (keepalive) clearInterval(keepalive);
      if (unsub) unsub();
    });
  },

  /**
   * 产物播放。支持 HTTP Range（206），流式转发，不整体读入内存。
   * 只有 state=READY 才可播；storage_path 永不出现在响应里。
   */
  /**
   * 网页播放 ⇒ 下发【降采样预览片】。
   * 视频插件自带的下载按钮下的是 currentSrc，所以它拿到的也是压缩片（用户要求）。
   */
  'GET /api/assets/:id/playback': async (req, res, { id }) => {
    return serveAsset(req, res, id, { attachment: false, variant: 'preview' });
  },

  /** 产物下载。附加 Content-Disposition。 */
  /**
   * 显式「下载原片」⇒ 永远下发**原片**，不降采样。
   * 前端那个按钮已标明「受政策影响速度较慢，请耐心等待」。
   */
  'GET /api/whitebox/jobs/:id/source': async (req, res, { id }) => {
    const u = currentUser(req); if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const j = await store.getJob(id); if (!j || j.user_id !== u.id) return err(res, 404, 'NOT_FOUND', '产物不存在或无权访问');
    try { const a = sekoDownload(config, j); res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': a.size, 'Content-Disposition': `attachment; filename="${a.name}"`, 'Cache-Control': 'private, no-store' }); const stream = createReadStream(a.path); stream.on('error', () => res.destroy()); stream.pipe(res); }
    catch { return err(res, 404, 'SOURCE_NOT_READY', '源码尚未就绪或校验失败'); }
  },

  'GET /api/assets/:id/download': async (req, res, { id }) => {
    return serveAsset(req, res, id, { attachment: true, variant: 'original' });
  },

  /** 产物元数据（不含 storage_path）。 */
  'GET /api/assets/:id': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const j = await store.getJob(id);
    if (!j || j.user_id !== u.id) return err(res, 404, 'NOT_FOUND', '产物不存在或无权访问');
    if (!j.result_asset) return err(res, 404, 'NOT_FOUND', '该任务尚无产物');
    // 同 serveAsset：未结束就不暴露产物元数据与链接
    if (!store.isTerminal(j.status))
      return err(res, 409, 'ASSET_NOT_READY', '任务尚未结束，成品还在制作中');
    const a = j.result_asset;
    return json(res, 200, {
      asset: {
        id, job_id: j.id, session_id: j.session_id,
        kind: a.kind ?? 'video', state: a.state,
        mime_type: a.mime_type ?? 'video/mp4',
        size_bytes: a.size_bytes, duration_ms: a.duration_ms ?? null,
        width: a.width ?? null, height: a.height ?? null,
        playable: a.state === 'READY', ready_at: a.ready_at ?? null,
        preview: a.preview
          ? { mode: a.preview.mode, size_bytes: a.preview.size_bytes ?? null,
              width: a.preview.width ?? null, height: a.preview.height ?? null }
          : null,
        playback_url: `/api/assets/${id}/playback`,
        download_url: `/api/assets/${id}/download`,
      },
      server_time: nowIso(),
    });
  },

  /** 恢复兜底：localStorage 丢失 / 换设备时按账号找回。 */
  'GET /api/me/active-context': async (req, res) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    /**
     * ★ brief=1：省略 recent_completed_jobs。
     *
     * 前端侧栏的 20 秒定时器唯一目的是看【别的会话】在跑的任务
     * （见 _workspace.tsx 那个 setInterval 的注释），它要的是 running_jobs ——
     * dev 实测只有 2 B。而整个响应是 652 KB / 124 条，99% 是【已完成历史】，
     * 那些数据根本不会变，每 20 秒重发一遍纯属白费。
     *
     * 线上实测后果：这一个接口就解释了前端出口的全部流量
     * （185 KB / 20s × 9 个页面 ≈ 84 KB/s，而入口只有 43~71 KB/s）——
     * 我们在要 1.3~2 倍于管子能给的量，超额部分变成排队，
     * 视频、首屏、SSE 全堵在后面。
     *
     * 默认行为不变（不传 brief 仍返回全量），所以首屏与"刚完成一个任务"
     * 那条同步路径都照旧。
     */
    const brief = new URL(req.url, 'http://x').searchParams.get('brief') === '1';
    const sessions = await store.listSessionsByUser(u.id);
    const all = await store.listJobs({ userId: u.id });
    const running = all.filter((j) => !store.isTerminal(j.status));
    // 已完成列表：放开到 200。
    // 原来硬编码 10 条，用户跑过的任务一多就看不到早先的（实测一个跑了 2 小时的
    // 品牌片任务直接不在列表里，用户找不到自己的成片）。侧栏已改为可滚动。
    // 仍留 200 这个上限：不设上限的话单次响应会随历史无界增长。
    const doneLimit = Number(config.raw.production?.recent_completed_limit ?? 200);
    const done = brief ? [] : all.filter((j) => j.status === 'COMPLETED').slice(0, doneLimit);
    const qids = await refreshQueue();
    return json(res, 200, {
      // active_session 选取：【有任务在跑的会话优先】。
      // 原来只按 last_activity_at 取最新的 ACTIVE 会话 —— 用户新建对话后，
      // 新会话排到最前，正在跑任务的旧会话就被挤掉，页面看起来像"任务不见了"
      // （用户反馈"同时跑 2 个会有问题、对话历史显示不太对"）。
      active_session: (() => {
        const live = new Set(running.map((j) => j.session_id));
        const actives = sessions.filter((s) => s.status === 'ACTIVE');
        return actives.find((s) => live.has(s.id)) ?? actives[0] ?? null;
      })(),
      running_jobs: running.map((j) => publicJob(j, qids)),
      // brief 模式不带这个键 —— 前端据此知道"这趟没有历史，别拿空数组去覆盖"
      ...(brief ? {} : { recent_completed_jobs: done.map(j => publicJob(j)) }),
      limits: { recent_completed_limit: doneLimit },
      brief,
      // 前端的「正在更新」横幅搭这趟车，不额外开轮询
      maintenance: maintenance.read(),
      server_time: nowIso(),
    });
  },

  /**
   * 我的全部任务，按时间倒序，分「进行中 / 已完成 / 已放弃」。
   * 用户要能回看视频、复制 prompt 复现制作。
   */
  'GET /api/me/history': async (req, res) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const all = (await store.listJobs({ userId: u.id }))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const bucket = (j) => {
      if (j.status === 'COMPLETED') return 'completed';
      if (store.isTerminal(j.status)) return 'abandoned';   // FAILED/CANCELLED/OUT_OF_SCOPE
      return 'running';
    };
    const qids = await refreshQueue();
    const out = { running: [], completed: [], abandoned: [] };
    for (const j of all) out[bucket(j)].push(publicJob(j, qids));
    return json(res, 200, {
      ...out,
      counts: { running: out.running.length, completed: out.completed.length, abandoned: out.abandoned.length },
      server_time: nowIso(),
    });
  },

  'GET /api/me/jobs': async (req, res) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const q = new URL(req.url, 'http://x').searchParams;
    const kind = q.get('status') ?? 'active';
    const all = await store.listJobs({ userId: u.id });
    const jobs = kind === 'active' ? all.filter((j) => !store.isTerminal(j.status))
      : kind === 'recent' ? all.filter((j) => store.isTerminal(j.status))
      : all;
    return json(res, 200, {
      jobs: jobs.slice(0, Number(q.get('limit') ?? 20)).map(j => publicJob(j)), server_time: nowIso(),
    });
  },

  /**
   * 前端心跳（V2 需求 5）。
   * 切标签页/最小化时前端仍要发（只降频），关页才断。
   * 服务端阈值 600s，远大于浏览器节流后的间隔。
   */
  'POST /api/sessions/:id/presence': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const s = await store.getSession(id);
    if (!s || s.user_id !== u.id) return err(res, 404, 'NOT_FOUND', '会话不存在或无权访问');
    const b = await readJson(req);
    const r = presence.beat(id, u.id, b.tab_id);
    return json(res, 200, { ...r, server_time: nowIso() });
  },

  /** 标签页离开（sendBeacon）。不立即停止，仍走超时判定。 */
  'POST /api/sessions/:id/presence/leave': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const b = await readJson(req);
    return json(res, 200, presence.leave(id, b.tab_id));
  },

  'GET /api/system/capacity': async (req, res) => {
    const u = currentUser(req);
    const snap = pool.capacitySnapshot({ includeWorkers: u?.role === 'admin' });
    snap.global.queued = (await store.listJobs({ statuses: ['QUEUED'] })).length;
    return json(res, 200, snap);
  },

  /* ───────── Reference 附件（V2 需求 1）───────── */

  'GET /api/sessions/:id/references': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const s = await store.getSession(id);
    if (!s || s.user_id !== u.id) return err(res, 404, 'NOT_FOUND', '会话不存在或无权访问');
    try { return json(res, 200, await bridgeRefs.list(pool, s, id)); }
    catch (e) { return err(res, 503, 'BACKEND_UNAVAILABLE', e.message); }
  },

  /**
   * 上传附件（multipart/form-data）。
   * Gateway 收流 → 落到 Bridge 可见的临时路径 → 让 Bridge 校验入位。
   */
  'POST /api/sessions/:id/references': async (req, res, { id }) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const s = await store.getSession(id);
    if (!s || s.user_id !== u.id) return err(res, 404, 'NOT_FOUND', '会话不存在或无权访问');

    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.includes('multipart/form-data')) {
      return err(res, 400, 'VALIDATION_FAILED', '需要 multipart/form-data');
    }
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
    if (!boundary) return err(res, 400, 'VALIDATION_FAILED', 'multipart boundary 缺失');

    let parsed;
    try {
      parsed = await parseMultipart(req, boundary[1] ?? boundary[2]);
    } catch (e) {
      return err(res, 413, 'UPLOAD_FAILED', e.message);
    }
    if (!parsed.file) return err(res, 400, 'VALIDATION_FAILED', '未找到 file 字段');

    // 临时文件放在共享存储上，Bridge 能看见（两边同一挂载）
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const tmpDir = join(config.storage.root, 'uploads');
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, `up_${randomUUID()}`);
    await writeFile(tmpPath, parsed.file.data);

    try {
      const base = bridgeRefs.bridgeBase(pool, s);
      if (!base) return err(res, 503, 'PROCESS_UNAVAILABLE', '后端进程不可用');
      const r = await bridge.refsAdd(base, s.binding.backend_session_ref ?? id, {
        filename: parsed.file.filename, tmp_path: tmpPath, note: parsed.fields.note,
      });
      return json(res, 201, r);
    } catch (e) {
      const { unlink } = await import('node:fs/promises');
      await unlink(tmpPath).catch(() => {});
      const code = e.code ?? 'UPLOAD_FAILED';
      return err(res, e.status ?? 500, code, e.body?.error?.message ?? e.message);
    }
  },

  'DELETE /api/sessions/:id/references/:name': async (req, res, { id, name }) => {
    const u = currentUser(req);
    if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
    const s = await store.getSession(id);
    if (!s || s.user_id !== u.id) return err(res, 404, 'NOT_FOUND', '会话不存在或无权访问');
    try { return json(res, 200, await bridgeRefs.remove(pool, s, id, name)); }
    catch (e) { return err(res, e.status ?? 409, e.code ?? 'REFERENCE_FAILED', e.message); }
  },

  /* ───────── 内部 API：Bridge 回调 ───────── */

  /** 维护开关。供部署脚本调用（内部 token），所有操作都会打日志。 */
  'POST /internal/maintenance': async (req, res) => {
    if (!internalAuthed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const b = await readJson(req);
    const r = b.active ? maintenance.begin(b) : maintenance.end();
    console.warn(`[gateway] 维护状态 → ${r.active ? '开启' : '关闭'}` +
      (r.active ? `（预计 ${r.expected_seconds}s，最晚 ${r.expires_at} 自动失效）` : ''));
    return json(res, 200, { maintenance: r, server_time: nowIso() });
  },

  'POST /internal/processes/register': async (req, res) => {
    if (!internalAuthed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const b = await readJson(req);
    if (!b.worker_id || !b.process_instance_id)
      return err(res, 400, 'VALIDATION_FAILED', '缺少 worker_id 或 process_instance_id');
    pool.register(b);
    // Bridge 启动时认领下来的、仍在运行的任务（旧版本 Bridge 不带这个字段）
    const adoptedJobIds = Array.isArray(b.adopted_job_ids) ? b.adopted_job_ids : [];

    // ★ 顺序要紧：先改绑，再处理 superseded 的降级。
    // 反过来会先把会话打成 DEGRADED，再靠改绑去救，顺序一脆就留下锁死的输入框。
    //
    // 另外：Bridge 是先 register() 再 startHeartbeats() 的，本处理器同步执行完
    // 才回包，所以改绑一定早于新实例的第一次心跳。若有人调换
    // worker-bridge/src/server.mjs 里这两步的顺序，被认领的任务会在心跳对账里
    // 被判成「不属于此实例」而遭 abort —— 改那里之前先回来看这段注释。
    try {
      const { rebound, orphaned } = await store.rebindJobsToNewProcess(
        b.worker_id, b.process_instance_id, { adoptedJobIds },
      );
      if (rebound.length || orphaned.length) {
        console.log(`[gateway] ${b.worker_id} 注册后改绑任务：认领 ${rebound.length} 个，` +
          `待对账 ${orphaned.length} 个`);
      }
    } catch (e) {
      console.warn(`[gateway] 任务改绑失败（不影响注册）: ${e.message}`);
    }

    try {
      const { rebound, degraded } = await store.rebindSessionsToNewProcess(
        b.worker_id, b.process_instance_id, { adoptedJobIds, preserveIdle: pool.sharedWorkers.size > 0 },
      );
      if (rebound.length || degraded.length) {
        console.log(`[gateway] ${b.worker_id} 注册后收口会话：改绑 ${rebound.length} 个，` +
          `转 DEGRADED ${degraded.length} 个（有运行中任务且未被认领的那些）`);
      }
    } catch (e) {
      console.warn(`[gateway] 会话收口失败（不影响注册）: ${e.message}`);
    }

    console.log(`[gateway] 已注册 ${b.worker_id} / ${b.process_instance_id}` +
      (adoptedJobIds.length ? `（认领了 ${adoptedJobIds.length} 个运行中任务）` : ''));
    return json(res, 200, {
      accepted: true,
      config: {
        heartbeat_interval_seconds: config.timing.workerHeartbeatIntervalMs / 1000,
        job_heartbeat_interval_seconds: config.timing.jobHeartbeatIntervalMs / 1000,
        lease_ttl_seconds: config.timing.leaseTtlMs / 1000,
        cancel_grace_seconds: config.timing.cancelGraceMs / 1000,
      },
      server_time: nowIso(),
    });
  },

  'POST /internal/processes/heartbeat': async (req, res) => {
    if (!internalAuthed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const b = await readJson(req);
    const r = pool.heartbeat(b);
    if (!r.known) return json(res, 200, { ack: true, directives: [{ type: 'reregister' }], server_time: nowIso() });

    // 反向对账：后端在跑但 DB 不认识（或已终态）的 Job ⇒ 让它停。
    //
    // ⚠️ 这是最危险的一段：误判会杀掉正在运行的昂贵任务。三重保护：
    //   ① 容错读：读失败（文件正在写入）绝不当成「不存在」
    //   ② 宽限期：刚派发的 Job 可能还没落盘，GRACE 内不下 abort
    //   ③ 归属校验：只对确属本进程实例的 Job 下指令
    const directives = [];
    const GRACE_MS = 60_000;
    for (const jid of b.running_job_ids ?? []) {
      let j;
      try {
        j = await store.getJobReliable(jid);          // ① 读失败会抛，不会伪装成 null
      } catch (e) {
        console.warn(`[gateway] 对账跳过 ${jid}（记录暂不可读，下轮再看）: ${e.message}`);
        continue;                                     // 宁可晚一轮，也不误杀
      }

      if (!j) {
        // ② 真的没有记录。但 Gateway 可能刚重启、或 Job 刚派发未落盘 —— 给宽限期
        const upMs = process.uptime() * 1000;
        if (upMs < GRACE_MS) {
          console.warn(`[gateway] ${jid} 无记录，但 Gateway 启动仅 ${Math.round(upMs / 1000)}s，暂不处置`);
          continue;
        }
        directives.push({ type: 'abort_not_owner', job_id: jid, reason: 'gateway 无此任务记录' });
        continue;
      }

      // ③ 只处置属于本进程实例的 Job
      if (j.process_instance_id && j.process_instance_id !== b.process_instance_id) {
        // ★ 同一台机器的新实例 ⇒ 这是热更新后的重新认领，不是串台。
        // 改绑，绝不 abort —— 这里误判一次就杀掉一个跑了几小时的任务。
        // （注册时已经改绑过一轮，这是兜底：万一注册那轮没覆盖到，
        //   12 秒后的第一次心跳就会走到这里。）
        if (j.worker_id === b.worker_id) {
          await store.patchJob(jid, {
            process_instance_id: b.process_instance_id,
            rebound_at: nowIso(),
          });
          await store.reassignLeaseHolder(jid, b.process_instance_id);
          console.warn(`[gateway] ${jid} 改绑到同机新实例 ${b.process_instance_id}（热更新重新认领）`);
          continue;
        }
        console.warn(`[gateway] ${jid} 绑定 ${j.process_instance_id}，但 ${b.process_instance_id} 报告在跑 —— 通知后者停止`);
        directives.push({ type: 'abort_not_owner', job_id: jid, reason: '该任务不属于此进程实例' });
        continue;
      }

      if (store.isTerminal(j.status)) {
        directives.push({ type: 'abort_not_owner', job_id: jid, reason: `任务已终态 ${j.status}` });
      } else if (j.cancellation?.requested_at && j.status !== 'CANCELLING') {
        directives.push({ type: 'cancel_job', job_id: jid, reason: j.cancellation.reason ?? 'user' });
      }
    }
    return json(res, 200, { ack: true, server_time: nowIso(), directives });
  },

  'POST /internal/jobs/:id/heartbeat': async (req, res, { id }) => {
    if (!internalAuthed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const b = await readJson(req);
    const j = await store.getJob(id);
    if (!j) return err(res, 404, 'NOT_FOUND', '任务不存在');

    const v = store.validateLease(j, b.lease_token);
    if (!v.valid)
      return err(res, 409, 'LEASE_INVALID', `租约无效（${v.reason}）：立即停止且不得提交结果`);

    const patch = {
      last_heartbeat_at: nowIso(),
      ...(b.phase ? { phase: b.phase } : {}),
      ...(b.last_progress_at ? { last_progress_at: b.last_progress_at } : {}),
      ...(b.progress_percent != null ? { progress_percent: b.progress_percent } : {}),
    };
    if (j.status === 'ASSIGNED') {
      const started = await store.transition(id, 'RUNNING', { ...patch, started_at: j.started_at ?? nowIso() });
      if (started.ok) await store.appendEvent(id, 'job.started', { status: 'RUNNING', phase: b.phase });
    } else {
      await store.patchJob(id, patch);
    }
    const lease = await store.renewLease(id);

    // 控制指令：取消意图 / 超时 / 租约失效
    let control = 'continue';
    const cur = await store.getJob(id);
    if (cur.cancellation?.requested_at) {
      control = cur.cancellation.reason === 'max_runtime' ? 'abort_max_runtime' : 'cancel';
    }
    return json(res, 200, {
      lease: { valid: true, epoch: lease.epoch, expires_at: lease.expires_at },
      control, server_time: nowIso(),
    });
  },

  'POST /internal/jobs/:id/progress': async (req, res, { id }) => {
    if (!internalAuthed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const b = await readJson(req);
    const j = await store.getJob(id);
    if (!j) return err(res, 404, 'NOT_FOUND', '任务不存在');
    const v = store.validateLease(j, b.lease_token);
    if (!v.valid) return err(res, 409, 'LEASE_INVALID', `租约无效（${v.reason}），本次上报已丢弃`);

    const patch = { last_progress_at: nowIso() };
    if (b.phase && b.phase !== j.phase) { patch.phase = b.phase; patch.phase_started_at = nowIso(); }
    if (b.progress_percent != null) patch.progress_percent = b.progress_percent;
    if (j.status === 'ASSIGNED') {
      await store.transition(id, 'RUNNING', { ...patch, started_at: j.started_at ?? nowIso() });
    } else {
      await store.patchJob(id, patch);
    }
    const updated = await store.getJob(id);
    const ev = await store.appendEvent(id, b.phase && b.phase !== j.phase ? 'job.phase' : 'job.progress', {
      status: updated.status, phase: b.phase ?? j.phase, progress_percent: b.progress_percent ?? null,
    });
    const cur = await store.getJob(id);
    return json(res, 200, {
      accepted: true, seq: ev.seq,
      control: cur.cancellation?.requested_at ? 'cancel' : 'continue',
      server_time: nowIso(),
    });
  },

  'POST /internal/jobs/:id/complete': async (req, res, { id }) => {
    if (!internalAuthed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const b = await readJson(req);
    const j = await store.getJob(id);
    if (!j) return err(res, 404, 'NOT_FOUND', '任务不存在');

    // 幂等：已完成且产物相同 → 200
    if (j.status === 'COMPLETED')
      return json(res, 200, { accepted: true, job_status: 'COMPLETED', idempotent: true, server_time: nowIso() });

    const v = store.validateLease(j, b.lease_token);
    // 取消 vs 完成竞争：产物完整则【完成优先】，此时容忍已撤销的租约
    const racing = j.status === 'CANCEL_REQUESTED' || j.status === 'CANCELLING';
    if (!v.valid && !(racing && v.reason === 'REVOKED'))
      return err(res, 409, 'LEASE_INVALID', `租约无效（${v.reason}）：结果已丢弃`);
    if (store.isTerminal(j.status))
      return err(res, 409, 'JOB_ALREADY_TERMINAL', `任务已处于终态 ${j.status}`, { status: j.status });

    const responsePatch = whiteboxResponsePatch(j.mode, b.response);
    if (b.response && !responsePatch)
      return err(res, 400, 'VALIDATION_FAILED', 'Invalid whitebox conversational response');
    const asset = b.asset ?? {};
    if (!responsePatch && (!asset.storage_path || !(asset.size_bytes > 0)))
      return err(res, 400, 'VALIDATION_FAILED', '产物信息不完整（需 storage_path 与 size_bytes>0）');

    try {
      if (!responsePatch) Object.assign(asset, await validateVideo(asset.storage_path, { fullDecode: false, expectedSize: asset.size_bytes }));
    } catch (e) { return err(res, 400, 'INVALID_VIDEO', e.message); }

    const t = await store.transition(id, 'COMPLETED', {
      ...(responsePatch ?? { result_asset: { ...asset, state: 'READY', ready_at: nowIso() } }),
      finished_at: b.finished_at ?? nowIso(),
      // bridge 的 onComplete 本来就带着它（见 job-runner 的 .done meta），
      // 原来在这里被丢掉了 —— 于是已完成任务的「制作助手」只能靠重放轨迹才拿得到。
      ...(b.last_assistant_text ? { last_assistant_text: b.last_assistant_text } : {}),
    }, { force: racing });
    if (!t.ok) return err(res, 409, 'FORBIDDEN_TRANSITION', `无法迁移到 COMPLETED（当前 ${j.status}）`);

    /**
     * ★ 完成后【后台】生成降采样预览片，用户点开时通常已经就绪。
     *
     * 刻意 fire-and-forget：
     *   · 绝不阻塞 /complete —— 它一卡，Bridge 收不到回复会重试、任务状态会悬着
     *   · 失败绝不影响完成（模块内部已 catch，这里再兜一层）
     *   · 只读原片、只写 runtime/gateway/asset-previews/，不碰会话目录与 agent 工作区，
     *     所以对生成逻辑、多轮续跑、白模都没有副作用
     */
    void (async () => {
      try {
        if (responsePatch) return;
        const r = await ensurePreview(id, asset.storage_path, { log: console });
        if (r) {
          const cur = await store.getJob(id);
          if (cur?.result_asset) {
            await store.patchJob(id, { result_asset: { ...cur.result_asset, preview: r.meta } });
          }
        }
      } catch (e) { console.warn(`[preview] ${id} 完成后生成失败（不影响任务）: ${e.message}`); }
    })();

    await store.releaseLease(id);
    pool.release(id);                       // 派发预留（若还在）一并归还
    const p = pool.processes.get(j.process_instance_id);
    if (p) p.running_jobs = Math.max(0, p.running_jobs - 1);
    // ★ 槽位一腾出来就立刻出队，不要让排队的人白等一个 tick。
    // 只释放不唤醒的话，排队任务最多要干等 2 秒（dispatcher 的轮询周期）；
    // 高峰期每个任务都多等 2 秒，用户能明显感觉到"明明有人做完了却没动静"。
    dispatcher.tick().catch(() => {});
    // 会话名额：判据与"对话结束才展示视频"完全一致 —— isTerminal。
    // 这个会话的任务全部终态（成功/失败/用户停止）⇒ 它当下没在工作，名额还回去。
    void maybeReleaseIdleSession(j);
    await store.appendEvent(id, 'job.completed', { status: 'COMPLETED', asset: t.job.result_asset, response: t.job.response ?? null });
    if (racing) console.log(`[gateway] ${id} 在取消生效前完成 —— 完成优先`);
    return json(res, 200, {
      accepted: true, job_status: 'COMPLETED',
      asset_id: id, superseded_cancellation: racing, server_time: nowIso(),
    });
  },

  'POST /internal/jobs/:id/fail': async (req, res, { id }) => {
    if (!internalAuthed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const b = await readJson(req);
    const j = await store.getJob(id);
    if (!j) return err(res, 404, 'NOT_FOUND', '任务不存在');
    const v = store.validateLease(j, b.lease_token);
    if (!v.valid) return err(res, 409, 'LEASE_INVALID', `租约无效（${v.reason}）`);
    const t = await store.transition(id, 'FAILED', { failure: b.failure ?? { code: 'E_UNKNOWN' } });
    if (!t.ok) return err(res, 409, 'FORBIDDEN_TRANSITION', t.reason, { status: j.status });
    await store.releaseLease(id);
    pool.release(id);                       // 派发预留（若还在）一并归还
    const p = pool.processes.get(j.process_instance_id);
    if (p) p.running_jobs = Math.max(0, p.running_jobs - 1);
    // ★ 槽位一腾出来就立刻出队，不要让排队的人白等一个 tick。
    // 只释放不唤醒的话，排队任务最多要干等 2 秒（dispatcher 的轮询周期）；
    // 高峰期每个任务都多等 2 秒，用户能明显感觉到"明明有人做完了却没动静"。
    dispatcher.tick().catch(() => {});
    // 会话名额：判据与"对话结束才展示视频"完全一致 —— isTerminal。
    // 这个会话的任务全部终态（成功/失败/用户停止）⇒ 它当下没在工作，名额还回去。
    void maybeReleaseIdleSession(j);
    await store.appendEvent(id, 'job.failed', { status: 'FAILED', failure: b.failure });
    return json(res, 200, { accepted: true, job_status: 'FAILED', server_time: nowIso() });
  },

  'POST /internal/jobs/:id/cancel-ack': async (req, res, { id }) => {
    if (!internalAuthed(req)) return err(res, 401, 'INTERNAL_AUTH_FAILED', 'token 无效');
    const b = await readJson(req);
    const j = await store.getJob(id);
    if (!j) return err(res, 404, 'NOT_FOUND', '任务不存在');
    if (j.status === 'COMPLETED')
      return json(res, 200, { accepted: true, job_status: 'COMPLETED', note: '任务已先完成，取消未生效' });
    // 12h 超时属于【失败】，不是用户取消 —— 用户的原话是"超时就是失败"。
    // 两者都要停止计算、都要释放资源，但终态语义不同：
    // CANCELLED 看起来像用户主动放弃，会让人以为是自己点了停止。
    const timedOut = j.cancellation?.reason === 'max_runtime';
    const t = timedOut
      ? await store.transition(id, 'FAILED', {
          failure: {
            code: 'E_MAX_RUNTIME_EXCEEDED',
            message: `生成超过最长运行时间（${fmtDuration(j.max_runtime_seconds ?? 43200)}）已自动停止，可重新提交`,
          },
          cancellation: {
            acked_at: b.stopped_at ?? nowIso(),
            effective: b.stopped === true,
            resources_released_at: b.resources_released ? nowIso() : null,
            stop_method: b.stop_method,
          },
        })
      : await store.transition(id, 'CANCELLED', {
          cancellation: {
            acked_at: b.stopped_at ?? nowIso(),
            effective: b.stopped === true,
            resources_released_at: b.resources_released ? nowIso() : null,
            stop_method: b.stop_method,
          },
        });
    if (!t.ok) return err(res, 409, 'FORBIDDEN_TRANSITION', t.reason, { status: j.status });
    await store.releaseLease(id);
    pool.release(id);                       // 派发预留（若还在）一并归还
    const p = pool.processes.get(j.process_instance_id);
    if (p) p.running_jobs = Math.max(0, p.running_jobs - 1);
    // ★ 槽位一腾出来就立刻出队，不要让排队的人白等一个 tick。
    // 只释放不唤醒的话，排队任务最多要干等 2 秒（dispatcher 的轮询周期）；
    // 高峰期每个任务都多等 2 秒，用户能明显感觉到"明明有人做完了却没动静"。
    dispatcher.tick().catch(() => {});
    // 会话名额：判据与"对话结束才展示视频"完全一致 —— isTerminal。
    // 这个会话的任务全部终态（成功/失败/用户停止）⇒ 它当下没在工作，名额还回去。
    void maybeReleaseIdleSession(j);
    if (timedOut) {
      await store.appendEvent(id, 'job.failed', {
        status: 'FAILED',
        failure: { code: 'E_MAX_RUNTIME_EXCEEDED' },
        stop_method: b.stop_method, resources_released: b.resources_released,
      });
      return json(res, 200, { accepted: true, job_status: 'FAILED', server_time: nowIso() });
    }
    await store.appendEvent(id, 'job.cancelled', {
      status: 'CANCELLED', stop_method: b.stop_method, resources_released: b.resources_released,
    });
    return json(res, 200, { accepted: true, job_status: 'CANCELLED', server_time: nowIso() });
  },
};

/**
 * 流式提供产物文件，支持 Range。
 * 权限校验 → state 校验 → 文件存在校验 → 流式转发。
 * 共享存储路径只在服务端使用，绝不出现在响应头或体中。
 */
/**
 * 把文件读流接到响应上，并保证【响应一关就销毁读流】。
 *
 * ★ 为什么必须显式销毁：`rs.pipe(res)` 在 res 提前关闭时（客户端 seek/关页/暂停，
 *   或代理掐断）**不会**销毁 rs —— 文件句柄就那么一直挂着。
 *   线上 1.4.3 实测：Gateway 攒了 141 个 final.mp4 句柄，其中 78 个压在同一个文件上
 *   （同一个视频被播了 78 次，78 个读流一个都没关），同时代理↔网关 153 条
 *   ESTABLISHED、前端 RSS 1.9GB 还在涨。
 *
 *   这是两处缺陷里的后半截：前半截是代理从不把客户端的断开传给上游
 *   （见 apps/web/app/api/[...path]/route.ts 的 upstreamSignal）。
 *   两边都修才闭环 —— 代理不传断开，这里就永远收不到 close。
 */
function pipeWithCleanup(rs, res) {
  res.once('close', () => rs.destroy());
  rs.once('error', (e) => { if (!res.writableEnded) res.destroy(e); });
  return rs.pipe(res);
}

async function serveAsset(req, res, assetId, { attachment, variant = 'original' }) {
  const u = currentUser(req);
  if (!u) return err(res, 401, 'UNAUTHENTICATED', '未登录');
  const j = await store.getJob(assetId);           // V1: asset_id 即 job_id
  // 归属校验：普通用户只能看自己的；管理员可看全部（画廊要播别人的片）。
  // 这是【唯一】放宽归属的地方，且仅限读取产物 —— 其余接口管理员同样受限。
  const owns = j && (j.user_id === u.id || u.role === 'admin');
  if (!owns) return err(res, 404, 'NOT_FOUND', '产物不存在或无权访问');
  if (j.user_id !== u.id) {
    dbg('asset.admin_view', { admin: u.id, owner: j.user_id, job: j.id });
  }
  const a = j.result_asset;
  if (!a) return err(res, 404, 'NOT_FOUND', '该任务尚无产物');
  // ★ 对话真正结束前不给产物。这是最后一道闸门：前端不给链接还不够，
  // 任务跑着时工作区里就可能有一版 mp4，知道 URL 规则就能直接拉到中间版本，
  // 用户会把它当成品（线上 sess_09d06d8f 就是这么出的事）。
  if (!store.isTerminal(j.status))
    return err(res, 409, 'ASSET_NOT_READY', '任务尚未结束，成品还在制作中');
  if (a.state !== 'READY')
    return err(res, 409, 'ASSET_NOT_READY', `产物状态为 ${a.state}，尚不可访问`);
  if (!a.storage_path || !existsSync(a.storage_path))
    return err(res, 404, 'NOT_FOUND', '产物文件已不可读');

  /**
   * ★ 选片：播放用预览片，显式下载用原片。
   *
   * 预览片不存在/过期时【当场生成】并等它（上限见 config.preview.generate_timeout_ms）。
   * 为什么要等而不是"先播原片、后台生成"：线上最大的成片 98.6MB，
   * 在受限链路上等于打不开；等几秒换一个几 MB 的片子，体验好得多。
   * 等不到（超时/ffmpeg 不在/转码失败）就退化成播原片 —— 绝不让播放失败。
   */
  let servePath = a.storage_path;
  if (variant === 'preview') {
    try {
      const fp = { source_size: statSync(a.storage_path).size,
                   source_mtime_ms: Math.round(statSync(a.storage_path).mtimeMs) };
      const rec = a.preview;
      if (previewIsFresh(rec, fp) && rec.mode === 'none') {
        // 原片本来就达标，直接播原片（白模 previs、短动画多数走这条）
      } else if (previewIsFresh(rec, fp) && rec.mode === 'reencode'
                 && existsSync(previewPathFor(assetId))) {
        servePath = previewPathFor(assetId);
      } else {
        const r = await ensurePreview(assetId, a.storage_path, { log: console });
        if (r) {
          await store.patchJob(assetId, { result_asset: { ...a, preview: r.meta } }).catch(() => {});
          if (r.mode === 'reencode' && r.path) servePath = r.path;
        }
      }
    } catch (e) {
      console.warn(`[preview] ${assetId} 选片异常（改播原片）: ${e.message}`);
    }
  }

  const total = statSync(servePath).size;
  const mime = a.mime_type ?? 'video/mp4';
  const filename = `${j.mode}-${assetId.slice(0, 12)}.mp4`;
  const baseHeaders = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    ...(attachment ? { 'content-disposition': `attachment; filename="${filename}"` } : {}),
  };

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : total - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        res.writeHead(416, { 'content-range': `bytes */${total}` });
        return res.end();
      }
      end = Math.min(end, total - 1);
      res.writeHead(206, {
        ...baseHeaders,
        'content-range': `bytes ${start}-${end}/${total}`,
        'content-length': String(end - start + 1),
      });
      return pipeWithCleanup(createReadStream(servePath, { start, end }), res);
    }
  }
  res.writeHead(200, { ...baseHeaders, 'content-length': String(total) });
  return pipeWithCleanup(createReadStream(servePath), res);
}

/**
 * 后台增强：ENHANCING → QUEUED（成功）/ OUT_OF_SCOPE / FAILED。
 * 全程通过事件推给前端，用户看到的是"正在理解你的需求"而不是干等 HTTP。
 */
/**
 * 把一批会话的名额还给 Bridge。只释放【名额】，不动工作区 ——
 * 产物与轨迹要留给用户回看，用户回来继续用会自动重新计入。
 *
 * ★ 绝不能在"用户新建会话"时释放旧会话：产品支持多 session 并行体验，
 *   用户同时开几个就该占几个名额。释放的唯一依据是「这个会话当下没在工作」。
 */
function releaseSessionSlots(processInstanceId, sessionIds, workerId) {
  if (!sessionIds?.length) return;
  const base = pool.bridgeUrlFor(processInstanceId, workerId);
  if (!base) return;
  for (const sid of sessionIds) {
    bridge.releaseSession(base, sid).catch(() => {});   // 失败不要紧，TTL 还会兜底
  }
}

/**
 * 任务终结后看看它所属的会话是否还有活。
 *
 * 判据**复用**「对话结束才展示视频」那一套：`store.isTerminal(status)`。
 * 会话的全部任务都终态（COMPLETED / FAILED / CANCELLED / OUT_OF_SCOPE）
 * ⇒ 它当下没在工作 ⇒ 名额立刻还给 max_sessions，排队的人马上能用。
 *
 * 为什么是"当下"而不是"永久"：用户随时可能回到这个会话继续微调。
 * 所以只还名额、不删任何东西；他一回来提交，Bridge 侧的 touchSession
 * 会把名额重新算上（见 supervisor 的 sessionSeen）。
 */
async function maybeReleaseIdleSession(job) {
  try {
    const sid = job.session_id;
    if (!sid) return;
    const siblings = await store.listJobs({ sessionId: sid });
    // 还有任何非终态任务（排队中/跑着/正在取消）⇒ 会话仍在工作，不动
    if (siblings.some((x) => !store.isTerminal(x.status))) return;
    const base = pool.bridgeUrlFor(job.process_instance_id, job.worker_id);
    if (!base) return;
    await bridge.releaseSession(base, sid).catch(() => {});
    const session = await store.getSession(sid);
    if (session?.binding && session.binding.worker_id !== job.worker_id) {
      releaseSessionSlots(session.binding.process_instance_id, [sid], session.binding.worker_id);
    }
    dbg('session.slot_released', { sid, job: job.id, reason: 'all_jobs_terminal' });
  } catch { /* 释放失败不要紧：TTL 还会兜底，且绝不能影响任务收尾 */ }
}

async function runEnhancement({ job, session, instruction, isRevision, skipRequested = false }) {
  await store.appendEvent(job.id, 'job.enhancing', {
    status: 'ENHANCING',
    note: skipRequested ? '已按你的选择跳过增强，直接开始制作'
      : isRevision ? '提示词调整，跳过增强' : '正在理解你的创作需求…',
  });

  let r;
  try {
    const assets = await bridgeRefs.assetsJson(pool, session, job.session_id).catch(() => []);
    r = await enhance({ instruction, assets, isRevision, skipRequested,
      auditDir: join(config.storage.sessionsRoot, config.raw.storage.sessions_subdir, job.session_id, 'rounds', job.id, 'enhancement') });
  } catch (e) {
    // ★ 增强失败【不该让整个任务失败】。
    //
    // 事故：用户写的 "make an animation of seismic waves..." 完全合法，
    // 只是增强模型偶发返回了非法 JSON，任务就被判 FAILED —— 用户什么也没做错，
    // 却要重新提交。增强本来就是锦上添花，拿不到就用原始 prompt 投产。
    //
    // 只有真正不可投产的情况（非视频请求）才终结任务。
    console.warn(`[gateway] 增强失败 job=${job.id}，降级为原始 prompt 直投: ${e.message}`);
    dbg('enhance.degraded', { job: job.id, reason: e.message?.slice(0, 80) });
    await store.patchJob(job.id, {
      enhancement: { skipped: true, reason: 'enhance_failed', model: null, error: e.message },
    });
    const t = await store.transition(job.id, 'QUEUED', { queued_at: nowIso() }, { force: true });
    if (t.ok) {
      await store.appendEvent(job.id, 'job.queued', {
        status: 'QUEUED',
        enhancement: { skipped: true, reason: 'enhance_failed' },
        note: '智能扩写暂时不可用，已按你的原始描述开始制作',
      });
      dispatcher.tick().catch(() => {});
    }
    return;
  }

  // 非视频请求：Job 直接终结，前端据此显示提示（V2）
  if (!r.is_video_request) {
    const t = await store.transition(job.id, 'OUT_OF_SCOPE', {
      enhancement: r.enhancement, notice: r.notice,
    }, { force: true });
    if (t.ok) {
      await store.appendEvent(job.id, 'job.out_of_scope', {
        status: 'OUT_OF_SCOPE', notice: r.notice,
      });
    }
    console.log(`[gateway] job ${job.id} 判为非视频请求，未投产`);
    return;
  }

  // 增强成功 → 换成 dense prompt，入队
  await store.patchJob(job.id, { prompt: r.prompt, enhancement: r.enhancement });
  const t = await store.transition(job.id, 'QUEUED', { queued_at: nowIso() }, { force: true });
  if (!t.ok) {
    console.warn(`[gateway] job ${job.id} 增强后入队被拒: ${t.reason}`);
    return;
  }
  await store.appendEvent(job.id, 'job.queued', {
    status: 'QUEUED',
    enhancement: {
      skipped: r.enhancement.skipped, model: r.enhancement.model,
      dense_length: r.enhancement.dense_length, assets_count: r.enhancement.assets_count,
    },
  });
  console.log(`[gateway] job ${job.id} 增强完成 ` +
    `(${r.enhancement.skipped ? 'skipped' : `${r.enhancement.dense_length} 字符`})，已入队`);
  dispatcher.tick().catch(() => {});
}

/**
 * 极简 multipart 解析：只支持单文件 + 少量文本字段。
 * 不引第三方依赖 —— 附件上传是唯一用到 multipart 的地方。
 */
async function parseMultipart(req, boundary, maxBytes = 524288000) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw new Error(`上传超过 ${Math.round(maxBytes / 1048576)}MB 上限`);
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks);
  const delim = Buffer.from(`--${boundary}`);
  const out = { fields: {}, file: null };

  let pos = buf.indexOf(delim);
  while (pos >= 0) {
    const start = pos + delim.length;
    if (buf.slice(start, start + 2).toString() === '--') break;      // 结束标记
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd < 0) break;
    const head = buf.slice(start, headEnd).toString('utf8');
    const next = buf.indexOf(delim, headEnd);
    const bodyEnd = next < 0 ? buf.length : next - 2;               // 去掉尾部 \r\n
    const body = buf.slice(headEnd + 4, bodyEnd);

    const nameM = /name="([^"]*)"/.exec(head);
    const fileM = /filename="([^"]*)"/.exec(head);
    if (fileM && fileM[1]) {
      out.file = { filename: fileM[1], data: body };
    } else if (nameM) {
      out.fields[nameM[1]] = body.toString('utf8');
    }
    pos = next;
  }
  return out;
}

/** 对外暴露的 Job 视图：不含 prompt 全文与共享存储路径。 */
/** 把秒格式化成人话。不足 1 小时也要说得准，不能显示"0 小时"。 */
function fmtDuration(sec) {
  if (sec >= 3600) {
    const h = sec / 3600;
    return `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`;
  }
  if (sec >= 60) return `${Math.round(sec / 60)} 分钟`;
  return `${sec} 秒`;
}

/**
 * 队列快照与 dispatcher 使用同一套优先级和排队时间排序。
 * 算位置要用同一套排序，否则用户看到的"第几位"和实际出队顺序对不上。
 */
let queueSnapshot = { ids: [], at: 0 };
async function refreshQueue() {
  if (Date.now() - queueSnapshot.at < 1000) return queueSnapshot.ids;
  const queued = (await store.listJobs({ statuses: ['QUEUED'] })).sort(compareQueuedJobs);
  queueSnapshot = { ids: queued.map(job => job.id), at: Date.now() };
  return queueSnapshot.ids;
}

function publicJob(j, queueIds = null) {
  const now = Date.now();
  const ms = (t) => (t ? now - new Date(t).getTime() : null);
  return {
    id: j.id, session_id: j.session_id, mode: j.mode,
    ...(j.mode === 'blockout_3d' && isSeko(j.model_selection) ? { whitebox_result: sekoPublicResult(config, j) } : {}),
    model_selection: j.model_selection ?? null, experimental_skills: j.experimental_skills ?? null,
    status: j.status, phase: j.phase,
    progress_percent: j.progress_percent,          // 可为 null → 前端不得伪造
    created_at: j.created_at, queued_at: j.queued_at, assigned_at: j.assigned_at,
    started_at: j.started_at, phase_started_at: j.phase_started_at,
    last_heartbeat_at: j.last_heartbeat_at, last_progress_at: j.last_progress_at,
    finished_at: j.finished_at,
    elapsed: {
      queued_ms: j.queued_at ? (j.started_at ? new Date(j.started_at) - new Date(j.queued_at) : ms(j.queued_at)) : null,
      running_ms: j.started_at ? (j.finished_at ? new Date(j.finished_at) - new Date(j.started_at) : ms(j.started_at)) : null,
      current_phase_ms: ms(j.phase_started_at),
    },
    health: {
      worker_status: pool.processes.get(j.process_instance_id)?.status ?? 'UNKNOWN',
      job_heartbeat_age_ms: ms(j.last_heartbeat_at),
      progress_age_ms: ms(j.last_progress_at),
      stalled: !!j._stall_warned,
      assessment: assess(j),
    },
    cancellation: j.cancellation,
    /**
     * ★ 没有真实失败时下发 null，不下发空壳。
     *
     * 来源是建档模板（job-store.mjs 的初始记录就带 `{code:null,message:null}`），
     * 不是"成功时写上去的" —— 于是一个 COMPLETED 的任务也挂着 failure 对象。
     * 取 `failure.code` 是 null 所以不影响功能，但按 **failure 字段存在性**
     * 判成败的代码会误判，统计失败率时还要额外过滤。
     *
     * 在 API 边界收口，不动存储结构、也不碰 job-store 的
     * `next.failure = { ...j.failure, ...patch.failure }` 合并逻辑 —— 风险最小。
     */
    failure: j.failure?.code ? j.failure : null,
    /**
     * 产物只在【对话已结束】后下发（无论成功还是失败）。
     *
     * 事故（线上 sess_09d06d8f）：用户看到的是中间版本。
     * 任务还在跑时工作区里已经有可播放的 mp4，下发出去用户就会当成最终成品，
     * 可是 cc 后面还会继续改。执行过程照常实时显示，只有产物要等定论。
     */
    response: store.isTerminal(j.status) ? j.response ?? null : null,
    result_asset: (j.result_asset && store.isTerminal(j.status))
      ? {
          id: j.id,                                      // V1: asset_id 即 job_id
          state: j.result_asset.state,
          size_bytes: j.result_asset.size_bytes,
          kind: j.result_asset.kind ?? 'video',
          duration_ms: j.result_asset.duration_ms ?? null,
          width: j.result_asset.width ?? null,
          height: j.result_asset.height ?? null,
          playable: j.result_asset.state === 'READY',
          playback_url: `/api/assets/${j.id}/playback`,
          download_url: `/api/assets/${j.id}/download`,
          /**
           * 网页播放实际下发的是降采样预览片；size_bytes 仍然是【原片】大小。
           * 前端靠这个字段区分两者，并把「下载原片」标成慢操作。
           * mode:'none' 表示原片本来就达标、播的就是原片。
           */
          preview: j.result_asset.preview
            ? { mode: j.result_asset.preview.mode,
                size_bytes: j.result_asset.preview.size_bytes ?? null,
                width: j.result_asset.preview.width ?? null,
                height: j.result_asset.preview.height ?? null }
            : null,
        }                                                // ★ 不暴露 storage_path
      : null,
    attempt: j.attempt, max_runtime_seconds: j.max_runtime_seconds,
    worker_id: j.worker_id, process_instance_id: j.process_instance_id,
    prompt_summary: String(j.original_prompt ?? j.prompt ?? '').slice(0, 300),
    /**
     * cc 给用户看的最后一句话。
     * 下发它，前端的「制作助手」就不必为了一句话去重放整条轨迹 ——
     * 这是「切换任务不再从 0 加载」的前提。
     * 它本来就是要展示给用户的内容，不涉及 storage_path 那类内部信息。
     */
    last_assistant_text: j.last_assistant_text ?? null,
    /** 用户原始输入（完整），供"用这段重新创作" */
    original_prompt: j.original_prompt ?? null,
    /**
     * 增强后的制作方案。V2 要求"增强结果不返回给用户"是指【投产前】不回传、
     * 不接受 steering；任务已投产后展示出来只是让专业用户参考与复用，
     * 不影响正在跑的任务。ENHANCING 阶段仍然不给。
     */
    enhanced_prompt: j.status === 'ENHANCING' ? null : (j.prompt ?? null),
    // ★ 不下发模型名：它会出现在浏览器 devtools 里，等于公开技术路线。
    // 真实模型名仍完整留在 job 记录与日志中，排障不受影响。
    enhancement: j.enhancement
      ? {
          skipped: j.enhancement.skipped === true,
          reason: j.enhancement.reason ?? null,
          duration_ms: j.enhancement.duration_ms ?? null,
          via: j.enhancement.via ?? null,              // agent | single
          agent_tools: j.enhancement.agent_tools ?? null,
          model: j.enhancement.model ?? null,
          dense_length: j.enhancement.dense_length ?? null,
          assets_count: j.enhancement.assets_count ?? null,
        }
      : null,
    notice: j.notice ?? null,
    presence_lost: j._presence_lost === true,
    /**
     * 排队可见性：用户要知道"前面还有几个、总共几个"。
     * position 从 1 开始；非排队状态为 null（前端据此决定显不显示）。
     */
    queue: j.status === 'QUEUED' && queueIds
      ? {
          position: queueIds.indexOf(j.id) + 1 || null,
          total: queueIds.length,
          ahead: Math.max(0, queueIds.indexOf(j.id)),
        }
      : null,
    poll_url: `/api/jobs/${j.id}`, events_url: `/api/jobs/${j.id}/events`,
  };
}

function assess(j) {
  if (j.status === 'COMPLETED' || j.status === 'CANCELLED') return 'HEALTHY_RUNNING';
  if (j.status === 'FAILED') return 'CONFIRMED_FAILED';
  if (j.status === 'UNKNOWN' || j.status === 'RECOVERING') return 'STATE_UNKNOWN';
  if (j._stall_warned) return 'HEALTHY_STALLED';
  const p = pool.processes.get(j.process_instance_id);
  if (p && p.status !== 'HEALTHY') return 'HEARTBEAT_LOST';
  return 'HEALTHY_RUNNING';
}

/* ───────── 路由匹配 ───────── */

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? 'x'}`);
  const [h, params] = matchRoute(routes, req.method, pathname);
  if (!h) return err(res, 404, 'NOT_FOUND', `${req.method} ${pathname}`);
  try { await h(req, res, params); }
  catch (e) {
    console.error(`[gateway] ${req.method} ${pathname}:`, e);
    if (!res.headersSent) err(res, e.status ?? 500, e.code ?? 'INTERNAL', e.message);
  }
});

await store.init();
await invites.init();
await examples.init();
await users.init();

server.listen(config.server.port, config.server.host, () => {
  console.log('='.repeat(70));
  console.log('Gateway 已启动');
  console.log(describeGatewayConfig());
  console.log(`监听 ${config.server.host}:${config.server.port}`);
  console.log('  /api/*       浏览器公开 API');
  console.log('  /internal/*  Bridge 回调（共享密钥）');
  console.log('='.repeat(70));
  dispatcher.start();
  watchdog.start();
  pump.start();
  presence.start();
  wdPrompts.start();
  /**
   * ★ 存量示例片的一次性优化：只改上传路径的话，**已经传上去的片子不会自己变好**。
   * 放在 listen 回调里异步跑，不阻塞启动、失败只告警；幂等，处理过的下次直接跳过。
   */
  void examples.optimizeExistingVideos(console);
  void initPreviews().catch(() => {});
});

async function shutdown(sig) {
  console.log(`\n[gateway] 收到 ${sig}，Drain：停止派发与监测，不取消任何任务`);
  dispatcher.stop(); watchdog.stop(); pump.stop(); presence.stop(); wdPrompts.stop(); server.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
