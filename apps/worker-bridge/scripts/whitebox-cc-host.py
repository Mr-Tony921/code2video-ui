#!/usr/bin/env python3
"""CC host for the fingerprinted Blockout Previs 0.11.1 CLI; no model/provider code.

Keeps one measured directory, bounded candidates, actual Read evidence and scoped
follow-up edits. Original skill tools perform all compilation/review/validation.
"""
import contextlib, fcntl, hashlib, io, json, os, shlex, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CFG = json.loads((HERE / 'config.json').read_text())
ROOT = Path(CFG['workspace'])
JOB = ROOT / CFG['job']
SKILL = ROOT / CFG['skill']
STATE = HERE / 'state.json'

def read(p): return json.loads(Path(p).read_text())
def save(p, x):
    tmp = Path(str(p) + '.tmp')
    tmp.write_text(json.dumps(x, ensure_ascii=False, indent=2)); tmp.replace(p)
def digest(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def state(): return read(STATE)
def path(p):
    p = Path(p)
    return (p if p.is_absolute() else ROOT / p).resolve()
def inside(p, parent): return p == parent or parent in p.parents
def event(kind, **data):
    with (HERE / 'events.jsonl').open('a') as f:
        f.write(json.dumps({'at': time.time(), 'kind': kind, **data}, ensure_ascii=False) + '\n')
def deny(reason):
    return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny', 'permissionDecisionReason': reason}}
def allowance(s, reason):
    if s['repairs'] >= s['max_repairs']:
        raise ValueError('Correction allowance exhausted. Keep the same job; finish --reference with honest remaining issues.')
    s['repairs'] += 1; s['needs_repair'] = True
    event('correction', number=s['repairs'], reason=reason)

def hook(data):
    s = state(); name = data.get('tool_name'); inp = data.get('tool_input', {}); h = data['hook_event_name']
    if h == 'PreToolUse':
        if name == 'Bash':
            try: tokens = shlex.split(inp.get('command', ''))
            except ValueError: return deny('Use one direct host command, no shell composition.')
            if len(tokens) < 3 or path(tokens[0]) != path(CFG['python']) or path(tokens[1]) != HERE / 'host.py' or any(c in inp.get('command', '') for c in (';', '|', '&', '`', '$', '\n', '<', '>')):
                return deny('Use only: ' + CFG['python'] + ' ' + str(HERE / 'host.py') + ' COMMAND. Read/Write JSON with file tools; do not inspect or rewrite the renderer.')
            if inp.get('run_in_background'):
                return deny('Run this bounded command in the foreground with timeout 600000; no polling loop is needed.')
            if tokens[2] in ('preview', 'finish') and inp.get('timeout') != 600000:
                event('tool_timeout_adjusted', command=tokens[2], requested=inp.get('timeout'), effective=600000)
                return {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'allow', 'updatedInput': {**inp, 'timeout': 600000}}}
        elif name in ('Write', 'Edit'):
            p = path(inp.get('file_path', ''))
            inputs = ROOT / CFG['inputs']
            if p.parent != inputs or p.name not in ('brief.json','draft.json','facts-review.json','visual-review.json','edit-request.json','patch.json'):
                return deny('Write only JSON inputs under ' + str(inputs) + '; original brief, compiled artifacts, base film and host state are read-only to the model.')
            if p.name=='facts-review.json' and not CFG['require_facts']:
                return deny('Independent factual review is disabled for this model. Continue with the preview images and visual-review.json; do not add the DeepSeek-only phase.')
            if p.name=='brief.json' and (JOB/'job.json').exists():
                if name == 'Write' and p.is_file() and p.read_text() == inp.get('content'):
                    return {}
                return deny('The original story contract is frozen after initialization. Correct the draft within the existing allowance; never change the brief to make a failed check pass.')
            # Count every replacement, including changes before the first compile.
            # One correction is one consolidated JSON candidate/receipt, not a free loop.
            versions = s.setdefault('input_versions', {})
            fresh_receipt = p.name in ('facts-review.json','visual-review.json') and versions.get(str(p), -1) < s.get('candidates', 0)
            if p.exists() and not fresh_receipt:
                if name == 'Write' and p.read_text() == inp.get('content'): return {}
                try: allowance(s, 'rewrite ' + p.name)
                except ValueError as e: return deny(str(e))
            versions[str(p)] = s.get('candidates', 0)
            if p.name.startswith('draft'):
                used = s.get('draft_path')
                if used and used != str(p): return deny('Keep the same draft input path; a new filename cannot reset the candidate allowance.')
                s['draft_path'] = str(p)
            save(STATE, s)
        elif name == 'Read':
            p = path(inp.get('file_path', ''))
            if inside(p, SKILL / 'scripts') or p.suffix in ('.js', '.mjs'):
                return deny('The renderer is preinstalled and immutable. Read SKILL.md/references/compact.md and diagnostics, not engine source.')
            if not inside(p, ROOT): return deny('Read within this conversation workspace only.')
            if p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp') and CFG['require_facts'] and not s.get('facts_recorded'):
                return deny('Complete the literal factual review using facts and record-facts before looking at render images.')
    elif h == 'PostToolUse' and name in ('Write', 'Edit'):
        p=path(inp.get('file_path',''))
        steps={'brief.json':['init','--brief',str(p)], 'draft.json':['compile','--draft',str(p)],
               'patch.json':['apply-edit' if CFG['continued'] else 'repair','--patch',str(p)], 'facts-review.json':['record-facts','--review',str(p)],
               'visual-review.json':['record-review','--review',str(p)]}
        if p.name in steps:
            output=io.StringIO()
            with contextlib.redirect_stdout(output):
                try:
                    ok=main(steps[p.name])
                    if p.name=='draft.json' or p.name=='patch.json':
                        facts=JOB/'output/story-facts.json'
                        if ok is False:
                            print('NEXT: Compilation/numerical checks failed. Read the actual diagnostics and submit one consolidated patch.json or replacement draft.json. Do not run factual/image review on this invalid candidate. Keep the same job and correction allowance.')
                        elif CFG['require_facts'] and facts.exists():
                            print((SKILL/'references/factual-review.md').read_text())
                            print('NEXT: Write facts-review.json using the factual-review schema and these actual facts. Do not re-plan a passing draft.')
                            print(json.dumps(read(facts),ensure_ascii=False,separators=(',',':')))
                        elif (JOB/'scene.json').exists():main(['preview'])
                    elif p.name=='facts-review.json' and ok:
                        main(['preview'])
                    elif p.name=='visual-review.json' and ok:
                        main(['finish'])
                    if ok is False and state()['repairs']>=state()['max_repairs']:
                        main(['finish','--reference'])
                except Exception as e:
                    failed=state();failed['needs_repair']=True;save(STATE,failed)
                    if state()['repairs']>=state()['max_repairs']:
                        try:main(['finish','--reference'])
                        except Exception as export_error:print(json.dumps({'reference_export_error':str(export_error)}))
                    print(json.dumps({'host_stage_error':str(e),'next':'Inspect the concrete diagnostics. Consolidate a correction if allowed; otherwise finish --reference. Do not reset this job.'},ensure_ascii=False))
            return {'hookSpecificOutput':{'hookEventName':'PostToolUse','additionalContext':output.getvalue()}}
    elif h == 'PostToolUse' and name == 'Read':
        p = path(inp.get('file_path', ''))
        if p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp') and p.is_file():
            s.setdefault('seen', {})[str(p)] = digest(p); save(STATE, s)
            event('image_read', path=str(p), sha256=digest(p))
    elif h == 'Stop' and not s.get('delivered') and not s.get('clarification') and not s.get('answer'):
        n = s.get('stop_reminders', 0)
        if n < 2:
            s['stop_reminders'] = n + 1; save(STATE, s)
            return {'decision': 'block', 'reason': 'Continue the current whitebox tool phase until delivery, or explicitly clarify a material ambiguity. Do not stop after planning or fabricate quality acceptance.'}
    return {}

