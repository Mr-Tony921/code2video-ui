import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 「制作助手」与轨迹加载解耦的回归（1.4.1）。
 *
 * 用户要的是：切换对话时**默认不加载执行过程**，但制作助手照样有内容。
 * 这要求 last_assistant_text 必须活在 job 快照里 —— 它原来只活在 bridge 的内存
 * 与 .done 标记里，前端只能靠订阅整条 SSE 自己攒（品牌片任务 99975 行）。
 *
 * 这里守三件事，任一破了「默认折叠」就会退化成「制作助手空白」：
 *   1. stream-pump 在 assistant_text 分支里 patchJob，且**只在文本变化时**写
 *      （事件泵是热路径，每个事件都打盘会把所有在跑任务的过程框拖慢）；
 *      patchJob 失败只能告警，不能影响事件推送。
 *   2. /internal/jobs/:id/complete 不丢弃入参里的 last_assistant_text。
 *   3. publicJob 下发这个字段。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const R = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(R, p), 'utf8');
/** 去掉行注释与块注释 —— 否则注释里提到字段名会让断言假通过 */
// ★ 顺序很重要：**先去整行注释，再去块注释**。
//   反过来的话，注释里出现 `/api/*` 这种字样会被当成块注释开头，
//   一路吞到下一个 */ —— route.ts 第 92 行就有一条这样的整行注释，
//   导致它后面约 20 行（含 headers 构造与 accept-encoding 设置）在断言里凭空消失。
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

let pass = 0, fail = 0;
const t = (n, c, e = '') => { c ? (pass++, console.log('  ✅', n, e)) : (fail++, console.log('  ❌', n, e)); };

const pump = strip(read('apps/gateway/src/stream-pump.mjs'));
const srv = strip(read('apps/gateway/src/server.mjs'));
const ws = strip(read('apps/web/app/_workspace.tsx'));
const stream = strip(read('apps/web/features/useJobStream.ts'));

