/**
 * Bridge 启动时认领上一个实例留下的任务（热更新的核心）。
 *
 * 背景：cc 的 stdout 直接写文件，Bridge 退出不会带走它（实测：管道模式下
 * 父进程一退出子进程立刻被 SIGPIPE 杀掉，改文件则无限存活）。
 * 所以 Bridge 重启后，那些 cc 进程还在算 —— 只是没人看着它们。
 * 本模块把它们重新接管起来。
 *
 * 必须在 supervisor.register() 【之前】跑完：注册请求要带上认领到的 job 列表，
 * Gateway 据此改绑任务与租约持有者。晚一步，这些任务就会在第一次心跳的
 * 归属校验里被判成「不属于此实例」而遭 abort。
 *
 * ★ 容错原则：认领是「锦上添花」，绝不能把 Bridge 拖垮。
 * 单条记录的任何异常都就地吞掉并跳过 —— 一条坏数据不能让其它健康任务
 * 漏掉认领（漏掉就没人看着，也就永远写不出 .done，用户永远看到「进行中」）。
 */
import { readdir, readFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import * as runner from './job-runner.mjs';

const TERMINAL_MARKERS = [
  ['.done', 'completed'],
  ['.cancelled', 'cancelled'],
  ['.failed', 'failed'],
  ['.aborted', 'failed'],
];

/** 边车必须具备的字段。缺一个就不认领。 */
const REQUIRED = ['job_id', 'session_id', 'job_dir', 'log_path', 'pid'];

const indexDir = () => join(config.storage.root, 'bridge', config.worker.id, 'running');

/** 读边车。索引只是指针，真身在 job 目录里。返回 null 表示这条该丢弃。 */
async function readSidecar(indexFile) {
  const idx = JSON.parse(await readFile(indexFile, 'utf8'));
  if (!idx || typeof idx.job_dir !== 'string' || !idx.job_dir) return null;
  const scPath = join(idx.job_dir, '.running.json');
  if (!existsSync(scPath)) return null;
  const sc = JSON.parse(await readFile(scPath, 'utf8'));
  if (!sc || typeof sc !== 'object') return null;
  const missing = REQUIRED.filter((k) => sc[k] === undefined || sc[k] === null || sc[k] === '');
  if (missing.length) return null;                 // 字段不全，宁可不救
  if (!existsSync(sc.log_path)) return null;       // 轨迹都没了，无从恢复
  return sc;
}

async function dropIndex(indexFile) { await rm(indexFile, { force: true }).catch(() => {}); }

/** job 目录里是否已有终态标记（说明它在空窗期自己结束了）。 */
function terminalMarkerOf(jobDir) {
  for (const [name, status] of TERMINAL_MARKERS) {
    if (existsSync(join(jobDir, name))) return { name, status };
  }
  return null;
}

/** 安全地构造回调：hooksFor 自己抛了也不能连累认领。 */
function safeHooks(hooksFor, sc, log) {
  try { return hooksFor(sc.job_id, sc) ?? {}; }
  catch (e) {
    log.error(`[adopter] ${sc.job_id} 构造回调失败，用空回调继续: ${e.message}`);
    return {};
  }
}

/** 处理一条记录。任何异常由调用方兜住。 */
async function adoptOne(indexFile, label, hooksFor, log, out) {
  let sc = null;
  try {
    sc = await readSidecar(indexFile);
  } catch (e) {
    log.warn(`[adopter] ${label} 边车不可读，丢弃: ${e.message}`);
  }
  if (!sc) { await dropIndex(indexFile); out.skipped.push(label); return; }

  // ① 空窗期里已经自己结束了 → 不必认领，Gateway 的对账会读这些标记补判
  const marker = terminalMarkerOf(sc.job_dir);
  if (marker) {
    log.log(`[adopter] ${sc.job_id} 已有 ${marker.name}（${marker.status}），无需认领`);
    await dropIndex(indexFile);
    await rm(join(sc.job_dir, '.running.json'), { force: true }).catch(() => {});
    out.settled.push(sc.job_id);
    return;
  }

  // ② 进程还活着 → 接管
  if (runner.isSidecarProcessAlive(sc)) {
    try {
      const r = await runner.adoptJob(sc, safeHooks(hooksFor, sc, log));
      if (r.adopted) {
        log.log(`[adopter] ✅ 认领 ${sc.job_id}（pid=${sc.pid}，已重放 ${r.events} 条事件）`);
        out.adopted.push(sc.job_id);
      } else {
        out.skipped.push(sc.job_id);
      }
    } catch (e) {
      log.error(`[adopter] ${sc.job_id} 认领失败，留给 Gateway 对账: ${e.message}`);
      out.skipped.push(sc.job_id);
    }
    return;
  }

  // ③ 进程没了，也没有终态标记 → 它在空窗期里死了。
  //    必须主动收尾，否则用户永远看到「进行中」。
  log.warn(`[adopter] ${sc.job_id} 的进程（pid=${sc.pid}）已不在，补收尾`);
  try {
    await runner.settleDeadJob(sc, safeHooks(hooksFor, sc, log));
    out.dead.push(sc.job_id);
  } catch (e) {
    log.error(`[adopter] ${sc.job_id} 补收尾失败: ${e.message}`);
    out.skipped.push(sc.job_id);
  }
  await dropIndex(indexFile);
}

/**
 * @param hooksFor (jobId, sidecar) => hooks  —— 与 startJob 用的是同一套回调
 * @returns {adopted:[], settled:[], dead:[], skipped:[]}
 */
export async function adoptRunningJobs(hooksFor, log = console) {
  const out = { adopted: [], settled: [], dead: [], skipped: [] };
  let dir;
  try { dir = indexDir(); } catch (e) {
    log.error(`[adopter] 取索引目录失败，跳过认领: ${e.message}`);
    return out;
  }
  await mkdir(dir, { recursive: true }).catch(() => {});
  let files = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.json')); } catch { return out; }
  if (!files.length) return out;

  log.log(`[adopter] 发现 ${files.length} 条运行中记录，开始认领…`);

  for (const f of files) {
    try {
      await adoptOne(join(dir, f), f, hooksFor, log, out);
    } catch (e) {
      // 单条记录的任何意外都不中断整轮
      log.error(`[adopter] ${f} 处理异常，跳过该条: ${e.message}`);
      out.skipped.push(f);
    }
  }

  log.log(`[adopter] 认领完成：接管 ${out.adopted.length}，已终态 ${out.settled.length}，` +
    `补收尾 ${out.dead.length}，跳过 ${out.skipped.length}`);
  return out;
}
