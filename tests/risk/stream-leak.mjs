import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 视频流句柄泄漏的回归（1.4.4 修）。
 *
 * 线上实测（1.4.3 运行 16 小时后）：
 *   · Gateway 攒了 **141 个 final.mp4 文件句柄**，其中 **78 个压在同一个文件上**
 *     —— 同一个视频被播了 78 次，78 个读流一个都没关
 *   · 代理 ↔ 网关 **153 条 ESTABLISHED**
 *   · 前端 next-server **RSS 1.9GB 且仍在增长**
 *
 * 两处缺陷叠成的：
 *   1. 代理（route.ts）从来不把【客户端断开】传给上游 —— `signal` 只有
 *      「120 秒超时」或 `undefined`，没传过 `req.signal`。
 *      浏览器 seek/关页之后，到 Gateway 的请求没人取消。
 *   2. Gateway 用 `rs.pipe(res)`，而 pipe 在 res 提前关闭时**不销毁 rs**，
 *      句柄就一直挂着。
 *
 * 机制是老的（从来不传断开），但 1.4.2 为修「大文件被 120 秒掐断」给流去掉了超时，
 * 顺手把唯一的兜底回收也去掉了 —— 有界泄漏于此变成无界泄漏。
 * 所以两边都必须修：代理不传断开，Gateway 就永远收不到 close。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const R = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let pass = 0, fail = 0;
const t = (n, c, e = '') => { c ? (pass++, console.log('  ✅', n, e)) : (fail++, console.log('  ❌', n, e)); };

// ── Gateway 侧：所有文件下发都要带 close 清理
const gw = readFileSync(join(R, 'apps/gateway/src/server.mjs'), 'utf8');
const bare = [...gw.matchAll(/createReadStream\([^)]*\)\s*\.pipe\(/g)];
t('没有任何「裸 pipe」的 createReadStream', bare.length === 0, `发现 ${bare.length} 处`);
const wrapped = [...gw.matchAll(/pipeWithCleanup\(\s*createReadStream/g)];
t('四处下发（产物 playback/download + 示例视频，各含 Range 与全量）都走 pipeWithCleanup',
  wrapped.length === 4, `找到 ${wrapped.length} 处`);
t('pipeWithCleanup 在 res close 时销毁读流',
  /function pipeWithCleanup[\s\S]{0,400}res\.once\(\s*'close'[\s\S]{0,80}rs\.destroy\(\)/.test(gw));
t('读流出错时也不把响应吊死',
  /function pipeWithCleanup[\s\S]{0,500}rs\.once\(\s*'error'/.test(gw));

// ── 代理侧：必须把客户端断开传给上游
const rt = readFileSync(join(R, 'apps/web/app/api/[...path]/route.ts'), 'utf8');
t('上游 fetch 的 signal 由 upstreamSignal 决定', /signal:\s*upstreamSignal\(/.test(rt));
t('upstreamSignal 真的用了 req.signal', /function upstreamSignal[\s\S]{0,600}req\.signal/.test(rt));
t('流式请求不再传 undefined（否则断开传不下去）',
  !/signal:\s*isSse\s*\|\|\s*isStream\s*\?\s*undefined/.test(rt),
  '1.4.2 的写法已移除');
t('非流式请求仍保留 120 秒兜底', /AbortSignal\.timeout\(120_000\)/.test(rt));
t('AbortSignal.any 不可用时有退路（不能直接崩）',
  /typeof AbortSignal\.any === 'function'/.test(rt));
t('客户端自己断开不报成 502 假故障', /req\.signal\?\.aborted[\s\S]{0,120}499/.test(rt));

// ── node 守卫：Gateway 与 Bridge 都靠全局 fetch，起之前必须验版本
const guardPath = join(R, 'scripts/node-guard.sh');
const guard = readFileSync(guardPath, 'utf8');
t('有 node-guard.sh', guard.includes('require_node18'));
// Lifecycle scripts delegate to one implementation; version validation precedes Popen.
const lifecycle = readFileSync(join(R, 'scripts/service.py'), 'utf8');
for (const sh of ['restart-service.sh', 'start-backend.sh', 'start-bridge.sh', 'start-frontend.sh']) {
  t(`${sh} uses the guarded lifecycle`, /service\.py/.test(readFileSync(join(R, 'scripts', sh), 'utf8')));
}
t('central lifecycle requires Node >=22 before spawning',
  /int\(version\[1:\]\.split/.test(lifecycle) && / >= 22/.test(lifecycle)
  && lifecycle.indexOf('node = node_binary()') < lifecycle.indexOf('process = subprocess.Popen'));
// 行为验证：指一个假的 node 16 过去，必须拒绝（正则守卫挡不住逻辑写错）
let refused = false;
try {
  const fake = execFileSync('bash', ['-c',
    `d=$(mktemp -d); printf '#!/bin/sh\\necho v16.20.2\\n' > $d/node; chmod +x $d/node; ` +
    `cd ${R} && . scripts/node-guard.sh && CVW_NODE_BIN=$d require_node18 Gateway /dev/null; ` +
    `rc=$?; rm -rf $d; exit $rc`], { encoding: 'utf8' });
  refused = false; void fake;
} catch { refused = true; }
t('★ 行为验证：显式指向 node 16 时拒绝启动', refused);

console.log(`\n  流泄漏与 node 守卫: 通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
