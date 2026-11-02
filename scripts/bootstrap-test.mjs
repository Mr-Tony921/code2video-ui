#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('python3', [join(root, 'scripts/guard-isolation.py')]);
for (const line of (await readFile(join(root, 'runtime/.secrets'), 'utf8')).trim().split('\n')) {
  const i = line.indexOf('=');
  process.env[line.slice(0, i)] = line.slice(i + 1);
}
process.env.CVW_REPO_ROOT = root;
const users = await import('../apps/gateway/src/users.mjs');
for (const [name, blockout, filename] of [['test', true, 'test-account.json'], ['test-peer', false, 'test-peer-account.json']]) {
  const path = join(root, 'runtime', filename);
  let creds;
  try { creds = JSON.parse(await readFile(path, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    creds = { username: name, password: 'Test-' + randomBytes(20).toString('base64url') };
    await writeFile(path, JSON.stringify(creds) + '\n', { mode: 0o600, flag: 'wx' });
  }
  let user = await users.get(name);
  if (!user) user = await users.create({ ...creds, role: 'user', canUseBlockout3d: blockout,
    channel: 'test', note: 'Codex independent smoke tests' });
  if (user.role !== 'user' || user.can_use_blockout_3d !== blockout) throw new Error('Test account permissions differ');
  console.log(`${user.username}: role=user, blockout_3d=${user.can_use_blockout_3d}`);
}
