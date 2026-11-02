#!/usr/bin/env node
/**
 * 创建首个管理员。密码从参数或环境变量读，**不硬编码**（任务书 §4.1）。
 *
 *   node src/bootstrap-admin.mjs --username admin --password 'xxx'
 *   ADMIN_BOOTSTRAP_USERNAME=admin ADMIN_BOOTSTRAP_PASSWORD='xxx' node src/bootstrap-admin.mjs
 *   node src/bootstrap-admin.mjs --username admin           # 不给密码则随机生成并打印一次
 *
 * 已存在同名用户时拒绝，不覆盖。
 */
import { randomBytes } from 'node:crypto';
import * as users from './users.mjs';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
};

const username = arg('username') ?? process.env.ADMIN_BOOTSTRAP_USERNAME ?? 'admin';
let password = arg('password') ?? process.env.ADMIN_BOOTSTRAP_PASSWORD;
let generated = false;
if (!password) {
  // 随机强密码：含大小写与数字，满足强度校验
  password = `Adm${randomBytes(9).toString('base64url')}1`;
  generated = true;
}

await users.init();
const existing = await users.get(username).catch(() => null);
if (existing) {
  console.error(`✗ 用户 ${username} 已存在（role=${existing.role}）。`);
  console.error('  如需重置密码：在网页的管理后台操作，或删除 runtime/gateway/users/<name>.json 后重建。');
  process.exit(1);
}

const u = await users.create({
  username, password,
  role: 'admin',
  canUseBlockout3d: true,          // 管理员两种模式都能用（任务书 §4.2）
});

console.log('='.repeat(56));
console.log('管理员已创建');
console.log(`  用户名  ${u.username}`);
console.log(`  密码    ${password}${generated ? '   ← 随机生成，仅此一次显示' : ''}`);
console.log(`  角色    ${u.role}（可用户管理 + 两种模式）`);
console.log(`  白模    ${u.can_use_blockout_3d}`);
console.log('='.repeat(56));
if (generated) console.log('请立即保存密码，登录后可在页面修改。');
