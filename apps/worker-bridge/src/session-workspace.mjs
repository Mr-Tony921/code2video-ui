/**
 * Session 工作区准备。
 *
 * 关键设计：按 mode 挂载【物理隔离】的 skill 目录。
 * 无白模权限的用户，其 session 工作区里根本没有 whitebox 文件，
 * 因此模型即使想用也拿不到——权限由文件系统保证，不靠关键词过滤。
 */
import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { resolveExperimentalModel, validateBuiltinSkills } from '../../shared/experimental.mjs';

export function sessionDir(sessionId) {
  // 会话数据走 sessionsRoot（存储充足的卷），不再和控制面挤在 runtime/ 下
  return join(config.storage.sessionsRoot, config.storage.sessionsSubdir, sessionId);
}



/**
 * mode → 要挂载的 skillset 目录（内含多个独立 skill）。
 * 未知 mode 直接报错，不静默降级为"少挂几个"。
 */
export function skillsetForMode(mode) {
  const name = config.skills.byMode[mode];
  if (!name) throw new Error(`[workspace] 未知 mode: ${mode}`);
  const src = join(config.skills.skillsetsRoot, name);
  if (!existsSync(src)) throw new Error(`[workspace] skillset 目录不存在: ${src}`);
  return { name, src };
}

/**
 * 写 claude CLI 的 settings 文件。
 * 模型地址、API key、代理全部来自配置，不硬编码。
 */
function buildSettings(model = config.model) {
  const { proxy } = config;
  return {
    env: {
      ANTHROPIC_BASE_URL: model.baseUrl,
      ANTHROPIC_MODEL: model.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model.model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ...(model.maxContextTokens ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: model.maxContextTokens } : {}),
      HTTP_PROXY: proxy.http_proxy,
      HTTPS_PROXY: proxy.http_proxy,
      http_proxy: proxy.http_proxy,
      https_proxy: proxy.http_proxy,
      NO_PROXY: proxy.no_proxy,
      no_proxy: proxy.no_proxy,
      ...(config.runtimeBinaries.chromeBin ? { CHROME_BIN: config.runtimeBinaries.chromeBin } : {}),
      ...(config.runtimeBinaries.previsDependencyRoot
        ? { PREVIS_DEPENDENCY_ROOT: config.runtimeBinaries.previsDependencyRoot }
        : {}),
    },
    model: model.model,
    permissions: { defaultMode: config.claudeCli.permissionMode },
  };
}

/**
 * 创建 session 工作区：目录 + 隔离的 skill + settings。
 * 幂等：同一 sessionId 重复调用不会破坏已有内容。
 */
export async function prepareSessionWorkspace({ sessionId, mode, modelSelection, builtinSkills }) {
  const dir = sessionDir(sessionId);
  const builtin = mode === 'experimental' ? validateBuiltinSkills(builtinSkills) : mode;
  const { name: skillsetName, src } = builtin === 'none' ? { name: 'experimental-none', src: null } : skillsetForMode(builtin);
  const model = mode === 'experimental' ? resolveExperimentalModel(config.raw, modelSelection) : config.model;

  await mkdir(join(dir, 'jobs'), { recursive: true });
  await mkdir(join(dir, 'references'), { recursive: true });   // Reference 附件（V2）
  await mkdir(join(dir, '.claude'), { recursive: true });

  // session 级也挂一份 skill：便于 /sessions/:id/isolation 做权限审计。
  // 真正给 agent 用的是 job 级工作区里那份（见 job-workspace.mjs）。
  const skillTarget = join(dir, config.skills.targetDirInSession);
  await rm(skillTarget, { recursive: true, force: true });
  await mkdir(skillTarget, { recursive: true });
  if (src) await cp(src, skillTarget, { recursive: true });

  const { readdir } = await import('node:fs/promises');
  const skills = (await readdir(skillTarget, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const settingsPath = join(dir, config.claudeCli.settingsFileName);
  await writeFile(settingsPath, JSON.stringify(buildSettings(model), null, 2), 'utf8');

  return { dir, skillsetName, skillTarget, skills, settingsPath };
}

/**
 * 校验工作区挂的 skillset 与声明的 mode 一致 —— 权限审计与排障用。
 * blockout_3d 才应有 whitebox-previs 这个 skill 目录。
 */
export function verifySkillIsolation(sessionId, mode) {
  const skillTarget = join(sessionDir(sessionId), config.skills.targetDirInSession);
  const wbName = config.skills.whiteboxSkillName;
  const hasWhitebox = existsSync(join(skillTarget, wbName, 'SKILL.md'));
  const shouldHaveWhitebox = mode === 'experimental' ? hasWhitebox : mode === 'blockout_3d';
  let skills = [];
  try {
    skills = readdirSync(skillTarget, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { /* 目录还不存在 */ }
  return {
    ok: hasWhitebox === shouldHaveWhitebox,
    mode,
    has_whitebox: hasWhitebox,
    should_have_whitebox: shouldHaveWhitebox,
    skills,
    skill_count: skills.length,
    skill_dir: skillTarget,
  };
}

/** Reference 附件目录 */
export function referencesDir(sessionId) {
  return join(sessionDir(sessionId), 'references');
}
