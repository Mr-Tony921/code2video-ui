#!/usr/bin/env python3
"""Deterministic skill tools for the native CC loop. Never calls a model API.

The selected upstream CLI still compiles/checks/reviews/renders. CC owns model
calls, tool choices, conversation persistence and resume. All source observations
and model-submitted JSON are retained in the per-round workspace.
"""
import base64,contextlib,copy,fcntl,hashlib,io,json,mimetypes,re,sys,time
from pathlib import Path
import host as h
import edit_evidence as edits

HERE=h.HERE;JOB=h.JOB;ROOT=h.ROOT;SKILL=h.SKILL
INPUTS=ROOT/h.CFG['inputs']
KIND=['brief','draft','patch','facts','review','edit','clarify','answer']
class MethodNotFound(Exception):pass
TOOLS=[{'name':'submit','description':'Submit the JSON for the current whitebox phase. The result contains the next phase rules and all required data/images. New film: brief, draft, DeepSeek facts, review; bounded patch only after a concrete failure. For a brief, preserve each user-specified story beat in its original order and use the original clause as its description. Do not merge, duplicate, swap or rewrite separate user-specified beats to fit added constraints. Put additional context in separate brief requirements. Follow-up: edit then patch. Do not poll or duplicate a successful step.',
 'inputSchema':{'type':'object','properties':{'kind':{'type':'string','enum':KIND},'data':{'type':'object'}},'required':['kind','data'],'additionalProperties':False},
 '_meta':{'anthropic/maxResultSizeChars':480000}},
 {'name':'evidence','description':'Read additional original evidence only when the inline review pages cannot resolve a required detail. Use current review pages, event-sample files, or source frames/NNN_a.jpg (start), _b.jpg (middle), _c.jpg (end), numbered by current shot order. Fetch only needed detail, not already supplied pages or JSON.',
 'inputSchema':{'type':'object','properties':{'files':{'type':'array','items':{'type':'string'},'minItems':1,'maxItems':12}},'required':['files'],'additionalProperties':False},
 '_meta':{'anthropic/maxResultSizeChars':480000}}]

def text(v):return {'type':'text','text':v if isinstance(v,str) else json.dumps(v,ensure_ascii=False,separators=(',',':'))}
def result(*blocks):return {'content':list(blocks),'isError':False}
def rules(*names):return '\n\n'.join((SKILL/'references'/n).read_text() for n in names)
def model_rules():
 return '\n\n'+rules('model-patches.md').split('## Other models')[0] if h.CFG['require_facts'] else ''
def write_input(name,value):
 p=INPUTS/name;content=json.dumps(value,ensure_ascii=False,separators=(',',':'))
 guard=h.hook({'hook_event_name':'PreToolUse','tool_name':'Write','tool_input':{'file_path':str(p),'content':content}})
 denial=guard.get('hookSpecificOutput',{})
 if denial.get('permissionDecision')=='deny':raise ValueError(denial['permissionDecisionReason'])
 h.save(p,value)
 return str(p)
def run(*args):
 output=io.StringIO()
 try:
  with contextlib.redirect_stdout(output):ok=h.main(list(args))
 finally:
  (HERE/('mcp-cli-'+str(time.time_ns())+'.txt')).write_text(output.getvalue())
 return ok
def phase(name):
 s=h.state();s['mcp_phase']=name;h.save(h.STATE,s)
def diagnostics():
 s=h.state();p=Path(s.get('last_tool_result','/nonexistent'))
 if p.is_file() and s.get('last_tool_exit'):
  try:return h.read(p)
  except ValueError:return {'tool_error':p.read_text()[-12000:]}
 p=JOB/'output/checks.json'
 if s.get('mcp_phase') not in ('review','delivered') or not p.exists():p=JOB/'checks.json'
 return h.read(p) if p.exists() else {}
def finish(reference=False):
 if h.CFG['continued'] and not reference and not edits.evidence(JOB)['ok']:
  raise ValueError('Requested edit direction is not satisfied; preserve the baseline and correct within the existing allowance, or export a labelled reference.')
 run('finish',*(['--reference'] if reference else []));s=h.state();phase('delivered')
 return result(text({'phase':'delivered','next':'Give a concise user-facing delivery and actual limitations; no more tools.',
  **{k:s.get(k) for k in ['render_success','quality_pass','video','wall_seconds','repairs']},'checks':diagnostics()}))
