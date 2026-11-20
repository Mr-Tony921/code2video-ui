from pathlib import Path
import os,sys,unittest,json,copy,tempfile
R=Path(__file__).resolve().parents[2];E=R/'assets/whitebox-seko/releases'/os.environ.get('SEKO_TEST_RELEASE','seko-0.1.12-cvw.1')/'engine';sys.path.insert(0,str(E/'python'));from seko_engine.evidence import changed_shots,keep_visible_changes,retain_review_findings
class Hidden(unittest.TestCase):
 def fixture(self):
  return {'duration':60,'shot_plan':[{'id':f's{i}','start':i*10,'end':(i+1)*10} for i in range(6)],'entities':[{'id':'boot'}],'reference_usage':[],'animation':{'tracks':[{'target':'boot','property':'visible','keys':[{'time':0,'value':False},{'time':15,'value':True},{'time':19,'value':False}]},{'target':'boot','property':'position','keys':[{'time':0,'value':[0,0,0]},{'time':60,'value':[0,0,0]}]}]}}
 def scope(self,change,prepare=lambda p:None,changed_frame=None):
  a=self.fixture();prepare(a);b=copy.deepcopy(a);change(b)
  with tempfile.TemporaryDirectory() as t:
   root=Path(t)
   for name,p in [('old',a),('new',b)]:
    d=root/name;d.mkdir();(d/'project.json').write_text(json.dumps(p));e=[]
    for s in p['shot_plan']:
     f=s['id']+'.jpg';(d/f).write_bytes(b'changed' if name=='new' and s['id']==changed_frame else b'equal observed pixels');e.append({'shot':s['id'],'label':'middle','time':(s['start']+s['end'])/2,'file':f})
    (d/'evidence.json').write_text(json.dumps(e))
   return changed_shots(root/'old',root/'new')
 def move(self,p):
  for k in p['animation']['tracks'][-1]['keys']:k['value']=[1,0,0]
 def test_existing_hidden_track_only_reopens_visible_shot(self):self.assertEqual(self.scope(self.move),{'s1'})
 def test_between_sample_visibility_cannot_be_dropped(self):
  def prep(p):p['animation']['tracks'][0]['keys'][1]['time']=11.1;p['animation']['tracks'][0]['keys'][2]['time']=11.2
  self.assertEqual(self.scope(self.move,prep),{'s1'})
 def test_unknown_visibility_remains_global(self):
  def prep(p):p['animation']['tracks'][0]['keys'][1]['value']=1
  self.assertEqual(len(self.scope(self.move,prep)),6)
 def test_one_missing_visibility_track_remains_global(self):
  def change(p):self.move(p);p['animation']['tracks'].pop(0)
  self.assertEqual(len(self.scope(change)),6)
 def test_unrelated_changed_render_is_always_included(self):self.assertEqual(self.scope(self.move,changed_frame='s4'),{'s1','s4'})
 def test_camera_never_uses_hidden_entity_exemption(self):
  def prep(p):
   for tr in p['animation']['tracks']:tr['target']='__camera'
  self.assertEqual(len(self.scope(self.move,prep)),6)
 def test_old_and_new_visibility_union(self):
  a=self.fixture();b=copy.deepcopy(a);b['animation']['tracks'][0]['keys'][1]['time']=35;b['animation']['tracks'][0]['keys'][2]['time']=39
  self.assertEqual(keep_visible_changes([(0,60)],('boot','position'),a,b),[(15,19),(35,39)])
 def test_prior_warning_and_unresolved_shots_still_reviewed(self):
  r={'shots':[{'id':'s4','verdict':'warning'},{'id':'s5','verdict':'pass'}]};required={f's{i}' for i in range(6)};self.assertEqual(retain_review_findings({'s1'},r,[{'shot_id':'s2','problem':'required contact missing'}],required),{'s1','s2','s4'});self.assertEqual(retain_review_findings({'s1'},r,[{'technical':'unknown global error'}],required),required)
if __name__=='__main__':unittest.main()
