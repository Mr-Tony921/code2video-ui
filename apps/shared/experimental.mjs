import { createHash } from 'node:crypto';
import { isManagedModel, resolveManagedModel } from './model-settings.mjs';

export const EXPERIMENTAL_MODE = 'experimental';
export function experimentalEnabled(raw) {
  return raw.environment?.name === 'dev' && raw.experimental?.enabled === true;
}

function modelProfile(raw, profile) {
  if (!profile.source || profile.source === 'api') return profile;
  if (profile.source !== 'primary') throw new Error('实验模型 source 必须为 api 或 primary');
  const primary = raw.model ?? {};
  const model = process.env.CVW_MODEL ?? primary.model;
  // Match the ordinary worker's effective model and authentication settings.
  // The local proxy accepts the CLI's placeholder key when no key env is set.
  return {
    id: profile.id, enabled: profile.enabled,
    name: profile.name ?? `${model}（内网）`,
    endpoint: process.env.CVW_MODEL_BASE_URL ?? primary.base_url, model,
    api_key_env: primary.api_key_env, api_key: 'sk-local-proxy',
    max_context_tokens: primary.max_context_tokens ?? null,
    max_output_tokens: Number(process.env.CVW_MAX_OUTPUT_TOKENS ?? primary.max_output_tokens ?? 32000),
    autocompact_pct: Number(process.env.CVW_AUTOCOMPACT_PCT ?? primary.autocompact_pct ?? 80),
  };
}

export function experimentalModels(raw) {
  if (!experimentalEnabled(raw)) return [];
  const ids = new Set();
  return (raw.experimental.models ?? []).filter(p => p.enabled !== false).map(p => {
    p = modelProfile(raw, p);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(p.id ?? '')) throw new Error('实验模型 id 无效');
    if (ids.has(p.id)) throw new Error('实验模型 id 不能重复');
    ids.add(p.id);
    const endpoint = process.env[p.endpoint_env ?? ''] ?? p.endpoint;
    const model = process.env[p.model_env ?? ''] ?? p.model;
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('实验模型 endpoint 必须是无凭据的 HTTP(S) 地址');
    if (!model || !p.name) throw new Error('实验模型缺少 name 或 model');
    for (const key of ['max_context_tokens', 'max_output_tokens']) {
      if (p[key] != null && (!Number.isSafeInteger(p[key]) || p[key] <= 0)) throw new Error(`${key} 必须为正整数或 null`);
    }
    const snapshot = {
      profile_id: p.id, name: p.name, model, endpoint: endpoint.replace(/\/$/, ''),
      max_context_tokens: p.max_context_tokens ?? null,
      max_output_tokens: p.max_output_tokens ?? null,
      autocompact_pct: p.autocompact_pct ?? 80,
    };
    return { ...snapshot, revision: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 16) };
  });
}

export function resolveExperimentalModel(raw, selection) {
  if (isManagedModel(selection)) return resolveManagedModel(raw, selection);
  const model = experimentalModels(raw).find(m => m.profile_id === (selection?.profile_id ?? selection));
  if (!model) throw Object.assign(new Error('实验模型未配置或已停用'), { code: 'MODEL_UNAVAILABLE', status: 409 });
  if (selection?.revision && selection.revision !== model.revision)
    throw Object.assign(new Error('该对话的模型配置已变更，请选择模型新建对话；历史记录仍保留'), { code: 'MODEL_CONFIGURATION_CHANGED', status: 409 });
  const profile = modelProfile(raw, raw.experimental.models.find(p => p.id === model.profile_id));
  const apiKey = process.env[profile.api_key_env ?? ''] ?? profile.api_key;
  if (!apiKey) throw Object.assign(new Error('实验模型 API key 尚未配置'), { code: 'MODEL_UNAVAILABLE', status: 503 });
  return {
    snapshot: model, baseUrl: model.endpoint, apiKey, model: model.model,
    maxContextTokens: model.max_context_tokens == null ? null : String(model.max_context_tokens),
    maxOutputTokens: model.max_output_tokens, autocompactPct: model.autocompact_pct,
  };
}

export function validateBuiltinSkills(value = 'none') {
  if (!['none', 'coding_to_video', 'blockout_3d'].includes(value))
    throw Object.assign(new Error('内置 skill 必须选择 none、coding_to_video 或 blockout_3d'), { status: 400 });
  return value;
}
