import { experimentalEnabled } from './experimental.mjs';

/** Server-owned archives; clients receive only pinned, public metadata. */
export function configuredSkills(raw) {
  if (!experimentalEnabled(raw)) return [];
  const ids = new Set();
  return (raw.experimental.skills ?? []).filter(p => p.enabled !== false).map(p => {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(p.id ?? '') || ids.has(p.id))
      throw new Error('实验 skill id 无效或重复');
    ids.add(p.id);
    if (!p.name || typeof p.version !== 'string' || !p.version || !/^[a-f0-9]{64}$/.test(p.archive_sha256 ?? ''))
      throw new Error('实验 skill 需要 name、固定 version 和 archive_sha256');
    if (typeof p.archive !== 'string' || !/^assets\/experimental-skills\//.test(p.archive) ||
        p.archive.split('/').some(s => !s || s === '..' || s === '.') || p.archive.includes('\\'))
      throw new Error('实验 skill archive 必须位于 assets/experimental-skills 下');
    return { id: p.id, name: p.name, version: p.version, archive_sha256: p.archive_sha256,
      description: p.description ?? '', source: p.source ?? null };
  });
}