def correction(issues):
 s=h.state();s['needs_repair']=True;h.save(h.STATE,s)
 if s['repairs']>=s['max_repairs']:return finish(True)
 phase('patch')
 evidence=[];actual=None;index_path=JOB/'output/review/index.json'
 if index_path.exists() and (JOB/'scene.json').exists():
  idx=h.read(index_path)
  if idx['scene_sha256']==h.digest(JOB/'scene.json'):
   actual=h.read(JOB/'output/effective-scene.json')
   fields=('id','set','actors','events','camera','hidden_environment','continuity','cut_reason','deferred_actions','video_prompt')
   actual={'entities':actual['entities'],'shots':[{k:shot[k] for k in fields if k in shot} for shot in actual['shots']]}
   # Invalid previews still provide useful visibility evidence. Do not incur a
   # separate model review of a known-invalid candidate, or duplicate old pages.
   unseen=[p['file'] for p in idx['pages'] if p['kind'] in ('overview','continuity','events','details','compare')
     and h.state().get('seen',{}).get(str((JOB/'output'/p['file']).resolve()))!=h.digest(JOB/'output'/p['file'])]
   evidence=image_blocks(unseen)
 return result(text({'phase':'patch','next':'Submit one consolidated patch, or {replacement_draft: full_compact_plan} only for structural correction. Preserve original requirements and stable entity IDs.',
  'remaining_corrections':s['max_repairs']-s['repairs'],'issues':issues,'frozen_brief':h.read(JOB/'brief.json'),
  'edit_comparison':edits.evidence(JOB) if h.CFG['continued'] else None,
  'actual_preview':actual,'current_draft':h.read(HERE/'current-draft.json') if (HERE/'current-draft.json').exists() else None}),text(rules('compact.md','action-scope.md','interaction-motion.md')+model_rules()),*evidence)
def facts_packet():
 packet=h.read(JOB/'output/story-facts.json');phase('facts')
 instruction=rules('factual-review.md').split('## Factual review instruction',1)[-1].split('## Record and repair',1)[0]
 return result(text({'phase':'facts','next':'Submit the literal factual decision as kind=facts. All original requirements and actual world data follow. Do not issue file/status requests. Hashes are supplied by the host, not guessed by the model.',
  'required_event_ids':[e['id'] for e in packet['original_brief']['events']],
  'coverage':'Exactly one events item per required_event_id. Put each global constraint under its affected original event clauses. Do not invent summary events such as brief_constraints; do not omit any finding.',
  'edit_comparison':edits.evidence(JOB) if h.CFG['continued'] else None}),text(instruction),text(packet))
def diagnostic_correction(issues):
 # The selected native CLI explicitly allows diagnostic preview of a compiled
 # scene with numerical/story failures, before factual acceptance. Gather actual
 # visibility failures in the SAME bounded repair;
 # export still requires the native factual and image gates to pass.
 s=h.state()
 if s['repairs']<s['max_repairs']:
  capture=io.StringIO()
  with contextlib.redirect_stdout(capture):
   code,preview=h.run_skill('job.py',['preview',str(JOB),'--software'],label='diagnostic-preview')
  (HERE/('mcp-diagnostic-'+str(time.time_ns())+'.txt')).write_text(capture.getvalue())
  issues={**issues,'diagnostic_preview':preview,'diagnostic_preview_exit':code,
   'instruction':'Consolidate the factual blockers AND all actual preview visibility failures into the same correction. Factual acceptance is still unresolved; these images never certify export.'}
 return correction(issues)
def image_blocks(files):
 blocks=[];s=h.state()
 for rel in files:
  p=(JOB/'output'/rel).resolve()
  if not h.inside(p,(JOB/'output').resolve()) or p.suffix.lower() not in ('.jpg','.jpeg','.png','.webp') or not p.is_file():raise ValueError('Unknown current evidence page: '+rel)
  raw=p.read_bytes();sha=hashlib.sha256(raw).hexdigest()
  blocks += [text('Evidence page: '+rel),{'type':'image','mimeType':mimetypes.guess_type(p.name)[0],'data':base64.b64encode(raw).decode()}]
  s.setdefault('seen',{})[str(p)]=sha
  h.event('image_observation',path=str(p),sha256=sha,transport='mcp-inline')
 h.save(h.STATE,s)
 return blocks
