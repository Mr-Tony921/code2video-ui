#!/usr/bin/env node
/** Isolated, repeatable whitebox acceptance using the same worker runner as dev. */
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync,readdirSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
const help='Usage: node scripts/whitebox-acceptance.mjs --worker WORKER --out NEW_DIR --prompt FILE [--references DIR]\nFollowup: node scripts/whitebox-acceptance.mjs --resume REPORT_JSON --prompt FILE\nRun on the chosen dev worker in tmux. Does not submit to the public queue. Uses administrator whitebox model settings. Never use a real session/storage root as --out.';
const argv=process.argv.slice(2);if(argv.includes('--help')){console.log(help);process.exit(0);}
const a={};for(let i=0;i<argv.length;i+=2){if(!['--worker','--out','--prompt','--references','--resume'].includes(argv[i])||!argv[i+1])throw new Error(help);a[argv[i].slice(2)]=argv[i+1];}
if(!a.prompt||(!a.resume&&(!a.worker||!a.out)))throw new Error(help);
const R=resolve(dirname(fileURLToPath(import.meta.url)),'..'),raw=JSON.parse(readFileSync(join(R,'config/backend.json')));
for(const line of readFileSync(join(R,'runtime/.secrets'),'utf8').split('\n')){const i=line.indexOf('=');if(i>0&&!process.env[line.slice(0,i)])process.env[line.slice(0,i)]=line.slice(i+1);}
const previous=a.resume?JSON.parse(readFileSync(resolve(a.resume))):null;
if(previous&&!previous.isolated_whitebox_acceptance)throw new Error('Not an acceptance report');
const D=previous?previous.root:resolve(a.out);
if(!previous){if(existsSync(D))throw new Error('Use a new empty output path');mkdirSync(D,{recursive:true});}
else if(!existsSync(join(D,'ACCEPTANCE-ONLY.json')))throw new Error('Missing isolated storage marker');
const worker=previous?.worker_id??a.worker;if(!raw.workers.some(w=>w.worker_id===worker&&w.enabled!==false))throw new Error('Unknown dev worker');
const sid=previous?.session_id??'sess_'+randomUUID(),jid='job_'+randomUUID();
process.env.CVW_REPO_ROOT=R;process.env.CVW_STORAGE_ROOT=join(D,'store');process.env.CVW_SESSIONS_ROOT=join(D,'sessions');process.env.CVW_WORKER_ID=worker;process.env.CVW_GATEWAY_BASE_URL='http://127.0.0.1:1';
const model=await import('../apps/shared/seko-model.mjs');
const actual={...raw,model_settings:{...raw.model_settings,root:raw.model_settings?.root??join(raw.storage.root,'model-settings')}};
const {config}=await import('../apps/worker-bridge/src/config.mjs');config.raw.model_settings={root:join(D,'models')};
if(!previous){const admin=model.sekoAdminModel(actual);model.saveSekoModel(config.raw,model.prepareSekoConnection(actual,admin));}
const selection=previous?.model??model.sekoSelection(config.raw);
if(previous&&!previous.completed?.meta)throw new Error('Only refine a completed acceptance result');
const refdir=join(config.storage.sessionsRoot,config.storage.sessionsSubdir,sid,'references');mkdirSync(refdir,{recursive:true});
let referenceManifest=[];
if(!previous){
 if(a.references)referenceManifest=readdirSync(resolve(a.references)).filter(n=>/\.(png|jpe?g|webp)$/i.test(n)).sort((x,y)=>x.localeCompare(y,'en',{numeric:true})).map(name=>{const src=join(resolve(a.references),name);copyFileSync(src,join(refdir,name));return {stored_name:name,original_name:name,type:'image',sha256:createHash('sha256').update(readFileSync(src)).digest('hex')};});
 writeFileSync(join(refdir,'manifest.json'),JSON.stringify({items:referenceManifest,frozen:true}));
 writeFileSync(join(D,'ACCEPTANCE-ONLY.json'),JSON.stringify({isolated:true,created_at:new Date().toISOString()}));
}
const record={isolated_whitebox_acceptance:true,public_queue:false,root:D,worker_id:worker,session_id:sid,job_id:jid,model:selection,started_at:new Date().toISOString(),prompt_file:resolve(a.prompt),references:referenceManifest,parent_report:a.resume?resolve(a.resume):null};
const report=join(D,jid+'.json');writeFileSync(report,JSON.stringify(record,null,2));console.log(JSON.stringify({report,session_id:sid,job_id:jid}));
let finish;const done=new Promise(r=>finish=r);const runner=await import('../apps/worker-bridge/src/job-runner.mjs');
await runner.startJob({sessionId:sid,jobId:jid,mode:'blockout_3d',prompt:readFileSync(resolve(a.prompt),'utf8'),experimentalSkills:{builtin:'none'},modelSelection:selection,leaseToken:'isolated-acceptance',maxRuntimeSeconds:0,hooks:{onComplete:meta=>finish({meta}),onFail:failure=>finish({failure}),onCancelled:cancelled=>finish({cancelled})}});
const completed=await done,round=join(config.storage.sessionsRoot,config.storage.sessionsSubdir,sid,'rounds',jid,'seko');
const result=existsSync(join(round,'result.json'))?JSON.parse(readFileSync(join(round,'result.json'))):null;
writeFileSync(report,JSON.stringify({...record,completed,finished_at:new Date().toISOString(),result,artifacts:result?.scene_success?{video:join(round,'output/final.mp4'),source:join(round,'source.zip'),run:join(round,'run')}:null},null,2));
console.log(JSON.stringify({report,ok:!!completed.meta,timings:result?.timings,status:result?.status}));if(!completed.meta)process.exitCode=1;
