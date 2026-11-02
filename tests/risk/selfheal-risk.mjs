import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
// 自愈改绑的危险场景：会不会把任务改绑到【错误的机器】或造成重复派发？
import { WorkerPool } from '../../apps/gateway/src/worker-pool.mjs';
const R=TEST_REPO_ROOT;
const mk=()=>new WorkerPool({repoRoot:R, log:{warn(){}}});
let pass=0,fail=0;
const t=(n,c,e='')=>{c?(pass++,console.log('  ✅',n,e)):(fail++,console.log('  ❌',n,e));};

console.log('— 自愈改绑的边界 —');
{ const p=mk();
  p.register({worker_id:'w1',process_instance_id:'w1-new',supported_modes:['coding_to_video']});
  p.register({worker_id:'w2',process_instance_id:'w2-new',supported_modes:['coding_to_video']});
  // 关键：w1 的任务绝不能被改绑到 w2（会话与工作区都在 w1 的机器上）
  t('只找同一 worker 的实例，不跨机', p.healthyForWorker('w1').process_instance_id==='w1-new');
  t('w2 的也只找 w2', p.healthyForWorker('w2').process_instance_id==='w2-new');
  t('不存在的 worker 返回 null（不乱给）', p.healthyForWorker('w3')===null);
}
{ const p=mk();
  // 进程不健康时不能当作改绑目标
  p.register({worker_id:'w1',process_instance_id:'w1-a',supported_modes:['coding_to_video']});
  p.processes.get('w1-a').status='UNAVAILABLE';
  t('UNAVAILABLE 的实例不作为改绑目标', p.healthyForWorker('w1')===null);
  p.processes.get('w1-a').status='DRAINING';
  t('DRAINING（正在下线）的也不作为目标', p.healthyForWorker('w1')===null);
}
console.log('\n— 容量：自愈不会突破并发上限 —');
{ const p=mk();
  p.register({worker_id:'w1',process_instance_id:'p1',supported_modes:['coding_to_video'],max_concurrent_jobs:4});
  p.heartbeat({process_instance_id:'p1',running_jobs:4,running_job_ids:['a','b','c','d']});
  t('满载时即使实例健康也不许派发', !p.canAdmit('p1').ok, p.canAdmit('p1').reason);
}
console.log('\n— 全局上限仍然生效（两台机器加起来不超 8）—');
{ const p=mk();
  p.register({worker_id:'w1',process_instance_id:'p1',supported_modes:['coding_to_video'],max_concurrent_jobs:4});
  p.register({worker_id:'w2',process_instance_id:'p2',supported_modes:['coding_to_video'],max_concurrent_jobs:4});
  p.heartbeat({process_instance_id:'p1',running_jobs:4,running_job_ids:['a','b','c','d']});
  p.heartbeat({process_instance_id:'p2',running_jobs:4,running_job_ids:['e','f','g','h']});
  t('全局 8 满 → 都不许派发', !p.canAdmit('p1').ok && !p.canAdmit('p2').ok,
    `globalUsed=${p.globalUsed}`);
}
console.log('\n— 预留不会无限泄漏（最坏情况：派发后 bridge 再也不回报）—');
{ let now=0; const p=new WorkerPool({repoRoot:R,now:()=>now,log:{warn(){}}});
  p.register({worker_id:'w1',process_instance_id:'p1',supported_modes:['coding_to_video'],max_concurrent_jobs:4});
  for(let i=0;i<4;i++) p.reserve('p1','job'+i);
  t('4 个预留占满', !p.canAdmit('p1').ok);
  now += 91_000;
  t('TTL 到期后全部释放，不会永久占死槽位', p.canAdmit('p1').ok, `reserved=${p.reservedOn('p1')}`);
}
console.log(`\n══ 通过 ${pass}，失败 ${fail} ══`);
process.exit(fail?1:0);
