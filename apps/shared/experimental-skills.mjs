import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateBuiltinSkills } from './experimental.mjs';

const exec = promisify(execFile);
function revisionDir(sessionRoot, sid, revision) {
  if (!/^sess_[a-f0-9-]{36}$/.test(sid) || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('非法 skill 记录');
  return join(sessionRoot, sid, 'skill-revisions', revision);
}

/** Immutable per-session snapshots; uploads are never copied into control-plane jobs. */
export async function prepareSkillRevision(sessionRoot, sid, input = {}, previous = null) {
  const builtin = validateBuiltinSkills(input.builtin ?? previous?.builtin ?? 'none');
  const text = String(input.text ?? previous?.text ?? '');
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error('skill 文本不能超过 256 KiB');
  let archive = null, archiveName = null;
  if (input.archive_base64) {
    if (typeof input.archive_base64 !== 'string' || input.archive_base64.length > 12 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(input.archive_base64)) throw new Error('skill ZIP 上传无效或超过 8 MiB');
    archive = Buffer.from(input.archive_base64, 'base64');
    if (archive.length > 8 * 1024 * 1024) throw new Error('skill ZIP 不能超过 8 MiB');
    archiveName = String(input.archive_name ?? 'skills.zip').replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_').slice(0, 120);
  } else if (previous?.archive_name && input.clear_archive !== true) {
    archive = await readFile(join(revisionDir(sessionRoot, sid, previous.revision), 'uploaded.zip'));
    archiveName = previous.archive_name;
  }
  const archiveHash = archive ? createHash('sha256').update(archive).digest('hex') : null;
  const revision = createHash('sha256').update(JSON.stringify({ builtin, text, archiveHash })).digest('hex');
  const dest = revisionDir(sessionRoot, sid, revision);
  if (existsSync(join(dest, 'manifest.json'))) return JSON.parse(await readFile(join(dest, 'manifest.json'), 'utf8'));
  const stage = dest + '.' + randomUUID() + '.tmp';
  await mkdir(join(stage, 'skills'), { recursive: true });
  try {
    if (archive) {
      await writeFile(join(stage, 'uploaded.zip'), archive);
      await exec('python3', [fileURLToPath(new URL('./skill-zip.py', import.meta.url)), stage], { timeout: 20_000, maxBuffer: 4096 });
    }
    if (text.trim()) {
      await writeFile(join(stage, 'pasted.md'), text);
      const name = /^name:\s*['"]?([a-z0-9][a-z0-9_-]{0,63})['"]?\s*$/m.exec(text)?.[1] ?? 'custom-prompt-skill';
      const skillDir = join(stage, 'skills', name);
      if (existsSync(skillDir)) throw new Error('粘贴的 skill 与 ZIP 内 skill 名称重复');
      await mkdir(skillDir);
      await writeFile(join(skillDir, 'SKILL.md'), text.startsWith('---') ? text :
        `---\nname: ${name}\ndescription: User supplied instructions for this video experiment.\n---\n\n${text}`);
    }
    const { readdir } = await import('node:fs/promises');
    const skills = await readdir(join(stage, 'skills'));
    const manifest = { revision, builtin, text, archive_name: archiveName, archive_sha256: archiveHash, skills };
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
    try { await rename(stage, dest); }
    catch (e) { if (!existsSync(join(dest, 'manifest.json'))) throw e; }
    return manifest;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function mountCustomSkills(sessionRoot, sid, spec, target) {
  if (!spec?.revision) return;
  const dir = revisionDir(sessionRoot, sid, spec.revision);
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  if (manifest.revision !== spec.revision) throw new Error('skill 版本不匹配');
  await cp(join(dir, 'skills'), target, { recursive: true });
}
