import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
// 一条坏记录会不会连累同批的健康任务？（加固前会，这是真正的危害）
process.env.CVW_REPO_ROOT=TEST_REPO_ROOT;
process.env.CVW_WORKER_ID=process.env.CVW_WORKER_ID||'cvw-dev-360';
process.env.CVW_GATEWAY_BASE_URL='http://127.0.0.1:1';
process.env.CVW_INTERNAL_TOKEN='x'.repeat(32);
process.env.CVW_MODEL_API_KEY='sk-test';
process.env.CVW_STORAGE_ROOT=TEST_TMP_ROOT + '/fixture-devtest/repro/isostore';
process.env.CVW_SESSIONS_ROOT=TEST_TMP_ROOT + '/fixture-devtest/repro/fakesess';
const R=process.env.CVW_REPO_ROOT;
const {mkdirSync,writeFileSync,rmSync}=await import('node:fs');
const {adoptRunningJobs}=await import(`${R}/apps/worker-bridge/src/job-adopter.mjs`);
// ★ 路径必须跟着 CVW_WORKER_ID 走。原来环境变量和路径各写一遍同一个值，
//   在 dev 恰好相等所以能跑；同步到线上一改环境变量，adopter 去
//   bridge/<新id>/running 找而 fixture 还在旧路径 → 认领到 0 个、测试失败，
//   而且看起来像认领逻辑坏了，很容易查错方向。
const idx=TEST_TMP_ROOT + '/fixture-devtest/repro/isostore/bridge/'+process.env.CVW_WORKER_ID+'/running';
rmSync(TEST_TMP_ROOT + '/fixture-devtest/repro/isostore',{recursive:true,force:true});
mkdirSync(idx,{recursive:true});
const quiet={log(){},warn(){},error(){}};

// 先放 2 条坏的
writeFileSync(idx+'/bad1.json','{坏');
const bd=TEST_TMP_ROOT + '/fixture-devtest/repro/isobad'; mkdirSync(bd,{recursive:true});
writeFileSync(bd+'/.running.json',JSON.stringify({job_id:'b',session_id:'s'}));  // 缺字段
writeFileSync(idx+'/bad2.json',JSON.stringify({job_dir:bd,session_id:'s',pid:1}));

// 再放 1 条健康的（进程活着 = 当前 node）
const gd=TEST_TMP_ROOT + '/fixture-devtest/repro/isogood'; mkdirSync(gd+'/output',{recursive:true});
writeFileSync(gd+'/claude.jsonl',
  JSON.stringify({type:'system',subtype:'init',cwd:'/workspace',session_id:'g1'})+'\n');
writeFileSync(gd+'/.running.json',JSON.stringify({
  job_id:'job_healthy', session_id:'sess_g', mode:'coding_to_video',
  lease_token:'lt', pid:process.pid, pgid:null, start_ticks:null,
  job_dir:gd, out_dir:gd+'/output', log_path:gd+'/claude.jsonl',
  err_path:gd+'/claude.stderr', started_at:new Date().toISOString(),
}));
writeFileSync(idx+'/good.json',JSON.stringify({job_dir:gd,session_id:'sess_g',pid:process.pid}));

const r=await adoptRunningJobs(()=>({}),quiet);
const ok = r.adopted.includes('job_healthy');
console.log('  认领结果:', JSON.stringify({adopted:r.adopted,skipped:r.skipped.length}));
console.log(ok ? '  ✅ 坏记录被跳过，健康任务照常认领（故障被隔离）'
               : '  ❌ 健康任务被坏记录连累，没认领到');
rmSync(TEST_TMP_ROOT + '/fixture-devtest/repro/isostore',{recursive:true,force:true});
rmSync(bd,{recursive:true,force:true}); rmSync(gd,{recursive:true,force:true});
process.exit(ok?0:1);
