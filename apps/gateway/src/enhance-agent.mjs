/**
 * 增强用 agent loop：起一个独立的 cc 进程跑 dense prompt 生成。
 *
 * 为什么要 agent loop 而不是单轮：
 *   单轮只能凭模型已有知识写方案；loop 里它可以 WebSearch 查实际做法
 *   （片头常用帧率、某种视觉效果怎么实现、某个库的用法），方案更靠谱。
 *   实测该 key 可联网：cc 真的调了 WebSearch 并带回 URL。
 *
 * 与生成用 cc 的关系：
 *   · 完全独立的进程与配置 —— 不同 host（tokenhub）、不同 key（opus 5.5）、默认配置，
 *     不继承 codevideo 那套 ANTHROPIC_DEFAULT_* / 隔离 / skill。
 *   · 不占 worker 并发槽（它跑在 Gateway 机器上，不经 Bridge），
 *     但自己有一个并发上限，避免高峰期把 Gateway 机器压垮。
 *
 * ★ 最重要的约束：绝不能因为杀不掉而把后续生成堵住。
 *   所以：detached 进程组 + 超时先 SIGTERM 再 SIGKILL + finally 里一定释放名额，
 *   并且名额释放【不依赖进程真的死掉】—— 进程泄漏最多浪费机器资源，
 *   绝不能变成"增强名额耗尽 → 新任务卡在 ENHANCING"。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.mjs';
import { enhancementConnection } from '../../shared/model-settings.mjs';

/** 当前在跑的增强数。只增不漏：拿名额与还名额成对出现在 try/finally 里。 */
let inflight = 0;
export function agentInflight() { return inflight; }

function agentCfg() {
  const pe = config.raw.prompt_enhancement ?? {};
  const ag = pe.agent ?? {};
  const am = pe.aux_model ?? {};
  const saved = enhancementConnection(config.raw);
  return {
    enabled: ag.enabled === true,
    bin: ag.bin ?? 'claude',
    baseUrl: saved?.endpoint ?? process.env[am.base_url_env ?? 'CVW_AUX_ENHANCE_BASE_URL'] ?? am.base_url ?? '',
    apiKey: saved ? (saved.kind === 'intranet' ? 'sk-local-proxy' : saved.api_key) : process.env[am.api_key_env ?? 'CVW_AUX_ENHANCE_API_KEY'] ?? am.api_key ?? '',
    model: saved?.model ?? process.env[am.model_env ?? 'CVW_AUX_ENHANCE_MODEL'] ?? am.model ?? '',
    timeoutMs: ag.timeout_ms ?? 420_000,
    maxConcurrent: ag.max_concurrent ?? 6,
    allowedTools: ag.allowed_tools ?? 'WebSearch,WebFetch',
    graceMs: ag.sigterm_grace_ms ?? 5_000,
  };
}

export function agentStatus() {
  const a = agentCfg();
  return {
    enabled: a.enabled,
    configured: !!(a.enabled && a.baseUrl && a.apiKey && a.model),
    inflight,
    max_concurrent: a.maxConcurrent,
  };
}

/** 整组终止：cc 会派生子进程，只杀父的话会留下孤儿。 */
function killTree(child, sig) {
  try {
    if (child.pid) process.kill(-child.pid, sig);   // detached ⇒ pid 即 pgid
  } catch {
    try { child.kill(sig); } catch {}
  }
}

/**
 * 跑一轮 agent loop，返回 stdout 聚合出来的最终文本。
 * 失败一律抛错 —— 调用方会降级成单轮或直投，不会让任务失败。
 */
