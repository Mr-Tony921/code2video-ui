import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 增强 agent 绝不能 block 后续排队 —— 用户最担心的一条。
 *
 * 三条不变量：
 *  ① 名额严格归还（失败/超时/杀不掉都要还），否则增强会永久占满 → 任务卡 ENHANCING
 *  ② 超时一定会结束调用，不会无限挂着
 *  ③ 忽略 SIGTERM 的进程也能被 SIGKILL 整组清掉
 */
import { readFileSync } from 'node:fs';
const R=TEST_REPO_ROOT;
const src=readFileSync(`${R}/apps/gateway/src/enhance-agent.mjs`,'utf8');
let pass=0,fail=0;
const t=(n,c,e='')=>{c?(pass++,console.log('  ✅',n,e)):(fail++,console.log('  ❌',n,e));};

t('名额在 finally 里释放（不依赖进程是否真死）', /finally\s*\{[\s\S]*inflight\s*-=\s*1/.test(src));
t('超时先 SIGTERM', /killTree\(child,\s*'SIGTERM'\)/.test(src));
t('宽限后 SIGKILL', /killTree\(child,\s*'SIGKILL'\)/.test(src));
t('按进程组整树终止（负 pid）', /process\.kill\(-child\.pid/.test(src));
t('spawn 用 detached（才有独立进程组）', /detached:\s*true/.test(src));
t('超限直接抛 ENHANCE_BUSY，不排队等待', /ENHANCE_BUSY/.test(src));
t('finally 里兜底清进程', /if \(child && child\.exitCode === null[\s\S]*killTree/.test(src));

// 调用方必须降级而不是失败
const enh=readFileSync(`${R}/apps/gateway/src/enhancer.mjs`,'utf8');
t('agent 失败会降级为单轮', /agent loop 失败，降级为单轮/.test(enh));
t('降级后仍会走 callAux 单轮', /if \(text === undefined\)[\s\S]{0,120}callAux/.test(enh));

// 配置里必须有 ToolSearch，否则模型根本加载不了 WebSearch
const cfg=JSON.parse(readFileSync(`${R}/config/backend.json`,'utf8'));
const ag=cfg.prompt_enhancement.agent;
t('allowed_tools 含 ToolSearch（WebSearch 是 deferred 工具）', String(ag.allowed_tools).includes('ToolSearch'), ag.allowed_tools);
t('有超时与宽限配置', ag.timeout_ms>0 && ag.sigterm_grace_ms>0, `${ag.timeout_ms}/${ag.sigterm_grace_ms}`);
t('增强并发上限独立于生成并发', ag.max_concurrent>0 && ag.max_concurrent<=cfg.concurrency.global_max_concurrent_jobs,
  `enh=${ag.max_concurrent} gen=${cfg.concurrency.global_max_concurrent_jobs}`);

console.log(`\n══ 通过 ${pass}，失败 ${fail} ══`);
process.exit(fail?1:0);
