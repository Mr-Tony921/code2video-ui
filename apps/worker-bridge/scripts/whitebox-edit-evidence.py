"""Deterministic before/after evidence for scoped CC edits; no model calls."""
import hashlib,json,math
from pathlib import Path

METRICS={'camera_distance':'distance','camera_height':'height','camera_fov':'fov'}
def read(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def measurements(shot):
 c=shot['camera'];look=c['look'];endlook=c.get('look_to',look)
 return {'camera_distance':[math.dist(c['from'],look),math.dist(c['to'],endlook)],
  'camera_height':[c['from'][1],c['to'][1]],'camera_fov':[c['fov'],c['fov']]}
def validate_checks(request):
 checks=request.get('acceptance_checks',[])
 if not isinstance(checks,list):raise ValueError('acceptance_checks must be an array')
 paths=[x.get('path','').split('/') for x in request.get('targets',[])+request.get('dependencies',[])]
 shots={p[2].replace('~1','/').replace('~0','~') for p in paths if len(p)>=4 and p[1]=='shots'}
 required={(p[2].replace('~1','/').replace('~0','~'),metric) for p in paths if len(p)==4 and p[1]=='shots' for metric,field in METRICS.items() if p[3]==field}
 keys=[]
 for c in checks:
  if not isinstance(c,dict) or c.get('metric') not in METRICS or c.get('direction') not in ('increase','decrease','unchanged') or c.get('shot_id') not in shots:
   raise ValueError('Each acceptance check needs a scoped shot_id, camera_distance/camera_height/camera_fov metric and increase/decrease/unchanged direction')
  keys.append((c['shot_id'],c['metric']))
 if len(set(keys))!=len(keys):raise ValueError('Duplicate acceptance check')
 if not required<=set(keys):raise ValueError('Declare the requested measurable direction before editing numeric camera fields: '+str(sorted(required-set(keys))))

def selected_scene(root):
 scene=root/'scene.json';effective=root/'output/effective-scene.json';index=root/'output/review/index.json'
 if effective.exists() and index.exists() and read(index).get('scene_sha256')==sha(scene):return effective
 return scene
def evidence(job):
 job=Path(job);request=read(job/'edit-request.json');base=selected_scene(job/'baseline');current=selected_scene(job)
 original=read(base);candidate=read(current)
 scope=job/'output/edit-scope.json'
 ids=set(read(scope)['review_shots']) if scope.exists() else {p['path'].split('/')[2].replace('~1','/').replace('~0','~') for p in request['targets']+request.get('dependencies',[]) if p['path'].startswith('/shots/')}
 def filtered(scene):return [{k:s[k] for k in ('id','camera','actors','events','set') if k in s} for s in scene['shots'] if s['id'] in ids]
 before={s['id']:s for s in original['shots']};after={s['id']:s for s in candidate['shots']};results=[]
 for check in request.get('acceptance_checks',[]):
  sid=check['shot_id'];metric=check['metric'];direction=check['direction']
  a=measurements(before[sid])[metric];b=measurements(after[sid])[metric];delta=[y-x for x,y in zip(a,b)]
  ok=all(d>1e-6 for d in delta) if direction=='increase' else all(d< -1e-6 for d in delta) if direction=='decrease' else all(abs(d)<=1e-6 for d in delta)
  results.append({**check,'baseline':a,'current':b,'delta':delta,'ok':ok})
 return {'user_request':request['user_request'],'acceptance_checks':results,'ok':all(c['ok'] for c in results),
  'baseline_scene':str(base),'baseline_sha256':sha(base),'candidate_scene':str(current),'candidate_sha256':sha(current),
  'baseline_shots':filtered(original),'candidate_shots':filtered(candidate),
  'note':'Compare the requested change against actual baseline AND candidate data. Missing compact fields are compiler defaults, not zero. These numeric checks cover declared camera direction at endpoints only; the full user change and all required image pages still need semantic review.'}