export async function runEnhanceAgent(promptText, { log = console, auditDir, modelConfig } = {}) {
  const a = { ...agentCfg(), ...(modelConfig ? { baseUrl: modelConfig.baseUrl, apiKey: modelConfig.apiKey, model: modelConfig.model } : {}) };
  if (!a.configured && !(a.enabled && a.baseUrl && a.apiKey && a.model)) {
    throw new Error('agent 增强未配置');
  }
  if (inflight >= a.maxConcurrent) {
    const e = new Error(`增强并发已满（${inflight}/${a.maxConcurrent}）`);
    e.code = 'ENHANCE_BUSY';
    throw e;
  }

  inflight += 1;
  const dir = auditDir ?? await mkdtemp(join(tmpdir(), 'cvw-enh-'));
  if (auditDir) await mkdir(join(dir, '.home'), { recursive: true });
  let auditWrites = Promise.resolve();
  let child = null;
  let timer = null;
  let hardTimer = null;

  try {
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, promptText, 'utf8');

    // ★ 独立环境：只给 tokenhub 的 base_url/key/model，不带 codevideo 那套。
    // 显式清掉可能从 Gateway 继承下来的变量，避免串到生成用的模型。
    const proxy = process.env.CVW_CLAUDE_HTTP_PROXY;
    const noProxy = proxy ? config.raw.proxy?.no_proxy ?? '' : '';
    const env = {
      ...process.env,
      ...(proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy } : {}),
      ...(auditDir ? { HOME: join(dir, '.home'), CLAUDE_CONFIG_DIR: join(dir, '.home/.claude') } : {}),
      ANTHROPIC_BASE_URL: a.baseUrl,
      ANTHROPIC_API_KEY: a.apiKey,
      ANTHROPIC_MODEL: a.model,
      NO_PROXY: noProxy, no_proxy: noProxy,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
                     'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_AUTH_TOKEN',
                     'CVW_JOB_TOKEN', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CVW_CLAUDE_HTTP_PROXY']) {
      delete env[k];
    }
    if (proxy) {
      delete env.ALL_PROXY;
      delete env.all_proxy;
    }

    const args = [
      '-p',
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--allowedTools', a.allowedTools,
    ];

    child = spawn(a.bin, args, {
      cwd: dir,
      env,
      detached: true,                     // 独立进程组 ⇒ 可整树终止
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const result = await new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };

      child.stdout.on('data', (b) => { out += b.toString();
        if (auditDir) { const bytes = Buffer.from(b); auditWrites = auditWrites.then(() => appendFile(join(dir, 'claude.jsonl'), bytes)); auditWrites.catch(() => {}); }
      });
      child.stderr.on('data', (b) => { err += b.toString().slice(0, 2000);
        if (auditDir) { const bytes = Buffer.from(b); auditWrites = auditWrites.then(() => appendFile(join(dir, 'claude.stderr'), bytes)); auditWrites.catch(() => {}); }
      });
      child.on('error', (e) => done(reject, new Error(`增强 agent 启动失败: ${e.message}`)));
      child.on('close', (code, signal) => {
        if (signal) return done(reject, new Error(`增强 agent 被信号终止 ${signal}`));
        if (code !== 0) return done(reject, new Error(`增强 agent 退出码 ${code}: ${err.slice(0, 200)}`));
        done(resolve, out);
      });

      // 超时：先礼后兵。到点 SIGTERM，宽限后 SIGKILL。
      timer = setTimeout(() => {
        log.warn?.(`[enhance-agent] 超时 ${a.timeoutMs}ms，SIGTERM`);
        killTree(child, 'SIGTERM');
        hardTimer = setTimeout(() => {
          log.warn?.('[enhance-agent] 宽限到期，SIGKILL');
          killTree(child, 'SIGKILL');
          // 即使它还赖着不死，也要让这次调用结束 —— 名额在 finally 里释放，
          // 绝不能让一个僵死进程把增强名额永久占住。
          done(reject, new Error('增强 agent 超时'));
        }, a.graceMs);
      }, a.timeoutMs);

      child.stdin.on('error', () => {});
      child.stdin.end(promptText, 'utf8');
    });

    return parseStreamJson(result);
  } finally {
    clearTimeout(timer);
    clearTimeout(hardTimer);
    // 兜底：无论怎么退出的，都确保不留进程组
    if (child && child.exitCode === null && child.signalCode === null) {
      killTree(child, 'SIGKILL');
    }
    await auditWrites.catch(e => log.warn?.(`[enhance-agent] 原始日志保存失败: ${e.message}`));
    if (!auditDir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    inflight -= 1;                       // ★ 一定释放，不依赖进程是否真死
  }
}

/** 从 stream-json 里聚合出最终文本与用量。 */
function parseStreamJson(raw) {
  let text = '';
  let resultText = null;
  let usage = null;
  let model = null;
  const tools = [];
  for (const line of String(raw).split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let d;
    try { d = JSON.parse(s); } catch { continue; }
    if (d.type === 'system' && d.subtype === 'init') model = d.model ?? model;
    if (d.type === 'assistant') {
      for (const c of d.message?.content ?? []) {
        if (c.type === 'text') text += c.text;
        if (c.type === 'tool_use' && c.name) tools.push(c.name);
      }
    }
    if (d.type === 'result') {
      if (d.is_error) throw new Error(`增强 agent 报错: ${String(d.result ?? d.subtype).slice(0, 200)}`);
      if (typeof d.result === 'string') resultText = d.result;
      usage = d.usage ?? usage;
    }
  }
  const finalText = (resultText ?? text ?? '').trim();
  if (!finalText) throw new Error('增强 agent 没有返回文本');
  return { text: finalText, usage, model, tools };
}
