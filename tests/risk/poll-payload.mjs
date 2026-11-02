import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 轮询体积与代理层压缩的回归（1.4.6）。
 *
 * 线上实测：`/api/me/active-context` **185 KB、不压缩、每页每 20 秒全量轮询**，
 * 前端出口被填到 88.9 KB/s，而入口只有 43~71 KB/s ——
 * 我们在要 1.3~2 倍于管子能给的量，超额部分变成排队，视频/首屏/SSE 全堵在后面。
 * dev 更严重：**652 KB / 124 条，>99% 是不会变的已完成历史**。
 *
 * 两处修复：
 *   P0 轮询只取增量（brief）—— 652 KB → 约 1 KB
 *   P1 gzip 加在**代理层**，不是 Gateway（见下面那条断言的注释）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const R = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let pass = 0, fail = 0;
const t = (n, c, e = '') => { c ? (pass++, console.log('  ✅', n, e)) : (fail++, console.log('  ❌', n, e)); };
const read = (f) => readFileSync(join(R, f), 'utf8');
// ★ 顺序很重要：**先去整行注释，再去块注释**。
//   反过来的话，注释里出现 `/api/*` 这种字样会被当成块注释开头，
//   一路吞到下一个 */ —— route.ts 第 92 行就有一条这样的整行注释，
//   导致它后面约 20 行（含 headers 构造与 accept-encoding 设置）在断言里凭空消失。
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/* ───── P0 服务端：brief 省略历史 ───── */
const gw = strip(read('apps/gateway/src/server.mjs'));
const ac = gw.slice(gw.indexOf("'GET /api/me/active-context'"));
const acBody = ac.slice(0, ac.indexOf('\n  },'));
t('active-context 支持 brief=1', /searchParams\.get\('brief'\)/.test(acBody));
t('★ brief 时不计算已完成列表（省掉 124 次 publicJob 与 652KB 序列化）',
  /brief \?\s*\[\]\s*:\s*all\.filter/.test(acBody));
t('★ brief 时响应里【没有】recent_completed_jobs 这个键（不是空数组）',
  /\.\.\.\(brief \?\s*\{\}\s*:\s*\{ recent_completed_jobs/.test(acBody));
t('brief 时仍然返回 running_jobs（轮询就是为了它）',
  /running_jobs:\s*running\.map/.test(acBody));
t('默认行为不变：不传 brief 仍返回全量', /recent_completed_jobs/.test(acBody));

/* ───── P0 前端：定时器只打轻量请求 ───── */
const ws = strip(read('apps/web/app/_workspace.tsx'));
t('★ 20 秒定时器调 refreshRunning，不是 reload',
  /setInterval\(\(\) => \{ void boot\.refreshRunning\(\); \}, 20_000\)/.test(ws));
t('★ 定时器里不再出现 reload（否则又会拉全量）',
  !/setInterval[\s\S]{0,120}boot\.reload/.test(ws));

const us = strip(read('apps/web/features/useSession.ts'));
t('refreshRunning 存在并被导出', /const refreshRunning = useCallback/.test(us)
  && /return \{ \.\.\.state, reload, refreshRunning/.test(us));
const rr = us.slice(us.indexOf('const refreshRunning'), us.indexOf('return { ...state, reload'));
t('★ refreshRunning 只打 brief 的 activeContext', /api\.activeContext\(\{ brief: true \}\)/.test(rr));
t('★ refreshRunning 不调 me（那是 reload 的事）', !/api\.me\(/.test(rr));
t('★ refreshRunning 不调 getSession', !/api\.getSession\(/.test(rr));
t('★ refreshRunning 绝不设置 recentJobs（空数组会让"已完成"整列消失）',
  !/recentJobs/.test(rr));
t('★ 用 ref 同步判断"有任务消失"，不在 setState updater 里赋闭包变量',
  /runningIdsRef\.current\.some/.test(rr) && !/let vanished = false/.test(rr));
t('★ running 集合变小时补一次完整 reload（否则别的会话完成后"已完成"不更新）',
  /if \(vanished\) await reload\(true\)/.test(rr));
t('reload 里把 recent_completed_jobs 当可选处理（brief 响应没有这个键）',
  /recentJobs:\s*ctx\.recent_completed_jobs \?\? \[\]/.test(us));

const apiTs = strip(read('apps/web/lib/api.ts'));
t('api.activeContext 接受 brief 参数', /activeContext:\s*\(opts\?:\s*\{ brief\?: boolean \}\)/.test(apiTs));
t('类型上 recent_completed_jobs 是可选的', /recent_completed_jobs\?:\s*Job\[\]/.test(apiTs));

/* ───── P1 代理层压缩 ───── */
const rt = strip(read('apps/web/app/api/[...path]/route.ts'));
/**
 * ★ 这条是本次最容易做错的地方。
 *   线上报告建议「Gateway 对 JSON 加 gzip」——位置是错的：
 *   SKIP_REQ 原来不含 accept-encoding ⇒ 浏览器的 gzip 头透传到上游 ⇒
 *   undici 自动解压 ⇒ SKIP_RES 又剥掉 content-encoding ⇒
 *   只压了局域网那一跳（204 MB/s，不缺），面向用户的那一跳照旧全量。
 */
t('★ accept-encoding 被挡在 SKIP_REQ 里（压缩在本层做）',
  /SKIP_REQ[\s\S]{0,200}'accept-encoding'/.test(rt));
t('★ 向上游显式要明文 identity（绕开 undici 自动解压）',
  /headers\.set\('accept-encoding',\s*'identity'\)/.test(rt));
t('SKIP_RES 仍剥掉上游的 content-encoding（我们自己设）',
  /SKIP_RES[\s\S]{0,200}'content-encoding'/.test(rt));
t('有 gzip 实现并设置 content-encoding', /gzipSync/.test(rt)
  && /headers\.set\('content-encoding',\s*'gzip'\)/.test(rt));
t('设置 vary: accept-encoding（缓存正确性）', /'vary',\s*'accept-encoding'/.test(rt));
t('小响应不压（压完更大且白耗 CPU）', /GZIP_MIN_BYTES/.test(rt));
t('只在浏览器声明支持 gzip 时才压',
  /accept-encoding[\s\S]{0,120}includes\('gzip'\)/.test(rt));
t('★ SSE / 视频流直接透传、不缓冲不压缩',
  /if \(isSse \|\| isStream\) \{[\s\S]{0,200}return new Response\(res\.body/.test(rt));
t('★ 非文本类型也不缓冲（视频以外的二进制同样直通）',
  /json\|text\\\/\|javascript/.test(rt) || /json\|text\//.test(rt));

console.log(`\n  轮询体积与代理压缩: 通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
