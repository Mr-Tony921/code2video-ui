import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FAST_SKILL = 'c2v-fast-compact';
export const FAST_VERSION = '0.1.0';
const releases = new Set([FAST_VERSION]);

export function validateFastMode(mode, value) {
  if (value !== undefined && typeof value !== 'boolean') throw new Error('fast_mode 必须为布尔值');
  if (value === true && mode !== 'coding_to_video') throw new Error('快速模式仅支持 C2V');
  return value === true;
}

export function fastSkillRoot(repoRoot, version = FAST_VERSION) {
  if (!releases.has(version)) throw new Error('未知快速 skill 版本');
  return join(repoRoot, 'assets/c2v-fast/releases', version);
}

export async function fastSkillSnapshot(repoRoot, version = FAST_VERSION) {
  const root = fastSkillRoot(repoRoot, version);
  const hash = createHash('sha256');
  async function visit(relative = '') {
    const entries = (await readdir(join(root, relative), { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const bytes = await readFile(join(root, file));
        hash.update(file + '\0' + bytes.length + '\0'); hash.update(bytes);
      } else throw new Error('快速 skill 发行目录不允许链接或特殊文件');
    }
  }
  await visit();
  return { skill: FAST_SKILL, version, sha256: hash.digest('hex') };
}

export async function verifyFastSkill(repoRoot, snapshot) {
  if (!snapshot || snapshot.skill !== FAST_SKILL || !releases.has(snapshot.version))
    throw new Error('快速模式缺少有效的固定 skill 快照');
  const actual = await fastSkillSnapshot(repoRoot, snapshot.version);
  if (actual.sha256 !== snapshot.sha256) throw new Error('快速 skill 内容与排队时的快照不一致');
  return actual;
}

export function fastEntry(continued) {
  return [
    '## Selected C2V fast mode',
    `Before implementation, use Read to read .claude/skills/${FAST_SKILL}/SKILL.md in full.`,
    'Use its normal fast workflow (not strict_single_pass). Only this mounted skill applies to this submission; do not load old or generic creative/review skills from conversation memory.',
    'Produce one implementation, then render and batch technical validation. No aesthetic redesign or repeated quality-review loop. Only if no playable output exists, allow at most one local technical repair.',
    ...(continued ? ['This is a scoped follow-up: reuse existing source/assets, change only the user-requested scope, with at most one local implementation and one technical repair. Do not restart the whole film or revisit old quality issues.'] : []),
    'Five minutes is a soft measurement target, not a forced stop or a guaranteed runtime. Report remaining limitations honestly.',
    '', '## User request', '',
  ].join('\n');
}
