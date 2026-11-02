/**
 * 邀请码（V2 需求 6）：带时效、注册过即踢掉。
 *
 * · 创建时一并返回有效期时间点 —— 发给用户时要同时告知
 * · 默认单次使用（max_uses=1），用完立即失效
 * · 只存哈希，明文仅创建时返回一次
 */
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const root = () => join(config.storage.root, 'gateway', 'invites');
const cfg = () => config.raw.invites ?? {};

const hash = (code) => createHash('sha256').update(code).digest('hex');

/** 分组可读的高强度随机码 */
function generate() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉易混字符
  const pick = (n) => Array.from(randomBytes(n))
    .map((b) => alphabet[b % alphabet.length]).join('');
  return `SNV-${pick(4)}-${pick(4)}-${pick(4)}`;
}

export async function init() { await mkdir(root(), { recursive: true }); }

function pathFor(id) { return join(root(), `${id}.json`); }

export async function create({ createdBy, maxUses, validDays, grantsBlockout3d, note, channel }) {
  await init();
  const c = cfg();
  const code = generate();
  const id = hash(code).slice(0, 16);
  const days = validDays ?? c.default_valid_days ?? 7;
  const expiresAt = new Date(Date.now() + days * 86400_000).toISOString();
  const rec = {
    id,
    code_hash: hash(code),
    code_prefix: code.slice(0, 8),
    // 明文留存：管理员需要事后补发/重复复制历史邀请码（用户明确要求）。
    // 这是刻意的取舍 —— 邀请码只是注册凭证、非口令，且仅管理员接口可见。
    code_plain: code,
    max_uses: maxUses ?? c.default_max_uses ?? 1,
    used_count: 0,
    grants_blockout_3d: grantsBlockout3d === true,
    // 渠道随邀请码下发：注册时写进用户记录，便于按渠道区分测试/外发账户
    channel: channel ? String(channel).trim() : null,
    expires_at: expiresAt,
    valid_days: days,
    revoked_at: null,
    created_by: createdBy,
    created_at: new Date().toISOString(),
    note: note ?? null,
    used_by: [],
  };
  await writeFile(pathFor(id), JSON.stringify(rec, null, 2), 'utf8');
  // ★ 明文与有效期一并返回，之后永不可查
  return { invite: publicView(rec), code, expires_at: expiresAt, valid_days: days };
}

export async function list() {
  await init();
  const out = [];
  for (const f of await readdir(root())) {
    if (!f.endsWith('.json')) continue;
    try { out.push(publicView(JSON.parse(await readFile(join(root(), f), 'utf8')))); } catch {}
  }
  out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return out;
}

async function findByCode(code) {
  await init();
  const h = hash(code);
  for (const f of await readdir(root())) {
    if (!f.endsWith('.json')) continue;
    try {
      const r = JSON.parse(await readFile(join(root(), f), 'utf8'));
      if (r.code_hash === h) return r;
    } catch {}
  }
  return null;
}

export function statusOf(rec) {
  if (rec.revoked_at) return 'revoked';
  if (rec.used_count >= rec.max_uses) return 'exhausted';     // 注册过即踢掉
  if (new Date(rec.expires_at).getTime() < Date.now()) return 'expired';
  return 'valid';
}

function publicView(rec) {
  return {
    id: rec.id, code_prefix: rec.code_prefix,
    code: rec.code_plain ?? null,          // 老记录没有明文 → null，前端显示前缀
    expires_at_label: new Date(rec.expires_at).toLocaleString('zh-CN'),
    max_uses: rec.max_uses, used_count: rec.used_count,
    grants_blockout_3d: rec.grants_blockout_3d,
    channel: rec.channel ?? null,
    expires_at: rec.expires_at, valid_days: rec.valid_days,
    revoked_at: rec.revoked_at,
    created_by: rec.created_by, created_at: rec.created_at,
    note: rec.note, status: statusOf(rec),
    used_by: rec.used_by ?? [],
  };
}

export class InviteError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

/**
 * 消费邀请码。注册流程调用。
 * 原子性：文件存储下用"读-改-写 + 再校验"近似；DB 到位后换成事务内 UPDATE ... WHERE used_count < max_uses。
 */
export async function redeem(code, username) {
  const rec = await findByCode(code);
  if (!rec) throw new InviteError('INVITE_INVALID', '邀请码无效');
  const st = statusOf(rec);
  if (st === 'revoked') throw new InviteError('INVITE_REVOKED', '该邀请码已被撤销');
  if (st === 'expired') {
    throw new InviteError('INVITE_EXPIRED',
      `该邀请码已于 ${new Date(rec.expires_at).toLocaleString('zh-CN')} 过期`);
  }
  if (st === 'exhausted') throw new InviteError('INVITE_EXHAUSTED', '该邀请码已被使用');

  rec.used_count += 1;
  rec.used_by = [...(rec.used_by ?? []), { username, at: new Date().toISOString() }];
  if (rec.used_count >= rec.max_uses) rec.exhausted_at = new Date().toISOString();
  await writeFile(pathFor(rec.id), JSON.stringify(rec, null, 2), 'utf8');

  // 再校验：并发下若被别人抢先用满，回滚本次
  const after = JSON.parse(await readFile(pathFor(rec.id), 'utf8'));
  if (after.used_count > after.max_uses) {
    throw new InviteError('INVITE_EXHAUSTED', '该邀请码已被使用');
  }
  return {
    grants_blockout_3d: rec.grants_blockout_3d,
    invite_id: rec.id,
    channel: rec.channel ?? null,
    note: rec.note ?? null,
  };
}

export async function revoke(id) {
  const p = pathFor(id);
  if (!existsSync(p)) throw new InviteError('NOT_FOUND', '邀请码不存在');
  const rec = JSON.parse(await readFile(p, 'utf8'));
  if (!rec.revoked_at) {
    rec.revoked_at = new Date().toISOString();
    await writeFile(p, JSON.stringify(rec, null, 2), 'utf8');
  }
  return publicView(rec);
}