def allowed_evidence(index):
 # Source frames are the same pixels used to build the native review pages.
 # Bind them to the current scene/shot index, never a directory glob (which
 # could include stale files from a longer previous candidate).
 if index.get('scene_sha256')!=h.digest(JOB/'scene.json'):raise ValueError('Preview is stale; current-scene evidence is required')
 allowed={p['file'] for p in index['pages']}
 allowed.update(p['file'] for p in index.get('event_samples',[]))
 scope=index.get('edit_scope') or {};review_shots=scope.get('review_shots')
 for i,shot in enumerate(index.get('shots',[])):
  if review_shots is None or shot['id'] in review_shots:
   allowed.update(f'frames/{i+1:03d}_{suffix}.jpg' for suffix in ('a','b','c'))
 return allowed
def preview_packet():
 ok=run('preview');out=JOB/'output'
 if ok is False:return correction(diagnostics())
 edit_comparison=edits.evidence(JOB) if h.CFG['continued'] else None
 if edit_comparison:
  h.save(HERE/'edit-comparison.json',edit_comparison)
  if not edit_comparison['ok']:return correction({'edit_acceptance':edit_comparison})
 index=h.read(out/'review/index.json')
 pages=[p['file'] for p in index['pages'] if p['kind'] in ('overview','continuity','events','details','compare')]
 scene=h.read(out/'effective-scene.json');brief=h.read(JOB/'brief.json')
 draft=h.read(HERE/'current-draft.json') if (HERE/'current-draft.json').exists() else {}
 fields=('id','set','actors','events','camera','hidden_environment','continuity','cut_reason','deferred_actions','video_prompt')
 packet={'phase':'review','next':'Review the actual supplied data and ALL inline image pages, then submit kind=review. Do not regenerate data or request status.',
  'original_brief':brief,'checks':h.read(out/'checks.json'),'scene_sha256':index['scene_sha256'],'pages':pages,
  'review_events':index['events'],'edit_scope':index.get('edit_scope'),'edit_comparison':edit_comparison,
  'comparison':h.read(out/'review/comparison.json') if (out/'review/comparison.json').exists() else None,
  'actual_scene':{'coordinate_anchor':'Positions are bottom center. Deferred actions and video_prompt prove downstream handoff only, not motion performed by the proxy.',
   'entities':scene['entities'],'stage_geometry':[{'id':s['id'],'environment':s.get('environment',{})} for s in draft.get('stages',[])],
   'shots':[{k:s[k] for k in fields if k in s} for s in scene['shots']]}}
 phase('review')
 return result(text(packet),text(rules('review-protocol.md','action-scope.md')+model_rules()),*image_blocks(pages))
def candidate(*args):
 native=JOB/'draft.json'
 before=native.stat().st_mtime_ns if native.exists() else None
 ok=run(*args)
 # The native CLI writes draft.json only after compile_plan succeeds. Failed
 # parsing/patches leave the old candidate untouched; never diagnose it as new.
 fresh=native.exists() and native.stat().st_mtime_ns!=before and (HERE/'current-draft.json').exists() and h.read(native)==h.read(HERE/'current-draft.json')
 return after_candidate(ok,fresh)
def after_candidate(ok,fresh=False):
 if ok is False:return diagnostic_correction({'numeric_checks':diagnostics()}) if fresh else correction(diagnostics())
 return facts_packet() if h.CFG['require_facts'] else preview_packet()
def camera_enums():
 schema=h.read(SKILL/'references/scene.schema.json')
 camera=schema['properties']['shots']['items']['properties']['camera']['properties']
 return {key:camera[key]['enum'] for key in ('type','framing')}
