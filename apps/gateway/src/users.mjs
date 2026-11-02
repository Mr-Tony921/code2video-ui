/**
 * 用户存储与密码认证。
 *
 * 密码用 scrypt 加盐哈希（Node 内置，无需额外依赖）。
 * 管理员由 CLI `admin:bootstrap` 创建，密码不硬编码（任务书 §4.1）。
 *
 * 权限模型（任务书 §4.2）：
 *   role = admin | user
 *   can_use_blockout_3d = true | false        ← 与 role 独立
 * 业务用户 ≠ 管理员：role='user' ∧ can_use_blockout_3d=true 是合法且常见的组合。
 */
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const scrypt = promisify(_scrypt);
const root = () => join(config.storage.root, 'gateway', 'users');

export class UserError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

export async function init() { await mkdir(root(), { recursive: true }); }

/** 用户名 → 文件名。只允许安全字符，避免路径穿越。 */
function idOf(username) {
  const u = String(username).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(u)) {
    throw new UserError('USERNAME_INVALID',
      '用户名需 3~64 字符，只能用字母、数字、点、下划线、短横线，且以字母或数字开头');
  }
  return u;
}
const pathFor = (id) => join(root(), `${id}.json`);

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(keyHex, 'hex');
  return key.length === want.length && timingSafeEqual(key, want);
}

function checkPasswordStrength(pw) {
  const s = String(pw);
  if (s.length < 10) throw new UserError('PASSWORD_WEAK', '密码至少 10 个字符');
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(s)).length;
  if (kinds < 2) throw new UserError('PASSWORD_WEAK', '密码需包含大小写字母或数字中的至少两类');
}

function publicView(u) {
  return {
    id: u.id, username: u.username, role: u.role,
    can_use_blockout_3d: u.can_use_blockout_3d,
    can_use_experimental: u.can_use_experimental === true,
    status: u.status,
    must_change_password: u.must_change_password === true,
    invite_id: u.invite_id ?? null,
    channel: u.channel ?? defaultChannel(),
    note: u.note ?? null,
    created_at: u.created_at,
    last_login_at: u.last_login_at ?? null,
  };
}

async function readUser(id) {
  const p = pathFor(id);
  if (!existsSync(p)) return null;
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

/** 原子写，避免并发读到半个文件 */
async function writeUser(u) {
  const p = pathFor(u.id);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(u, null, 2), 'utf8');
  await rename(tmp, p);
  return u;
}

export async function create({
  username, password, role = 'user', canUseBlockout3d = false, inviteId,
  mustChangePassword = false, channel, note,
}) {
  await init();
  const id = idOf(username);
  if (existsSync(pathFor(id))) {
    throw new UserError('USERNAME_TAKEN', '该用户名已被注册');
  }
  checkPasswordStrength(password);
  const u = {
    id, username: String(username).trim(),
    password_hash: await hashPassword(password),
    role: role === 'admin' ? 'admin' : 'user',
    can_use_blockout_3d: canUseBlockout3d === true,
    can_use_experimental: false,
    status: 'active',
    must_change_password: mustChangePassword === true,
    invite_id: inviteId ?? null,
    // 渠道与备注：区分测试账户与外发账户，便于按渠道汇总/导出用户轨迹
    channel: normalizeChannel(channel),
    note: note ? String(note).slice(0, 200) : null,
    created_at: new Date().toISOString(),
    password_changed_at: new Date().toISOString(),
    last_login_at: null,
  };
  await writeUser(u);
  return publicView(u);
}

const channelCfg = () => config.raw.users ?? {};
function defaultChannel() { return channelCfg().default_channel ?? 'test'; }

/** 渠道取值收敛到配置允许的集合；非法值回落默认，不抛错（不该因为备注挡住注册）。 */
function normalizeChannel(c) {
  const allowed = channelCfg().channels ?? ['test', 'external'];
  const v = c ? String(c).trim() : '';
  return allowed.includes(v) ? v : defaultChannel();
}

export function channels() {
  return { channels: channelCfg().channels ?? ['test', 'external'], default: defaultChannel() };
}

/** 管理员改渠道/备注。随时可改，不影响已有 session。 */
export async function setChannel(username, { channel, note }) {
  const u = await readUser(idOf(username));
  if (!u) throw new UserError('NOT_FOUND', '用户不存在');
  if (channel !== undefined) u.channel = normalizeChannel(channel);
  if (note !== undefined) u.note = note ? String(note).slice(0, 200) : null;
  await writeUser(u);
  return publicView(u);
}

