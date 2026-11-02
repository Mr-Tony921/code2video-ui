import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
// 用真实模块验证认领的边界：pid 复用识别、死亡补收尾、seq 连续性
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
process.env.CVW_REPO_ROOT=TEST_REPO_ROOT;
process.env.CVW_WORKER_ID=process.env.CVW_WORKER_ID||'cvw-dev-360';
process.env.CVW_GATEWAY_BASE_URL='http://127.0.0.1:1';
process.env.CVW_INTERNAL_TOKEN='x'.repeat(32);
process.env.CVW_MODEL_API_KEY='sk-test';
process.env.CVW_SESSIONS_ROOT=TEST_TMP_ROOT + '/fixture-devtest/repro/fakesess';
process.env.CVW_STORAGE_ROOT=TEST_TMP_ROOT + '/fixture-devtest/repro/fakestore';
const R=process.env.CVW_REPO_ROOT;
const runner=await import(`${R}/apps/worker-bridge/src/job-runner.mjs`);
let pass=0,fail=0;
const t=(n,c,e='')=>{c?(pass++,console.log('  ✅',n,e)):(fail++,console.log('  ❌',n,e));};

console.log('— pid 复用识别 —');
// 自己的 pid 肯定活着，但 start_ticks 故意写错 → 必须判死
t('start_ticks 不符 → 判定为已死',
  runner.isSidecarProcessAlive({pid:process.pid,start_ticks:999999999,job_dir:'/tmp'})===false);
// 不存在的 pid
t('pid 不存在 → 判定为已死',
  runner.isSidecarProcessAlive({pid:4194300,start_ticks:null,job_dir:'/tmp'})===false);
// 真实存活的进程，不带 start_ticks
t('真实存活进程 → 判定为活',
  runner.isSidecarProcessAlive({pid:process.pid,start_ticks:null,job_dir:'/tmp'})===true);

console.log('\n— 死亡补收尾：轨迹能解析出成败 —');
const jd=TEST_TMP_ROOT + '/fixture-devtest/repro/fakejob';
rmSync(jd,{recursive:true,force:true}); mkdirSync(jd+'/output',{recursive:true});
writeFileSync(jd+'/claude.jsonl',
  JSON.stringify({type:'system',subtype:'init',cwd:'/workspace',session_id:'s1'})+'\n'+
  JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'})+'\n');
const fired={};
await runner.settleDeadJob({
  job_id:'job_dead_test', session_id:'sess_x', mode:'coding_to_video',
  lease_token:'lt_x', pid:4194300, pgid:null, job_dir:jd,
  out_dir:jd+'/output', log_path:jd+'/claude.jsonl', err_path:jd+'/claude.stderr',
  started_at:new Date().toISOString(),
}, { onFail:(f)=>{fired.fail=f;}, onComplete:(m)=>{fired.done=m;} });
t('没有产物 → 走失败上报（不会永远卡在进行中）', !!fired.fail, fired.fail?.code);
rmSync(jd,{recursive:true,force:true});
rmSync(TEST_TMP_ROOT + '/fixture-devtest/repro/fakestore',{recursive:true,force:true});
console.log(`\n══ 通过 ${pass}，失败 ${fail} ══`);
process.exit(fail?1:0);