def validate_brief(b):
 for field in ('title','duration','story','cast','events'):
  if field not in b:raise ValueError('Brief requires '+field+'; use the supplied brief schema, not draft entity fields.')
 if not isinstance(b['cast'],dict) or not b['cast']:raise ValueError('Brief cast must map stable entity IDs to their identities')
 if not isinstance(b['duration'],(int,float)) or isinstance(b['duration'],bool) or not 0<b['duration']<float('inf'):raise ValueError('Brief duration must be a positive finite number')
 if not isinstance(b['events'],list) or not b['events']:raise ValueError('Brief events must be a non-empty list')
 ids=[]
 for e in b['events']:
  if not isinstance(e,dict) or not e.get('id') or not e.get('description') or not isinstance(e.get('subjects'),list):raise ValueError('Each event needs id, original description, and subjects (required visible entities).')
  if any(subject not in b['cast'] for subject in e['subjects']):raise ValueError('Every visible event subject must be a stable ID declared in cast')
  ids.append(e['id'])
 if len(set(ids))!=len(ids):raise ValueError('Event IDs must be unique')
 for c in b.get('camera_constraints',[]):
  if not isinstance(c,dict):raise ValueError('Each camera constraint must be an object')
  for key,allowed in camera_enums().items():
   if key in c and c[key] not in allowed:
    raise ValueError('Before freezing the original brief, camera_constraints.'+key+' must use the selected skill enum: '+', '.join(allowed)+'. Preserve the requested camera intent using its supported representation.')
 for c in b.get('state_constraints',[]):
  if c.get('type')=='remain_after' and (not c.get('entity') or c.get('event') not in ids or (c.get('until_event') and c['until_event'] not in ids)):
   raise ValueError('remain_after needs entity and an existing event, with until_event when a later user-requested event moves the object. Never use object in place of entity.')
def validate_facts_receipt(receipt):
 import importlib.util
 scripts=str(SKILL/'scripts')
 if scripts not in sys.path:sys.path.insert(0,scripts)
 spec=importlib.util.spec_from_file_location('whitebox_native_facts',SKILL/'scripts/story_facts.py')
 native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
 native.validate_receipt(JOB,receipt)
def validate_visual_receipt(receipt):
 """Run the selected skill's exact format checks without writing a receipt.

 Native 0.11.1 combines validation, persistence and quality gating in record().
 A fresh module instance gets an in-memory input and no persistence for this
 preflight only. The real CLI record-review still runs unchanged afterwards,
 including its factual/visual quality gate. No accepted result is synthesized.
 """
 import importlib.util
 spec=importlib.util.spec_from_file_location('whitebox_review_format',SKILL/'scripts/review.py')
 native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
 virtual=HERE/'in-memory-visual-review.json';read=native.read
 native.read=lambda path:copy.deepcopy(receipt) if Path(path)==virtual else read(path)
 native.write=lambda *args:None
 native.gate=lambda job:None
 native.record(JOB,virtual)
def unwrap_envelope(kind,data):
 # Lossless tool-protocol aliases only: discard no judgment, target or finding.
 if isinstance(data,dict) and set(data)=={kind} and isinstance(data[kind],dict):
  h.event('input_canonicalization',rule='singleton-phase-envelope-v1',kind_name=kind)
  return data[kind]
 for key in (kind,'data'):
  if isinstance(data,dict) and set(data)=={'kind',key} and data.get('kind')==kind and isinstance(data.get(key),dict):
   h.event('input_canonicalization',rule='redundant-tool-envelope-v1',kind_name=kind,payload_key=key)
   return data[key]
 return data
def canonicalize_colors(value):
 changes=[]
 def walk(v,path):
  if isinstance(v,list):return [walk(x,path+'/'+str(i)) for i,x in enumerate(v)]
  if not isinstance(v,dict):return v
  out={}
  for key,item in v.items():
   p=path+'/'+key.replace('~','~0').replace('/','~1')
   if key=='color' and isinstance(item,str) and re.fullmatch(r'#[0-9a-fA-F]{3}',item):
    expanded='#'+''.join(c*2 for c in item[1:]);changes.append({'path':p,'original':item,'canonical':expanded});out[key]=expanded
   else:out[key]=walk(item,p)
  return out
 normalized=walk(value,'')
 if changes:h.event('input_canonicalization',rule='css-rgb-shorthand-v1',changes=changes,
  scope='Equivalent color spelling only; original model arguments retained in mcp_call and raw API capture. No scene quality rule changed.')
 return normalized