/** 登录。失败一律用同一条消息，不泄露用户是否存在。 */
export async function authenticate(username, password) {
  let id;
  try { id = idOf(username); } catch { throw new UserError('UNAUTHENTICATED', '用户名或密码错误'); }
  const u = await readUser(id);
  if (!u) throw new UserError('UNAUTHENTICATED', '用户名或密码错误');
  if (!(await verifyPassword(password, u.password_hash))) {
    throw new UserError('UNAUTHENTICATED', '用户名或密码错误');
  }
  if (u.status !== 'active') {
    throw new UserError('ACCOUNT_DISABLED', '账号已被禁用，请联系管理员');
  }
  u.last_login_at = new Date().toISOString();
  await writeUser(u);
  return publicView(u);
}

/**
 * 记录一次登录时间。
 * 注册会直接下发会话 Cookie（等于已登录），所以注册路径也必须调用它，
 * 否则新用户在管理后台会一直显示"从未登录"，直到他第二次登录。
 */
export async function touchLogin(username) {
  let id;
  try { id = idOf(username); } catch { return null; }
  const u = await readUser(id);
  if (!u) return null;
  u.last_login_at = new Date().toISOString();
  await writeUser(u);
  return publicView(u);
}

export async function get(username) {
  const u = await readUser(idOf(username));
  return u ? publicView(u) : null;
}

export async function list() {
  await init();
  const out = [];
  for (const f of await readdir(root())) {
    if (!f.endsWith('.json') || f.includes('.tmp')) continue;
    const u = await readUser(f.replace(/\.json$/, ''));
    if (u) out.push(publicView(u));
  }
  out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return out;
}

export async function count() {
  await init();
  return (await readdir(root())).filter((f) => f.endsWith('.json') && !f.includes('.tmp')).length;
}

/**
 * 改白模权限（任务书 §4.3）。
 * 只影响后续新建会话与新提交任务；已运行 Job 继续执行 ——
 * 权限管理与任务取消严格分离，撤权不隐式取消任何任务。
 */
export async function setBlockout3d(username, allowed) {
  const id = idOf(username);
  const u = await readUser(id);
  if (!u) throw new UserError('NOT_FOUND', '用户不存在');
  u.can_use_blockout_3d = allowed === true;
  u.permissions_changed_at = new Date().toISOString();
  await writeUser(u);
  return publicView(u);
}

export async function setExperimental(username, allowed) {
  const u = await readUser(idOf(username));
  if (!u) throw new UserError('NOT_FOUND', '用户不存在');
  u.can_use_experimental = allowed === true;
  u.permissions_changed_at = new Date().toISOString();
  await writeUser(u);
  return publicView(u);
}

export async function setStatus(username, status) {
  const id = idOf(username);
  const u = await readUser(id);
  if (!u) throw new UserError('NOT_FOUND', '用户不存在');
  if (!['active', 'disabled'].includes(status)) {
    throw new UserError('VALIDATION_FAILED', 'status 只能是 active 或 disabled');
  }
  u.status = status;
  await writeUser(u);
  return publicView(u);
}

/** 管理员重置密码：生成一次性临时密码，强制下次登录修改 */
export async function resetPassword(username) {
  const id = idOf(username);
  const u = await readUser(id);
  if (!u) throw new UserError('NOT_FOUND', '用户不存在');
  const temp = `Tmp-${randomBytes(6).toString('base64url')}`;
  u.password_hash = await hashPassword(temp);
  u.must_change_password = true;
  u.password_changed_at = new Date().toISOString();
  await writeUser(u);
  return { user: publicView(u), temporary_password: temp };
}

/** 用户自己改密码 */
export async function changePassword(username, currentPassword, newPassword) {
  const id = idOf(username);
  const u = await readUser(id);
  if (!u) throw new UserError('NOT_FOUND', '用户不存在');
  if (!(await verifyPassword(currentPassword, u.password_hash))) {
    throw new UserError('UNAUTHENTICATED', '当前密码错误');
  }
  checkPasswordStrength(newPassword);
  u.password_hash = await hashPassword(newPassword);
  u.must_change_password = false;
  u.password_changed_at = new Date().toISOString();
  await writeUser(u);
  return publicView(u);
}
