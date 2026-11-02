import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
import { JsonlTailer } from '../../apps/worker-bridge/src/log-tailer.mjs';
import { writeFileSync, appendFileSync, rmSync } from 'node:fs';
const F=TEST_TMP_ROOT + '/tail-fixture.jsonl';
rmSync(F,{force:true}); writeFileSync(F,'');
const got=[]; let pass=0,fail=0;
const t=(n,c,e='')=>{c?(pass++,console.log('  ✅',n,e)):(fail++,console.log('  ❌',n,e));};
const tl=new JsonlTailer({path:F,onLine:l=>got.push(l)});

appendFileSync(F,'{"a":1}\n{"a":2}\n');
await tl.pump();
t('读到完整的两行', got.length===2, JSON.stringify(got));

// 关键：写入一个被截断的行（模拟 cc 正写到一半）
appendFileSync(F,'{"a":3}\n{"partial":');
await tl.pump();
t('完整行被消费', got.length===3, got[2]);
t('残缺行【不】被消费', !got.some(l=>l.includes('partial')));

// 补完那一行
appendFileSync(F,'true}\n');
await tl.pump();
t('补完后残缺行被正确拼回', got.length===4 && got[3]==='{"partial":true}', got[3]);

// 空行与大块
appendFileSync(F,'\n\n{"a":5}\n');
await tl.pump();
t('空行被跳过', got.length===5 && got[4]==='{"a":5}', got[4]);

// 幂等：没有新内容时不重复
const before=got.length; await tl.pump();
t('无新内容时不重复读', got.length===before);

// 超过单次 1MB 的大块
const big='{"big":"'+'x'.repeat(1_500_000)+'"}\n';
appendFileSync(F,big);
await tl.pump();
t('跨 1MB 分片的长行能拼回', got.length===before+1 && got[got.length-1].length===big.length-1,
  `len=${got[got.length-1].length}`);

rmSync(F,{force:true});
console.log(`\n══ 通过 ${pass}，失败 ${fail} ══`);
process.exit(fail?1:0);
