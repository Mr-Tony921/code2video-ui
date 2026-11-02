import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 直接验证超时 kill 路径：用一个真的会赖着不走的进程。
 * 这是用户最担心的一条 —— 杀不掉会不会 block 后续。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let pass=0,fail=0;
const t=(n,c,e='')=>{c?(pass++,console.log('  ✅',n,e)):(fail++,console.log('  ❌',n,e));};

// 复刻 enhance-agent 的 kill 逻辑
function killTree(child, sig){
  try { if (child.pid) process.kill(-child.pid, sig); }
  catch { try { child.kill(sig); } catch {} }
}
async function run({bin,args,timeoutMs,graceMs}){
  let inflight_local = 1;
  const dir = await mkdtemp(join(tmpdir(),'kt-'));
  let child=null,timer=null,hard=null;
  try{
    child = spawn(bin,args,{cwd:dir,detached:true,stdio:['pipe','pipe','pipe']});
    return await new Promise((res,rej)=>{
      let settled=false; const done=(f,v)=>{if(!settled){settled=true;f(v);}};
      child.on('exit',(c,s)=>done(s?rej:res, s?new Error('signal '+s):'exited'));
      child.on('error',e=>done(rej,e));
      timer=setTimeout(()=>{
        killTree(child,'SIGTERM');
        hard=setTimeout(()=>{ killTree(child,'SIGKILL'); done(rej,new Error('超时')); },graceMs);
      },timeoutMs);
      child.stdin.on('error',()=>{}); child.stdin.end('x');
    });
  } finally {
    clearTimeout(timer); clearTimeout(hard);
    if (child && child.exitCode===null && child.signalCode===null) killTree(child,'SIGKILL');
    await rm(dir,{recursive:true,force:true}).catch(()=>{});
    inflight_local = 0;        // ← 对应真实代码里的 inflight -= 1
  }
}

console.log('— 场景1：进程忽略 SIGTERM（最坏情况）—');
const t0=Date.now();
let err=null, pid=null;
try{
  // bash 陷住 SIGTERM，只有 SIGKILL 能杀死它
  await run({bin:'bash',args:['-c','trap "" TERM; sleep 300'],timeoutMs:1500,graceMs:800});
}catch(e){ err=e; }
const dt=Date.now()-t0;
t('调用结束了（没有永远挂住）', !!err, `${dt}ms ${err?.message}`);
t('耗时 ≈ timeout+grace，没有拖到 300 秒', dt<6000, `${dt}ms`);

console.log('\n— 场景2：SIGKILL 真的把进程组清掉了 —');
const probe = spawn('bash',['-c','trap "" TERM; sleep 60 & wait'],{detached:true,stdio:'ignore'});
const ppid = probe.pid;
await new Promise(r=>setTimeout(r,500));
const alive1 = (()=>{ try{ process.kill(ppid,0); return true;}catch{return false;} })();
killTree(probe,'SIGKILL');
await new Promise(r=>setTimeout(r,800));
const alive2 = (()=>{ try{ process.kill(ppid,0); return true;}catch{return false;} })();
t('SIGKILL 前进程在', alive1);
t('SIGKILL 后进程组已清除', !alive2);

console.log(`\n══ 通过 ${pass}，失败 ${fail} ══`);
process.exit(fail?1:0);
