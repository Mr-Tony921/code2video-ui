/** Dev whitebox settings are independent of experimental/C2V production profiles. */
import { createHash } from 'node:crypto';
import { experimentalModels, resolveExperimentalModel } from './experimental.mjs';
import { configuredSkills } from './experimental-catalog.mjs';
import { prepareSkillRevision } from './experimental-skills.mjs';

export const whiteboxEnabled = raw => raw.environment?.name === 'dev' && raw.whitebox?.enabled === true;
function modelView(raw, profile) {
  return { ...raw, experimental: { enabled: true, models: profile.source === 'primary'
    ? [profile] : profile.channels.map((c, i) => ({ ...profile, ...c, id: `${profile.id}-${i}`, name: profile.name })) } };
}
export function whiteboxModels(raw) {
  if (!whiteboxEnabled(raw)) return [];
  return raw.whitebox.models.filter(p => p.enabled !== false).map(p => {
    const channels = experimentalModels(modelView(raw, p));
    if (!channels.length) throw new Error('白模模型至少需要一个渠道');
    const view = { ...channels[0], profile_id: p.id, name: p.name ?? channels[0].name,
      channels: channels.map(c => ({ model: c.model, endpoint: c.endpoint })), protocol: p.protocol ?? 'anthropic', reasoning_effort: p.reasoning_effort ?? null, thinking: p.thinking ?? null };
    return { ...view, revision: createHash('sha256').update(JSON.stringify(view)).digest('hex').slice(0, 16) };
  });
}
export function resolveWhiteboxModel(raw, selection = 'whitebox-intranet') {
  const snapshot = whiteboxModels(raw).find(m => m.profile_id === (selection?.profile_id ?? selection));
  if (!snapshot) throw Object.assign(new Error('白模模型未配置或已停用'), { status: 409, code: 'MODEL_UNAVAILABLE' });
  if (selection?.revision && selection.revision !== snapshot.revision)
    throw Object.assign(new Error('白模模型配置已变更，请新建对话；历史记录保留'), { status: 409, code: 'MODEL_CONFIGURATION_CHANGED' });
  const profile = raw.whitebox.models.find(p => p.id === snapshot.profile_id);
  const view = modelView(raw, profile);
  const channels = experimentalModels(view).map(c => ({ ...resolveExperimentalModel(view, c),
    compatibility: view.experimental.models.find(p => p.id === c.profile_id)?.anthropic_compatibility ?? {} }));
  return { ...channels[0], snapshot, channels, protocol: profile.protocol ?? 'anthropic',
    reasoningEffort: profile.reasoning_effort ?? 'low', thinking: profile.thinking ?? null, requestTimeoutMs: profile.request_timeout_ms ?? 300000 };
}
/** Hide retired choices only for new sessions; existing immutable selections remain resolvable. */
export function newWhiteboxModels(raw) {
  const allowed = new Set((raw.whitebox?.models ?? []).filter(p => p.selectable !== false).map(p => p.id));
  return whiteboxModels(raw).filter(p => allowed.has(p.profile_id));
}
export function defaultWhiteboxModel(raw) {
  const id = raw.whitebox?.default_model ?? newWhiteboxModels(raw)[0]?.profile_id;
  if (!newWhiteboxModels(raw).some(p => p.profile_id === id)) throw new Error('默认白模模型未配置或不可选择');
  return id;
}
export function resolveNewWhiteboxModel(raw, selection = defaultWhiteboxModel(raw)) {
  if (!newWhiteboxModels(raw).some(p => p.profile_id === selection))
    throw Object.assign(new Error('此白模模型不再用于新对话，请选择当前模型'), { status: 409, code: 'MODEL_UNAVAILABLE' });
  return resolveWhiteboxModel(raw, selection);
}
function skillView(raw) { return { ...raw, experimental: { enabled: true, skills: raw.whitebox?.skills ?? [] } }; }
export function whiteboxSkills(raw) { return whiteboxEnabled(raw) ? configuredSkills(skillView(raw)) : []; }
export function defaultWhiteboxSkills(raw) {
  const skill = whiteboxSkills(raw).find(s => s.id === raw.whitebox.default_skill);
  if (!skill) throw new Error('默认白模 skill 未配置');
  return { builtin: 'none', text: '', configured: [skill] };
}
export async function prepareWhiteboxSkills(root, sid, input, previous, options) {
  const fallback = previous ?? defaultWhiteboxSkills(options.raw);
  const next = { ...fallback, ...input };
  const uploaded = !!next.archive_base64 || (!!fallback.archive_name && next.clear_archive !== true);
  // Upload replaces the entire set, even when the prior round used a configured skill.
  if (uploaded) Object.assign(next, { builtin: 'none', text: '', configured: [] });
  else if (next.text?.trim()) Object.assign(next, { builtin: 'none', configured: [] });
  else if (next.builtin === 'blockout_3d') Object.assign(next, { text: '', configured: [] });
  else if (next.builtin !== 'none' || next.configured?.length !== 1)
    throw new Error('白模请选择一个 skill 或上传替换包，不能混用其他 skill');
  const spec = await prepareSkillRevision(root, sid, next, previous, { ...options, singleCustomSkill: true, raw: skillView(options.raw) });
  if (spec.builtin === 'none' && spec.skills.length !== 1) throw new Error('白模替换包必须只包含一个 SKILL.md，不能混用多个 skill');
  return spec;
}
