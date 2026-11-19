import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { configuredSkills } from './experimental-catalog.mjs';
import { validateBuiltinSkills } from './experimental.mjs';

const exec = promisify(execFile);
function revisionDir(sessionRoot, sid, revision) {
  if (!/^sess_[a-f0-9-]{36}$/.test(sid) || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('非法 skill 记录');
  return join(sessionRoot, sid, 'skill-revisions', revision);
}

/** Immutable per-session snapshots; uploads are never copied into control-plane jobs. */
export async function prepareSkillRevision(sessionRoot, sid, input = {}, previous = null, options = {}) {
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
  const requested = input.configured ?? previous?.configured ?? [];
  if (!Array.isArray(requested) || requested.length > 16) throw new Error('配置 skill 选择无效');
  const catalog = requested.length ? configuredSkills(options.raw ?? {}) : [];
  const selectedIds = new Set();
  const configured = requested.map(ref => {
    const entry = catalog.find(p => p.id === ref?.id);
    if (!entry) throw new Error(`配置 skill ${ref?.id ?? ''} 未配置或已停用，请取消选择`);
    if (selectedIds.has(entry.id)) throw new Error('配置 skill 不能重复选择');
    selectedIds.add(entry.id);
    if (ref.version !== entry.version || ref.archive_sha256 !== entry.archive_sha256)
      throw new Error(`配置 skill ${entry.name} 版本已变更，请在设置中重新选择`);
    return entry;
  }).sort((a, b) => a.id.localeCompare(b.id));
  const archiveHash = archive ? createHash('sha256').update(archive).digest('hex') : null;
  const revision = createHash('sha256').update(JSON.stringify({ builtin, text, archiveHash, ...(configured.length ? { configured } : {}) })).digest('hex');
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
    for (const entry of configured) {
      const profile = options.raw.experimental.skills.find(p => p.id === entry.id);
      const bytes = await readFile(join(options.repoRoot, profile.archive));
      if (bytes.length > 8 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== entry.archive_sha256)
        throw new Error(`配置 skill ${entry.name} 包大小或 SHA256 校验失败`);
      const packageDir = join(stage, 'configured-packages', entry.id);
      await mkdir(join(packageDir, 'skills'), { recursive: true });
      await writeFile(join(packageDir, 'uploaded.zip'), bytes);
      await exec('python3', [fileURLToPath(new URL('./skill-zip.py', import.meta.url)), packageDir], { timeout: 20_000, maxBuffer: 4096 });
      for (const name of await readdir(join(packageDir, 'skills'))) {
        const dest = join(stage, 'skills', name);
        if (existsSync(dest)) throw new Error(`skill 名称冲突：${name}（配置 skill、ZIP 或粘贴内容重复）`);
        await rename(join(packageDir, 'skills', name), dest);
      }
      await rm(join(packageDir, 'skills'), { recursive: true });
    }
    if (builtin !== 'none' && options.raw?.skills && options.repoRoot) {
      const skills = options.raw.skills;
      const root = skills.skillsets_root.startsWith('/') ? skills.skillsets_root : join(options.repoRoot, skills.skillsets_root);
      const reserved = await readdir(join(root, skills.by_mode[builtin]));
      for (const name of await readdir(join(stage, 'skills')))
        if (reserved.includes(name)) throw new Error(`skill 名称冲突：${name} 与内置 skill 重复`);
    }
    const skills = await readdir(join(stage, 'skills'));
    if (options.singleCustomSkill && builtin === 'none' && skills.length !== 1)
      throw new Error('白模替换包必须只包含一个 SKILL.md，不能混用多个 skill');
    const manifest = { revision, builtin, text, archive_name: archiveName, archive_sha256: archiveHash, skills, ...(configured.length ? { configured } : {}) };
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
  for (const name of await readdir(join(dir, 'skills')))
    if (existsSync(join(target, name))) throw new Error(`skill 名称冲突：${name}，拒绝覆盖工作区 skill`);
  for (const name of await readdir(join(dir, 'skills')))
    await cp(join(dir, 'skills', name), join(target, name), { recursive: true, force: false, errorOnExist: true });
}
