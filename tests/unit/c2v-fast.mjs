import '../fixtures.mjs';
import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fastSkillSnapshot, verifyFastSkill, validateFastMode } from '../../apps/shared/c2v-fast.mjs';
process.env.CVW_GATEWAY_BASE_URL = 'http://127.0.0.1:1';
process.env.CVW_INTERNAL_TOKEN = 'fast-fixture-token';
const { prepareJobWorkspace } = await import('../../apps/worker-bridge/src/job-workspace.mjs');

test('fast mode validates API types and verifies pinned content before preparing a workspace', async () => {
  assert.equal(validateFastMode('coding_to_video', undefined), false);
  assert.equal(validateFastMode('coding_to_video', true), true);
  for (const value of ['true', 1, null]) assert.throws(() => validateFastMode('coding_to_video', value));
  for (const mode of ['experimental', 'blockout_3d']) assert.throws(() => validateFastMode(mode, true));
  const snapshot = await fastSkillSnapshot(TEST_REPO_ROOT);
  const fakeRoot = join(TEST_TMP_ROOT, 'modified-release');
  await cp(join(TEST_REPO_ROOT, 'assets/c2v-fast'), join(fakeRoot, 'assets/c2v-fast'), { recursive: true });
  await writeFile(join(fakeRoot, 'assets/c2v-fast/releases/0.1.0/c2v-fast-compact/SKILL.md'), 'changed');
  await assert.rejects(verifyFastSkill(fakeRoot, snapshot), /快照不一致/);
  await assert.rejects(verifyFastSkill(TEST_REPO_ROOT, { ...snapshot, version: '../../' }));
  await assert.rejects(prepareJobWorkspace({ sessionId: 'sess_' + randomUUID(), jobId: 'job_' + randomUUID(),
    mode: 'coding_to_video', prompt: 'test', fastMode: true }), /快照/);
});

test('fast mode replaces normal review skills, preserves source on follow-up, and can return to standard mode', async () => {
  const sid = 'sess_' + randomUUID(), snapshot = await fastSkillSnapshot(TEST_REPO_ROOT);
  const options = { sessionId: sid, mode: 'coding_to_video', agentWsPath: '/workspace', fastMode: true, fastSkill: snapshot };
  const first = await prepareJobWorkspace({ ...options, jobId: 'job_' + randomUUID(), prompt: 'Keep my exact story.' });
  assert.deepEqual(first.skills, ['c2v-fast-compact']);
  const firstPrompt = await readFile(first.promptPath, 'utf8');
  assert.match(firstPrompt, /Before implementation, use Read/);
  assert.match(firstPrompt, /Keep my exact story\./);
  assert.doesNotMatch(firstPrompt, /Start by loading `code-video-core`/);
  const metaBytes = await readFile(join(first.bookDir, '_meta.json'), 'utf8');
  assert.deepEqual(JSON.parse(metaBytes).fast_skill, snapshot);
  const native = join(first.ws, '.home/.claude/projects/-workspace');
  await mkdir(native, { recursive: true });
  await writeFile(join(native, sid.slice(5) + '.jsonl'), '{}\n');
  await writeFile(join(first.ws, 'src/film.mjs'), '// accepted source');
  const revised = await prepareJobWorkspace({ ...options, jobId: 'job_' + randomUUID(), prompt: 'Change title only.' });
  assert.equal(revised.isContinuation, true);
  assert.match(await readFile(revised.promptPath, 'utf8'), /scoped follow-up/);
  assert.equal(await readFile(join(revised.ws, 'src/film.mjs'), 'utf8'), '// accepted source');
  assert.equal(await readFile(join(first.bookDir, '_meta.json'), 'utf8'), metaBytes);
  const standard = await prepareJobWorkspace({ sessionId: sid, jobId: 'job_' + randomUUID(), mode: 'coding_to_video', prompt: 'Polish this.' });
  assert.ok(standard.skills.includes('code-video-core'));
  assert.ok(!standard.skills.includes('c2v-fast-compact'));
  assert.match(await readFile(standard.promptPath, 'utf8'), /Start by loading `code-video-core`/);
});