def run_skill(script, args, label=None):
    s = state(); command = label or args[0]; started = time.time(); s['phase'] = command; save(STATE, s)
    log = HERE / 'tool-logs'; log.mkdir(exist_ok=True)
    stem = str(time.time_ns()) + '-' + command
    try:
        result = subprocess.run([CFG['python'], str(SKILL / 'scripts' / script), *args], capture_output=True, text=True, timeout=780)
        if result.returncode:
            failed=state();failed['needs_repair']=True;save(STATE,failed)
        (log / (stem + '.stdout')).write_text(result.stdout); (log / (stem + '.stderr')).write_text(result.stderr)
        latest=state();latest['last_tool_result']=str(log / (stem + '.stdout'));latest['last_tool_exit']=result.returncode;save(STATE,latest)
        try: output = json.loads(result.stdout)
        except ValueError: output = {'stdout_tail': result.stdout[-4000:], 'stderr_tail': result.stderr[-4000:]}
        event('tool', command=command, script=script, args=args, seconds=time.time()-started, exit_code=result.returncode, log=stem)
        # Compact tool receipts; full diagnostics always remain readable on disk.
        if isinstance(output, dict):
            compact = {k:v for k,v in output.items() if k in ('ok','status','error','errors','diagnostics','message','render_success','quality_pass','video','manifest','visual_review_required','stdout_tail','stderr_tail')}
            compact.update({'command': command, 'exit_code': result.returncode, 'seconds': round(time.time()-started, 3), 'full_result': str(log / (stem + '.stdout'))})
            print(json.dumps(compact, ensure_ascii=False), flush=True)
        return result.returncode, output
    except subprocess.TimeoutExpired:
        event('tool', command=command, seconds=time.time()-started, error='host timeout')
        raise

