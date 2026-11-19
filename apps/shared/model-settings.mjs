import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const fail = (message, status = 400) => Object.assign(new Error(message), { status, code: 'MODEL_CONFIGURATION_INVALID' });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const root = raw => raw.model_settings?.root ?? join(process.env.CVW_STORAGE_ROOT ?? raw.storage.root, 'model-settings');
const managedId = value => /^managed-[a-f0-9]{32}$/.test(value ?? '');
export const isManagedModel = selection => managedId(selection?.profile_id ?? selection);
function read(raw, name) {
  const file = join(root(raw), name);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}
function write(raw, name, value) {
  mkdirSync(root(raw), { recursive: true, mode: 0o700 });
  chmodSync(root(raw), 0o700);
  const file = join(root(raw), name), tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}
function record(raw, selection) {
  const id = selection?.profile_id ?? selection;
  if (!managedId(id)) throw fail('模型配置不存在', 404);
  const entry = read(raw, id + '.json');
  if (!entry) throw fail('模型配置不存在', 404);
  if (selection?.revision && entry.snapshot.revision !== selection.revision) throw fail('模型配置版本不匹配', 409);
  return entry;
}
export function normalizeEndpoint(value, kind) {
  let endpoint = String(value ?? '').trim();
  if (!endpoint && kind === 'tokenhub') endpoint = 'https://tokenhub.sensetime.com';
  if (!endpoint) throw fail('请填写模型地址');
  if (!/^https?:\/\//i.test(endpoint)) {
    if (kind !== 'intranet') throw fail('Tokenhub 地址须以 http:// 或 https:// 开头');
    endpoint = 'http://' + endpoint;
    let u;
    try { u = new URL(endpoint); } catch { throw fail('模型地址无效'); }
    if (!u.port && u.pathname === '/') u.port = '8000';
    endpoint = u.href;
  }
  let url;
  try { url = new URL(endpoint); } catch { throw fail('模型地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw fail('模型地址须为不带认证信息、参数或片段的 HTTP(S) 地址');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1(?:\/messages|\/models)?$/, '');
  return url.href.replace(/\/$/, '');
}
export function normalizeConnection(input, previous = null) {
  if (!input || !['tokenhub', 'intranet'].includes(input.kind)) throw fail('请选择 Tokenhub 或内网模型');
  const kind = input.kind, endpoint = normalizeEndpoint(input.endpoint, kind);
  const model = String(input.model ?? '').trim();
  if (!model || model.length > 256 || /[\r\n\x00]/.test(model)) throw fail('请填写正确的模型名称');
  let api_key = '';
  if (kind === 'tokenhub') {
    if (input.api_key != null && typeof input.api_key !== 'string') throw fail('Key 格式无效');
    api_key = (input.api_key ?? '').trim();
    if (!api_key && previous?.kind === kind && previous.endpoint === endpoint) api_key = previous.api_key;
    if (!api_key || api_key.includes('****') || /\s/.test(api_key) || api_key.length > 2048) throw fail('Tokenhub 模型需要填写 Key；留空只保留同一地址已保存的 Key');
  }
  const sameModel = previous?.kind === kind && previous.model === model;
  return { kind, endpoint, model, api_key,
    max_context_tokens: sameModel ? previous?.max_context_tokens ?? null : null,
    max_output_tokens: sameModel ? previous?.max_output_tokens ?? null : null,
    autocompact_pct: previous?.autocompact_pct ?? 80 };
}
function legacy(raw, purpose) {
  const m = purpose === 'c2v' ? raw.model : raw.prompt_enhancement?.aux_model ?? {};
  const endpoint = process.env[m.base_url_env ?? ''] ?? m.base_url ?? '';
  const api_key = process.env[m.api_key_env ?? ''] ?? m.api_key ?? '';
  return { kind: /tokenhub\./.test(endpoint) ? 'tokenhub' : 'intranet', endpoint,
    model: process.env[m.model_env ?? ''] ?? m.model ?? '', api_key,
    max_context_tokens: m.max_context_tokens ?? null, max_output_tokens: m.max_output_tokens ?? null,
    autocompact_pct: m.autocompact_pct ?? 80 };
}
function pointer(raw, purpose, owner) {
  const name = purpose === 'experimental' ? `user-${hash(owner).slice(0, 32)}.json` : `default-${purpose}.json`;
  const p = read(raw, name);
  return { name, entry: p ? record(raw, p.profile_id) : null };
}
export function modelView(entry) {
  if (!entry) return null;
  const c = entry.connection, key = c.kind === 'tokenhub' ? c.api_key : '';
  return { ...entry.snapshot, kind: c.kind, endpoint: c.endpoint,
    has_key: !!key, key_mask: key ? (key.length > 10 ? key.slice(0, 6) + '****' + key.slice(-3) : '****') : '',
    custom: entry.purpose === 'experimental' };
}
export function adminModelViews(raw) {
  return Object.fromEntries(['c2v', 'enhancement'].map(purpose => {
    const entry = pointer(raw, purpose).entry ?? { purpose, connection: legacy(raw, purpose),
      snapshot: { name: legacy(raw, purpose).model, model: legacy(raw, purpose).model } };
    return [purpose, modelView(entry)];
  }));
}
export function lastPersonalModel(raw, owner) { return modelView(pointer(raw, 'experimental', owner).entry); }
export function canUsePersonalModel(raw, selection, owner) {
  try { const e = record(raw, selection); return e.purpose === 'experimental' && e.owner_id === owner; }
  catch { return false; }
}
export function prepareConnection(raw, purpose, owner, input) {
  if (!['c2v', 'enhancement', 'experimental'].includes(purpose)) throw fail('模型用途无效');
  let prior = pointer(raw, purpose, owner).entry;
  if (input?.reference_id) {
    prior = record(raw, input.reference_id);
    if (prior.purpose !== purpose || (purpose === 'experimental' && prior.owner_id !== owner)) throw fail('无权使用该模型配置', 403);
  }
  return normalizeConnection(input, prior?.connection ?? (purpose !== 'experimental' ? legacy(raw, purpose) : null));
}
export function saveModel(raw, purpose, owner, input) {
  const connection = prepareConnection(raw, purpose, owner, input);
  const revision = hash({ purpose, owner: purpose === 'experimental' ? owner : null, connection });
  const id = 'managed-' + revision.slice(0, 32);
  const snapshot = { profile_id: id, name: connection.model, model: connection.model, endpoint: connection.endpoint,
    max_context_tokens: connection.max_context_tokens, max_output_tokens: connection.max_output_tokens,
    autocompact_pct: connection.autocompact_pct, revision: revision.slice(0, 16) };
  const entry = { snapshot, purpose, owner_id: purpose === 'experimental' ? owner : null, connection, created_at: new Date().toISOString() };
  if (!read(raw, id + '.json')) write(raw, id + '.json', entry);
  write(raw, pointer(raw, purpose, owner).name, { profile_id: id });
  return modelView(entry);
}
export function c2vModelSnapshot(raw) { return pointer(raw, 'c2v').entry?.snapshot ?? null; }
export function resolveManagedModel(raw, selection) {
  const e = record(raw, selection), c = e.connection;
  return { snapshot: e.snapshot, baseUrl: c.endpoint, apiKey: c.kind === 'tokenhub' ? c.api_key : 'sk-local-proxy',
    model: c.model, maxContextTokens: c.max_context_tokens == null ? null : String(c.max_context_tokens),
    maxOutputTokens: c.max_output_tokens, autocompactPct: c.autocompact_pct };
}
export function enhancementConnection(raw) { return pointer(raw, 'enhancement').entry?.connection ?? null; }

export async function checkConnection(connection, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const start = Date.now();
  const result = { ok: false, model: connection.model, checked_at: new Date().toISOString() };
  try {
    const response = await fetchImpl(connection.endpoint + '/v1/messages', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01',
        'x-api-key': connection.kind === 'tokenhub' ? connection.api_key : 'sk-local-proxy' },
      body: JSON.stringify({ model: connection.model, max_tokens: 128, stream: false,
        messages: [{ role: 'user', content: 'Reply with OK.' }] }),
    });
    result.http_status = response.status;
    if (!response.ok) { await response.body?.cancel(); return { ...result, latency_ms: Date.now() - start, error: `模型接口返回 HTTP ${response.status}` }; }
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { return { ...result, latency_ms: Date.now() - start, error: '接口未返回 Anthropic Messages JSON，请核对地址与协议' }; }
    result.ok = !!(data.stop_reason && data.content?.some(c => c.text || c.thinking || c.type === 'tool_use') && !data.error);
    return { ...result, latency_ms: Date.now() - start, ...(result.ok ? {} : { error: '接口未返回完整模型回复，请核对模型名称及渠道' }) };
  } catch (e) {
    return { ...result, latency_ms: Date.now() - start, error: e.name === 'TimeoutError' || e.name === 'AbortError'
      ? '检测超时（20 秒）' : '无法连接模型接口，请核对地址、网络及接口协议' };
  }
}
