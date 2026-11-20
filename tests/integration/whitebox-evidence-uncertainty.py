"""A missing observation is unresolved quality, not permission to rewrite a scene."""
import contextlib,importlib.util,io,json,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
R=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('fixtures',R/'tests/integration/whitebox-provider-failures.py');f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f);h=f.harness
class EvidenceBoundary(unittest.TestCase):
 def test_uncertain_quality_preserves_artifact_without_speculative_correction(self):
  calls=[];review=json.loads(f.REVIEW);review['shots'][0].update(core='uncertain',observed='The necessary event is outside the finite samples; no contrary scene state observed.')
  class Provider:
   def __init__(self,*args):pass
   def clean(self,text):return str(text)
   def call(self,prompt,images,effort,json_mode):
    calls.append(prompt)
    if len(calls)>2:raise AssertionError('Evidence gap must not call source repair')
    return {'text':f.SOURCE if len(calls)==1 else json.dumps(review),'seconds':0}
  def compile(command,**kwargs):f.fixture_output(Path(command[command.index('--out')+1]));return types.SimpleNamespace(stdout='',stderr='',returncode=0)
  with tempfile.TemporaryDirectory() as tmp:
   out=Path(tmp)/'run'
   with patch.object(h,'Provider',Provider),patch.object(h,'normalize',lambda *args:f.TASK.copy()),patch.object(h.subprocess,'run',compile),contextlib.redirect_stdout(io.StringIO()):result=h.run('unused',[],{},'fixture',out)
   self.assertEqual(len(calls),2);self.assertEqual(result['repairs'],0);self.assertTrue(result['scene_success']);self.assertTrue(result['structure_pass'])
   self.assertEqual(result['status'],'renderable_with_issues');self.assertEqual(result['stop_reason'],'quality_evidence_unresolved_without_demonstrated_source_defect')
   artifact=json.loads((out/'artifact.json').read_text());self.assertEqual((out/artifact['source']).read_text(),f.SOURCE)
   saved=json.loads((out/'candidate-00/review.json').read_text());self.assertEqual(saved['shots'][0]['verdict'],'blocker');self.assertEqual(saved['shots'][0]['core'],'uncertain')
   issues=json.loads((out/'candidate-00/issues.json').read_text());self.assertTrue(issues);self.assertFalse(issues[0]['repairable']);self.assertFalse((out/'repair-1-request.json').exists())
if __name__=='__main__':unittest.main()