/* ── 1. stream-pump ── */
t('pump 里有 last_assistant_text 的 patchJob',
  /patchJob\([^)]*\{\s*last_assistant_text/.test(pump));
t('★ 只在文本变化时写（热路径不能每事件打盘）',
  /!==\s*job\.last_assistant_text/.test(pump));
t('★ patchJob 包在 try/catch 里（写失败不能挡事件推送）', (() => {
  const i = pump.indexOf('last_assistant_text');
  if (i < 0) return false;
  const around = pump.slice(Math.max(0, i - 400), i + 400);
  return /try\s*\{/.test(around) && /catch/.test(around);
})());
t('取的是这批里的最后一条 assistant_text',
  /texts\[texts\.length\s*-\s*1\]/.test(pump));
t('原有的 appendEvent 推送没被替换掉',
  /appendEvent\([^)]*job\.assistant_text/.test(pump));

/* ── 2. complete 入参不丢 ── */
const ci = srv.indexOf("'POST /internal/jobs/:id/complete'");
t('找到 complete 路由', ci > 0);
const cbody = srv.slice(ci, ci + 4000);
t('★ complete 把 b.last_assistant_text 并进 patch',
  /last_assistant_text:\s*b\.last_assistant_text/.test(cbody));

/* ── 3. publicJob 下发 ── */
const pi = srv.indexOf('function publicJob');
t('找到 publicJob', pi > 0);
t('★ publicJob 下发 last_assistant_text',
  /last_assistant_text/.test(srv.slice(pi, pi + 3000)));

/* ── 4. 前端：快照优先，不依赖 SSE ── */
/**
 * ★ 顺序很要紧：必须是 `job?.last_assistant_text ?? assistantText`。
 *   反过来写（assistantText 在前）的话，展开过程框时 SSE 回放的每一条
 *   历史回复都会盖掉快照，让「制作助手」卡片挨个闪一遍 ——
 *   对话区反复重排，就是用户反馈的「展开后对话框还是跳变」。
 */
t('★★ helperText 快照优先（反了就会跳变）',
  /helperText\s*=\s*job\?\.last_assistant_text\s*\?\?\s*assistantText/.test(ws));
t('   不是 assistantText 在前',
  !/helperText\s*=\s*assistantText\s*\?\?/.test(ws));

/* ── 5. 回放不得抖动：进度条撑到安静期，期间不推 assistant 文本 ── */
t('★★ 回放期间缓冲 assistant 文本、不逐条 setState',
  /if\s*\(replaying\)\s*lastAssistant\s*=/.test(stream));
t('★★ loadingEvents 不再「首批事件即撤」',
  /bumpSettle/.test(stream)
  && !/job\.process'\s*&&\s*e\.process\)\s*\{\s*setLoadingEvents\(false\)/.test(stream));
t('   一条事件都没来时也有了结（队列中的任务没有轨迹）',
  /SETTLE_EMPTY_MS/.test(stream));
t('   cleanup 清掉安静期计时器（防切换后残留回调）',
  /clearTimeout\(settleTimer\)/.test(stream));

/* ── 6. 加载完成前不渲染列表，也不显示会跳的数字 ── */
const pp = strip(read('apps/web/components/ProcessPanel.tsx'));
t('★★ 加载期间藏起事件列表（不边到边渲染）',
  /open\s*&&\s*!loadingEvents\s*\?\s*undefined\s*:\s*\{\s*display:\s*'none'/.test(pp));
t('★ 加载期间显示进度条', /procbar/.test(pp) && /role="progressbar"/.test(pp));
t('★ 加载期间不显示条数（它会一路往上跳）',
  /!loadingEvents\s*&&\s*<span[^>]*>\{shown\.length\}/.test(pp));
t('★ 进度条是不定长的（总条数未知，不能装百分比）',
  /procbar-slide/.test(read('apps/web/app/globals.css')));

/* ── 6b. 回放与实时必须分清：历史 status/phase 不能合进当前状态 ── */
/**
 * 用户实测：点开【已完成】任务的执行过程，阶段又把 GENERATING/FINALIZING
 * 走一遍、JobCard 从「生成完成」闪回「正在生成」，对话区跟着重排。
 * 根因是历史事件带着当时的 status/phase，被逐条合并进了当前状态。
 */
t('★★ gateway 发回放结束哨兵 job.replay_done',
  /event: job\.replay_done/.test(srv));
t('★ 哨兵不带 id:（否则污染 Last-Event-ID、断线重连从假 seq 续传）', (() => {
  const i = srv.indexOf('event: job.replay_done');
  const line = srv.slice(srv.lastIndexOf('\n', i), srv.indexOf('\n', i) + 1);
  return !/\bid:\s*\$/.test(line);
})());
t('★ 哨兵排在回放之后、订阅实时流之前', (() => {
  const r = srv.indexOf('readEvents(id, last)');
  const sent = srv.indexOf('event: job.replay_done');
  const sub = srv.indexOf('store.subscribe(id, send)');
  return r > 0 && sent > r && sub > sent;
})());
t('★ 前端登记了 job.replay_done（没登记会被静默丢弃）',
  /'job\.replay_done'/.test(strip(read('apps/web/lib/api.ts'))));
t('★★ 哨兵在【去重之前】处理（它没有有效 seq，会被 seq<=maxSeq 丢掉）', (() => {
  const h = stream.indexOf("'job.replay_done'");
  const d = stream.indexOf('seq <= maxSeq.current');
  return h > 0 && d > 0 && h < d;
})());
t('★★ 回放期间不合并 status/phase', /if\s*\(replaying\)\s*\{[\s\S]{0,400}?return;\s*\}/.test(stream)
  && stream.indexOf('if (replaying)') < stream.indexOf('status: e.status ?? prev.status'));
t('★★ 回放期间不逐条 sync（原来 4.8s 发了 19 次请求）', (() => {
  /*
   * 只看【带花括号的那个回放闸门块】。
   * 不能从第一个 `if (replaying)` 起算 —— 那是 assistant_text 分支里
   * 的单行形式，切片会一路圈到 out_of_scope 分支，把那里正常的
   * `void sync()` 也算进来（第一版断言就这么误报的）。
   */
  const i = stream.indexOf('if (replaying) {');
  if (i < 0) return false;
  const j = stream.indexOf('}', stream.indexOf('return;', i));
  return j > i && !/void sync\(\)/.test(stream.slice(i, j));
})());
t('★ 回放结束时统一 sync 一次对齐', (() => {
  const i = stream.indexOf('const settleNow');
  return i > 0 && /void sync\(\)/.test(stream.slice(i, i + 600));
})());
t('★ 回放里遇终态立即结束（终态之后不会再有事件）',
  /isTerminal\(e\.status\)\)\s*\{\s*stopped\.current = true;\s*settleNow\(\)/.test(stream));
t('★ 终态任务靠连接关闭兜底结束回放',
  /if\s*\(done\)\s*\{\s*settleNow\(\);\s*return;\s*\}/.test(stream));
t('★★ 只在【真的换任务】时清空状态（否则展开会退回旧快照、阶段倒退）',
  /const jobChanged = lastJobId\.current !== jobId/.test(stream)
  && /if\s*\(jobChanged\)\s*\{[\s\S]{0,400}setJob\(null\)/.test(stream));
t('   换任务时仍然清空（否则会显示上一个任务的卡片）',
  /if\s*\(jobChanged\)\s*\{[\s\S]{0,400}setProcessEvents\(\[\]\)/.test(stream));
t('   jobId 变 null 时重置 lastJobId', /lastJobId\.current = null/.test(stream));
t('★ 安静期只当兜底、放宽到 2.5s（600ms 对长轨迹判早了）',
  /SETTLE_FALLBACK_MS\s*=\s*2500/.test(stream) && !/SETTLE_MS\s*=\s*600/.test(stream));

/* ── 7. 开合不记忆，默认总是收起（用户明确要求）── */
t('★★ 不再把开合写进 localStorage', !/cvw:procOpen/.test(ws));
t('★★ 切换任务一律折叠', /justSubmitted\.current === activeId\) return;[\s\S]{0,120}setProcOpen\(false\)/.test(ws));
t('   刚提交那轮仍然展开', /justSubmitted\.current\s*=\s*r\.job\.id/.test(ws));
t('   初始值就是折叠', /useState\(false\)/.test(ws.slice(ws.indexOf('const [procOpen'), ws.indexOf('const [procOpen') + 80)));
t('过程框折叠时不订阅（subscribe 传 procOpen）',
  /subscribe\s*[:=]\s*\{?procOpen/.test(ws) || /useJobStream\([^)]*procOpen/.test(ws));
t('useJobStream 接受 subscribe 入参', /subscribe\s*=\s*true/.test(stream));
t('★ subscribe=false 时直接返回、不建 SSE', /if\s*\(!subscribe\)/.test(stream));
t('★ cancelled/unsub 竞态处理仍在（防 SSE 连接泄漏）',
  (stream.match(/cancelled/g) ?? []).length >= 3 && /unsub/.test(stream));
t('subscribe 在 effect 依赖里（切换要重跑同一套 cleanup）',
  /\[\s*jobId\s*,\s*sync\s*,\s*subscribe\s*\]/.test(stream));
t('暴露 loadingEvents 给进度条', /loadingEvents/.test(stream));

console.log(`  —— 通过 ${pass} 失败 ${fail} ——`);
process.exit(fail ? 1 : 0);
