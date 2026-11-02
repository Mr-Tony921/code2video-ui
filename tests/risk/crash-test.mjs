import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
// 核心问题：认领环节出错，会不会让整个 Bridge 起不来（荡机）？
process.env.CVW_REPO_ROOT=TEST_REPO_ROOT;
process.env.CVW_WORKER_ID=process.env.CVW_WORKER_ID||'cvw-dev-360';
process.env.CVW_GATEWAY_BASE_URL='http://127.0.0.1:1';
process.env.CVW_INTERNAL_TOKEN='x'.repeat(32);
process.env.CVW_MODEL_API_KEY='sk-test';
process.env.CVW_STORAGE_ROOT=TEST_TMP_ROOT + '/fixture-devtest/repro/crashstore';
process.env.CVW_SESSIONS_ROOT=TEST_TMP_ROOT + '/fixture-devtest/repro/fakesess';
const R=process.env.CVW_REPO_ROOT;
const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
const { adoptRunningJobs } = await import(`${R}/apps/worker-bridge/src/job-adopter.mjs`);
// ★ 路径必须跟着 CVW_WORKER_ID 走。原来环境变量和路径各写一遍同一个值，
//   在 dev 恰好相等所以能跑；同步到线上一改环境变量，adopter 去
//   bridge/<新id>/running 找而 fixture 还在旧路径 → 认领到 0 个、测试失败，
//   而且看起来像认领逻辑坏了，很容易查错方向。
const idx=TEST_TMP_ROOT + '/fixture-devtest/repro/crashstore/bridge/'+process.env.CVW_WORKER_ID+'/running';
rmSync(TEST_TMP_ROOT + '/fixture-devtest/repro/crashstore',{recursive:true,force:true});
mkdirSync(idx,{recursive:true});
let pass=0,fail=0;
const t=(n,c,e='')=>{c?(pass++,console.log('  ✅',n,e)):(fail++,console.log('  ❌',n,e));};
const quiet={log(){},warn(){},error(){}};

// 场景1：索引文件是坏 JSON
writeFileSync(idx+'/a.json','{这不是合法 JSON');
// 场景2：索引指向不存在的 job_dir
writeFileSync(idx+'/b.json',JSON.stringify({job_dir:'/nonexistent/path',session_id:'s',pid:1}));
// 场景3：边车本身是坏 JSON
const jd=TEST_TMP_ROOT + '/fixture-devtest/repro/crashjob'; mkdirSync(jd,{recursive:true});
writeFileSync(jd+'/.running.json','{坏的');
writeFileSync(idx+'/c.json',JSON.stringify({job_dir:jd,session_id:'s',pid:1}));
// 场景4：边车缺字段（没有 log_path）
const jd2=TEST_TMP_ROOT + '/fixture-devtest/repro/crashjob2'; mkdirSync(jd2,{recursive:true});
writeFileSync(jd2+'/.running.json',JSON.stringify({job_id:'x',session_id:'s',pid:4194300}));
writeFileSync(idx+'/d.json',JSON.stringify({job_dir:jd2,session_id:'s',pid:4194300}));

let r=null, threw=null;
try { r = await adoptRunningJobs(()=>({}), quiet); } catch(e){ threw=e; }
t('四种损坏数据都不抛异常（Bridge 能正常启动）', threw===null, threw?.message??'');
t('返回了结果对象', !!r, r?JSON.stringify({a:r.adopted.length,s:r.settled.length,d:r.dead.length,k:r.skipped.length}):'');

// 场景5：索引目录根本不存在
rmSync(TEST_TMP_ROOT + '/fixture-devtest/repro/crashstore',{recursive:true,force:true});
let r2=null,threw2=null;
try { r2 = await adoptRunningJobs(()=>({}), quiet); } catch(e){ threw2=e; }
t('索引目录不存在时不抛（首次部署/全新机器）', threw2===null, threw2?.message??'');
t('返回空结果', r2 && r2.adopted.length===0);

// 场景6：hooksFor 自己抛异常
mkdirSync(idx,{recursive:true});
writeFileSync(idx+'/e.json',JSON.stringify({job_dir:jd2,session_id:'s',pid:4194300}));
let threw3=null;
try { await adoptRunningJobs(()=>{throw new Error('hooks 坏了');}, quiet); } catch(e){ threw3=e; }
t('hooksFor 抛异常也不会冒泡', threw3===null, threw3?.message??'');

rmSync(TEST_TMP_ROOT + '/fixture-devtest/repro/crashstore',{recursive:true,force:true});
rmSync(jd,{recursive:true,force:true}); rmSync(jd2,{recursive:true,force:true});
console.log(`\n══ 通过 ${pass}，失败 ${fail} ══`);
process.exit(fail?1:0);
