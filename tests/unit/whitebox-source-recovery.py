import os
import sys,json,unittest,tempfile,os,contextlib,io
from pathlib import Path
from unittest.mock import patch
R=Path(__file__).resolve().parents[2];L=Path(__file__).parent;E=R/'assets/whitebox-seko/releases'/os.environ.get('SEKO_TEST_RELEASE','seko-0.1.10-cvw.1')/'engine';sys.path.insert(0,str(E/'python'))
from seko_engine.provider import normalize_source,parse_source
from seko_engine import harness
class Recovery(unittest.TestCase):
 def test_valid_body_is_retained_exactly_without_model_call(self):
  body="const actor = helpers.person('a', '人物', [0,0,0]);\nreturn {actor, duration:task.duration};"
  source,audit=normalize_source(body)
  self.assertEqual(audit['kind'],'contract_envelope');self.assertEqual(source.split('\n',1)[1].rsplit('\n}',1)[0],body);self.assertEqual(audit['model_calls'],0)
 def test_complete_module_unchanged(self):
  source='export async function buildScene({task}) { return {duration:task.duration}; }\n';self.assertEqual(parse_source(source),source)
 def test_syntax_invalid_partial_or_non_code_is_not_invented(self):
  for body in ['你好，请稍等。','const x = ;\nreturn {};','const x=1;\nreturn {','import x from "x";\nreturn {};','const buildScene=()=>({});']:
   with self.assertRaises(ValueError):parse_source(body)
 def test_syntax_normalization_never_executes_source(self):
  with tempfile.TemporaryDirectory() as temp:
   p=Path(temp)/'must-not-exist';body=f'process.getBuiltinModule("fs").writeFileSync({json.dumps(str(p))},"bad");\nreturn {{}};'
   self.assertEqual(normalize_source(body)[1]['kind'],'contract_envelope');self.assertFalse(p.exists())
 def test_invalid_draft_and_every_reference_reach_next_repair(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);img=root/'reference.png';img.write_bytes(b'fixture');task={'duration':1,'segments':[],'references':[{'id':'reference_1','filename':'reference.png','local_path':str(img)}]};raw='const malformed = ;\nreturn {};';seen=[]
   class P:
    def __init__(self,*a):pass
    def clean(self,s):return s
    def call(self,prompt,images,effort,json_mode):
     seen.append((prompt,images))
     if len(seen)==1:return {'text':raw,'seconds':0}
     self_test.assertIn('CURRENT_SOURCE:\n'+raw,prompt);self_test.assertEqual(images,[('reference_1',img)]);raise RuntimeError('fixture transport unavailable')
   self_test=self
   with patch.object(harness,'Provider',P),patch.object(harness,'normalize',lambda *a:task),patch.object(harness,'reference_sheets',lambda *a:[]),contextlib.redirect_stdout(io.StringIO()):r=harness.run('unused',[],{},'fixture',root/'run')
   self.assertEqual(len(seen),2,r.get('error')); self.assertEqual(r['failed_model_stage'],'repair-1');self.assertFalse((root/'run/artifact.json').exists())
if __name__=='__main__':unittest.main()
