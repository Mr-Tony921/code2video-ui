import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 会话名额必须反映真实占用，且终结后立刻释放给排队任务。
 *
 * 1.3.8 之前：`activeSessions` 是只有 add、没有 delete 的 Set ——
 * 名额只增不减，只能靠重启 bridge 清零。满了之后新建会话报
 * 503 PROCESS_UNAVAILABLE，而任务槽往往是空的（线上实测 73 个 ACTIVE 会话、
 * 每台 13~17 个，远超 max_sessions=8）。对用户就是"机器闲着却建不了新对话"。
 *
 * 释放判据【复用】"对话结束才展示视频"那一套：store.isTerminal(status)。
 * 成功 / 失败 / 用户停止，三条路径统一处理。
 * ★ 新建会话【不是】释放条件 —— 产品支持多 session 并行体验。
 */
import { readFileSync } from 'node:fs';
const R=TEST_REPO_ROOT;
const sup=readFileSync(`${R}/apps/worker-bridge/src/supervisor.mjs`,'utf8');
const srv=readFileSync(`${R}/apps/gateway/src/server.mjs`,'utf8');
const bsv=readFileSync(`${R}/apps/worker-bridge/src/server.mjs`,'utf8');
const wd =readFileSync(`${R}/apps/gateway/src/watchdog.mjs`,'utf8');
const bc =readFileSync(`${R}/apps/gateway/src/bridge-client.mjs`,'utf8');
let pass=0,fail=0;
const t=(n,c,e='')=>{c?(pass++,console.log('  ✅',n,e)):(fail++,console.log('  ❌',n,e));};

console.log('— 名额可增可减 —');
t('不再是裸 Set（只增不减）', !/export const activeSessions = new Set\(\);/.test(sup));
t('改为带时间戳的 Map', /const sessionSeen = new Map\(\)/.test(sup));
t('有 releaseSession（显式释放）', /export function releaseSession/.test(sup));
t('有 TTL 回收兜底', /sweepSessions|SESSION_TTL_MS/.test(sup));
t('有 touchSession（用户回来重新计入）', /export function touchSession/.test(sup));

console.log('\n— 释放判据复用 isTerminal —');
t('★ 终结后检查会话是否还有活', /maybeReleaseIdleSession/.test(srv));
t('★ 判据是 store.isTerminal（与展示视频同一套）',
  /siblings\.some\(\(x\) => !store\.isTerminal\(x\.status\)\)/.test(srv));
t('三个终结点都挂了（成功/失败/停止）',
  (srv.match(/void maybeReleaseIdleSession\(j\);/g) || []).length === 3,
  `${(srv.match(/void maybeReleaseIdleSession\(j\);/g)||[]).length} 处`);
t('bridge 提供 DELETE /sessions/:id', /'DELETE \/sessions\/:id'/.test(bsv));
t('bridge-client 有 releaseSession', /releaseSession:/.test(bc));

console.log('\n— 多 session 并行不受影响 —');
t('★ 新建会话【不】释放旧会话',
  !/POST \/api\/sessions[\s\S]{0,2000}releaseSession/.test(srv)
  && /绝不能在"用户新建会话"时释放旧会话/.test(srv));

console.log('\n— 槽位腾出后立刻出队（不让排队的白等）—');
t('三个终结点都唤醒 dispatcher',
  (srv.match(/dispatcher\.tick\(\)\.catch\(\(\) => \{\}\);\n    \/\/ 会话名额/g) || []).length === 3,
  `${(srv.match(/槽位一腾出来就立刻出队/g)||[]).length} 处注释`);
t('watchdog 的 releaseSlot 也会唤醒', /this\.onSlotFreed\?\.\(\)/.test(wd));
t('watchdog 实例接上了回调', /onSlotFreed: \(\) => dispatcher\.tick\(\)/.test(srv));

console.log('\n— 未鉴权请求不得占名额（1.3.10 修，报告 BUG-session-slot-unauth-touch）—');
// 鉴权必须出现在 touchSession 之前
const authIdx = bsv.indexOf('PUBLIC_ROUTES.has');
const touchIdx = bsv.indexOf('sup.touchSession(params.id)');
t('★ 分发层先鉴权、后打点', authIdx > 0 && touchIdx > authIdx,
  `auth@${authIdx} touch@${touchIdx}`);
t('/health 仍在免鉴权白名单（监控要用）', /PUBLIC_ROUTES = new Set\(\['GET \/health'\]\)/.test(bsv));
t('DELETE /sessions/:id 不先 touch（否则 released 永远 true）',
  /const isRelease = req\.method === 'DELETE'[\s\S]{0,120}!isRelease/.test(bsv));
t('★ touchSession 只刷新已有，不凭空创建',
  /export function touchSession[\s\S]{0,200}sessionSeen\.has\(sessionId\)/.test(sup));
t('占名额只走 registerSession 一个入口', /export function registerSession/.test(sup));
t('兼容壳 add 指向 registerSession（否则建会话登记不上）',
  /add: \(sid\) => \{ registerSession\(sid\); return activeSessions; \}/.test(sup));
t('派任务用 registerSession（bridge 重启后老会话才不会漏算）',
  /if \(b\.session_id\) sup\.registerSession\(b\.session_id\)/.test(bsv));
t('认领在跑任务时重新登记会话（否则超卖）',
  /if \(sc\?\.session_id\) sup\.registerSession\(sc\.session_id\)/.test(bsv));

console.log(`\n══ 通过 ${pass}，失败 ${fail} ══`);
process.exit(fail?1:0);