def submit(kind,data):
 s=h.state();expected=s.get('mcp_phase','edit' if h.CFG['continued'] else 'brief')
 if kind not in ('clarify','answer') and kind!=expected:
  raise ValueError('Current phase is '+expected+'; submit it directly. A successful earlier step cannot be repeated or reset.')
 data=unwrap_envelope(kind,data)
 if kind in ('draft','patch'):data=canonicalize_colors(data)
 if kind=='brief':
  validate_brief(data);p=write_input('brief.json',data);run('init','--brief',p);phase('draft')
  refs=['action-scope.md','compact.md','interaction-motion.md']
  contract=rules(*refs)
  contract+=model_rules()
  return result(text({'phase':'draft','next':'Submit one full compact plan JSON as kind=draft using the frozen brief and rules. Initialization is complete. Do not issue init/status/read operations.','frozen_brief':h.read(JOB/'brief.json'),'planning_note':'Author one simple recognizable blocking plan. Use compiler-derived camera distance unless the original user specifically fixes it. Calculate required actor/object movements and explicit predicates once; leave projection, pixel coverage and sampled occlusion to the deterministic preview. Do not mentally simulate every camera sample or repeatedly redesign optional decor before the first compile. Keep all original story, camera, ownership and visibility requirements; the normal numeric, factual and image checks remain mandatory.'}),text(contract))
 if kind=='draft':return candidate('compile','--draft',write_input('draft.json',data))
 if kind=='patch':
  if 'replacement_draft' in data:
   if h.CFG['continued']:raise ValueError('Scoped user edits cannot replace the whole film')
   return candidate('compile','--draft',write_input('draft.json',data['replacement_draft']))
  return candidate('apply-edit' if h.CFG['continued'] else 'repair','--patch',write_input('patch.json',data))
 if kind=='facts':
  facts=h.read(JOB/'output/story-facts.json')
  receipt={**data,'scene_sha256':facts['scene_sha256'],'brief_sha256':facts['brief_sha256']}
  # Native schema validation is read-only. A malformed decision is not a new
  # scene candidate or evidence of scene failure; retain it and ask for the
  # same decision in the native format without consuming a scene correction.
  try:validate_facts_receipt(receipt)
  except (ValueError,KeyError,TypeError) as error:
   h.event('receipt_format_error',phase='facts',message=str(error),receipt=receipt)
   raise ValueError('Facts receipt format: '+str(error)+'. Keep the same candidate and all actual findings; submit the corrected receipt. Required event IDs: '+json.dumps([e['id'] for e in facts['original_brief']['events']])) from error
  ok=run('record-facts','--review',write_input('facts-review.json',receipt))
  return preview_packet() if ok else diagnostic_correction({'factual_review':data,'checks':diagnostics()})
 if kind=='review':
  index=h.read(JOB/'output/review/index.json');pages=[p['file'] for p in index['pages'] if p['kind'] in ('overview','continuity','events','details','compare')]
  # Accept the skill's native receipt. Fill only deterministic provenance fields.
  receipt={**data,'scene_sha256':index['scene_sha256'],'seen':pages}
  try:validate_visual_receipt(receipt)
  except (ValueError,KeyError,TypeError) as error:
   h.event('receipt_format_error',phase='review',message=str(error),receipt=receipt)
   raise ValueError('Visual receipt format: '+str(error)+'. Keep the same candidate and all actual findings. Submit the corrected receipt, not a scene patch.') from error
  ok=run('record-review','--review',write_input('visual-review.json',receipt))
  # An explicitly incomplete image audit cannot certify quality, even though
  # the native CLI permits a conservatively labelled reference export.
  if ok and data.get('status')=='incomplete':return finish(True)
  return finish() if ok else correction({'visual_review':data,'checks':diagnostics()})
 if kind=='edit':
  base=h.CFG.get('base_job')
  if not base:raise ValueError('No selected playable base exists for this follow-up')
  edits.validate_checks(data)
  data={**data,'user_request':h.CFG.get('user_prompt') or data.get('user_request')}
  run('start-edit','--base',str(ROOT/base),'--request',write_input('edit-request.json',data));phase('patch')
  return result(text({'phase':'patch','next':'Submit ONLY the scoped patch as data={shots:[{id,...changed_fields}],...}. Do not wrap it in patch or repeat user_request/targets/dependencies/brief_patch. Keep unrelated fields unchanged. This first user edit is not a correction; at most one subsequent correction is allowed.',
   'edit_comparison':edits.evidence(JOB),'scope':data,'base_job':base,'current_draft':h.read(JOB/'draft.json'),'frozen_brief':h.read(JOB/'brief.json')}),text(rules('user-edits.md','compact.md','interaction-motion.md')+model_rules()))
 if kind in ('clarify','answer'):
  if expected not in ('brief','edit'):raise ValueError('Clarification/answer is an intake decision, not a way to abandon a failed candidate')
  value=data.get('question' if kind=='clarify' else 'text')
  if not isinstance(value,str) or not value.strip():raise ValueError('A concise non-empty user-facing response is required')
  s=h.state();s['clarification' if kind=='clarify' else 'answer']=value;s['mcp_phase']='waiting_user' if kind=='clarify' else 'answered';h.save(h.STATE,s)
  return result(text({'phase':s['mcp_phase'],'next':'Return this response to the user without creating/replacing a video.','text':value}))
 raise ValueError('Unknown whitebox step')

