"""Run with Python + Pillow. Isolated failure-boundary regression; no network/real user data."""
import contextlib,io,json,sys,tempfile,types,unittest,os
from pathlib import Path
from unittest.mock import patch
from PIL import Image
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'assets/whitebox-seko/releases'/os.environ.get('SEKO_TEST_RELEASE','seko-0.1.10-cvw.1')/'engine/python'))
from seko_engine import harness
SOURCE='export async function buildScene(){ return {}; }\n'
TASK={'references':[],'segments':[],'duration':1}
PROJECT={'revision':0,'duration':1,'shot_plan':[{'id':'s1','segment_id':'seg1','start':0,'end':1}],'entities':[],'animation':{'tracks':[]},'reference_usage':[]}
REVIEW=json.dumps({'shots':[{'id':'s1','verdict':'pass','core':'met','simplification':'none','requirement':'actor present','observed':'actor visible','evidence':['seg01-page01.jpg']}],'seen':['seg01-page01.jpg'],'issues':[]})
def put(p,v):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v))
def fixture_output(out,blocker=False):
 out.mkdir(parents=True,exist_ok=True)
 for name,v in {'project.json':PROJECT,'probe.json':{'ok':True,'seconds':0,'errors':[]},'checks.json':{'pass':True,'errors':[]},'focus-checks.json':{'pass':not blocker,'errors':[{'code':'required_focus','shot_id':'s1','message':'recorded factual blocker'}] if blocker else []},'determinism.json':{'pass':True}}.items():put(out/name,v)
 Image.new('RGB',(8,8),'gray').save(out/'frame.png')
 put(out/'evidence.json',[{'shot':'s1','segment_id':'seg1','label':'middle','time':.5,'file':'frame.png'}])
class BoundaryTests(unittest.TestCase):
 def run_scenario(self,scenario):
  calls=[]
  class Provider:
   def __init__(self,*args):pass
   def clean(self,s):return s
   def call(self,prompt,images,effort,json_mode):
    calls.append(prompt)
    if scenario in ('plan_fail','refine_fail') or scenario=='review_fail' and len(calls)==2:raise BrokenPipeError(32,'Broken pipe')
    if len(calls)==1:return {'text':SOURCE,'seconds':0}
    if scenario=='success' and len(calls)==2:return {'text':REVIEW,'seconds':0}
    raise AssertionError('Provider failure must not trigger a source-repair call')
  def compile_record(command,**kwargs):
   fixture_output(Path(command[command.index('--out')+1]),blocker=scenario=='review_fail');return types.SimpleNamespace(stdout='',stderr='',returncode=0)
  with tempfile.TemporaryDirectory(prefix='whitebox-boundary-') as temp:
   temp=Path(temp);out=temp/'run';seed=None
   if scenario=='refine_fail':
    seed=temp/'seed';fixture_output(seed/'candidate-00/output');(seed/'candidate-00/source.js').write_text(SOURCE);put(seed/'task.json',TASK);put(seed/'artifact.json',{'source':'candidate-00/source.js','project':'candidate-00/output/project.json'})
   with patch.object(harness,'Provider',Provider),patch.object(harness,'normalize',lambda *args:TASK.copy()),patch.object(harness.subprocess,'run',compile_record),contextlib.redirect_stdout(io.StringIO()):
    result=harness.run('unused',[],{},'fake',out,seed_run=seed,refinement_request='Move camera' if seed else None)
   self.assertEqual(result['repairs'],0)
   if scenario=='plan_fail':
    self.assertEqual(result['status'],'failed');self.assertFalse((out/'artifact.json').exists());self.assertEqual(len(calls),1)
   else:
    self.assertEqual(result['status'],'self_checked' if scenario=='success' else 'renderable_with_issues')
    artifact=json.loads((out/'artifact.json').read_text());self.assertEqual((out/artifact['source']).read_text(),SOURCE)
    self.assertEqual(len(calls),1 if scenario=='refine_fail' else 2)
   if scenario=='review_fail':
    self.assertTrue(result['self_check_unavailable']);self.assertEqual(result['failed_model_stage'],'review-0')
    issues=json.loads((out/'candidate-00/issues.json').read_text());self.assertEqual([x['code'] for x in issues],['required_focus','model_call_unavailable'])
    self.assertFalse((out/'repair-1-request.json').exists())
   if seed:
    self.assertEqual((seed/'candidate-00/source.js').read_text(),SOURCE)
    self.assertFalse((seed/'candidate-00/issues.json').exists())
    self.assertEqual(result['failed_model_stage'],'refine')
    self.assertEqual(json.loads((out/'candidate-base/issues.json').read_text())[0]['code'],'model_call_unavailable')
 def test_initial_provider_failure_has_no_fabricated_artifact(self):self.run_scenario('plan_fail')
 def test_review_network_failure_keeps_scene_and_facts_without_repair(self):self.run_scenario('review_fail')
 def test_refinement_failure_preserves_previous_scene(self):self.run_scenario('refine_fail')
 def test_successful_path_still_reviews_and_packages(self):self.run_scenario('success')
if __name__=='__main__':unittest.main()
