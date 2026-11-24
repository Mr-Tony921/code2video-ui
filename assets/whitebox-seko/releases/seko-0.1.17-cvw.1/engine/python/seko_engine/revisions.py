"""Immutable scoped edits and compare-and-swap workspace heads."""
import copy,fcntl,json,math,subprocess,time
from contextlib import contextmanager
from pathlib import Path
from .io import ENGINE,read,write,sha
from .provider import Provider,parse_json
from .evidence import build_sheets

@contextmanager
def locked(workspace):
    workspace=Path(workspace);workspace.mkdir(parents=True,exist_ok=True)
    with (workspace/'.lock').open('a') as f:
        fcntl.flock(f,fcntl.LOCK_EX)
        try:yield workspace
        finally:fcntl.flock(f,fcntl.LOCK_UN)

def create_workspace(project,task,out):
    with locked(out) as root:
        if (root/'head.json').exists():raise ValueError('Workspace already exists')
        p=read(project);write(root/'revision-000/project.json',p);write(root/'task.json',read(task))
        head={'revision':0,'project':'revision-000/project.json','sha256':sha(root/'revision-000/project.json'),'imported_project_revision':p['revision']}
        write(root/'head.json',head);return head

def interval(project,scope):
    matches=[x for x in project['segments']+project['shot_plan'] if x['id']==scope]
    if len(matches)!=1:raise ValueError('Scope must identify one original segment or shot')
    return matches[0]['start'],matches[0]['end']

def apply_operations(project,operations,scope=None,entities=None):
    if not isinstance(operations,list) or not 1<=len(operations)<=32:raise ValueError('Need 1..32 operations')
    result=copy.deepcopy(project);ids={e['id'] for e in project['entities']}|{'__camera'}
    bounds=interval(project,scope) if scope else (0,project['duration'])
    for op in operations:
        kind=op.get('kind');field={'translate':'delta','freeze_position':'position','rotation':'rotation','visible':'visible'}.get(kind)
        if field is None or set(op)!={'kind','entity_id','start','end',field}:raise ValueError('Unsupported operation fields')
        if op['entity_id'] not in ids or entities is not None and op['entity_id'] not in entities:raise ValueError('Entity outside authorized scope')
        if not all(isinstance(op[k],(int,float)) and not isinstance(op[k],bool) and math.isfinite(op[k]) for k in ('start','end')) or not bounds[0]<=op['start']<op['end']<=bounds[1]:raise ValueError('Time outside authorized scope')
        values=op[field]
        if field=='visible':
            if not isinstance(values,bool):raise ValueError('Visibility must be boolean')
        elif not isinstance(values,list) or len(values)!=3 or any(not isinstance(v,(int,float)) or isinstance(v,bool) or not math.isfinite(v) or abs(v)>10000 for v in values):raise ValueError('Invalid finite local vector')
    result.setdefault('edits',[]).extend(copy.deepcopy(operations));result['revision']+=1
    result['provenance']['scoped_edit']=True
    return result

def publish(workspace,base_head,project,receipt):
    with locked(workspace) as root:
        current=read(root/'head.json')
        if current!=base_head:raise ValueError('Workspace changed during revision; candidate retained, head not overwritten')
        n=current['revision']+1;dest=root/f'revision-{n:03d}/project.json'
        if dest.exists():raise ValueError('Revision destination already exists')
        project['parent_sha256']=base_head['sha256'];write(dest,project);write(dest.parent/'receipt.json',receipt)
        head={'revision':n,'project':str(dest.relative_to(root)),'sha256':sha(dest)};write(root/'head.json',head);return head

def manual_edit(workspace,operations,expected_revision):
    root=Path(workspace);head=read(root/'head.json')
    if head['revision']!=expected_revision:raise ValueError('Stale revision')
    project=read(root/head['project']);result=apply_operations(project,operations)
    return publish(root,head,result,{'kind':'manual','status':'requires_scoped_review','operations':operations})

