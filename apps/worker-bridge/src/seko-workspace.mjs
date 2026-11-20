import { createHash } from 'node:crypto';
import { mkdir, writeFile, cp, copyFile, symlink, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { sekoConnection, isSeko } from '../../shared/seko-model.mjs';
import { config } from './config.mjs';
import { resolveJobPaths, jobToken } from './job-paths.mjs';
import { referencesDir } from './session-workspace.mjs';

export async function prepareSekoWorkspace(p) {
  if(p.mode!=='blockout_3d'||!isSeko(p.modelSelection))throw new Error('Seko only accepts new whitebox sessions');
  const {agentWs:ws,bookDir}=resolveJobPaths(p.sessionId,p.jobId),release=p.modelSelection.engine_release;
  if(!/^seko-[\w.-]+$/.test(release??''))throw new Error('Invalid whitebox release');
  const source=join(config.repoRoot,'assets/whitebox-seko/releases',release,'engine');
  if(!existsSync(source))throw new Error('Whitebox release is unavailable; retained session requires its pinned release');
  const manifest=JSON.parse(readFileSync(join(source,'..','RELEASE.json')));
  if(p.modelSelection.engine_sha256 && createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex') !== p.modelSelection.engine_sha256)throw new Error('Pinned whitebox release changed; restore the original release');
  for(const [name,hash] of Object.entries(manifest.files)) {
    if(name.split('/').includes('..') || name.startsWith('/'))throw new Error('Invalid release manifest path');
    if(createHash('sha256').update(readFileSync(join(source,name))).digest('hex')!==hash)throw new Error('Whitebox release hash mismatch: '+name);
  }
  const task=join(bookDir,'seko'),engine=join(task,'engine'),refs=join(task,'references');
  await mkdir(ws,{recursive:true});await mkdir(task,{recursive:true});await mkdir(refs,{recursive:true});
  await cp(source,engine,{recursive:true,filter:f=>!f.split('/').some(x=>x==='node_modules'||x==='__pycache__')});
  await symlink(join(source,'node_modules'),join(engine,'node_modules'),'dir');
  for(const f of ['seko-run.py','seko-provider.py','seko-audit.py','seko-intake.py'])await copyFile(join(config.repoRoot,'apps/worker-bridge/scripts',f),join(task,f));
  const connection=sekoConnection(config.raw,p.modelSelection),{api_key:key,...publicConnection}=connection;
  const configFile=join(task,'model.json');
  await writeFile(configFile,JSON.stringify({models:{selected:{...publicConnection,http_timeout_seconds:1200,max_output_tokens:publicConnection.max_output_tokens ?? (publicConnection.family === 'gpt' ? 32768 : 98304)}}},null,2),{mode:0o600});
  let assets=[];
  const referenceManifest=join(referencesDir(p.sessionId),config.raw.references?.manifest_file ?? 'manifest.json');
  if(existsSync(referenceManifest))assets=JSON.parse(readFileSync(referenceManifest)).items??[];
  if(assets.some(a=>a.type!=='image'))throw new Error('白模参考素材目前仅支持图片');
  for(const [i,a] of assets.entries()) {
    if(basename(a.stored_name)!==a.stored_name)throw new Error('Invalid reference name');
    await copyFile(join(referencesDir(p.sessionId),a.stored_name),join(refs,String(i+1).padStart(3,'0')+'-'+a.stored_name));
  }
  await writeFile(join(bookDir,'prompt.md'),p.prompt);
  const args={book_dir:bookDir,job_id:p.jobId,prompt:p.prompt,engine,references:refs,config:configFile,model:p.modelSelection.model,release};
  const request=join(task,'request.json');await writeFile(request,JSON.stringify(args,null,2));
  await writeFile(join(bookDir,'_meta.json'),JSON.stringify({mode:p.mode,harness:'seko-v1',model_selection:p.modelSelection,assets,engine_release:release,host_sha256:Object.fromEntries(['seko-run.py','seko-provider.py','seko-audit.py','seko-intake.py'].map(f=>[f,createHash('sha256').update(readFileSync(join(task,f))).digest('hex')]))},null,2));
  const env={PATH:process.env.PATH,LANG:'C.UTF-8',PYTHONUNBUFFERED:'1',PYTHONDONTWRITEBYTECODE:'1',
    CHROME_PATH:config.raw.runtime_binaries?.chrome_bin_host??config.runtimeBinaries.chromeBin,
    FFMPEG_BIN:config.runtimeBinaries.ffmpeg??'ffmpeg',CVW_JOB_TOKEN:jobToken(ws,p.jobId),CVW_SEKO_API_KEY:key};
  return {ws,bookDir,viewPath:ws,promptPath:join(bookDir,'prompt.md'),skills:['seko-blockout'],skillsetName:release,assetFiles:assets.map(a=>a.stored_name),
    isContinuation:(await readdir(join(bookDir,'..'))).length>1,seko:{cmd:config.raw.runtime_binaries?.videokit_venv_python??config.runtimeBinaries.python??'python3',args:[join(task,'seko-run.py'),request],cwd:task,env,output:join(task,'output')}};
}

export function sekoEvents(line) {
  let v;try{v=JSON.parse(line);}catch{return [];}
  if(v.type!=='seko') {
    if(v.event && v.case) {
      const name=String(v.event);
      const phase=name.startsWith('compile')||name.startsWith('review')?'VALIDATING':name==='package'?'FINALIZING':'GENERATING';
      const label=name==='plan'?'正在等待模型生成初稿':name.startsWith('repair')?'正在按自检问题修正':name.startsWith('compile')?'正在验证工程并生成真实画面':name.startsWith('review')?'正在核对画面与原始要求':'正在整理工程产物';
      return [{kind:'system',subtype:label,phase}];
    }
    return [];
  }
  if(v.event==='message')return [{kind:'assistant_text',text:v.text}];
  if(v.event==='complete')return [{kind:'result',is_error:!v.ok,subtype:v.ok?'success':'error',result_text:null}];
  if(v.event==='phase')return [{kind:'system',subtype:v.text,phase:v.phase}];
  return [];
}
export function sekoResult(bookDir) {try{return JSON.parse(readFileSync(join(bookDir,'seko/result.json')));}catch{return null;}}
