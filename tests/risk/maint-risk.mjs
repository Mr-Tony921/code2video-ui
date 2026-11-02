import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
// 维护标记最怕「卡住不解除」=> 前端永久锁死。必须 fail-open。
process.env.CVW_REPO_ROOT=TEST_REPO_ROOT;
process.env.CVW_STORAGE_ROOT=TEST_TMP_ROOT + '/fixture-devtest/repro/mstore';
process.env.CVW_GATEWAY_BASE_URL='http://127.0.0.1:1';
process.env.CVW_INTERNAL_TOKEN='x'.repeat(32);
process.env.CVW_MODEL_API_KEY='sk-test';
const R=process.env.CVW_REPO_ROOT;
const {mkdirSync,writeFileSync,rmSync,chmodSync}=await import('node:fs');
const m=await import(`${R}/apps/gateway/src/maintenance.mjs`);
const d=TEST_TMP_ROOT + '/fixture-devtest/repro/mstore/gateway';
rmSync(TEST_TMP_ROOT + '/fixture-devtest/repro/mstore',{recursive:true,force:true}); mkdirSync(d,{recursive:true});
const f=d+'/maintenance.json';
let pass=0,fail=0;
const t=(n,c,e='')=>{c?(pass++,console.log('  ✅',n,e)):(fail++,console.log('  ❌',n,e));};
const fresh=()=>{ /* 绕过 1 秒缓存 */ return new Promise(r=>setTimeout(r,1100)); };

t('文件不存在 → 未维护', m.isActive()===false);

writeFileSync(f,'{这不是 JSON'); await fresh();
t('文件损坏 → fail-open（不锁死）', m.isActive()===false);

writeFileSync(f,JSON.stringify({active:true})); await fresh();
t('没有 expires_at 的 active 仍然生效（手动置位场景）', m.isActive()===true);

const past=new Date(Date.now()-60000).toISOString();
writeFileSync(f,JSON.stringify({active:true,expires_at:past})); await fresh();
t('过期 → 自动失效（脚本崩了也能自愈）', m.isActive()===false);

writeFileSync(f,JSON.stringify({active:'yes'})); await fresh();
t('active 不是布尔 true → 不生效（严格判断）', m.isActive()===false);

writeFileSync(f,'null'); await fresh();
t('内容是 null → 不锁死', m.isActive()===false);

writeFileSync(f,'[]'); await fresh();
t('内容是数组 → 不锁死', m.isActive()===false);

// 不可读
writeFileSync(f,JSON.stringify({active:true}));
try{ chmodSync(f,0o000); }catch{}
await fresh();
const unreadable=m.isActive();
try{ chmodSync(f,0o644); }catch{}
t('文件不可读 → fail-open', unreadable===false, `实际=${unreadable}`);

// begin/end 往返
m.begin({expected_seconds:60}); 
t('begin 后生效', m.isActive()===true);
m.end();
t('end 后解除', m.isActive()===false);

// 无 expires_at 但 started_at 很久以前 → 绝对上限兜底
const old2=new Date(Date.now()-20*60000).toISOString();
writeFileSync(f,JSON.stringify({active:true,started_at:old2})); await fresh();
t('无 expires_at 且超过最大窗口 → 自动失效', m.isActive()===false);
const recent=new Date(Date.now()-60000).toISOString();
writeFileSync(f,JSON.stringify({active:true,started_at:recent})); await fresh();
t('无 expires_at 但刚置位 → 仍然生效（不误伤）', m.isActive()===true);

rmSync(TEST_TMP_ROOT + '/fixture-devtest/repro/mstore',{recursive:true,force:true});
console.log(`\n══ 通过 ${pass}，失败 ${fail} ══`);
process.exit(fail?1:0);
