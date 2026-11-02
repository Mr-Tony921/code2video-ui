import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
import { WorkerPool } from '../../apps/gateway/src/worker-pool.mjs';
const R=TEST_REPO_ROOT;
const mk=()=>new WorkerPool({repoRoot:R, log:{warn(){}}});
let pass=0,fail=0;
const t=(name,cond,extra='')=>{ if(cond){pass++;console.log('  ✅',name,extra);}else{fail++;console.log('  ❌',name,extra);} };

console.log('— B1：乐观计数不再被心跳清掉（改用预留）—');
{ const p=mk();
  p.register({worker_id:'w1',process_instance_id:'p1',supported_modes:['coding_to_video'],max_concurrent_jobs:4});
  p.reserve('p1','jobA'); p.reserve('p1','jobB');
  t('派发 2 个后 canAdmit 仍可接', p.canAdmit('p1').ok);
  // 真心跳到来，但还没看到这两个 job（cc 启动有延迟）
  p.heartbeat({process_instance_id:'p1', running_jobs:0, running_job_ids:[]});
  const a=p.canAdmit('p1');
  t('心跳未报这两个 job 时，预留仍然占位', p.reservedOn('p1')===2, `reserved=${p.reservedOn('p1')}`);
  // 填满到 4
  p.reserve('p1','jobC'); p.reserve('p1','jobD');
  t('占满 4 个后拒绝新任务', !p.canAdmit('p1').ok, JSON.stringify(p.canAdmit('p1')));
  // 心跳终于报出来了 → 预留让位给真实计数
  p.heartbeat({process_instance_id:'p1', running_jobs:4, running_job_ids:['jobA','jobB','jobC','jobD']});
  t('心跳报出后预留自动作废', p.reservedOn('p1')===0);
  t('此时仍按真实计数拒绝', !p.canAdmit('p1').ok, `used=${p.processes.get('p1').running_jobs}`);
}

console.log('\n— B2：running_job_ids 不再被局部心跳清空 —');
{ const p=mk();
  p.register({worker_id:'w2',process_instance_id:'p2',supported_modes:['coding_to_video']});
  p.heartbeat({process_instance_id:'p2', running_jobs:2, running_job_ids:['jobA','jobB']});
  p.heartbeat({process_instance_id:'p2', running_jobs:3});   // 不带 ids 的局部心跳
  t('ids 保留', JSON.stringify(p.processes.get('p2').running_job_ids)==='["jobA","jobB"]',
    JSON.stringify(p.processes.get('p2').running_job_ids));
}

console.log('\n— B3：bridge 重启后能找到同机健康实例 —');
{ const p=mk();
  p.register({worker_id:'w1',process_instance_id:'old',supported_modes:['coding_to_video']});
  p.register({worker_id:'w1',process_instance_id:'new',supported_modes:['coding_to_video']});
  t('canAdmit(old) 仍不可用', !p.canAdmit('old').ok, p.canAdmit('old').reason);
  const live=p.healthyForWorker('w1');
  t('healthyForWorker 找到新实例', live?.process_instance_id==='new', live?.process_instance_id);
  t('改绑后可派发', p.canAdmit('new').ok);
}

console.log('\n— 新增：bridgeUrlFor 对已消失实例的回退 —');
{ const p=mk();
  // ★ 不要写死 worker_id / IP：dev 能跑、同步到线上必然失败（线上没有 cvw-dev-360）。
  //   这是 dev → 线上同步反复踩的同一类坑，改为从配置取第一台，两边通用。
  const { readFileSync: _rf } = await import('node:fs');
  // 用本文件顶部的 R（仓库根），不要用 CVW_REPO_ROOT —— 本测试不设那个环境变量
  const _cfg = JSON.parse(_rf(`${R}/config/backend.json`, 'utf8'));
  const _w0 = _cfg.workers[0];
  const url=p.bridgeUrlFor('ghost-instance', _w0.worker_id);
  t('按 worker_id 回退到配置地址', !!url && url.includes(_w0.bridge.host), url);
  t('没有 worker_id 时仍返回 null', p.bridgeUrlFor('ghost')===null);
}

console.log('\n— 预留 TTL 过期后自动释放 —');
{ let now=0; const p=new WorkerPool({repoRoot:R, now:()=>now, log:{warn(){}}});
  p.register({worker_id:'w1',process_instance_id:'p1',supported_modes:['coding_to_video']});
  p.reserve('p1','stuck');
  t('刚预留时占位', p.reservedOn('p1')===1);
  now += 91_000;
  t('超过 TTL 后自动作废', p.reservedOn('p1')===0);
}
console.log(`\n══ 通过 ${pass}，失败 ${fail} ══`);
process.exit(fail?1:0);
