/** Independent whitebox credentials. Never changes CC/C2V/experimental profiles. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, chmodSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import { normalizeConnection } from './model-settings.mjs';
export const SEKO_HARNESS = 'seko-v1';
export const SEKO_RELEASE = 'seko-0.1.5-cvw.1';
export const isSeko = selection => selection?.harness === SEKO_HARNESS;
const fail = (text, status = 400) => Object.assign(new Error(text), { status, code: 'WHITEBOX_MODEL_INVALID' });
const root = raw => join(raw.model_settings?.root ?? join(process.env.CVW_STORAGE_ROOT ?? raw.storage.root, 'model-settings'), 'whitebox');
const read = (raw, name) => existsSync(join(root(raw), name)) ? JSON.parse(readFileSync(join(root(raw), name))) : null;
function write(raw, name, data) {
  mkdirSync(root(raw), { recursive: true, mode: 0o700 }); chmodSync(root(raw), 0o700);
  const tmp = join(root(raw), name + '.' + randomUUID() + '.tmp');
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); renameSync(tmp, join(root(raw), name));
}
function initial(raw) {
  const profile = raw.whitebox?.models?.find(p => p.id === 'whitebox-deepseek');
  const c = profile?.channels?.[0];
  if (!c) throw fail('白模默认 DeepSeek 尚未配置', 503);
  return { kind: 'tokenhub', endpoint: c.endpoint, model: c.model,
    api_key: process.env[c.api_key_env] ?? '', protocol: 'chat', family: 'deepseek', max_context_tokens: 262144 };
}
function current(raw) { const p = read(raw, 'default.json'); return p ? record(raw, p) : { connection: initial(raw) }; }
function record(raw, selection) {
  const id = selection?.profile_id ?? selection;
  if (!/^seko-[a-f0-9]{32}$/.test(id ?? '')) throw fail('白模模型配置不存在', 404);
  const r = read(raw, id + '.json');
  if (!r || selection?.revision && selection.revision !== r.snapshot.revision) throw fail('白模模型配置不存在或版本不匹配', 409);
  return r;
}
export function sekoConnection(raw, selection) { return { ...record(raw, selection).connection }; }
export function prepareSekoConnection(raw, input) {
  const previous = input?.reference_id ? record(raw, input.reference_id).connection : current(raw).connection;
  const endpoint = String(input?.endpoint ?? '').replace(/\/v1\/(chat\/completions|responses)\/?$/, '/v1');
  const c = normalizeConnection({ ...input, endpoint }, previous);
  c.max_context_tokens = Number(input.max_context_tokens ?? previous.max_context_tokens ?? 262144);
  if (!Number.isSafeInteger(c.max_context_tokens) || c.max_context_tokens < 16384 || c.max_context_tokens > 2097152) throw fail('上下文上限须在 16384–2097152 token 之间');
  c.protocol = input.protocol ?? previous.protocol ?? 'chat';
  if (!['chat', 'anthropic'].includes(c.protocol)) throw fail('不支持的白模接口协议');
  c.family = /deepseek/i.test(c.model) ? 'deepseek' : /claude|opus/i.test(c.model) ? 'opus' : 'generic';
  return c;
}
function view(entry, admin = true) {
  const c = entry.connection;
  return { ...entry.snapshot, name: c.model, model: c.model,
    ...(admin ? { kind: c.kind, endpoint: c.endpoint, protocol: c.protocol, max_context_tokens: c.max_context_tokens ?? 262144, has_key: !!c.api_key,
      key_mask: c.api_key ? c.api_key.slice(0, 6) + '****' + c.api_key.slice(-3) : '' } : {}) };
}
export const sekoAdminModel = raw => view(current(raw));
export function saveSekoModel(raw, input) {
  const c = prepareSekoConnection(raw, input);
  const revision = createHash('sha256').update(JSON.stringify(c)).digest('hex');
  const id = 'seko-' + revision.slice(0, 32);
  const entry = { connection: c, snapshot: { profile_id: id, name: c.model, model: c.model, revision: revision.slice(0, 16) }, created_at: new Date().toISOString() };
  if (!read(raw, id + '.json')) write(raw, id + '.json', entry);
  write(raw, 'default.json', { profile_id: id }); return view(entry);
}
export function sekoSelection(raw) {
  let e = current(raw);
  if (!e.snapshot) { saveSekoModel(raw, e.connection); e = current(raw); }
  const release = raw.whitebox?.seko_release ?? SEKO_RELEASE;
  if (!/^seko-[\w.-]+$/.test(release)) throw fail('白模发布版本格式无效');
  const manifest = JSON.parse(readFileSync(join(fileURLToPath(new URL('../../', import.meta.url)), 'assets/whitebox-seko/releases', release, 'RELEASE.json')));
  return { ...view(e, false), harness: SEKO_HARNESS, engine_release: release, skill_version: manifest.skill_version, engine_sha256: createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex') };
}
export const sekoSkill = { id: 'seko-blockout', name: 'Seko Blockout', version: '0.1.5', release: SEKO_RELEASE };
export function sekoSettings(raw) { const m = sekoSelection(raw); return { models: [m], default_model_id: m.profile_id,
  skills: [{ ...sekoSkill, version: m.skill_version }], default_skills: { builtin: 'none', configured: [{ ...sekoSkill, version: m.skill_version, release: m.engine_release }] }, harness: SEKO_HARNESS,
  fixed_model: true, fixed_skill: true, time_target_seconds: 600, video_timing_separate: true, hard_timeout_seconds: null }; }
/** Actual intended protocol; an internal request has no fake authorization header. */
export async function checkSekoConnection(c, { timeoutMs = 60000 } = {}) {
  const start = Date.now(), anthropic = c.protocol === 'anthropic';
  const body = JSON.stringify({ model: c.model, max_tokens: 256, stream: false, messages: [{ role: 'user', content: 'Reply with OK.' }] });
  const url = new URL(c.endpoint + (anthropic ? '/v1/messages' : '/v1/chat/completions'));
  const result = { ok: false, model: c.model, protocol: c.protocol, checked_at: new Date().toISOString() };
  try {
    const { status, text } = await new Promise((resolve, reject) => {
      const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
      if (anthropic) headers['anthropic-version'] = '2023-06-01';
      if (c.kind === 'tokenhub') headers[anthropic ? 'x-api-key' : 'authorization'] = (anthropic ? '' : 'Bearer ') + c.api_key;
      const req = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers, agent: false }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', s => { text += s; if (text.length > 2e6) req.destroy(new Error('Oversized response')); });
        res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
      req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end(body);
    });
    result.http_status = status;
    if (status !== 200) throw new Error('HTTP ' + status);
    const d = JSON.parse(text);
    result.ok = !d.error && (anthropic ? ['end_turn', 'stop_sequence'].includes(d.stop_reason) && d.content?.some(x => x.type === 'text' && x.text)
      : ['stop', 'end_turn'].includes(d.choices?.[0]?.finish_reason) && !!d.choices[0].message?.content);
    if (!result.ok) result.error = '接口未返回完整文本回复';
  } catch (e) { result.error = e.message === 'timeout' ? '检测超时（60 秒）' : /^HTTP \d+$/.test(e.message) ? e.message : '无法取得完整模型回复，请核对地址与接口协议'; }
  return { ...result, latency_ms: Date.now() - start };
}
