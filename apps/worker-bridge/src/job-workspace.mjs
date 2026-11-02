/**
 * 会话工作区 + 按轮次的簿记目录。
 *
 * ★ 1.4.0：续跑改为 cc --resume，工作区从「每轮一个」改为「同会话各轮共用」。
 *
 *   runtime/sessions/<sid>/workspace/        ← agent 的工作区，**各轮共用**
 *     .claude/skills/        按 mode 挂的一组独立 skill（每轮重刷）
 *     node_modules -> /opt/videokit/node_modules
 *     assets/                从 session 的 references/ 硬链接或拷入
 *     src/  output/  work/   agent 的产出 —— 续跑时原位保留，不再拷贝
 *     .tmp/                  隔离后成为 /tmp
 *     .home/                 agent 的 HOME；cc 的会话落在
 *                            .home/.claude/projects/-workspace/<cc_session_id>.jsonl
 *                            各轮共用它，`cc --resume` 才找得到上一轮的对话
 *     claude.jsonl           执行轨迹，各轮**追加**到同一个文件
 *
 *   runtime/sessions/<sid>/rounds/<jid>/     ← 我们按轮次的记录
 *     prompt.md  _meta.json
 *     .done | .failed | .cancelled | .aborted
 *     .running.json  .cc-session
 *     final.mp4              本轮成片的「钉住」副本（见 job-paths.pinnedAssetPath）
 *
 * 为什么不再「每轮一个自包含目录」：
 *   · 用户要求续跑不要拷贝视频与输入 —— 共用工作区后文件天然原位。
 *   · cc 的会话存储在 .home 下，共用它是 `--resume` 成立的前提。
 * 为什么簿记仍按轮次：标记/边车/成片若共用，第 2 轮会覆盖第 1 轮，
 *   认领对账全乱、早先的成片再也播不出来。
 *
 * 1.3.x 的老会话只有 `jobs/<jid>/`（工作区与簿记合一），由
 * `job-paths.resolveJobPaths` 回退处理 —— 历史任务仍可读可播。
 */
import { mkdir, writeFile, cp, rm, readdir, symlink, link, copyFile, stat } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { config } from './config.mjs';
import { sessionDir, referencesDir } from './session-workspace.mjs';
import {
  resolveJobPaths, ccSessionIdFor, findCcSessionFile,
  newestLegacyRound, recordedCcSessionId, lastRoundBlewContext,
} from './job-paths.mjs';


/** mode → skillset 源目录 */
function skillsetSrc(mode) {
  const name = config.skills.byMode[mode];
  if (!name) throw new Error(`[job-ws] 未知 mode: ${mode}`);
  const src = join(config.skills.skillsetsRoot, name);
  if (!existsSync(src)) throw new Error(`[job-ws] skillset 不存在: ${src}`);
  return { name, src };
}

/**
 * Output contract —— 告诉 agent 交付到哪、环境里有什么。
 * 路径全部来自实际工作区，不写死（同事的模板里是 /root/videobench/... 硬编码）。
 */
