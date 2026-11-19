/**
 * Prompt 增强（V2 需求 2）：用 opus 5.5 把用户指令变成 dense prompt。
 *
 * 流程（dense_prompt_template.md 的设计）：
 *   ① 判断是不是视频生成请求 → 不是就返回 out_of_scope，不建 Job
 *   ② 是：把 references 的 assets JSON（含 ffprobe 实测 meta）一起交给模型
 *   ③ 模型返回 {is_video_request, dense_prompt}
 *   ④ dense_prompt 【不回传用户】，直接投产（V2 需求 3）
 *
 * 模板里不含 output contract —— 那部分由 job-workspace 按真实路径追加。
 *
 * 未配置 aux_model 时跳过增强，用户原始 prompt 直投，并明确标记 skipped（不静默）。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { config } from './config.mjs';
import { runEnhanceAgent, agentStatus } from './enhance-agent.mjs';
import { enhancementConnection } from '../../shared/model-settings.mjs';

const TEMPLATE_REL = 'assets/prompt-templates/dense_prompt_template.md';

function auxCfg() {
  const pe = config.raw.prompt_enhancement ?? {};
  const am = pe.aux_model ?? {};
  const saved = enhancementConnection(config.raw);
  return {
    enabled: pe.enabled !== false,
    skipForRevision: pe.skip_for_revision !== false,
    baseUrl: saved?.endpoint ?? process.env[am.base_url_env ?? 'CVW_AUX_ENHANCE_BASE_URL'] ?? am.base_url ?? '',
    apiKey: saved ? (saved.kind === 'intranet' ? 'sk-local-proxy' : saved.api_key) : process.env[am.api_key_env ?? 'CVW_AUX_ENHANCE_API_KEY'] ?? am.api_key ?? '',
    model: saved?.model ?? process.env[am.model_env ?? 'CVW_AUX_ENHANCE_MODEL'] ?? am.model ?? '',
    timeoutMs: am.timeout_ms ?? 300_000,
    maxTokens: am.max_tokens ?? 32000,
  };
}

export function enhancementStatus() {
  const a = auxCfg();
  const ready = !!(a.enabled && a.baseUrl && a.apiKey && a.model);
  return {
    enabled: a.enabled,
    configured: ready,
    model: ready ? a.model : null,
    reason: !a.enabled ? 'disabled'
      : !a.baseUrl ? 'aux_model.base_url 未配置'
      : !a.apiKey ? 'aux_model.api_key 未配置'
      : !a.model ? 'aux_model.model 未配置'
      : null,
  };
}

async function loadTemplate() {
  const p = join(config.repoRoot, TEMPLATE_REL);
  if (!existsSync(p)) throw new Error(`[enhancer] 模板不存在: ${p}`);
  return readFile(p, 'utf8');
}

/** 模型可能把 JSON 包在代码块里 —— usage.md 的 parse() 就处理了这种情况 */
function parseModelJson(text) {
  const t = String(text ?? '').trim();
  try { return JSON.parse(t); } catch {}
  if (t.startsWith('```')) {
    const inner = t.split('\n').slice(1).join('\n').replace(/```\s*$/, '');
    try { return JSON.parse(inner); } catch {}
  }
  // 退一步：抓第一个 {...} 块
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw new Error('模型返回不是合法 JSON');
}

async function callAux({ baseUrl, apiKey, model, maxTokens, timeoutMs }, message, auditDir) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model, max_tokens: maxTokens,
        messages: [{ role: 'user', content: message }],
      }),
      signal: ac.signal,
    });
    const txt = await res.text();
    if (auditDir) await writeFile(join(auditDir, 'single-response.json'), txt);
    if (!res.ok) {
      const e = new Error(`增强模型 HTTP ${res.status}: ${txt.slice(0, 200)}`);
      e.status = res.status;
      throw e;
    }
    const body = JSON.parse(txt);
    const text = (body.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    return { text, usage: body.usage, model: body.model };
  } finally { clearTimeout(timer); }
}

/**
 * 增强一条用户指令。
 * @param {object} p
 * @param {string} p.instruction  用户原始指令
 * @param {Array}  p.assets       assets JSON（来自 references，含 ffprobe meta）
 * @param {boolean} p.isRevision  是否是对已完成视频的 prompt 调整（跳过增强）
 */
export async function enhance({ instruction, assets = [], isRevision = false, skipRequested = false, auditDir }) {
  const a = auxCfg();
  const st = enhancementStatus();

  // prompt 调整不增强（用户明确要求）
  // 用户显式关闭增强：原样投产。
  // 场景：示例 prompt 本身就是增强过的，再增强一遍只会越改越偏；
  // 以及专业用户自己写好了详细方案，不希望被改写。
  if (skipRequested) {
    return {
      is_video_request: true,
      prompt: instruction,
      enhancement: { skipped: true, reason: 'user_disabled', model: null },
    };
  }
  if (isRevision && a.skipForRevision) {
    return {
      is_video_request: true,
      prompt: instruction,
      enhancement: { skipped: true, reason: 'revision', model: null },
    };
  }

  // 未配置：直投并明确标记，不静默
  if (!st.configured) {
    console.warn(`[enhancer] 跳过增强（${st.reason}），用户原始 prompt 直投`);
    return {
      is_video_request: true,
      prompt: instruction,
      enhancement: { skipped: true, reason: st.reason ?? 'not_configured', model: null },
    };
  }

  const tpl = await loadTemplate();
  const msg = tpl
    .replace('{{USER_INSTRUCTION}}', instruction)
    .replace('{{ASSETS_JSON}}', JSON.stringify(assets, null, 2));

  if (auditDir) {
    await mkdir(auditDir, { recursive: true });
    await writeFile(join(auditDir, 'prompt.md'), msg);
    await writeFile(join(auditDir, 'model.json'), JSON.stringify({ model: a.model, endpoint: a.baseUrl }));
  }
  const t0 = Date.now();
  let text, usage, model, via = 'single';
  let agentTools = null;

  // ① 优先 agent loop：它能 WebSearch 查真实做法，方案比单轮靠谱。
  //    任何失败都【降级】到单轮，绝不让增强方式的问题影响出片。
  const ag = agentStatus();
  if (ag.configured) {
    try {
      const r = await runEnhanceAgent(msg, { log: console, auditDir, modelConfig: a });
      text = r.text; usage = r.usage; model = r.model ?? a.model;
      agentTools = r.tools; via = 'agent';
      console.log(`[enhancer] agent loop 完成（${Date.now() - t0}ms，工具 ${(r.tools ?? []).join(',') || '无'}）`);
    } catch (e) {
      console.warn(`[enhancer] agent loop 失败，降级为单轮: ${e.message}`);
    }
  }
  // ② 单轮（原有路径）
  if (text === undefined) {
    const r = await callAux(a, msg, auditDir);
    text = r.text; usage = r.usage; model = r.model;
  }

  const out = parseModelJson(text);
  const ms = Date.now() - t0;

  if (out.is_video_request === false) {
    return {
      is_video_request: false,
      prompt: null,
      notice: {
        code: 'OUT_OF_SCOPE',
        title: '本站是视频生成展示平台',
        message: '我们目前只支持 AI 视频生成与视频修改，其他内容暂不支持。请描述你想生成的视频。',
        suggestions: [
          '描述你想生成的视频画面与时长',
          '上传参考素材后说明想要的风格',
          '对已生成的视频提出修改意见',
        ],
      },
      enhancement: { skipped: false, model, duration_ms: ms, usage, via, is_video_request: false },
    };
  }

  const dense = out.dense_prompt;
  if (!dense || typeof dense !== 'string' || dense.trim().length < 50) {
    throw new Error(`增强返回的 dense_prompt 无效（长度 ${String(dense ?? '').length}）`);
  }

  return {
    is_video_request: true,
    prompt: dense,
    enhancement: {
      skipped: false, model, duration_ms: ms, usage,
      via, agent_tools: agentTools,
      assets_count: assets.length,
      original_length: instruction.length,
      dense_length: dense.length,
    },
  };
}
