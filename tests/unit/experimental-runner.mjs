import '../fixtures.mjs';
import { TEST_TMP_ROOT } from '../fixtures.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
process.env.CVW_INTERNAL_TOKEN = 'experimental-runner-fixture-token';
process.env.CVW_GATEWAY_BASE_URL = 'http://127.0.0.1:1';
const { config } = await import('../../apps/worker-bridge/src/config.mjs');
const { experimentalModels } = await import('../../apps/shared/experimental.mjs');
const runner = await import('../../apps/worker-bridge/src/job-runner.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real child uses the selected API model for every CLI role, preserves raw signatures and emits only the minimal contract', async () => {
  config.raw.experimental = { enabled: true, models: [{ id: 'fixture', name: 'fixture', model: 'fixture-opus',
    endpoint: 'https://models.example.test', api_key: 'fixture-key' }] };
  config.isolation = { enabled: false };
  const fake = join(TEST_TMP_ROOT, 'fake-claude');
  await writeFile(fake, `#!/usr/bin/env python3
import json,os,pathlib,sys,time
p=pathlib.Path.cwd()
keys=['ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','CLAUDE_CODE_SUBAGENT_MODEL','CLAUDE_CODE_MAX_CONTEXT_TOKENS','CVW_INTERNAL_TOKEN','CVW_SESSION_SECRET']
(p/'fixture-env.json').write_text(json.dumps({k:os.environ.get(k) for k in keys}))
(p/'received-prompt.md').write_text(sys.stdin.read())
record={'type':'assistant','message':{'content':[{'type':'thinking','thinking':'fixture thinking','signature':'opaque+signature=='}],'reasoning_signature':'opaque-reasoning-signature'}}
native=pathlib.Path(os.environ['HOME'])/'.claude/projects/-workspace/session.jsonl'
native.parent.mkdir(parents=True,exist_ok=True);native.write_text(json.dumps(record)+'\\n')
print(json.dumps(record),flush=True)
time.sleep(30)
`);
  await chmod(fake, 0o755); config.claudeCli.bin = fake;
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = 'stale-intranet-limit';
  const sid = 'sess_' + randomUUID(), jid = 'job_' + randomUUID();
  const ws = join(config.storage.sessionsRoot, config.storage.sessionsSubdir, sid, 'workspace');
  let settled;
  const done = new Promise(resolve => { settled = resolve; });
  try {
    await runner.startJob({ sessionId: sid, jobId: jid, mode: 'experimental', prompt: '  My exact prompt.\n\n',
      modelSelection: experimentalModels(config.raw)[0], leaseToken: 'fixture-lease', maxRuntimeSeconds: 60,
      hooks: { onCancelled: settled, onLeaseLostExit: settled, onFail: settled } });
    let env;
    for (let i = 0; i < 100; i++) {
      try { env = JSON.parse(await readFile(join(ws, 'fixture-env.json'))); break; } catch { await sleep(30); }
    }
    assert.ok(env); assert.equal(env.ANTHROPIC_API_KEY, 'fixture-key');
    for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(env[key], 'fixture-opus');
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, null);
    assert.equal(env.CVW_INTERNAL_TOKEN, null);
    assert.equal(env.CVW_SESSION_SECRET, null);
    const prompt = await readFile(join(ws, 'received-prompt.md'), 'utf8');
    assert.ok(prompt.startsWith('  My exact prompt.\n\n')); assert.match(prompt, /output\/final\.mp4/);
    assert.ok(!prompt.includes('code-video-core')); assert.ok(!prompt.includes('make the smallest'));
    const raw = await readFile(join(ws, 'claude.jsonl'), 'utf8'); assert.match(raw, /opaque-reasoning-signature/);
    const native = await readFile(join(ws, '.home/.claude/projects/-workspace/session.jsonl'), 'utf8');
    assert.match(native, /opaque\+signature==/);
  } finally {
    await runner.cancelJob(jid, 'fixture finished', 0.01);
    await Promise.race([done, sleep(5000)]);
  }
});
