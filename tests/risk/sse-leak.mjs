import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 切 session 不能泄漏 SSE 连接。
 *
 * 线上实测：sse.open 255 次 / close 仅 139 次，净泄漏 116 条，
 * 连接数一路爬到 55。单个 job 被 open 15 次且每次 last=0。
 * 根因：订阅在 sync() 的【异步】回调里才建立，cleanup 是【同步】的 ——
 * 快速切 session 时 cleanup 跑的时候 unsub 还是 null，什么也没断掉，
 * 之后回调返回再建连，这条连接永远没人关。
 * 僵尸连接的 onEvent 闭包持有旧 job 的 setState ⇒ 页面来回跳变、
 * 显示别的任务的产物、当前任务在跑却不滚动。
 */
import { readFileSync } from 'node:fs';
const R=TEST_REPO_ROOT;
const s=readFileSync(`${R}/apps/web/features/useJobStream.ts`,'utf8');
let pass=0,fail=0;
const t=(n,c,e='')=>{c?(pass++,console.log('  ✅',n,e)):(fail++,console.log('  ❌',n,e));};

t('effect 内有 cancelled 标志', /let cancelled = false;/.test(s));
t('cleanup 第一件事就是置 cancelled', /cancelled = true;\s*\/\/ 先置位/.test(s));
t('★ 异步回调建连前先判 cancelled（根治竞态）',
  /void sync\(\)\.then\(\(j\) => \{[\s\S]{0,260}if \(cancelled \|\| !j\) return;/.test(s));
t('cleanup 仍然调用 unsub', /unsub\?\.\(\);/.test(s));
t('cleanup 后把 unsub 置空', /unsub = null;/.test(s));
t('第二道防线：onEvent 丢弃已清理 effect 的事件', /if \(cancelled\) return;/.test(s));
t('第二道防线：onEvent 校验事件归属 job', /if \(e\.job_id && e\.job_id !== jobId\) return;/.test(s));

// 事件必须真的带 job_id，否则上面那条校验永远不生效
const js=readFileSync(`${R}/apps/gateway/src/store/job-store.mjs`,'utf8');
t('服务端事件带 job_id（校验才有依据）', /job_id:\s*jobId/.test(js));

console.log(`\n══ 通过 ${pass}，失败 ${fail} ══`);
process.exit(fail?1:0);
