import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { isSeko } from './seko-model.mjs';
function load(config, job) {
  if(job.mode!=='blockout_3d'||!isSeko(job.model_selection)||job.status!=='COMPLETED')return null;
  if(!/^sess_[a-f0-9-]{36}$/.test(job.session_id)||!/^job_[a-f0-9-]{36}$/.test(job.id))return null;
  const root=join(config.storage.sessionsRoot,config.raw.storage.sessions_subdir,job.session_id,'rounds',job.id,'seko');
  try {const result=JSON.parse(readFileSync(join(root,'result.json')));return result.job_id===job.id?{root,result}:null;}catch{return null;}
}
export function sekoPublicResult(config,job) {
  const loaded=load(config,job);if(!loaded)return null;
  const r=loaded.result;
  return {harness:r.harness,release:r.release,model:r.model,status:r.status,scene_success:r.scene_success,structure_pass:r.structure_pass,
    timings:r.timings,repairs:r.repairs,duration:r.duration,shot_count:r.shot_count,reference_count:r.reference_count,
    issues:(r.issues??[]).map(i=>({code:i.code??'review',shot_id:i.shot_id,message:typeof i==='string'?i:i.problem??i.message??i.observed??i.technical??'存在待核对项'})),
    ...(r.export?{download_url:`/api/whitebox/jobs/${job.id}/source`,source_size_bytes:r.export.size_bytes}:{} )};
}
export function sekoDownload(config,job) {
  const loaded=load(config,job);if(!loaded?.result.export)throw new Error('源码尚未就绪');
  const {root,result:r}=loaded;if(r.export.file!=='source.zip')throw new Error('Invalid export');
  const path=realpathSync(join(root,'source.zip')),rel=relative(realpathSync(root),path);
  if(isAbsolute(rel)||rel.startsWith('..'))throw new Error('Invalid export path');
  const bytes=readFileSync(path);
  if(createHash('sha256').update(bytes).digest('hex')!==r.export.sha256)throw new Error('Export integrity check failed');
  return {path,size:statSync(path).size,name:`whitebox-${job.id}.zip`};
}
