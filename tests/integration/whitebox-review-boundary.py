"""Exercise real engine failure routing with fake local tools/provider only."""
import importlib.util,contextlib,io,json,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
R=Path(__file__).resolve().parents[2];spec=importlib.util.spec_from_file_location('fixtures',R/'tests/integration/whitebox-provider-failures.py');f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f);h=f.harness
class Boundary(unittest.TestCase):
 def scenario(self,answer):
  calls=[]
  class Provider:
   def __init__(self,*args):pass
   def clean(self,text):return str(text)
   def call(self,prompt,images,effort,json_mode):
    calls.append(prompt)
    if len(calls)==1:return {'text':f.SOURCE,'seconds':0}
    if len(calls)==2:return {'text':answer,'seconds':0}
    raise AssertionError('Invalid review must not create a source repair or implicit model retry')
  def compile(command,**kwargs):f.fixture_output(Path(command[command.index('--out')+1]));return types.SimpleNamespace(stdout='',stderr='',returncode=0)
  with tempfile.TemporaryDirectory() as temp:
   out=Path(temp)/'run'
   with patch.object(h,'Provider',Provider),patch.object(h,'normalize',lambda *args:f.TASK.copy()),patch.object(h.subprocess,'run',compile),contextlib.redirect_stdout(io.StringIO()):result=h.run('unused',[],{},'fixture',out)
   self.assertEqual(len(calls),2);self.assertEqual(result['repairs'],0);self.assertEqual(result['status'],'renderable_with_issues');self.assertTrue(result['self_check_unavailable']);self.assertEqual(result['failed_review_stage'],'review-0')
   a=json.loads((out/'artifact.json').read_text());self.assertEqual((out/a['source']).read_text(),f.SOURCE);self.assertEqual(json.loads((out/'candidate-00/issues.json').read_text())[0]['code'],'review_contract');self.assertFalse((out/'repair-1-request.json').exists())
 def test_invalid_json_retains_scene_without_source_repair(self):self.scenario('not a review JSON')
 def test_missing_core_retains_scene_without_source_repair(self):
  d=json.loads(f.REVIEW);d['shots'][0].pop('core');self.scenario(json.dumps(d))
if __name__=='__main__':unittest.main()
