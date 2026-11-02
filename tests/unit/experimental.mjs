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

test('enhancement audit retains raw reasoning signatures and native sessions after successful cleanup', async () => {
  process.env.CVW_INTERNAL_TOKEN = 'enhancement-audit-fixture-token';
  const { config } = await import('../../apps/gateway/src/config.mjs');
  const { runEnhanceAgent } = await import('../../apps/gateway/src/enhance-agent.mjs');
  const bin = join(TEST_TMP_ROOT, 'audit-fixture-claude');
  await writeFile(bin, `#!/usr/bin/env python3
import json,os,pathlib
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
  const auditDir = join(TEST_TMP_ROOT, 'enhancement-audit');
  const result = await runEnhanceAgent('fixture prompt', { auditDir });
  assert.equal(result.text, 'fixture response');
  assert.match(await readFile(join(auditDir, 'claude.jsonl'), 'utf8'), /opaque-audit-reasoning/);
  assert.match(await readFile(join(auditDir, '.home/.claude/projects/fixture/native.jsonl'), 'utf8'), /opaque-audit-signature/);
});
