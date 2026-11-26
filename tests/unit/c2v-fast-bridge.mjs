import '../fixtures.mjs';
import { TEST_TMP_ROOT, TEST_REPO_ROOT } from '../fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fastSkillSnapshot } from '../../apps/shared/c2v-fast.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real Bridge HTTP passes fast selection into the actual child workspace and stdin contract', async () => {
  const gateway = createServer(async (req, res) => {
    for await (const chunk of req) { /* drain callback body */ }
    res.setHeader('content-type', 'application/json'); res.end('{}');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const raw = JSON.parse(await readFile(join(TEST_REPO_ROOT, 'config/backend.json')));
  const fake = join(TEST_TMP_ROOT, 'fake-fast-claude');
  await writeFile(fake, `#!/usr/bin/env python3
import json,pathlib,sys
p=pathlib.Path.cwd()
(p/'received-prompt.md').write_text(sys.stdin.read())
(p/'received-skills.json').write_text(json.dumps(sorted(x.name for x in (p/'.claude/skills').iterdir())))
print(json.dumps({'type':'result','subtype':'success','result':'Fixture child completed.'}),flush=True)
`);
  await chmod(fake, 0o755);
  raw.claude_cli.bin = fake;
  raw.isolation = { ...raw.isolation, enabled: false };
  raw.model = { ...raw.model, base_url: 'http://127.0.0.1:1', api_key: '', auto_detect_context: false };
  const file = join(TEST_TMP_ROOT, 'bridge-config.json'); await writeFile(file, JSON.stringify(raw));
  const token = 'fast-bridge-fixture-token';
  const child = spawn(process.execPath, [join(TEST_REPO_ROOT, 'apps/worker-bridge/src/server.mjs')], {
    cwd: TEST_TMP_ROOT, env: { ...process.env, CVW_BACKEND_CONFIG: file,
      CVW_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.address().port}`, CVW_INTERNAL_TOKEN: token,
      CVW_BRIDGE_HOST: '127.0.0.1', CVW_BRIDGE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {}
      await sleep(30);
    }
    assert.ok(ready, logs);
    const sid = 'sess_' + randomUUID(), jid = 'job_' + randomUUID();
    const snapshot = await fastSkillSnapshot(TEST_REPO_ROOT);
    const response = await fetch(`http://127.0.0.1:${port}/jobs`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': token },
      body: JSON.stringify({ session_id: sid, job_id: jid, mode: 'coding_to_video', prompt: 'My raw brief.',
        fast_mode: true, fast_skill: snapshot, lease_token: 'fixture-lease', max_runtime_seconds: 30 }),
      signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 202, await response.text());
    const session = join(process.env.CVW_SESSIONS_ROOT, raw.storage.sessions_subdir, sid);
    let received;
    for (let i = 0; i < 150; i++) {
      try { received = await readFile(join(session, 'workspace/received-prompt.md'), 'utf8'); break; } catch {}
      await sleep(30);
    }
    assert.ok(received, logs);
    assert.match(received, /Before implementation, use Read/);
    assert.doesNotMatch(received, /Start by loading `code-video-core`/);
    assert.deepEqual(JSON.parse(await readFile(join(session, 'workspace/received-skills.json'))), ['c2v-fast-compact']);
    const meta = JSON.parse(await readFile(join(session, 'rounds', jid, '_meta.json')));
    assert.equal(meta.fast_mode, true); assert.deepEqual(meta.fast_skill, snapshot);
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
    }
    gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve));
  }
});