function buildOutputContract({ wsDir, hasAssets, skills, mode }) {
  // ★ wsDir 必须是 agent 在自己视图里看到的路径。
  // 隔离开启时工作区 bind 到浅路径 /workspace，宿主的 /mnt/... 路径在隔离内被遮蔽，
  // 写进 contract 会让 agent 找不到目录、转而乱探查文件系统（实测发生过）。
  const venv = config.videokit?.venvPython;
  const lines = [
    '',
    '## Output contract',
    '',
    `- Your project folder is \`${wsDir}\` (the current directory). Put all source code you write under \`${wsDir}/src/\`.`,
    `- Save the finished video at **\`${wsDir}/output/final.mp4\`**; that file is the deliverable.`,
  ];
  if (hasAssets) {
    lines.push('- Input files supplied by the user are in `./assets/`. Reference them by these exact paths.');
  }
  lines.push(
    '',
    '## Environment',
    '',
    '- Linux. Installed: `ffmpeg`/`ffprobe`, Node 22, LaTeX for manim `MathTex`, Noto CJK fonts.',
    venv
      ? `- Python with \`manim\`, \`numpy\`, \`scipy\`, \`pillow\`, \`opencv-python-headless\`, \`matplotlib\`, \`soundfile\`, \`librosa\`, \`edge-tts\` (online TTS) and \`faster-whisper\` (\`base.en\` and \`small\` already downloaded, they load offline by name): use \`${venv}\`.`
      : '- Python 3 is available; check for packages before relying on them.',
    '- `./node_modules` already contains `three`, `gsap`, `roughjs`, `p5`, `@napi-rs/canvas`, `playwright` and `puppeteer`. Import these local copies; do not load libraries from CDNs.',
  );
  if (config.runtimeBinaries.chromeBin) {
    lines.push(
      `- A headless Chrome is at \`${config.runtimeBinaries.chromeBin}\` and \`CHROME_BIN\` points to it. ` +
      'Pass it as `executablePath` to puppeteer/playwright, and always launch with ' +
      '`--no-sandbox --disable-gpu --disable-dev-shm-usage`.',
    );
  }
  if (skills?.length) {
    lines.push(
      '- Project skills for code-to-video work are available through the Skill tool (their files are in ' +
      '`./.claude/skills/`). Start by loading `code-video-core`, then load the craft skills that fit this brief.',
    );
  }

  // 「Context budget (hard limit)」那一节已按用户要求移除（1.3.9）。
  //
  // 它原本是为一个真实事故加的：某任务把 17 张 jpg 读回上下文（单张最大 30 万字符
  // ≈10 万 token），57 分钟后以 "Prompt is too long" 失败、产物全丢。
  // 但实测反馈这段硬约束把成片质量带下来了 —— 禁止看帧之后，agent 只能靠
  // 数值自检，画面问题发现不了。用户判断：质量优先，宁可承担偶发的上下文耗尽。
  //
  // 如果以后要再加回来，别用「Never Read a frame」这种一刀切写法；
  // 可行的方向是只限制【张数与分辨率】（例如允许抽检 1~2 张缩略图），
  // 原文见 git 历史与 /tmp/cvw-codex-tests/devtest/job-workspace.139.bak。
  // 上下文真的爆了还有兜底：claude 会自动压缩（HOME 指向 .home 后压缩可用，见 1.2.0）。
  // ★ 按前端 mode 显式触发白模（用户明确要求）
  if (mode === 'blockout_3d' && skills?.includes(config.skills.whiteboxSkillName)) {
    lines.push(
      '',
      '## Mode: 3D Blockout (whitebox previs)',
      '',
      `- The user selected **3D Blockout** mode. Load the \`${config.skills.whiteboxSkillName}\` skill and follow it.`,
      '- Deliver a simplified 3D scene study: untextured grey primitives, for exploring spatial staging, ' +
      'actor or vehicle movement, action timing, shot composition and camera choreography.',
      '- Default to no audio and modest resolution unless the user asked otherwise. ' +
      'Explicit user requirements in the brief take precedence over these defaults.',
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * 准备 job 工作区。幂等：重复调用会重建 skill 与 prompt，保留已有产出。
 */
/**
 * 微调轮要告诉 agent：这不是新任务，上一版的东西都在手边。
 * 写得具体一点 —— 只说「这是修改」它仍可能推倒重来。
 */
/**
 * 续跑轮次要加在 prompt 前面的说明。
 *
 * 1.4.0 起 agent 是用 `cc --resume` 起的，上一轮的对话它自己记得，
 * 工作区也是同一个 —— 所以这里**不要再罗列**「上一版在 previous/、源码在 src/」那套：
 * 那是拷贝时代的说法，现在既冗余又容易让 agent 以为文件是副本而不是它自己写的。
 * 只需要点明三件它可能判断错的事：这是同一个工作区、要做最小改动、交付位置不变。
 */
function buildRevisionNote() {
  return [
    '',
    '## This continues the same piece of work',
    '',
    'You are resuming the same session, in the same working directory. Every file you',
    'wrote earlier is still exactly where you left it — nothing was copied or reset.',
    'Inspect the current state on disk rather than assuming it matches your memory.',
    '',
    'The request above is a change to the video you already delivered. Make the smallest',
    'change that satisfies it, and keep everything the user did not ask you to change',
    '— same style, timing, framing and sound — so the result reads as the same video, edited.',
    'Deliver to `output/final.mp4` as usual (it will be archived per round, so overwriting it is fine).',
    '',
  ].join('\n');
}

export async function prepareJobWorkspace({ sessionId, jobId, mode, prompt, agentWsPath }) {
  const { agentWs, bookDir, legacy } = resolveJobPaths(sessionId, jobId);
  const ws = agentWs;
  // agent 视图里的工作区路径：隔离开启时是浅挂载点，否则就是宿主真实路径
  const viewPath = agentWsPath ?? ws;
  const { name: skillsetName, src: skillsetPath } = skillsetSrc(mode);

  /**
   * 本轮是不是同一会话的后续轮次。
   *
   * 判据用 cc 的会话目录是否已有内容 —— 它才是 `--resume` 真正依赖的东西。
   * 不用「workspace 目录是否存在」：目录可能是上一轮刚建好就失败了，
   * 那种情况没有可 resume 的会话，当成首轮处理才对。
   */
  /**
   * 1.3.x 老会话的一次性迁移。
   *
   * 老会话只有 jobs/<旧jid>/，没有 workspace/。不迁移的话新一轮会拿到一个
   * 全新的空工作区 —— 既不 resume 也看不到上一轮的 src/，而拷贝继承已被删掉，
   * 于是「续写老对话 = 从零重做」，比 1.3.x 还差（详见 job-paths.newestLegacyRound）。
   *
   * 只在 workspace/ 还不存在时做一次；之后这个会话就是标准的新布局。
   * 搬 src/ 让 agent 看得到上一轮的代码；搬 .home 让 cc 的会话文件也在位，
   * 于是老对话连「记得上一轮聊过什么」都能恢复。
   * 任何一步失败都只是降级（回到从零重做），绝不让本轮启动失败。
   */
  let migratedCcId = null;
  if (!legacy && !existsSync(ws)) {
    const prev = newestLegacyRound(sessionId);
    if (prev) {
      try {
        await mkdir(ws, { recursive: true });
        const prevSrc = join(prev.dir, 'src');
        if (existsSync(prevSrc)) await cp(prevSrc, join(ws, 'src'), { recursive: true, force: true });
        const prevHome = join(prev.dir, '.home');
        if (existsSync(prevHome)) await cp(prevHome, join(ws, '.home'), { recursive: true, force: true });
        migratedCcId = recordedCcSessionId(prev.dir);
        console.log(`[job-ws] 会话 ${sessionId} 从 1.3.x 迁移：基准轮 ${prev.jobId}`
          + ` src=${existsSync(prevSrc)} home=${existsSync(prevHome)} ccId=${migratedCcId ?? '无'}`);
      } catch (e) {
        console.warn(`[job-ws] 会话 ${sessionId} 迁移失败（本轮按全新处理）: ${e.message}`);
      }
    }
  }

  /**
   * 本轮用哪个 cc 会话。
   *
   * 优先我们自己的会话 id（1.4.0 起首轮就是用它建的，`cc 会话 id ≡ 会话 id`）。
   * 老会话迁移过来的那份是 cc 当初自己生成的 id，和我们的会话 id 不一样，
   * 所以要退回读它的 .cc-session —— 不然老对话的记忆白搬了。
   * 两者都要【确认会话文件真的在】才敢 resume：带着不存在的 id 去 --resume
   * 会让 cc 直接启动失败、整轮白丢。
   */
  const ownCcId = ccSessionIdFor(sessionId);
  let ccSessionId = ownCcId;
  let ccFile = findCcSessionFile(ws, ownCcId);
  if (!ccFile && migratedCcId) {
    const f = findCcSessionFile(ws, migratedCcId);
    if (f) { ccSessionId = migratedCcId; ccFile = f; }
  }
  /**
   * 上一轮因上下文耗尽失败 ⇒ 放弃 resume。
   * 把一个已经溢出的上下文接回来，新一轮只会立刻再爆，用户反复重试都出不来。
   * 文件仍在原位，所以不是从零重做，只是没有对话记忆。
   */
  const blew = lastRoundBlewContext(sessionId);
  if (blew && ccFile) {
    console.warn(`[job-ws] 会话 ${sessionId} 上一轮因上下文耗尽失败 → 本轮不 resume（文件仍在原位）`);
  }
  const isContinuation = !!ccFile && !blew;

  // .home：agent 的 HOME（见 job-runner 的 buildChildEnv）。
  // 必须预建 —— 隔离里 /mnt 被遮蔽，claude 自动压缩上下文时要往 HOME 写会话文件，
  // 写不了就报 ENOSPC 并整个失败（线上实测 job_356f7a34 因此丢了 47 分钟的工作）。
  //
  // ★ recursive:true 对已存在的目录是幂等的 —— 续跑时只补缺失的，
  //   绝不清空：src/ build/ output/ 里是上一轮的成果，清了就等于回到拷贝时代。
  for (const d of ['src', 'output', 'work', '.tmp',
                   '.home', '.home/.claude', '.home/.config', '.home/.cache']) {
    await mkdir(join(ws, d), { recursive: true });
  }
  // 本轮的簿记目录（legacy 会话里它与工作区同一个，mkdir 幂等）
  await mkdir(bookDir, { recursive: true });

  // 整组 skill：每次重建，确保与 mode 严格对应
  const skillTarget = join(ws, '.claude', 'skills');
  await rm(skillTarget, { recursive: true, force: true });
  await mkdir(skillTarget, { recursive: true });
  await cp(skillsetPath, skillTarget, { recursive: true });
  const skills = (await readdir(skillTarget, { withFileTypes: true }))
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();

  // node_modules → videokit（symlink，不拷贝几百 MB）
  const nm = join(ws, 'node_modules');
  const kit = config.videokit?.nodeModules;
  if (kit && existsSync(kit) && !existsSync(nm)) {
    try { await symlink(kit, nm, 'dir'); }
    catch (e) { if (e.code !== 'EEXIST') console.warn(`[job-ws] node_modules 链接失败: ${e.message}`); }
  }

  // Reference 附件：从 session 的 references/ 复制进 assets/
  // 硬链接优先（省空间且同文件系统），失败回退复制
  const refs = referencesDir(sessionId);
  const assetsDir = join(ws, 'assets');
  let assetFiles = [];
  if (existsSync(refs)) {
    const names = (await readdir(refs, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name !== 'manifest.json')
      .map((e) => e.name);
    if (names.length) {
      await mkdir(assetsDir, { recursive: true });
      for (const n of names) {
        const srcF = join(refs, n);
        const dstF = join(assetsDir, n);
        if (existsSync(dstF)) { assetFiles.push(n); continue; }
        try { await link(srcF, dstF); }
        catch { await copyFile(srcF, dstF); }
        assetFiles.push(n);
      }
    }
  }

  /**
   * 续跑（多轮）：**什么都不拷**。
   *
   * 1.3.x 的做法是把上一轮的 src/ 拷进来、成片放 previous/、SPEC.md 改名 SPEC.prev.md。
   * 1.4.0 改成同一会话各轮共用这个工作区，所以上一轮的文件本来就在原位 ——
   * 拷贝不但多余，还会和 cc --resume 的记忆打架：
   * cc 记得自己写过 `src/main.js`，那个文件就应该是它写的那一份，不是副本。
   *
   * 这里只需要判断「是不是后续轮次」，交给 job-runner 决定是否带 --resume。
   */
  const revision = isContinuation ? { continued: true } : null;
  if (isContinuation) {
    console.log(`[job-ws] job ${jobId} 续跑：复用会话工作区 ${ws}（不拷贝，文件原位）`);
  }

  // prompt.md = 增强后的 prompt + 微调上下文 + output contract
  const contract = buildOutputContract({
    wsDir: viewPath, hasAssets: assetFiles.length > 0, skills, mode,
  });
  const revisionNote = revision ? buildRevisionNote() : '';
  // ★ prompt.md 与 _meta.json 落【本轮簿记目录】，不落共享工作区 ——
  //   共享的话第 2 轮会把第 1 轮的 prompt 覆盖掉，排障时查不到当轮提交了什么。
  const promptPath = join(bookDir, 'prompt.md');
  await writeFile(promptPath, `${prompt.trim()}\n${revisionNote}${contract}`, 'utf8');

  await writeFile(join(bookDir, '_meta.json'), JSON.stringify({
    session_id: sessionId, job_id: jobId, mode,
    skillset: skillsetName, skills,
    assets: assetFiles,
    node_modules: kit ?? null,
    host_path: ws,
    book_dir: bookDir,
    legacy_layout: legacy,
    continued: isContinuation,
    cc_session_id: ccSessionId,
    cc_session_file: ccFile,
    agent_view_path: viewPath,
    prepared_at: new Date().toISOString(),
  }, null, 2), 'utf8');

  return {
    ws, bookDir, legacy, isContinuation, ccSessionId,
    viewPath, skillsetName, skills, promptPath, assetFiles, assetsDir,
  };
}

/** 权限审计：工作区挂的 skill 是否与 mode 相符 */
export function verifyJobIsolation(sessionId, jobId, mode) {
  // ★ 1.4.0：skill 挂在【会话工作区】下，不再是每轮目录。
  //   不跟着改的话这条权限审计会查到空目录，把正常任务判成「缺 skill」。
  const { agentWs } = resolveJobPaths(sessionId, jobId);
  const skillTarget = join(agentWs, '.claude', 'skills');
  const wb = config.skills.whiteboxSkillName;
  const hasWhitebox = existsSync(join(skillTarget, wb, 'SKILL.md'));
  let skills = [];
  try {
    skills = readdirSync(skillTarget, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {}
  return {
    ok: hasWhitebox === (mode === 'blockout_3d'),
    mode, has_whitebox: hasWhitebox,
    should_have_whitebox: mode === 'blockout_3d',
    skills, skill_count: skills.length,
  };
}