def option(args, flag, required=True):
    if flag in args:
        i=args.index(flag)
        if i+1 < len(args): return args[i+1]
    if required: raise ValueError(flag + ' required')

def input_path(args, flag):
    p=path(option(args, flag))
    if not inside(p, ROOT / CFG['inputs']) and not inside(p, ROOT / 'assets'):
        raise ValueError('Inputs must be in this round input directory or immutable session assets')
    return p

def main(args):
    command=args[0] if args else 'status'; s=state()
    if command == 'status':
        print(json.dumps({**s, 'wall_seconds':time.time()-s['started_at'], 'job':str(JOB), 'inputs':str(ROOT / CFG['inputs']), 'base_candidates':[str(p.parent) for p in (ROOT/'work').glob('*/job.json') if p.parent != JOB]}, ensure_ascii=False)); return
    if command == 'clarify':
        question=option(args,'--question'); s['clarification']=question; save(STATE,s); event('clarification',question=question)
        print(json.dumps({'needs_user_input':True,'question':question},ensure_ascii=False)); return
    if command == 'init':
        if CFG['continued']: raise ValueError('Follow-up requires start-edit using the prior playable base; no whole-film restart.')
        if (JOB/'job.json').exists():
            requested=option(args,'--brief',required=False)
            if requested:
                brief=input_path(args,'--brief')
                frozen=JOB/'brief.json'
                if not frozen.is_file() or read(brief) != read(frozen):
                    raise ValueError('This job already has a different frozen brief; do not reset it or weaken its story contract.')
            print(json.dumps({'already_initialized':True,'job':str(JOB),'next':'Continue with draft.json or the current review. Initialization cannot reset the clock or correction allowance.'}))
            return
        brief=input_path(args,'--brief')
        code,_=run_skill('job.py',['init',str(JOB),'--brief',str(brief),'--budget','600']+(['--require-facts'] if CFG['require_facts'] else []))
        if code: raise ValueError('init failed; inspect its saved result')
        return
    if command == 'start-edit':
        base=path(option(args,'--base')); req=input_path(args,'--request')
        if not inside(base,ROOT/'work') or base==JOB: raise ValueError('Use a prior job in this conversation as the preserved edit base')
        code,_=run_skill('edit_scope.py',['start',str(JOB),'--base',str(base),'--request',str(req)])
        if code: raise ValueError('start-edit failed')
        shutil.copyfile(JOB/'draft.json',HERE/'current-draft.json')
        # A resumed conversation may switch models. The new DeepSeek round still
        # requires its factual pass; this does not rewrite the archived base.
        native=read(JOB/'job.json');native['require_facts']=CFG['require_facts'];save(JOB/'job.json',native)
        s=state();s['max_repairs']=1;save(STATE,s);return
    if not (JOB/'job.json').exists(): raise ValueError('Initialize this job first; status shows the fixed directory.')
    if command == 'apply-edit' and not CFG['continued']:
        command = 'repair'
    if command in ('compile','apply-edit','repair'):
        s=state()
        candidate=input_path(args,'--draft' if command=='compile' else '--patch')
        candidate_hash=digest(candidate)
        if s.get('last_candidate_sha256')==candidate_hash:
            print(json.dumps({'already_processed':True,'candidate_sha256':candidate_hash,'next':'Read the prior diagnostics and continue its review, without another compile.'}));return
        s['last_candidate_sha256']=candidate_hash
        if s.get('candidates',0):
            # File rewrites already consumed a correction; don't double-count the compile.
            if s.get('last_candidate_repairs',0)==s['repairs']: allowance(s,command)
        s['candidates']=s.get('candidates',0)+1;s['last_candidate_repairs']=s['repairs'];s['facts_recorded']=False;s['seen']={};save(STATE,s)
        if command=='compile':
            if CFG['continued']: raise ValueError('Use apply-edit in the scoped user edit branch')
            draft=input_path(args,'--draft');shutil.copyfile(draft,HERE/'current-draft.json')
            code,_=run_skill('job.py',['compile',str(JOB),'--draft',str(draft)])
        elif command=='repair':
            if CFG['continued']: raise ValueError('Use apply-edit in the scoped user edit branch')
            base=HERE/'current-draft.json'
            if not base.exists():base=JOB/'draft.json'
            if not base.exists():raise ValueError('Write one complete draft before submitting a repair patch')
            patched=HERE/'patched-draft.json'
            code,_=run_skill('patch_draft.py',[str(base),'--patch',str(candidate),'--out',str(patched)],label='patch-draft')
            if not code:
                shutil.copyfile(patched,HERE/'current-draft.json')
                code,_=run_skill('job.py',['compile',str(JOB),'--draft',str(patched)])
        else:
            patch=input_path(args,'--patch');code,_=run_skill('edit_scope.py',['apply',str(JOB),'--patch',str(patch)])
            if (JOB/'draft.json').exists():shutil.copyfile(JOB/'draft.json',HERE/'current-draft.json')
        if code:
            s=state();s['needs_repair']=True;save(STATE,s)
        if (JOB/'scene.json').exists():
            check_code,_=run_skill('job.py',['check',str(JOB)])
            code=code or check_code
            if not code and CFG['require_facts']: run_skill('job.py',['facts',str(JOB)])
        print(json.dumps({'read_next':[str(JOB/'checks.json')]+([str(JOB/'output/story-facts.json')] if CFG['require_facts'] else [])}))
        return code==0
    if command=='record-review':
        receipt=input_path(args,'--review');review=read(receipt)
        for name in review.get('seen',[]):
            candidates=[path(name),JOB/'output'/name]
            seen=[p for p in candidates if p.is_file() and s.get('seen',{}).get(str(p.resolve()))==digest(p)]
            if not seen: raise ValueError('Review claims an image not actually read for the current candidate: '+name)
        code,_=run_skill('job.py',['record-review',str(JOB),'--review',str(receipt)]);return code==0
    if command in ('facts','record-facts') and not CFG['require_facts']:
        print(json.dumps({'skipped':True,'reason':'Independent factual review applies only to the configured DeepSeek branch. Numerical checks already ran. Continue image review; do not write facts-review.json.'}));return True
    if command=='record-facts':
        receipt=input_path(args,'--review');code,_=run_skill('job.py',['record-facts',str(JOB),'--review',str(receipt)])
        # A declared blocker is still a factual review, not permission to claim quality.
        s=state();s['facts_recorded']=(JOB/'output/story-review.json').exists()
        if code:s['needs_repair']=True
        save(STATE,s);return code==0
    if command=='preview':
        if CFG['require_facts'] and not s.get('facts_recorded'): raise ValueError('Record the literal factual review before preview and image judgments')
        code,_=run_skill('job.py',['preview',str(JOB),'--software'])
        print((SKILL/'references/review-protocol.md').read_text())
        print('NEXT: Read all required image pages in this index together in one tool-call batch. Only inspect extra originals if a required detail is unreadable. Then then Write visual-review.json with actual observations; the host will record it and export automatically.')
        index=JOB/'output/review/index.json'
        if index.exists():
            idx=read(index)
            # The full packet remains on disk. Repeated per-frame bounding boxes are
            # optional detail; keep the required page/event/comparison index inline so
            # CC does not offload the entire phase instruction into another tool file.
            packet={k:v for k,v in idx.items() if k!='event_samples'}
            packet['full_index_path']=str(index)
            print(json.dumps(packet,ensure_ascii=False,separators=(',',':')))
        else:print(json.dumps({'missing_review_index':str(index)}))
        return code==0
    if command=='finish':
        ref='--reference' in args
        code,output=run_skill('job.py',[('reference' if ref else 'render'),str(JOB),'--software'])
        if code: raise ValueError('Export failed. Inspect diagnostics; use finish --reference for unresolved quality within the same bounded job.')
        if not ref:
            code,_=run_skill('job.py',['package',str(JOB)])
            if code:raise ValueError('Packaging failed; preserve artifacts and report its diagnostics')
        video=JOB/('reference-output' if ref else 'output')/'preview.mp4'
        if not video.is_file() or video.stat().st_size<1024:raise ValueError('No validated playable export')
        destination=ROOT/'output/final.mp4';tmp=destination.with_suffix('.mp4.tmp');shutil.copyfile(video,tmp);tmp.replace(destination)
        s=state();s.update(delivered=True,phase='delivered',video=str(video),render_success=True,quality_pass=bool(output.get('quality_pass',False)),wall_seconds=time.time()-s['started_at']);save(STATE,s)
        event('delivered',**{k:s[k] for k in ('video','wall_seconds','repairs','render_success','quality_pass')})
        print(json.dumps({'delivered':True,'video':'output/final.mp4','wall_seconds':s['wall_seconds'],'repairs':s['repairs'],'render_success':True,'quality_pass':s['quality_pass'],'note':'State quality limitations and image-only review briefly; no extra report-generation loop.'},ensure_ascii=False));return
    if command in ('facts','check'):run_skill('job.py',[command,str(JOB)]);return
    raise ValueError('Unknown host command: '+command)

if __name__=='__main__':
    try:
        # AFS may return EAGAIN even for a blocking flock; all tools for this job
        # run on one worker, so use its local shared-memory filesystem.
        lock_id=hashlib.sha256(CFG['job'].encode()).hexdigest()[:24]
        with (Path('/dev/shm')/('cvw-whitebox-'+lock_id+'.lock')).open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            if len(sys.argv)>1 and sys.argv[1]=='hook':print(json.dumps(hook(json.load(sys.stdin))))
            else:main(sys.argv[1:])
    except Exception as e:
        event('host_error',error=type(e).__name__,message=str(e))
        if len(sys.argv)>1 and sys.argv[1]=='hook':
            print(json.dumps(deny('Whitebox workflow guard: '+str(e))))
        else:print(json.dumps({'error':type(e).__name__,'message':str(e)},ensure_ascii=False));sys.exit(1)
