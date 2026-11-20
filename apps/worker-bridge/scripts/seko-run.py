#!/usr/bin/env python3
"""One job process, one immutable Seko round. Queue/lease/cancellation belong to dev."""
import contextlib,hashlib,importlib.util,json,os,shutil,subprocess,sys,time,traceback,zipfile
from pathlib import Path

def read(p):return json.loads(Path(p).read_text())
def write(p,v):
    p=Path(p);p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_suffix(p.suffix+'.tmp');tmp.write_text(json.dumps(v,ensure_ascii=False,indent=2));tmp.replace(p)
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def emit(event,**kwargs):print(json.dumps({'type':'seko','event':event,**kwargs},ensure_ascii=False),flush=True)
def safe(root,name):
    p=(Path(root)/name).resolve()
    if not p.is_relative_to(Path(root).resolve()) or not p.is_file():raise ValueError('Invalid artifact path')
    return p

def capture_timings(root):
    """Measured client upload is separable; API wait still includes queue/inference."""
    result={'api_calls':0,'api_complete_calls':0,'api_seconds':0.0,'api_connect_seconds':0.0,'api_upload_seconds':0.0,'api_response_wait_seconds':0.0,'api_download_seconds':0.0,'stages':[]}
    for folder in sorted(Path(root).glob('[0-9][0-9][0-9][0-9]')):
        def data(name):
            p=folder/name
            return read(p) if p.exists() else {}
        meta=data('metadata.json');receipt=data('receipt.json');transport=data('transport.json')
        row={'capture':folder.name,'stage':meta.get('stage','unknown'),'complete':receipt.get('complete',False),'seconds':receipt.get('seconds',0.0),'upload_seconds':transport.get('submit_seconds',0.0)}
        result['stages'].append(row);result['api_calls']+=1;result['api_complete_calls']+=int(row['complete'])
        result['api_seconds']+=row['seconds']
        for key,field in [('api_connect_seconds','connect_seconds'),('api_upload_seconds','submit_seconds'),('api_response_wait_seconds','response_headers_seconds'),('api_download_seconds','response_body_seconds')]:
            result[key]+=transport.get(field,0.0)
    return result

def past_rounds(book):
    result=[]
    for p in book.parent.glob('*/seko/result.json'):
        if p.parent.parent==book or not (p.parent.parent/'.done').exists():continue
        r=read(p)
        if r.get('harness')=='seko-v1':result.append((r['finished_at'],p,r))
    return sorted(result,key=lambda v:v[0])

INTAKE='''You are the intake stage for a Seko Three.js whitebox workflow. Users speak natural language, never require them to write technical formats. This intake stage receives attachment labels, not image pixels. The scene author will inspect every reference image in the generation stage. Preserve references and user wording; do not invent image contents or ask users to transcribe their images. Return ONLY JSON. Use one of:
{"action":"clarify","text":"concise question in user's language"}, {"action":"answer","text":"answer based on actual saved project"}, {"action":"refine","request":"user's exact requested edit, preserving prior decisions"}, or {"action":"generate","input":{"version":2,"duration":SECONDS,"work_prompt":"original story and requirements","segments":[{"id":"seg_001","title":"...","duration":SECONDS,"resolved_duration":SECONDS,"start":0,"end":SECONDS,"prompt":"verbatim segment text; create shot markers only when the user provided no shot structure"}]}}.
For initial generation keep every explicit story event, actor, shot and duration, camera/POV/roll and dialogue metadata, and reference identities. No added story beats, no merged/reordered explicit shots. Preserve any supplied segment IDs and all dialogue/camera instructions verbatim in segment prompt text; do not paraphrase or shorten an already detailed storyboard. Do not invent per-shot duration lines when the user intentionally leaves them to be decided within a fixed segment; the scene author will allocate them. Only explicit per-shot durations become hard constraints. Story <=300s, all segments contiguous and shot times fit. For prose without shot numbering create the smallest necessary shot plan faithful to the original. Ask a question for missing required story/duration or contradictions; resolve harmless artistic details lightly. Already supplied facts must not be asked again. Full prior user turns are supplied below. If a saved delivered project exists, edits use refine, explanations use answer, ambiguous changes use clarify; do not restart the story. Do not promise nonexistent outputs or claim tool checks. In later turns the intake stage routes edits using saved project facts; it does not receive new visual evidence, so never invent a fresh image inspection. Detailed visual verification happens during the engine edit/review stages. A fresh initial task with concrete details uses generate. No engine or technical directions belong in user questions.'''

