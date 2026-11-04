import '../fixtures.mjs';
import { TEST_TMP_ROOT, TEST_REPO_ROOT } from '../fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { configuredSkills } from '../../apps/shared/experimental-catalog.mjs';
import { prepareSkillRevision, mountCustomSkills } from '../../apps/shared/experimental-skills.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const sid = 'sess_12345678-1234-1234-1234-123456789abc';
function zip(entries) {
  return execFileSync('python3', ['-c', "import io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); [(z.writestr(k,v)) for k,v in json.loads(sys.argv[1]).items()]; z.close(); sys.stdout.buffer.write(b.getvalue())", JSON.stringify(entries)]);
}
async function fixture() {
  const root = join(TEST_TMP_ROOT, 'catalog-' + Math.random()); await mkdir(join(root, 'assets/experimental-skills'), { recursive: true });
  const archive = 'assets/experimental-skills/fixture.zip';
  const bytes = zip({ 'fixture/SKILL.md': 'original v1', 'fixture/resources/data.json': '{"answer":42}' });
  await writeFile(join(root, archive), bytes);
  const raw = { environment: { name: 'dev' }, experimental: { enabled: true, skills: [{ id: 'fixture', name: 'Fixture', version: 'commit-v1', archive, archive_sha256: hash(bytes) }] },
    skills: { skillsets_root: join(TEST_REPO_ROOT, 'assets/skillsets'), by_mode: { coding_to_video: 'coding_to_video' } } };
  return { root, raw, options: { raw, repoRoot: root } };
}
test('catalog is dev-only, hides paths, validates pins and rejects disabled or changed selections', async () => {
  const { root, raw, options } = await fixture(); const [selected] = configuredSkills(raw);
  assert.equal(selected.archive, undefined);
  assert.deepEqual(configuredSkills({ ...raw, environment: { name: 'prod' } }), []);
  assert.deepEqual(configuredSkills({ ...raw, experimental: { ...raw.experimental, enabled: false } }), []);
  await assert.rejects(prepareSkillRevision(root, sid, { configured: [selected, selected] }, null, options), /重复/);
  const a = await prepareSkillRevision(root, sid, { configured: [selected], builtin: 'coding_to_video' }, null, options);
  raw.experimental.skills[0].enabled = false;
  await assert.rejects(prepareSkillRevision(root, sid, {}, a, options), /停用/);
  const mounted = join(root, 'mounted'); await mkdir(mounted);
  await mountCustomSkills(root, sid, a, mounted); // Already submitted work is independent of live configuration.
  assert.equal(await readFile(join(mounted, 'fixture/SKILL.md'), 'utf8'), 'original v1');
  raw.experimental.skills[0].enabled = true;
  const bytes = zip({ 'fixture/SKILL.md': 'v2' }); await writeFile(join(root, raw.experimental.skills[0].archive), bytes);
  await assert.rejects(prepareSkillRevision(root, 'sess_22345678-1234-1234-1234-123456789abc', { configured: [selected] }, null, options), /SHA256/);
  raw.experimental.skills[0].archive_sha256 = hash(bytes); raw.experimental.skills[0].version = 'commit-v2';
  await assert.rejects(prepareSkillRevision(root, sid, {}, a, options), /版本已变更/);
  const b = await prepareSkillRevision(root, sid, { configured: configuredSkills(raw) }, a, options);
  assert.notEqual(a.revision, b.revision);
  assert.equal(await readFile(join(root, sid, 'skill-revisions', a.revision, 'skills/fixture/SKILL.md'), 'utf8'), 'original v1');
  const cleared = await prepareSkillRevision(root, sid, { configured: [] }, a, options); assert.deepEqual(cleared.skills, []);
  await assert.rejects(mountCustomSkills(root, sid, b, mounted), /名称冲突/);
});
test('configured packages reject conflicts with uploads, pasted skills and builtins before jobs are created', async () => {
  const { root, raw, options } = await fixture(); const selected = configuredSkills(raw);
  await assert.rejects(prepareSkillRevision(root, sid, { configured: selected, archive_base64: zip({ 'fixture/SKILL.md': 'upload' }).toString('base64') }, null, options), /名称冲突/);
  await assert.rejects(prepareSkillRevision(root, sid, { configured: selected, text: '---\nname: fixture\n---\npasted' }, null, options), /名称冲突/);
  await assert.rejects(prepareSkillRevision(root, sid, { builtin: 'coding_to_video', archive_base64: zip({ 'code-video-core/SKILL.md': 'upload' }).toString('base64') }, null, options), /内置 skill/);
});
test('the pinned Anatomy package imports all original bytes, composes with core, and is included in session exports', async () => {
  const root = join(TEST_TMP_ROOT, 'real-anatomy');
  const provenance = JSON.parse(await readFile(join(TEST_REPO_ROOT, 'assets/experimental-skills/anatomy/provenance.json')));
  const archive = 'assets/experimental-skills/anatomy/' + provenance.source_commit + '.zip';
  const raw = { environment: { name: 'dev' }, experimental: { enabled: true, skills: [{ id: 'anatomy', name: 'Anatomy', version: provenance.source_commit, archive, archive_sha256: provenance.skill_archive_sha256 }] },
    skills: { skillsets_root: 'assets/skillsets', by_mode: { coding_to_video: 'coding_to_video' } } };
  const a = await prepareSkillRevision(root, sid, { configured: configuredSkills(raw), builtin: 'coding_to_video' }, null, { raw, repoRoot: TEST_REPO_ROOT });
  assert.deepEqual(a.skills, ['anatomy']);
  const rev = join(root, sid, 'skill-revisions', a.revision);
  for (const f of provenance.skill_files) assert.equal(hash(await readFile(join(rev, 'skills', f.archive_path))), f.sha256, f.archive_path);
  assert.ok(existsSync(join(TEST_REPO_ROOT, 'assets/skillsets/coding_to_video/code-video-core/SKILL.md')));
  const archiveBytes = execFileSync('python3', [join(TEST_REPO_ROOT, 'apps/shared/session-archive.py'), join(root, sid)], { maxBuffer: 20 * 1024 * 1024 });
  const exported = JSON.parse(execFileSync('python3', ['-c', "import io,json,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({'manifest':json.loads(z.read(next(n for n in z.namelist() if n.endswith('/manifest.json')))), 'package':any('/configured-packages/anatomy/uploaded.zip' in n for n in z.namelist())}))"], { input: archiveBytes, encoding: 'utf8' }));
  assert.equal(exported.manifest.configured[0].version, provenance.source_commit); assert.equal(exported.package, true);
});
