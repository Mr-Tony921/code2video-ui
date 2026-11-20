import contextlib,hashlib,importlib.util,io,json,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
R=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('fixture',R/'tests/integration/whitebox-provider-failures.py');f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f);h=f.harness
class CameraStage(unittest.TestCase):
 def scenario(self,unavailable=False):
  calls=[];tools=[];review=json.loads(f.REVIEW);review['shots'][0]['core']='missing'
  class Provider:
   def __init__(self,*args):pass
   def clean(self,text):return str(text)
   def call(self,prompt,images,effort,json_mode):
    calls.append(prompt)
    if len(calls)==1:text=f.SOURCE
    elif len(calls)==2:text=json.dumps(review)
    elif len(calls)==3:
     self_check='OPTIONAL_GEOMETRY_CAMERA_SUGGESTIONS:' in prompt
     if self_check==unavailable:raise AssertionError('wrong suggestion availability')
     if self_check:
      assert 'NOT semantic/all-frame acceptance' in prompt
      assert ('CURRENT_SOURCE:' in prompt and f.SOURCE in prompt) or ('CURRENT_SOURCE_SHA256:' in prompt and h.numbered_source(f.SOURCE) in prompt)
     text=json.dumps({'source_sha256':hashlib.sha256(f.SOURCE.encode()).hexdigest(),'line_edits':[{'start_line':n,'end_line':n,'new_lines':[line.replace('return {};','return {repaired:true};')]} for n,line in enumerate(f.SOURCE.splitlines(),1) if 'return {};' in line]}) if hasattr(h,'numbered_source') else json.dumps({'replacements':[{'old':'return {};','new':'return {repaired:true};'}]})
    elif len(calls)==4:text=f.REVIEW
    else:raise AssertionError('No extra model reflection allowed')
    return {'text':text,'seconds':0}
  def run_tool(command,**kwargs):
   if command[1].endswith('/camera-proposals.mjs'):
    tools.append(command);project=Path(command[command.index('--project')+1]);before=project.read_bytes();dest=Path(command[command.index('--out')+1])
    if unavailable:return types.SimpleNamespace(returncode=1,stdout='',stderr='fixture failure')
    f.put(dest,{'project_sha256':hashlib.sha256(before).hexdigest(),'rows':[{'shot_id':'s1','interval':[0,1],'original_checks':[{'entity_id':'a','time':.5,'pass':False,'in_frame':False,'unoccluded':True,'front_dot':.7}],'proposals':[{'position':[0,1,4],'target':[0,1,0],'fov':45,'checks':[]}],'limitations':'Unapplied point constraints only'}]});assert project.read_bytes()==before
   else:f.fixture_output(Path(command[command.index('--out')+1]))
   return types.SimpleNamespace(returncode=0,stdout='',stderr='')
  with tempfile.TemporaryDirectory() as tmp:
   out=Path(tmp)/'run'
   with patch.object(h,'Provider',Provider),patch.object(h,'normalize',lambda *args:f.TASK.copy()),patch.object(h.subprocess,'run',run_tool),contextlib.redirect_stdout(io.StringIO()):result=h.run('unused',[],{},'fixture',out)
   self.assertEqual(len(calls),4);self.assertEqual(len(tools),1);self.assertEqual(result['repairs'],1);self.assertEqual(result['status'],'self_checked')
   self.assertEqual((out/'candidate-00/source.js').read_text(),f.SOURCE)
   self.assertEqual((out/'repair-1-camera-unavailable.json').exists(),unavailable)
 def test_geometry_candidates_reach_existing_repair_call(self):self.scenario()
 def test_optional_tool_failure_does_not_add_model_call_or_fail_scene(self):self.scenario(True)
if __name__=='__main__':unittest.main()