def revise(workspace,scope,entities,request,config,model,out):
    root=Path(workspace).resolve();out=Path(out).resolve()
    if (out/'job.json').exists():raise ValueError('Output job already exists')
    out.mkdir(parents=True,exist_ok=True);start=time.monotonic();head=read(root/'head.json');base=read(root/head['project']);task=read(root/'task.json')
    if sha(root/head['project'])!=head['sha256']:raise ValueError('Base project hash changed')
    lo,hi=interval(base,scope);allowed=set(entities)
    if not allowed or not allowed.issubset({e['id'] for e in base['entities']}|{'__camera'}):raise ValueError('Select authorized entity IDs')
    provider=Provider(config,model);job={'kind':'followup','status':'running','scope':scope,'entities':entities,'base_head':head,'request':request,'max_repairs':1,'user_approval':'pending','candidates':[]};write(out/'job.json',job)
    # Probe the latest saved project: this includes all preceding UI edits.
    command=['node',str(ENGINE/'tools/probe.mjs'),'--project',str(root/head['project']),'--task',str(root/'task.json'),'--out',str(out/'base-probe'),'--scope',scope]
    result=subprocess.run(command,capture_output=True,text=True,timeout=210)
    if result.returncode:raise ValueError('Latest project is not renderable; preserve it and report a technical recovery request')
    samples=read(out/'base-probe/states.json')+read(out/'base-probe/edit-boundaries.json');facts=[{'time':s['time'],'entities':{k:v for k,v in s['state']['entities'].items() if k in allowed}} for s in samples]
    selected=[s for seg in task['segments'] for s in seg['shots'] if s['id'] in {p['id'] for p in base['shot_plan'] if lo<=p['start'] and p['end']<=hi}]
    context={'user_request':request,'scope':scope,'start':lo,'end':hi,'authorized_entities':[e for e in base['entities'] if e['id'] in allowed],'shots':selected,'observed_states':facts}
    instruction=(ENGINE/'skills/seko-blockout/references/revisions.md').read_text()+'''\nReturn ONLY JSON {"operations":[...],"explanation":"..."} or {"unsupported":"reason"}. Allowed operations have EXACT fields: kind,entity_id,start,end and one of delta (translate), position (freeze_position), rotation (absolute Euler radians), visible (boolean). Vectors are local coordinates. Freeze uses observed local_position at the selected interval start. Do not change camera unless __camera is authorized. No additions to modeling, timing or geometry. Only authorized entities/times; descendants inherit parent edits. If a separately animated attachment needs an unauthorized edit, explicitly report unsupported instead of silently editing it. Avoid visual self-certification; tools will check the candidate.'''
    issues=[];last_valid=None
    for attempt in range(2):
        candidate=out/f'candidate-{attempt:02d}';candidate.mkdir();record={'attempt':attempt};job['candidates'].append(record)
        prompt=instruction+'\nCONTEXT:'+json.dumps(context,ensure_ascii=False)+'\nPREVIOUS_FAILURES:'+json.dumps(issues,ensure_ascii=False)
        try:
            response=provider.call(prompt,effort='low' if attempt==0 else 'high',json_mode=True);write(candidate/'model-result.json',response);answer=parse_json(response['text'])
            if answer.get('unsupported'):job.update(status='unsupported',reason=answer['unsupported']);break
            project=apply_operations(base,answer['operations'],scope,allowed);write(candidate/'project.json',project)
            cmd=command.copy();cmd[cmd.index('--project')+1]=str(candidate/'project.json');cmd[cmd.index('--out')+1]=str(candidate/'probe')
            probe=subprocess.run(cmd,capture_output=True,text=True,timeout=210);(candidate/'tool.log').write_text(probe.stdout+'\n'+probe.stderr)
            if probe.returncode:raise ValueError('Scoped rendering failed: '+probe.stderr[-1500:])
            invariant=subprocess.run(['node',str(ENGINE/'tools/compare-revisions.mjs'),'--base',str(root/head['project']),'--edited',str(candidate/'project.json'),'--scope',scope,'--entities',','.join(entities),'--out',str(candidate/'scope-checks.json')],capture_output=True,text=True,timeout=60)
            if invariant.returncode:raise ValueError('Revision invariants failed: '+invariant.stdout[-2000:])
            last_valid=candidate;record['renderable']=True
            sheets=build_sheets(candidate/'probe');images=[(s['file'],candidate/'probe/review'/s['file']) for s in sheets]
            review_prompt='Review only the requested change against actual screenshots and observed states. No unrelated beauty/modeling repairs. Return JSON {"pass":true|false,"issues":[],"limitations":[],"seen":[every sheet filename]}. Optional gestures are not required.\n'+json.dumps(context,ensure_ascii=False)+'\nOPERATIONS:'+json.dumps(answer['operations'],ensure_ascii=False)+'\nAFTER_STATES:'+json.dumps(read(candidate/'probe/states.json'),ensure_ascii=False)
            reviewed=provider.call(review_prompt,images,effort='low',json_mode=True);write(candidate/'review-result.json',reviewed);review=parse_json(reviewed['text']);write(candidate/'review.json',review)
            issues=review.get('issues',[])
            if not review.get('pass') or not {s['file'] for s in sheets}.issubset(set(review.get('seen',[]))):issues.append('Requested change or visual evidence review is incomplete')
            if not issues:
                receipt={'kind':'followup','status':'self_checked','scope':scope,'entities':entities,'operations':answer['operations'],'outside_scope':'Unchanged serialized geometry, tracks and earlier edits; only bounded overlay edits appended','elapsed_seconds':time.monotonic()-start,'user_approval':'pending'}
                job['head']=publish(root,head,project,receipt);job['status']='self_checked';break
        except Exception as e:issues=[provider.clean(str(e))];record['error']=issues
        write(candidate/'issues.json',issues)
    if job['status']=='running':job['status']='candidate_with_issues' if last_valid else 'failed'
    if last_valid:job['candidate_project']=str(last_valid/'project.json')
    job.update(issues=issues,elapsed_seconds=time.monotonic()-start);write(out/'job.json',job);return job
