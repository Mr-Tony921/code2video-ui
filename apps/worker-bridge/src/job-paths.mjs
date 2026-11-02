/**
 * 任务与会话的落盘路径。
 *
 * ★ 1.4.0 的布局变更（续跑改为 cc --resume）
 *
 * 1.3.x：每轮一个独立目录 `<sessions>/<sid>/jobs/<jobId>/`，既是 agent 的工作区，
 *        也放我们的簿记（.done / .running.json / output / claude.jsonl）。
 *        续跑靠把上一轮的 src/ 与成片【拷】进新目录。
 *
 * 1.4.0：拆成两块 ——
 *   `<sessions>/<sid>/workspace/`        agent 的工作区，**同一会话各轮共用**
 *                                        （src/ build/ output/ .home/ claude.jsonl）
 *   `<sessions>/<sid>/rounds/<jobId>/`   我们按轮次的记录
 *                                        （.done/.failed/.cancelled/.running.json/
 *                                          .cc-session/_meta.json/prompt.md/钉住的成片）
 *
 * 为什么这么拆：
 *   · 工作区共用 → agent 的文件原位保留，不需要拷贝（用户明确要求），
 *     且 `.home/.claude` 跟着共用，`cc --resume <id>` 才找得到上一轮的会话。
 *     （cc 按 cwd 推项目 slug，隔离里 cwd 恒为 /workspace，所以 slug 跨轮一致。）
 *   · 簿记仍按轮次 → `.done` 这类标记、边车、产物不会被下一轮覆盖。
 *     这一点如果偷懒共用，后果是：第 2 轮的 .done 盖掉第 1 轮的（认领与对账全乱），
 *     第 2 轮的 output/final.mp4 盖掉第 1 轮的成片（用户再也播不出早先那版）。
 *
 * 兼容：1.3.x 建的会话只有 `jobs/<jobId>/`。读历史任务时必须仍然能找到它们，
 * 所以每个解析函数都带 legacy 回退 —— 新会话走新布局，老会话照旧。
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionDir } from './session-workspace.mjs';

/** 1.3.x 的每轮独立目录。保留：历史任务仍要能读。 */
export function legacyJobDir(sessionId, jobId) {
  return join(sessionDir(sessionId), 'jobs', jobId);
}

/** agent 的工作区：同一会话各轮共用。 */
export function sessionWorkspaceDir(sessionId) {
  return join(sessionDir(sessionId), 'workspace');
}

/** 本轮的簿记目录。 */
export function roundDir(sessionId, jobId) {
  return join(sessionDir(sessionId), 'rounds', jobId);
}

/**
 * 解析某个 job 实际的工作区与簿记目录。
 *
 * 新会话：workspace/ + rounds/<jobId>/
 * 老会话（1.3.x）：两者都是 jobs/<jobId>/
 *
 * 判据用「legacy 目录存在且新布局不存在」—— 不能只看 legacy 是否存在，
 * 否则同一会话从 1.3.x 升到 1.4.0 后会一直被判成 legacy。
 */
export function resolveJobPaths(sessionId, jobId) {
  const ws = sessionWorkspaceDir(sessionId);
  const rd = roundDir(sessionId, jobId);
  const legacy = legacyJobDir(sessionId, jobId);
  if (!existsSync(ws) && !existsSync(rd) && existsSync(legacy)) {
    return { agentWs: legacy, bookDir: legacy, legacy: true };
  }
  return { agentWs: ws, bookDir: rd, legacy: false };
}

/**
 * 本轮成片的「钉住」位置。
 *
 * agent 始终按 output contract 写 `output/final.mp4`（契约不变，agent 侧零感知），
 * 但工作区是共用的 —— 下一轮会把它覆盖。所以收尾时把成片硬链到这里，
 * 并把【这个】路径记成 result_asset.storage_path，于是每轮的交付物不可变。
 * 硬链同文件系统不额外占空间；跨设备失败时调用方退回复制。
 */
export function pinnedAssetPath(bookDir, ext = 'mp4') {
  return join(bookDir, `final.${ext}`);
}

/**
 * 清残留用的进程标识。
 *
 * ★ 必须每轮唯一。1.3.x 用的是工作区路径，工作区一共用就各轮相同 ——
 * 那样 isSidecarProcessAlive 的防 pid 复用校验会失效：
 * 上一轮残留的进程会被认成本轮的（环境里 token 一模一样）。
 * 所以带上 jobId。
 */
export function jobToken(agentWs, jobId) {
  return `${agentWs}#${jobId}`;
}

/** 轨迹与 stderr：跟工作区走，各轮追加到同一个文件（用户要求"接着之前的轨迹显示"）。 */
export function trajectoryPath(agentWs) { return join(agentWs, 'claude.jsonl'); }
export function stderrPath(agentWs) { return join(agentWs, 'claude.stderr'); }

