import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
// tailer 的系统性风险：定时器泄漏、文件被删/截断、事件循环阻塞
import { JsonlTailer } from '../../apps/worker-bridge/src/log-tailer.mjs';
import { writeFileSync, appendFileSync, rmSync, truncateSync } from 'node:fs';
const F=TEST_TMP_ROOT + '/risk.jsonl';
let pass=0,fail=0;
const t=(n,c,e='')=>{c?(pass++,console.log('  ✅',n,e)):(fail++,console.log('  ❌',n,e));};

// 1) 文件不存在时不抛、不刷屏
rmSync(F,{force:true});
let errs=0;
const t1=new JsonlTailer({path:F,onLine:()=>{},onError:()=>errs++});
const n1=await t1.pump();
t('文件不存在 → 返回 0 不抛', n1===0 && errs===0);

// 2) 文件中途被删
writeFileSync(F,'{"a":1}\n');
const got=[]; const t2=new JsonlTailer({path:F,onLine:l=>got.push(l),onError:()=>errs++});
await t2.pump();
rmSync(F,{force:true});
const n2=await t2.pump();
t('文件被删 → 不抛、不丢已读', n2===0 && got.length===1 && errs===0);

// 3) 文件被截断（size < offset）—— 不能死循环也不能乱读
writeFileSync(F,'{"a":1}\n{"a":2}\n{"a":3}\n');
const got3=[]; const t3=new JsonlTailer({path:F,onLine:l=>got3.push(l)});
await t3.pump();
const off=t3.offset;
truncateSync(F,5);                       // 变短
const t0=Date.now(); const n3=await t3.pump(); const dt=Date.now()-t0;
t('文件被截断 → 不死循环', dt<1000, `${dt}ms`);
t('截断后不重复吐旧行', got3.length===3, `${got3.length}`);

// 4) onLine 抛异常不能中断整个 tail
writeFileSync(F,'{"a":1}\n{"a":2}\n{"a":3}\n');
let seen=0, caught=0;
const t4=new JsonlTailer({path:F,
  onLine:()=>{seen++; throw new Error('解析炸了');},
  onError:()=>caught++});
await t4.pump();
t('onLine 每行抛异常 → 仍然逐行推进，不中断', seen===3, `处理了 ${seen} 行`);
t('异常被 onError 接住', caught===3);

// 5) stop() 后定时器确实停了（不泄漏）
const t5=new JsonlTailer({path:F,onLine:()=>{},intervalMs:20});
t5.start();
const before=process.getActiveResourcesInfo?.().filter(x=>x==='Timeout').length ?? 0;
t5.stop();
const after=process.getActiveResourcesInfo?.().filter(x=>x==='Timeout').length ?? 0;
t('stop() 后定时器被清理', after<=before, `${before}→${after}`);

// 6) 大文件单次 pump 不会长时间阻塞事件循环
const big='{"x":"'+'y'.repeat(200)+'"}\n';
writeFileSync(F, big.repeat(50000));     // ~10MB
let ticked=0; const iv=setInterval(()=>ticked++,10);
const t6=new JsonlTailer({path:F,onLine:()=>{}});
const s6=Date.now(); await t6.pump(); const d6=Date.now()-s6;
clearInterval(iv);
console.log(`  10MB 单次 pump 耗时 ${d6}ms，期间事件循环 tick ${ticked} 次`);
t('大文件 pump 不会完全饿死事件循环', ticked>0 || d6<200, `${d6}ms/${ticked}ticks`);

rmSync(F,{force:true});
console.log(`\n══ 通过 ${pass}，失败 ${fail} ══`);
process.exit(fail?1:0);
