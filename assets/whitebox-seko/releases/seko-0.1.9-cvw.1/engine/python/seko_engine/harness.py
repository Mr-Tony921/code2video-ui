import datetime,hashlib,json,os,shutil,subprocess,time,traceback
from pathlib import Path
from .io import ENGINE,read,write,sha
from .provider import Provider,parse_json,parse_source,normalize_source,source_payload,apply_source_patch
from .line_patches import numbered_source,PATCH_PROTOCOL
from .normalize import normalize
from .review_contract import validated_review,ReviewContractError
from .evidence import build_sheets,reference_sheets,changed_shots,repair_shot_scope

class ModelCallError(RuntimeError):
    """Provider failure is not a source defect and must never start a repair."""
    def __init__(self,stage,message):
        self.stage=stage
        super().__init__(message)

SKILL=ENGINE/'skills/seko-blockout'
def phase_skill(stage):
    text=(SKILL/'SKILL.md').read_text()
    if stage=='author':return text
    # Keep every geometry/camera/product policy; only the initial workflow's
    # author/plan/package instructions are irrelevant to a review/local edit.
    first=text.index('## Initial story');last=text.index('## Minimal readable geometry',first)
    return text[:first]+'## Current stage\nExecute only the current review or targeted patch. The host performs compilation, checks and packaging. Initial draft plus at most two corrections; follow-up edit plus at most one correction. Never restart planning, fabricate tool evidence or add polish. The original task and latest evidence below remain authoritative.\n\n'+text[last:]

def stamp():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def fingerprint():
    files={str(p.relative_to(ENGINE)):sha(p) for p in sorted(ENGINE.rglob('*')) if p.is_file() and not {'__pycache__','node_modules'}.intersection(p.parts)}
    return {'version':read(ENGINE/'package.json')['version'],'files':files,'sha256':hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest()}
def model_task(task):
    return {k:v for k,v in task.items() if k not in ('source_input','references','segments')}|{'references':[{'id':r['id'],'filename':r['filename']} for r in task['references']], 'segments':[{k:v for k,v in s.items() if k!='prompt'}|{'context':s['prompt'].split('【镜头')[0].split('分镜')[0]} for s in task['segments']]}

def carry_failures(previous,error):
    return previous + [error] if previous else [error]

def unavailable_review_issues(previous,current,error):
    # A new valid source is not evidence that the previous semantic finding was
    # resolved. Preserve it as unverified, without mutating the previous round or
    # claiming that the edited scene still demonstrably has the same defect.
    result=list(current)
    canonical=lambda item:json.dumps({k:v for k,v in item.items() if k!='recheck_status'},sort_keys=True)
    seen={canonical(item) for item in current}
    for item in previous:
        if item.get('code') in ('model_call_unavailable','review_contract'):continue
        key=canonical(item)
        if key not in seen:
            result.append(dict(item,recheck_status='unavailable'));seen.add(key)
    return result+[error]