def fingerprint():
 s=h.state()
 return {k:s.get(k) for k in ('mcp_phase','last_candidate_sha256','candidates','repairs','delivered')}
def handle(method,params):
 if method=='initialize':return {'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'cvw-whitebox-skill-tools','version':'15.0.0'}}
 if method=='ping':return {}
 if method=='tools/list':
  tools=copy.deepcopy(TOOLS)
  tools[0]['description']+=' Intake camera constraints use the selected skill enum: '+json.dumps(camera_enums(),separators=(',',':'))+'. Do not freeze unsupported camera names. Before freezing, reconcile an object-stays condition with the complete requested event order: begin its hold after its final placement, not an earlier pickup/handover when the story still moves it; use until_event when the user later moves it. Do not invent numerical distances or platform duration limits that the user did not request.'
  return {'tools':tools}
 if method=='resources/templates/list':return {'resourceTemplates':[]}
 if method in ('resources/list','prompts/list'):return {('resources' if method.startswith('resources') else 'prompts'):[]}
 if method!='tools/call':raise MethodNotFound(method)
 name=params['name'];args=params.get('arguments',{});h.event('mcp_call',tool=name,arguments=args)
 if name=='submit':
  signature=hashlib.sha256(json.dumps(args,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
  cached=HERE/'mcp-last-result.json'
  if cached.exists():
   prior=h.read(cached)
   if prior['signature']==signature and prior['after']==fingerprint():
    h.event('mcp_replay',signature=signature)
    return prior['result']
  # Only the native CLI/correction path marks actual scene repair. Tool protocol
  # errors must not promote initial planning to high effort or spend a repair.
  value=submit(args['kind'],args['data'])
  h.save(cached,{'signature':signature,'after':fingerprint(),'result':value})
  return value
 if name=='evidence':
  if h.state().get('mcp_phase')!='review':raise ValueError('Evidence is supplied inline at the review phase; no evidence fetch is needed now')
  index=h.read(JOB/'output/review/index.json');allowed=allowed_evidence(index)
  if not set(args['files'])<=allowed:raise ValueError('Unknown or out-of-scope current evidence; use exact current review page or source-frame names only.')
  return result(text('Additional detail from the current preview. The native review receipt must still cite the corresponding review/ page already supplied; these source frames supplement that page, not a different candidate.'),*image_blocks(args['files']))
 raise ValueError('Unknown skill tool')

def serve():
 h.event('mcp_adapter',version='15.0.0',workflow='cc-native-complete-model-skill-rules')
 lock_id=hashlib.sha256(h.CFG['job'].encode()).hexdigest()[:24]
 for line in sys.stdin:
  try:
   request=json.loads(line)
   if 'id' not in request:continue
   with (Path('/dev/shm')/('cvw-whitebox-'+lock_id+'.lock')).open('a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    protocol_error=None
    try:payload=handle(request['method'],request.get('params',{}))
    except MethodNotFound as e:
     h.event('mcp_unsupported_method',method=str(e));protocol_error={'code':-32601,'message':'Method not found'}
    except Exception as e:
     h.event('mcp_error',method=request.get('method'),error=type(e).__name__,message=str(e))
     payload={'content':[text({'error':str(e),'phase':h.state().get('mcp_phase'),'remaining_corrections':h.state()['max_repairs']-h.state()['repairs']})],'isError':True}
   print(json.dumps({'jsonrpc':'2.0','id':request['id'],**({'error':protocol_error} if protocol_error else {'result':payload})},ensure_ascii=False),flush=True)
  except (ValueError,KeyError) as e:
   print(json.dumps({'jsonrpc':'2.0','id':None,'error':{'code':-32700,'message':type(e).__name__}}),flush=True)
if __name__=='__main__':serve()
