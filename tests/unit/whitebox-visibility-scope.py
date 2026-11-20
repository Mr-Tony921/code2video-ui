import sys,json,unittest,importlib.util,os
from pathlib import Path
R=Path(__file__).resolve().parents[2];E=R/'assets/whitebox-seko/releases'/os.environ.get('SEKO_TEST_RELEASE','seko-0.1.10-cvw.1')/'engine';sys.path.insert(0,str(E/'python'))
os.environ['SEKO_TEST_RELEASE']=E.parent.name
spec=importlib.util.spec_from_file_location('scope_fixtures',R/'tests/unit/whitebox-flow.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
from seko_engine.evidence import changed_shots
class VisibilityScope(unittest.TestCase):
 scope=mod.Flow.scope
 def add(self,p,existing=False):
  if not existing:p['entities']=[{'id':'burst'}]
  p['animation']['tracks'].append({'target':'burst','property':'visible','keys':[{'time':0,'value':False,'interpolation':'step'},{'time':15,'value':True,'interpolation':'step'},{'time':19,'value':False,'interpolation':'step'},{'time':60,'value':False,'interpolation':'step'}]})
 def test_new_short_lived_entity_does_not_reopen_other_shots(self):self.assertEqual(self.scope(self.add),{'s1'})
 def test_existing_entity_visibility_still_conservatively_reopens_all(self):self.assertEqual(len(self.scope(lambda p:self.add(p,True),lambda p:p.update(entities=[{'id':'burst'}]))),6)
 def test_removed_short_lived_entity_has_same_scope(self):self.assertEqual(self.scope(lambda p:p.update(entities=[],animation={'tracks':[]}),self.add),{'s1'})
 def test_new_between_sample_event_cannot_be_dropped(self):
  def change(p):
   self.add(p);p['animation']['tracks'][0]['keys'][1]['time']=11.1;p['animation']['tracks'][0]['keys'][2]['time']=11.2
  self.assertEqual(self.scope(change),{'s1'})
 def test_unknown_visibility_encoding_stays_full(self):
  def change(p):self.add(p);p['animation']['tracks'][0]['keys'][1]['value']=1
  self.assertEqual(len(self.scope(change)),6)
if __name__=='__main__':unittest.main()
