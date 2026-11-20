import os
import sys,json,tempfile,unittest,copy,re
from pathlib import Path
R=Path(__file__).resolve().parents[2];E=R/'assets/whitebox-seko/releases'/os.environ.get('SEKO_TEST_RELEASE','seko-0.1.10-cvw.1')/'engine';sys.path.insert(0,str(E/'python'))
from seko_engine.intake import assemble
from seko_engine.evidence import changed_shots
from seko_engine.harness import phase_skill
L=Path(__file__).parent;B=L.parent/'whitebox-threecase-2026-11-19/vendor/seko-scenes'
def put(p,v):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v))
class Flow(unittest.TestCase):
 def test_detailed_business_text_is_copied_verbatim(self):
  source='咖啡厅故事，总计20秒。\n片段1：见面，10秒\n分镜1\n原始台词：你好。\n片段2：告别，10秒\n分镜1\n固定镜头，他离开。'
  out,audit=assemble({'action':'generate','segments':[{'first_line':2,'last_line':4,'duration':10},{'first_line':5,'last_line':7,'duration':10}]},source)
  self.assertEqual(out['input']['segments'][0]['prompt'],'片段1：见面，10秒\n分镜1\n原始台词：你好。')
  self.assertEqual(out['input']['segments'][1]['prompt'],'片段2：告别，10秒\n分镜1\n固定镜头，他离开。')
  self.assertEqual(out['input']['work_prompt'],'咖啡厅故事，总计20秒。');self.assertEqual(audit['original_lines_retained'],7)
 def test_wish_plans_keep_raw_requirements_and_detailed_shots_cannot_be_rewritten(self):
  source='我想看一个小机器人发现箱子里的花，做成20秒，最后停在它捧着花的画面。'
  out,audit=assemble({'action':'generate','planned_segments':[{'title':'发现花','duration':20,'prompt':'分镜1 机器人发现箱子。\n分镜2 它捧着花停下。'}]},source)
  self.assertEqual(out['input']['work_prompt'],source);self.assertEqual(audit['policy'],'prose-plan-with-original-v1')
  with self.assertRaises(ValueError):assemble({'action':'generate','planned_segments':[{'duration':20,'prompt':'分镜1 改写'}]},'分镜1 用户的详细内容')
  for segments in [[{'first_line':1,'last_line':3,'duration':10},{'first_line':2,'last_line':3,'duration':10}],[{'first_line':1,'last_line':1,'duration':20}]]:
   with self.assertRaises(ValueError):assemble({'action':'generate','segments':segments},'分镜1 原文\n内容\n分镜2 另一镜')
  self.assertEqual(assemble({'action':'clarify','text':'希望多长时间？'},'一段追逐')[0]['action'],'clarify')
 def scope(self,change,old_change=None):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);old={'duration':60,'shot_plan':[{'id':f's{i}','start':i*10,'end':(i+1)*10,'camera_plan':{'mode':'static'}} for i in range(6)],'animation':{'tracks':[]},'reference_usage':[]}
   if old_change:old_change(old)
   new=copy.deepcopy(old);change(new)
   for name,p in [('old',old),('new',new)]:
    d=root/name;put(d/'project.json',p);e=[]
    for s in p['shot_plan']:
     f=s['id']+'.jpg';(d/f).write_bytes(b'same fixture pixels');e.append({'shot':s['id'],'label':'middle','time':(s['start']+s['end'])/2,'file':f})
    put(d/'evidence.json',e)
   return changed_shots(root/'old',root/'new')
 def test_metadata_only_edit_does_not_reopen_other_shots(self):
  self.assertEqual(self.scope(lambda p:p['shot_plan'][2]['camera_plan'].update(reason='clearer view')),{'s2'})
 def test_timing_or_reference_binding_change_requires_full_review(self):
  for fn in [lambda p:p['shot_plan'][1].update(start=9),lambda p:p.update(reference_usage=[{'id':'r1'}])]:self.assertEqual(len(self.scope(fn)),6)
 def test_separate_track_edits_preserve_middle_and_cover_hold_after_last_key(self):
  def init(p):p['animation']['tracks']=[{'target':'actor','property':'position','keys':[{'time':i,'value':[0,0,0]} for i in [0,5,15,25,35,45,50]]}]
  def change(p):
   keys=p['animation']['tracks'][0]['keys'];keys[0]['value']=[1,0,0];keys[-1]['value']=[1,0,0]
  self.assertEqual(self.scope(change,init),{'s0','s4','s5'})
 def test_phase_policy_keeps_camera_geometry_and_budget_but_not_initial_authoring_steps(self):
  text=phase_skill('review');self.assertNotIn('## Initial story',text);self.assertIn('Static-first camera',text);self.assertIn('separate cylinder arms',text);self.assertIn('at most two corrections',text);self.assertIn('## Initial story',phase_skill('author'))
if __name__=='__main__':unittest.main()