/**
 * 本会话对应的 cc 会话 id。
 *
 * 取我们自己会话 id 里的 uuid 部分（`sess_<uuid>` → `<uuid>`），于是
 * **cc 会话 id ≡ 我们的会话 id**：排障时一眼对得上，不必再去解析 .cc-session，
 * 也不会出现「同一个对话有多个 cc 会话」的歧义。
 *
 * `--session-id` 要求合法 uuid，形状不符就返回 null —— 调用方据此退回
 * 「不指定 id、也不 resume」的 1.3.x 行为，而不是硬塞一个非法值让 cc 启动失败。
 */
export function ccSessionIdFor(sessionId) {
  const m = /^sess_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    .exec(String(sessionId ?? ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * cc 的会话文件在不在。
 *
 * ★ resume 前必须先查 —— 文件不在就带 `--resume` 的话 cc 会直接启动失败，
 * 整轮任务白丢。查到才 resume，查不到就当首轮，这是「失败退化」的主路径。
 *
 * 不写死 `projects/-workspace/`：隔离不可用时 cwd 是宿主路径，slug 会不同，
 * 所以在所有 projects/* 下找 `<ccId>.jsonl`。
 */
export function findCcSessionFile(agentWs, ccId) {
  if (!agentWs || !ccId) return null;
  const root = join(agentWs, '.home', '.claude', 'projects');
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch { return null; }
  for (const d of dirs) {
    const f = join(root, d.name, `${ccId}.jsonl`);
    try { if (statSync(f).size > 0) return f; } catch { /* 下一个 */ }
  }
  return null;
}

/**
 * 找出 1.3.x 老会话里最值得作为「续写基准」的那一轮。
 *
 * ★ 为什么需要它（1.4.0 的回归，必须修）：
 *   老会话只有 `jobs/<旧jid>/`、没有 `workspace/`。提交新一轮时
 *   `resolveJobPaths` 查的是 `jobs/<【新】jid>` —— 那个当然不存在，
 *   于是判定走新布局，给出一个**全新的空 workspace/**。
 *   而 1.4.0 已经删掉了拷贝继承，结果是：
 *   既不 resume、也看不到上一轮的 src/ ⇒ **续写老对话等于从零重做**，
 *   比 1.3.x（至少会拷 src/ 和上一版成片）还差。
 *   线上刚同步 1.4.0，存量对话全部受影响，所以不能只靠「以后的新会话没问题」。
 *
 * 选法：优先取有 `.done`（真出过片）的那一轮里最新的；
 * 都没有就退回按 mtime 最新的 —— 失败的那一轮里也可能有值得接着改的代码。
 */
export function newestLegacyRound(sessionId) {
  const jobsRoot = join(sessionDir(sessionId), 'jobs');
  let names;
  try { names = readdirSync(jobsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch { return null; }
  const cands = [];
  for (const e of names) {
    const d = join(jobsRoot, e.name);
    let mt = 0;
    try { mt = statSync(d).mtimeMs; } catch { continue }
    cands.push({ dir: d, jobId: e.name, done: existsSync(join(d, '.done')), mt });
  }
  if (!cands.length) return null;
  const done = cands.filter((c) => c.done);
  const pool = done.length ? done : cands;
  pool.sort((a, b) => b.mt - a.mt);
  return pool[0];
}

/** 读某一轮记录的 cc 会话 id（老会话的 id 不等于我们的会话 id，必须从这里取）。 */
export function recordedCcSessionId(bookDir) {
  try {
    const v = JSON.parse(readFileSync(join(bookDir, '.cc-session'), 'utf8')).cc_session_id;
    return typeof v === 'string' && v ? v : null;
  } catch { return null; }
}

/**
 * 最近结束的那一轮是不是「上下文耗尽」失败的。
 *
 * ★ 为什么要查：resume 会把上一轮的对话整个接回来。如果上一轮正是因为
 *   上下文爆了而失败（E_TASK_TOO_COMPLEX），那么 resume 的起点就已经是
 *   一个溢出的上下文 —— 新一轮必然立刻再失败，用户反复重试都出不来，
 *   而且看不出原因。这种情况要放弃 resume、从干净上下文重开。
 *   （上一轮的文件仍在原位，所以不是从零重做。）
 */
export function lastRoundBlewContext(sessionId) {
  const roundsRoot = join(sessionDir(sessionId), 'rounds');
  let dirs;
  try { dirs = readdirSync(roundsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch { return false; }
  let newest = null;
  for (const e of dirs) {
    for (const m of ['.done', '.failed', '.cancelled', '.aborted']) {
      const f = join(roundsRoot, e.name, m);
      let mt;
      try { mt = statSync(f).mtimeMs; } catch { continue }
      if (!newest || mt > newest.mt) newest = { mt, marker: m, file: f };
    }
  }
  if (!newest || newest.marker !== '.failed') return false;
  try {
    const meta = JSON.parse(readFileSync(newest.file, 'utf8'));
    return meta.code === 'E_TASK_TOO_COMPLEX';
  } catch { return false; }
}