def run(input_file,references,config,model,out,case_id=None,seed_run=None,refinement_request=None):
    out=Path(out).resolve()
    if (out/'job.json').exists():raise ValueError('Existing job; use resume protocol, never overwrite')
    out.mkdir(parents=True,exist_ok=True);start=time.monotonic();provider=Provider(config,model)
    job={'job_id':out.name,'case_id':case_id,'model':model,'version':'0.1.9','status':'running','started_at':stamp(),'phase':'normalize','repairs':0,'model_seconds':0,'tool_seconds':0,'target_seconds':600,'max_repairs':1 if seed_run else 2,'kind':'source_refinement' if seed_run else 'initial','candidates':[],'user_approval':'pending','engine':fingerprint()}
    def save():job['elapsed_seconds']=time.monotonic()-start;write(out/'job.json',job)
    def phase(name):job['phase']=name;save();print(json.dumps({'event':name,'case':case_id,'model':model,'elapsed':round(job['elapsed_seconds'],2)}),flush=True)
    def invoke(name,prompt,images=(),effort='low',json_mode=False):
        phase(name);write(out/(name+'-request.json'),{'prompt':prompt,'images':[{'label':l,'sha256':sha(p)} for l,p in images],'effort':effort,'json_mode':json_mode})
        began=time.monotonic()
        provider.current_stage=name
        try:response=provider.call(prompt,images,effort,json_mode)
        except Exception as e:
            elapsed=time.monotonic()-began;job['model_seconds']+=elapsed;write(out/(name+'-result.json'),{'failed':True,'seconds':elapsed,'error':provider.clean(str(e)),'effort_requested':effort});save()
            if type(e).__name__ == 'ContextLimitError': raise
            raise ModelCallError(name,provider.clean(str(e))) from e
        job['model_seconds']+=response['seconds'];
        write(out/(name+'-result.json'),{k:v for k,v in response.items() if k!='text'});(out/(name+'-response.txt')).write_text(response['text']);save();return response['text']
    last_valid=None;issues=[];source='';prior_review=None;prior_review_candidate=None
    try:
        task=read(Path(seed_run)/'task.json') if seed_run else normalize(input_file,references);task['case_id']=case_id or task.get('case_id');job['case_id']=task['case_id'];write(out/'task.json',task)
        tasktext=json.dumps(model_task(task),ensure_ascii=False,separators=(',',':'))
        refs=[(r['id'],Path(r['local_path'])) for r in task['references']]
        refpages=reference_sheets(task,out/'reference-review')
        instruction=phase_skill('author')+'\n'+(SKILL/'references/source-contract.md').read_text()
        edit_instruction=phase_skill('edit')+'\n'+(SKILL/'references/source-contract.md').read_text()
        prompt=instruction+'\nCURRENT CALL: Author the complete initial JS module only. Tools and visual review are executed in later phases; do not simulate their results now. Inspect attached references. Return only the complete JS module, no markdown. Use supplied helpers for concise executable geometry/tracks; no video export or extra performance detail.\nORIGINAL_TASK:\n'+tasktext
        if seed_run:
            seed=Path(seed_run).resolve();seed_artifact=read(seed/'artifact.json');seed_project=read(seed/seed_artifact['project'])
            if seed_project.get('edits'):raise ValueError('Source refinement cannot overwrite manual overlays; use scoped revise on the latest workspace instead')
            if not refinement_request or not refinement_request.strip():raise ValueError('A concrete refinement request is required')
            selected=(seed/seed_artifact['source']).parent;source=(seed/seed_artifact['source']).read_text()
            last_valid=out/'candidate-base';shutil.copytree(selected,last_valid)
            job.update(parent_run=str(seed),parent_project_sha256=sha(seed/seed_artifact['project']),refinement_request=refinement_request)
            issues=read(selected/'issues.json') if (selected/'issues.json').exists() else []
            prior_review=read(selected/'review.json') if (selected/'review.json').exists() else None;prior_review_candidate=last_valid
            prompt=edit_instruction+'\nCURRENT CALL: Refine the supplied source ONLY for the explicit request and still-unresolved factual issues. Preserve all unrelated geometry, cast, timing, original shot IDs and camera instructions. Do not replan or beautify. '+PATCH_PROTOCOL+'\nORIGINAL_TASK:'+tasktext+'\n'+numbered_source(source)+'\nREQUEST:'+refinement_request+'\nUNRESOLVED:'+json.dumps(issues,ensure_ascii=False)
            scope={i.get('shot_id') for i in issues if i.get('shot_id')};sheets=build_sheets(last_valid/'output',scope) if scope else build_sheets(last_valid/'output');folder=last_valid/'output'/('review-scope' if scope else 'review')
            answer=invoke('refine',prompt,[(s['file'],folder/s['file']) for s in sheets]+refpages,effort='high',json_mode=True)
        else:answer=invoke('plan',prompt,refs)
        for revision in range(job['max_repairs']+1):
            job['repairs']=revision;candidate=out/f'candidate-{revision:02d}';candidate.mkdir(exist_ok=True)
            previous_issues=issues
            record={'revision':revision,'scene_success':False,'structure_pass':False,'semantic_self_check':'unknown'};job['candidates'].append(record)
            try:
                if revision or seed_run:
                    source=apply_source_patch(source,answer)
                    normalization={'kind':'patch','original_response_preserved':True}
                else:
                    source=answer.strip()  # retain even malformed transport containers
                    source=source_payload(source)
                    source,normalization=normalize_source(source)
                (candidate/'source.js').write_text(source)
                write(candidate/'normalization.json',normalization)
                phase(f'compile-{revision}');t=time.monotonic()
                command=['node',str(ENGINE/'tools/probe.mjs'),'--source',str(candidate/'source.js'),'--task',str(out/'task.json'),'--out',str(candidate/'output')]
                result=subprocess.run(command,capture_output=True,text=True,timeout=210,env={k:v for k,v in os.environ.items() if k != 'CVW_SEKO_API_KEY'});job['tool_seconds']+=time.monotonic()-t
                (candidate/'tool.log').write_text(result.stdout+'\n'+result.stderr)
                probe=read(candidate/'output/probe.json') if (candidate/'output/probe.json').exists() else {'ok':False,'errors':[result.stderr[-3000:]]}
                issues=[{'technical':x} for x in probe.get('errors',[])]
                checks=read(candidate/'output/checks.json') if (candidate/'output/checks.json').exists() else {'pass':False,'errors':[]}
                issues+=checks.get('errors',[])
                focus_checks=read(candidate/'output/focus-checks.json') if (candidate/'output/focus-checks.json').exists() else {'pass':None,'errors':[]}
                issues+=focus_checks['errors']
                record.update(scene_success=bool(probe.get('ok')),structure_pass=checks.get('pass',False),probe_seconds=probe.get('seconds'))
                if record['scene_success']:
                    last_valid=candidate;job.setdefault('first_scene_seconds',time.monotonic()-start)
                    project=read(candidate/'output/project.json')
                    required={s['id'] for s in project['shot_plan']};scope=required
                    if prior_review is not None:
                        scope=changed_shots(prior_review_candidate/'output',candidate/'output')
                        unresolved=previous_issues+issues+prior_review.get('issues',[])
                        from .evidence import retain_review_findings
                        scope=retain_review_findings(scope,prior_review,unresolved,required)
                    if not scope:scope={s['id'] for s in project['shot_plan'][:1]}  # bounded sanity evidence, never invent a model review
                    scoped=scope!=required;sheets=build_sheets(candidate/'output',scope) if scoped else build_sheets(candidate/'output');sheetfolder=candidate/'output'/('review-scope' if scoped else 'review')
                    images=[(s['file'],sheetfolder/s['file']) for s in sheets]+refpages
                    write(candidate/'review-scope.json',{'shots':sorted(scope),'all_shots':sorted(required),'policy':'changed metadata, sampled images, track neighborhoods intersected with proven old/new visibility, prior warning shots and all unresolved checks; original reference pages retained'})
                    # Source tracks are executable facts; do not flood context with every mesh's state.
                    facts={'entities':[{k:v for k,v in e.items() if k not in ('uuid','parent')} for e in project['entities']], 'shot_plan':project['shot_plan'],'animation':project['animation'],'reference_usage':project['reference_usage']}
                    if (candidate/'output/subject-observations.json').exists():
                        from .evidence import compact_subject_observations
                        observations=read(candidate/'output/subject-observations.json');facts['subject_observations']=compact_subject_observations(observations,scope)
                    technical={'structure':checks,'focus':focus_checks,'actual_render':probe,'seek':read(candidate/'output/determinism.json')}
                    review_prompt=phase_skill('review')+'\n'+(SKILL/'references/review.md').read_text()+'\nORIGINAL_TASK:'+tasktext+'\nACTUAL_FACTS:'+json.dumps(facts,ensure_ascii=False,separators=(',',':'))+'\nPAGES:'+json.dumps([label for label,_ in images])+'\nTECHNICAL_CHECKS:'+json.dumps(technical,ensure_ascii=False)+'\nCURRENT_REVIEW_SCOPE:'+json.dumps(sorted(scope))+'\nFor this call cover exactly these scoped shot IDs. Other shots inherit the prior review after unchanged sampled images and unaffected track intervals; do not re-review or invent new requirements for them. This is finite evidence, not proof of all frames.'
                    raw_review=invoke(f'review-{revision}',review_prompt,images,effort='low',json_mode=True)
                    try:review=parse_json(raw_review)
                    except (ValueError,TypeError) as e:raise ReviewContractError(['review JSON is invalid']) from e
                    write(candidate/'review-response.json',review)
                    pages={label for label,_ in images};review=validated_review(review,scope,pages,facts.get('subject_observations'));seen=set(review['seen'])
                    issues+=review.get('issues',[]);record['semantic_self_check']='pass' if not issues else 'issues'
                    if scoped:
                        review['inherited_from']=str(prior_review_candidate.relative_to(out));review['newly_reviewed']=sorted(scope)
                        inherited=[dict(s,inherited=True) for s in prior_review['shots'] if s['id'] not in scope];review['shots']=sorted(review['shots']+inherited,key=lambda s:s['id'])
                        review['warnings']=review.get('warnings',[])+['Unchanged shots inherit prior finite-sample review; no all-frame certification.']
                    write(candidate/'review.json',review)
                    if len(review['shots'])==len(required) and {s['id'] for s in review['shots']}==required and pages.issubset(seen):prior_review=review;prior_review_candidate=candidate
                    else:prior_review=None;prior_review_candidate=None
                write(candidate/'issues.json',issues);save()
            except Exception as e:
                if isinstance(e,ReviewContractError):
                    issues=unavailable_review_issues(previous_issues,issues,{'code':'review_contract','stage':f'review-{revision}','errors':e.errors})
                    write(candidate/'issues.json',issues);record['error']=issues;record['semantic_self_check']='incomplete'
                    job['self_check_unavailable']=True;job['failed_review_stage']=f'review-{revision}';save();raise
                if isinstance(e,ModelCallError):
                    # Keep factual check findings, but never ask source repair to fix the network.
                    issues=unavailable_review_issues(previous_issues,issues,{'code':'model_call_unavailable','stage':e.stage,'message':provider.clean(str(e))})
                    write(candidate/'issues.json',issues);record['error']=issues;record['semantic_self_check']='incomplete'
                    job['self_check_unavailable']=True;job['failed_model_stage']=e.stage;save();raise
                if type(e).__name__ == 'ContextLimitError': raise
                issues=carry_failures(previous_issues,{'code':'candidate_error','message':provider.clean(str(e))});write(candidate/'issues.json',issues);record['error']=issues;save()
            if not issues:
                job['status']='self_checked';job['selected_candidate']=str(candidate.relative_to(out));break
            repair_issues=[i for i in issues if i.get('repairable',True)]
            if not repair_issues:
                job['status']='renderable_with_issues' if last_valid else 'failed'
                if last_valid:job['selected_candidate']=str(last_valid.relative_to(out))
                job['stop_reason']='quality_evidence_unresolved_without_demonstrated_source_defect'
                break
            if revision<job['max_repairs']:
                repair_prompt=edit_instruction+'\nCURRENT CALL: Make only targeted edits for the listed factual blockers; do not replan or beautify the complete story. Keep edits short and preserve all unaffected geometry/timing/identity. '+PATCH_PROTOCOL+'\nORIGINAL_TASK:'+tasktext+'\n'+numbered_source(source)+'\nFAILURES:'+json.dumps(repair_issues,ensure_ascii=False)+'\nUNVERIFIED_QUALITY_FINDINGS_DO_NOT_EDIT:'+json.dumps([i for i in issues if not i.get('repairable',True)],ensure_ascii=False)
                repair_images=images if record['scene_success'] and 'images' in locals() else refs
                # A non-renderable draft still has original image references; never
                # turn a wrapper/compile repair into ungrounded scene regeneration.
                if record['scene_success'] and repair_images:
                    local_scope=repair_shot_scope(repair_issues,{s['id'] for s in project['shot_plan']})
                    if local_scope:
                        # Unique folder: never overwrite screenshots referenced by an earlier capture.
                        repair_sheets=build_sheets(candidate/'output',local_scope,folder_name='repair-evidence')
                        repair_images=[('repair-'+s['file'],candidate/'output/repair-evidence'/s['file']) for s in repair_sheets]+refpages
                        write(out/f'repair-{revision+1}-evidence.json',{'shots':sorted(local_scope),'pages':[label for label,_ in repair_images],'policy':'All blocker shots start/middle/end plus original reference sheets; full source/task retained. Subsequent replay and changed/unresolved-shot review unchanged.'})
                        repair_prompt+='\nREPAIR_EVIDENCE_SCOPE:'+json.dumps(sorted(local_scope))+'. These are actual frames for every reported blocker plus original reference sheets. The complete source and original task above remain authoritative. Unrelated shots will be replayed and changed/unresolved shots reviewed after applying edits.'
                if record['scene_success']:
                    # Geometry suggestions are not edits or extra model reflections.
                    # The model still applies a scoped source patch; actual replay
                    # and visual review validate it afterwards. No image/geometry
                    # changes occur here, and a tool failure does not spend repair.
                    scope=repair_shot_scope(repair_issues,{s['id'] for s in project['shot_plan']})
                    if scope:
                        proposal_path=out/f'repair-{revision+1}-camera-proposals.json';began=time.monotonic()
                        try:
                            command=['node',str(ENGINE/'tools/camera-proposals.mjs'),'--project',str(candidate/'output/project.json'),'--scope',','.join(sorted(scope)),'--out',str(proposal_path)]
                            proposal_run=subprocess.run(command,capture_output=True,text=True,timeout=25,env={k:v for k,v in os.environ.items() if k!='CVW_SEKO_API_KEY'})
                            if proposal_run.returncode:raise ValueError('Camera suggestion tool unavailable')
                            proposals=read(proposal_path)
                            if proposals.get('project_sha256')!=sha(candidate/'output/project.json'):raise ValueError('Camera suggestion source mismatch')
                            compact=[{'shot_id':row['shot_id'],'interval':row['interval'],'original_checks':[{k:c[k] for k in ('entity_id','time','pass','in_frame','unoccluded','front_dot')} for c in row['original_checks']],'proposals':[{k:v for k,v in p.items() if k!='checks'} for p in row['proposals'][:2]],'limitations':row['limitations']} for row in proposals['rows'] if row['proposals']]
                            if compact:
                                repair_prompt+='\nOPTIONAL_GEOMETRY_CAMERA_SUGGESTIONS:'+json.dumps(compact,ensure_ascii=False,separators=(',',':'))+'\nThese are unapplied static camera numeric candidates tested against the listed actual point visibility/front and currently visible declared subjects at the stated times, NOT semantic/all-frame acceptance. Prefer one only if consistent with the original shot framing/POV; otherwise explain the conflict and use a local alternative. Apply the chosen position/target/FOV to this camera interval in CURRENT_SOURCE; preserve all surrounding intervals, subject geometry and required motion. Never remove a focus/subject or make it transparent to satisfy a check. Do not blindly infer passing story quality from these suggestions. Actual replay and review follow.'
                        except Exception as e:
                            write(out/f'repair-{revision+1}-camera-unavailable.json',{'error':provider.clean(str(e)),'applied':False,'model_calls':0})
                        finally:job['tool_seconds']+=time.monotonic()-began
                answer=invoke(f'repair-{revision+1}',repair_prompt,repair_images,effort='high',json_mode=True)
        if job['status']=='running':
            job['status']='renderable_with_issues' if last_valid else 'failed'
            if last_valid:job['selected_candidate']=str(last_valid.relative_to(out))
        phase('package')
        if job.get('selected_candidate'):
            selected=out/job['selected_candidate'];project_path=selected/'output/project.json'
            project=read(project_path)
            write(out/'artifact.json',{'project':str(project_path.relative_to(out)),'source':str((selected/'source.js').relative_to(out)),'sha256':sha(project_path),'shot_plan':project['shot_plan'],'status':job['status'],'user_approval':'pending','revision':project['revision']})
            job['scene_success']=True;job['structure_pass']=read(selected/'output/checks.json')['pass']
        else:job['scene_success']=False;job['structure_pass']=False
    except Exception as e:
        if isinstance(e,ModelCallError):
            job['failed_model_stage']=e.stage
            if last_valid:
                # A failed follow-up must retain the prior source AND expose why the edit was not applied.
                selected_issues=read(last_valid/'issues.json') if (last_valid/'issues.json').exists() else []
                if not any(i.get('code')=='model_call_unavailable' and i.get('stage')==e.stage for i in selected_issues):
                    selected_issues.append({'code':'model_call_unavailable','stage':e.stage,'message':provider.clean(str(e))})
                write(last_valid/'issues.json',selected_issues);job['self_check_unavailable']=True
        job['status']='renderable_with_issues' if last_valid else 'failed';job['error']=provider.clean(str(e));job['traceback']=provider.clean(traceback.format_exc());job.setdefault('scene_success',False)
        if last_valid:
            project_path=last_valid/'output/project.json';project=read(project_path)
            job.update(selected_candidate=str(last_valid.relative_to(out)),scene_success=True,structure_pass=read(last_valid/'output/checks.json')['pass'])
            write(out/'artifact.json',{'project':str(project_path.relative_to(out)),'source':str((last_valid/'source.js').relative_to(out)),'sha256':sha(project_path),'shot_plan':project['shot_plan'],'status':job['status'],'user_approval':'pending','revision':project['revision']})
    job['finished_at']=stamp();job['phase']='finished';save();job['time_pass']=job['elapsed_seconds']<=600;write(out/'job.json',job)
    print(json.dumps({k:job.get(k) for k in ('job_id','model','case_id','status','scene_success','structure_pass','elapsed_seconds','model_seconds','repairs','error')},ensure_ascii=False),flush=True)
    return job