def business_input(raw):
    """Read the upstream text-plus-JSON format without an LLM rewriting its shots.

    Surrounding user instructions are retained in work_prompt. Ordinary prose
    still uses conversational intake; malformed business data is not repaired here.
    """
    begin=raw.find('{')
    if begin<0:return None
    try:value,end=json.JSONDecoder().raw_decode(raw[begin:])
    except ValueError:return None
    if not isinstance(value,dict) or value.get('version')!=2 or not isinstance(value.get('segments'),list):return None
    prefix=raw[:begin].strip();suffix=raw[begin+end:].strip()
    surrounding='\n'.join(part for part in (prefix,suffix) if part)
    if surrounding:value={**value,'work_prompt':value.get('work_prompt','')+'\n用户附加说明（原文）：\n'+surrounding}
    return value

AUDIT = None

def main():
    global AUDIT
    args=read(sys.argv[1]);book=Path(args['book_dir']);work=book/'seko';work.mkdir(parents=True,exist_ok=True)
    start=time.monotonic();engine=Path(args['engine']);sys.path.insert(0,str(engine/'python'))
    spec=importlib.util.spec_from_file_location('seko_host_provider',Path(__file__).with_name('seko-provider.py'));mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
    from seko_engine import harness
    from seko_engine.provider import parse_json
    harness.Provider=mod.Provider
    mod.Provider.capture_root=work/'capture'
    audit_spec=importlib.util.spec_from_file_location('seko_audit',Path(__file__).with_name('seko-audit.py'));audit_mod=importlib.util.module_from_spec(audit_spec);audit_spec.loader.exec_module(audit_mod)
    AUDIT=audit_mod.RoundAudit(work,args).install(mod.Provider)
    if (engine/'python/seko_engine/media.py').is_file():
        from seko_engine.media import optimize_image
        mod.Provider.image_optimizer=staticmethod(optimize_image)
    else:mod.Provider.image_optimizer=None
    history=past_rounds(book)
    turns=[{'user':r['user_prompt'],'assistant':r.get('message'),'outcome':r.get('status'),'job_id':r['job_id']} for _,_,r in history]
    turns.append({'user':args['prompt']});mod.Provider.context=json.dumps(turns,ensure_ascii=False)
    write(work/'conversation.json',turns)
    provider=mod.Provider(args['config'],'selected')
    latest=next(((p,r) for _,p,r in reversed(history) if r.get('scene_success')),None)
    refs=Path(args['references']);images=[(p.name,p) for p in sorted(refs.iterdir()) if p.suffix.lower() in ('.png','.jpg','.jpeg','.webp')]
    emit('phase',phase='PLANNING',text='正在理解白模需求')
    user=args['prompt'];initial=business_input(user) if not latest else None
    supplied_business_input = initial is not None
    compact_intake = not latest and (engine/'python/seko_engine/intake.py').is_file()
    intake_seconds=0
    if initial is None:
        context={}
        if latest:
            previous=latest[0].parent/'run';a=read(previous/'artifact.json');project=read(safe(previous,a['project']))
            context={'duration':project['duration'],'segments':project['segments'],'shots':project['shot_plan'],'entities':project['entities'],'known_issues':latest[1].get('issues',[]),'reference_usage':project.get('reference_usage',[]),'model':args['model']}
        t=time.monotonic()
        if compact_intake:
            # Only opt-in releases use compact intake. Existing pinned releases
            # and all follow-up routing keep their established behavior.
            from seko_engine.intake import decide
            decision=decide(provider,parse_json,turns,images,write,work)
        else:
            reply=provider.call(INTAKE+'\nLATEST_DELIVERED_PROJECT:'+json.dumps(context,ensure_ascii=False)+'\nREFERENCE_ATTACHMENTS:'+json.dumps([{'id':f'reference_{i+1}','filename':label} for i,(label,_) in enumerate(images)],ensure_ascii=False),[],effort='low',json_mode=True)
            decision=parse_json(reply['text'])
        intake_seconds=time.monotonic()-t
        write(work/'intake.json',decision)
        if decision.get('action') in ('clarify','answer'):
            text=decision.get('text','').strip()
            if not text:raise ValueError('Empty conversational response')
            result={'harness':'seko-v1','job_id':args['job_id'],'status':'waiting_user' if decision['action']=='clarify' else 'answered','scene_success':False,'user_prompt':user,'message':text,'response':{'kind':'clarification' if decision['action']=='clarify' else 'answer','text':text},'finished_at':time.time(),'timings':{'engineering_seconds':time.monotonic()-start,'video_seconds':0}}
            write(work/'result.json',result);emit('message',text=text);emit('complete',ok=True);return
        if latest and decision.get('action')!='refine':raise ValueError('Existing project must be refined or explicitly clarified; history retained')
        if not latest:
            if decision.get('action')!='generate':raise ValueError('No delivered project to refine')
            initial=decision['input']
    if initial:
        # Business JSON already supplies the exact shot text. Natural-language
        # intake additionally carries original user wording once, not in three copies.
        if not supplied_business_input and not compact_intake:
            initial['work_prompt']=initial.get('work_prompt','')+'\n原始用户对话（逐字保留）：\n'+json.dumps([t['user'] for t in turns],ensure_ascii=False)
        write(work/'input.json',initial)
        mod.Provider.context=''  # original task is already present in every engine phase
    else:
        # The frozen task carries the original story; latest source carries prior edits.
        mod.Provider.context=json.dumps(turns[1:],ensure_ascii=False)
    emit('phase',phase='GENERATING',text='正在生成 Three.js 工程')
    result=harness.run(work/'input.json' if initial else None,refs,args['config'],'selected',work/'run',args['job_id'],
        seed_run=latest[0].parent/'run' if latest else None,refinement_request=user if latest else None)
    engineering=time.monotonic()-start
    transport_timing=capture_timings(work/'capture')
    transport_timing['engineering_excluding_measured_upload_seconds']=max(0.0,engineering-transport_timing['api_upload_seconds'])
    transport_timing['timing_note']='Excludes client request-body send time only; response wait may include upstream upload, queue and inference. Video measured separately.'
    if not result.get('scene_success'):raise RuntimeError(result.get('error') or 'No renderable whitebox project')
    run=work/'run';a=read(run/'artifact.json');project=safe(run,a['project']);source=safe(run,a['source'])
    if a.get('sha256') and sha(project)!=a['sha256']:raise ValueError('Artifact hash mismatch')
    if latest and (a['sha256']==read(latest[0].parent/'run/artifact.json')['sha256'] or sha(source)==sha(safe(latest[0].parent/'run',read(latest[0].parent/'run/artifact.json')['source']))):
        raise RuntimeError('本轮未能应用修改，上一版工程已保留。'+str(result.get('error') or '请结合本轮错误调整修改要求。'))
    data=read(project);export=work/'export';export.mkdir()
    shutil.copyfile(project,export/'project.json');shutil.copyfile(source,export/'source.js')
    shutil.copytree(engine/'runtime',export/'runtime');shutil.copyfile(engine/'package.json',export/'package.json');shutil.copyfile(engine/'package-lock.json',export/'package-lock.json')
    shutil.copyfile(work/'run/task.json',export/'task.json')
    task=read(export/'task.json');task.pop('source_input',None)
    for r in task.get('references',[]):r.pop('local_path',None)
    write(export/'task.json',task)
    (export/'README.txt').write_text('Seko Three.js 工程\nsource.js 为模型生成的 buildScene ES module，依赖 runtime/helpers.js 与 Three.js 0.180.0。\nproject.json 为已编译的可回放工程。业务建议使用 runtime/project.js 的 loadProject(project)，逐帧 setTime(绝对秒)，并调用 renderer.render(view.scene, view.camera)。\n人物/镜头/时间轴由 project.json 提供；运行时不包含模型 key，不需要模型调用。\n本包由平台按实际依赖打包。three / puppeteer 版本见 package-lock.json，视频渲染不属于业务接入要求。\n')
    manifest={str(p.relative_to(export)):sha(p) for p in sorted(export.rglob('*')) if p.is_file()};write(export/'MANIFEST.json',manifest)
    zip_path=work/'source.zip'
    with zipfile.ZipFile(zip_path,'w',zipfile.ZIP_DEFLATED) as z:
        for p in sorted(export.rglob('*')):
            if p.is_file():z.write(p,p.relative_to(export))
    emit('phase',phase='RENDERING',text='工程已生成，正在渲染剧情相机视频')
    render_start=time.monotonic();output=work/'output';output.mkdir(exist_ok=True)
    env=dict(os.environ);env.pop('CVW_SEKO_API_KEY',None)
    proc=subprocess.run(['node',str(engine/'tools/render-video.mjs'),'--project',str(project),'--out',str(output/'final.mp4')],env=env,capture_output=True,text=True,timeout=1800)
    (work/'render.log').write_text(proc.stdout+'\n'+proc.stderr)
    if proc.returncode:raise RuntimeError('Whitebox video rendering failed; project retained: '+proc.stderr[-1500:])
    issues=read(source.parent/'issues.json') if (source.parent/'issues.json').exists() else []
    if result.get('error'):issues.append({'code':'engine_error','message':result['error']})
    message='白模工程与视频已生成，可预览视频或下载工程。'+('仍有未确认或已知质量问题，请结合结果说明检查。' if result['status']!='self_checked' else '已通过有限自检，效果请以预览为准。')
    final={'harness':'seko-v1','release':args['release'],'job_id':args['job_id'],'model':args['model'],'status':result['status'],'scene_success':True,'structure_pass':result.get('structure_pass'),'user_prompt':user,'message':message,'issues':issues,'repairs':result.get('repairs'),'duration':data['duration'],'shot_count':len(data['shot_plan']),'reference_count':len(task.get('references',[])), 'parent_job_id':latest[1]['job_id'] if latest else None,'finished_at':time.time(), 'export':{'file':'source.zip','sha256':sha(zip_path),'size_bytes':zip_path.stat().st_size},'timings':{**transport_timing,'intake_seconds':intake_seconds,'engineering_seconds':engineering,'model_seconds':result.get('model_seconds'),'tool_seconds':result.get('tool_seconds'),'video_seconds':time.monotonic()-render_start,'total_seconds':time.monotonic()-start}}
    write(work/'result.json',final);emit('message',text=message);emit('complete',ok=True)

if __name__=='__main__':
    completed=False
    try:
        main();completed=True
    except Exception as e:
        # Provider strips credentials; never print configuration or environment.
        secret=os.environ.get('CVW_SEKO_API_KEY','');text=str(e);text=text.replace(secret,'[REDACTED]') if secret else text
        emit('message',text='白模执行失败：'+text[:1500]);emit('complete',ok=False);sys.exit(1)

    finally:
        if AUDIT is not None:AUDIT.close(completed)
