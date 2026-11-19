import '../fixtures.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile, symlink, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TEST_TMP_ROOT, TEST_REPO_ROOT } from '../fixtures.mjs';
import { experimentalModels, resolveExperimentalModel, experimentalEnabled } from '../../apps/shared/experimental.mjs';
import { prepareSkillRevision, mountCustomSkills } from '../../apps/shared/experimental-skills.mjs';

const raw = { environment: { name: 'dev' }, experimental: { enabled: true, models: [
  { id: 'fixture', name: 'Fixture model', model: 'fixture-opus', endpoint: 'https://models.example.test', api_key: 'fixture-key' },
] } };
const sid = 'sess_12345678-1234-1234-1234-123456789abc';
test('profiles are dev-only, contain no credentials, and reject changes within a conversation', () => {
  assert.equal(experimentalEnabled({ ...raw, environment: { name: 'prod' } }), false);
  assert.deepEqual(experimentalModels({ ...raw, environment: { name: 'prod' } }), []);
  const [selection] = experimentalModels(raw);
  assert.ok(!JSON.stringify(selection).includes('fixture-key'));
  assert.equal(resolveExperimentalModel(raw, selection).model, 'fixture-opus');
  const changed = structuredClone(raw); changed.experimental.models[0].model = 'different';
  assert.throws(() => resolveExperimentalModel(changed, selection), /配置已变更/);
  const rotated = structuredClone(raw); rotated.experimental.models[0].api_key = 'rotated';
  assert.equal(resolveExperimentalModel(rotated, selection).apiKey, 'rotated');
});
test('intranet option inherits the primary model without changing existing API conversations', t => {
  const names = ['CVW_MODEL', 'CVW_MODEL_BASE_URL', 'CVW_MAX_OUTPUT_TOKENS', 'CVW_AUTOCOMPACT_PCT', 'FIXTURE_PRIMARY_KEY'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  t.after(() => { for (const name of names) saved[name] === undefined ? delete process.env[name] : process.env[name] = saved[name]; });
  const config = structuredClone(raw);
  config.model = { base_url: 'http://intranet.example.test:8000', model: 'fixture-local',
    api_key_env: 'FIXTURE_PRIMARY_KEY', max_context_tokens: 524288, max_output_tokens: 64000, autocompact_pct: 80 };
  const original = experimentalModels(config)[0];
  config.experimental.models.push({ id: 'intranet-default', source: 'primary' });
  const [api, local] = experimentalModels(config);
  assert.deepEqual(api, original);
  assert.equal(resolveExperimentalModel(config, original).apiKey, 'fixture-key');
  assert.equal(local.name, 'fixture-local（内网）'); assert.equal(local.endpoint, config.model.base_url);
  assert.equal(local.model, config.model.model); assert.equal(local.max_context_tokens, 524288);
  assert.equal(local.max_output_tokens, 64000);
  assert.equal(resolveExperimentalModel(config, local).apiKey, 'sk-local-proxy');
  process.env.FIXTURE_PRIMARY_KEY = 'rotated-primary-fixture-key';
  assert.equal(resolveExperimentalModel(config, local).apiKey, 'rotated-primary-fixture-key');
  assert.deepEqual(experimentalModels(config)[1], local);
  process.env.CVW_MODEL_BASE_URL = 'http://another-intranet.example.test';
  process.env.CVW_MODEL = 'fixture-local-v2'; process.env.CVW_MAX_OUTPUT_TOKENS = '32000';
  const changed = experimentalModels(config)[1];
  assert.equal(changed.model, 'fixture-local-v2'); assert.equal(changed.max_output_tokens, 32000);
  assert.throws(() => resolveExperimentalModel(config, local), /配置已变更/);
  assert.deepEqual(experimentalModels(config)[0], api);
});
test('pasted skill revisions are immutable, mounted without builtins, and retain original bytes', async () => {
  const root = join(TEST_TMP_ROOT, 'skills');
  const a = await prepareSkillRevision(root, sid, { text: 'Use only my custom process.\n', builtin: 'none' });
  const b = await prepareSkillRevision(root, sid, { text: 'A different process.' }, a);
  assert.notEqual(a.revision, b.revision);
  assert.equal(await readFile(join(root, sid, 'skill-revisions', a.revision, 'pasted.md'), 'utf8'), 'Use only my custom process.\n');
  const target = join(TEST_TMP_ROOT, 'mounted'); await mkdir(target);
  await mountCustomSkills(root, sid, a, target);
  assert.ok(existsSync(join(target, 'custom-prompt-skill/SKILL.md')));
  assert.ok(!existsSync(join(target, 'code-video-core')));
  assert.equal((await prepareSkillRevision(root, sid, {}, a)).revision, a.revision);
});
function zip(entries) {
  return execFileSync('python3', ['-c', "import io,json,sys,zipfile,base64; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); [(z.writestr(k,v)) for k,v in json.loads(sys.argv[1]).items()]; z.close(); print(base64.b64encode(b.getvalue()).decode())", JSON.stringify(entries)], { encoding: 'utf8' }).trim();
}
test('ZIP retains scripts/resources and rejects traversal, nested skills and duplicate names', async () => {
  const root = join(TEST_TMP_ROOT, 'zip-skills');
  const archive = zip({ 'my-skill/SKILL.md': '---\nname: my-skill\ndescription: fixture\n---\nDo it.',
    'my-skill/scripts/test.py': 'print(42)', 'my-skill/resources/data.json': '{"ok":true}' });
  const a = await prepareSkillRevision(root, sid, { archive_base64: archive, archive_name: 'skill.zip' });
  assert.deepEqual(a.skills, ['my-skill']);
  assert.equal(await readFile(join(root, sid, 'skill-revisions', a.revision, 'skills/my-skill/scripts/test.py'), 'utf8'), 'print(42)');
  const b = await prepareSkillRevision(root, sid, { text: 'Use the supplied package.' }, a);
  assert.deepEqual(b.skills.sort(), ['custom-prompt-skill', 'my-skill']);
  for (const entries of [ { '../outside': 'bad', 'SKILL.md': 'x' },
    { 'a/SKILL.md': 'x', 'a/b/SKILL.md': 'y' }, { 'no-skill/readme.md': 'x' } ]) {
    await assert.rejects(prepareSkillRevision(root, sid, { archive_base64: zip(entries) }));
  }
  await assert.rejects(mountCustomSkills(root, '../another-session', a, '/tmp/unused'));
});
test('archive preserves opaque reasoning fields and nested native sessions without following links', async () => {
  const dir = join(TEST_TMP_ROOT, 'archive');
  const native = 'workspace/.home/.claude/projects/-workspace/subagents/agent.jsonl';
  const value = JSON.stringify({ message: { content: [{ type: 'thinking', thinking: 'x', signature: 'opaque+signature==' }], reasoning_signature: { unknown: 'preserve exactly' } } }) + '\n';
  await mkdir(join(dir, native, '..'), { recursive: true });
  await writeFile(join(dir, native), value);
  await writeFile(join(dir, 'workspace/claude.jsonl'), value);
  await writeFile(join(dir, 'workspace/settings.json'), '{"api_key":"must-not-export"}');
  await symlink('/etc/passwd', join(dir, 'workspace/outside-link'));
  const archive = execFileSync('python3', [join(TEST_REPO_ROOT, 'apps/shared/session-archive.py'), dir]);
  const result = JSON.parse(execFileSync('python3', ['-c', "import io,json,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({k:z.read(k).decode() for k in z.namelist()}))"], { input: archive, encoding: 'utf8' }));
  assert.equal(result[native], value); assert.equal(result['workspace/claude.jsonl'], value);
  assert.ok(!('workspace/settings.json' in result));
  assert.ok(!('workspace/outside-link' in result));
});

test('enhancement agent applies its private proxy and retains raw audit and native sessions', async t => {
  process.env.CVW_INTERNAL_TOKEN = 'enhancement-audit-fixture-token';
  const { config } = await import('../../apps/gateway/src/config.mjs');
  const { runEnhanceAgent } = await import('../../apps/gateway/src/enhance-agent.mjs');
  const bin = join(TEST_TMP_ROOT, 'audit-fixture-claude');
  await writeFile(bin, `#!/usr/bin/env python3
import json,os,pathlib
for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'):
    assert os.environ[key] == 'http://fixture-proxy.test:7914'
for key in ('NO_PROXY', 'no_proxy'):
    assert os.environ[key] == 'localhost,models.example.test'
assert all(key not in os.environ for key in ('ALL_PROXY', 'all_proxy', 'CVW_CLAUDE_HTTP_PROXY'))
assert 'CVW_INTERNAL_TOKEN' not in os.environ
assert os.environ['ANTHROPIC_API_KEY'] == 'fixture-key'
p=pathlib.Path(os.environ['HOME'])/'.claude/projects/fixture/native.jsonl'
p.parent.mkdir(parents=True,exist_ok=True)
r={'type':'assistant','message':{'content':[{'type':'thinking','thinking':'fixture','signature':'opaque-audit-signature'},{'type':'text','text':'fixture response'}],'reasoning_signature':'opaque-audit-reasoning'}}
p.write_text(json.dumps(r)+'\\n')
print(json.dumps(r),flush=True)
print(json.dumps({'type':'result','result':'fixture response','is_error':False}),flush=True)
`);
  await chmod(bin, 0o755);
  config.raw.prompt_enhancement = { aux_model: { base_url: 'http://127.0.0.1:1', api_key: 'fixture-key', model: 'fixture' },
    agent: { enabled: true, bin, timeout_ms: 2000, max_concurrent: 1 } };
  const originalProxy = process.env.CVW_CLAUDE_HTTP_PROXY;
  const originalConfig = config.raw.proxy;
  t.after(() => {
    if (originalProxy === undefined) delete process.env.CVW_CLAUDE_HTTP_PROXY;
    else process.env.CVW_CLAUDE_HTTP_PROXY = originalProxy;
    config.raw.proxy = originalConfig;
  });
  process.env.CVW_CLAUDE_HTTP_PROXY = 'http://fixture-proxy.test:7914';
  config.raw.proxy = { no_proxy: 'localhost,models.example.test' };
  const auditDir = join(TEST_TMP_ROOT, 'enhancement-audit');
  const result = await runEnhanceAgent('fixture prompt', { auditDir });
  assert.equal(result.text, 'fixture response');
  assert.match(await readFile(join(auditDir, 'claude.jsonl'), 'utf8'), /opaque-audit-reasoning/);
  assert.match(await readFile(join(auditDir, '.home/.claude/projects/fixture/native.jsonl'), 'utf8'), /opaque-audit-signature/);
});
