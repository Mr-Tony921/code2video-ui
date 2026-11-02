import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.mjs';

/** IPv4 CIDR 匹配。Gateway 绑 0.0.0.0 后，/internal/* 必须限制来源网段。 */
function inCidr(ip, cidr) {
  const [net, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw ?? 32);
  const toInt = (a) => a.split('.').reduce((n, o) => (n << 8) + (Number(o) & 255), 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(net)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(net) & mask);
}

function remoteIp(req) {
  const ip = req.socket?.remoteAddress ?? '';
  return ip.replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
}

function internalSourceAllowed(req) {
  const cidrs = config.raw.deployment?.internal_allowed_cidrs;
  if (!cidrs?.length) return true;                 // 未配置则不限制（单机绑回环时用）
  const ip = remoteIp(req);
  return cidrs.some((c) => inCidr(ip, c));
}

export function internalAuthed(req) {
  // 双重：来源网段 + 共享密钥。Gateway 绑 0.0.0.0 时网段校验不可省。
  if (!internalSourceAllowed(req)) {
    console.warn(`[gateway] 拒绝来自 ${remoteIp(req)} 的内部 API 调用（网段不允许）`);
    return false;
  }
  const t = req.headers['x-internal-token'];
  if (typeof t !== 'string' || t.length !== config.auth.internalToken.length) return false;
  try { return timingSafeEqual(Buffer.from(t), Buffer.from(config.auth.internalToken)); } catch { return false; }
}

/** 开发期的轻量会话：HMAC 签名 Cookie。Phase 2 接入 next-auth 后替换。 */
function signSession(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', config.auth.sessionSecret).update(b).digest('base64url');
  return `${b}.${sig}`;
}
export function setSessionCookie(res, u) {
  const payload = {
    id: u.id, username: u.username, role: u.role,
    can_use_blockout_3d: u.can_use_blockout_3d,
    must_change_password: u.must_change_password === true,
    exp: Date.now() + config.auth.sessionMaxAgeMs,
  };
  res.setHeader('set-cookie',
    `${config.auth.sessionCookieName}=${signSession(payload)}; HttpOnly; Path=/; ` +
    `SameSite=Lax; Max-Age=${config.auth.sessionMaxAgeMs / 1000}`);
}

function verifySession(cookie) {
  if (!cookie) return null;
  const m = cookie.match(new RegExp(`${config.auth.sessionCookieName}=([^;]+)`));
  if (!m) return null;
  const [b, sig] = m[1].split('.');
  if (!b || !sig) return null;
  const want = createHmac('sha256', config.auth.sessionSecret).update(b).digest('base64url');
  if (sig !== want) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}
export function currentUser(req) { return verifySession(req.headers.cookie); }

