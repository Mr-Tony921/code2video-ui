"""Public business envelope omits transport metadata; explicit constraints stay authoritative."""
from pathlib import Path
import importlib.util,json,unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('host',ROOT/'apps/worker-bridge/scripts/seko-run.py');host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
class Business(unittest.TestCase):
 def test_minimal_envelope_derives_only_missing_time_fields(self):
  value={'work_prompt':'原始故事','segments':[{'id':'A','duration':6,'prompt':'【镜头1】\n时长：6s\n拿起包。'},{'id':'B','duration':4,'prompt':'【镜头2】\n时长：4s\n离开。'}]}
  out=host.business_input(json.dumps(value,ensure_ascii=False));self.assertEqual(out['version'],2);self.assertEqual(out['duration'],10)
  self.assertEqual(out['segments'][1]['start'],6);self.assertEqual(out['segments'][1]['end'],10)
  self.assertEqual([s['prompt']for s in out['segments']],[s['prompt']for s in value['segments']]);self.assertNotIn('version',value)
 def test_conflicting_explicit_fields_are_not_silently_rewritten(self):
  value={'version':2,'work_prompt':'x','duration':99,'segments':[{'id':'A','duration':6,'start':4,'end':20,'resolved_duration':8,'prompt':'分镜1 x'}]}
  out=host.business_input(json.dumps(value));self.assertEqual(out['duration'],99);self.assertEqual(out['segments'][0]['start'],4);self.assertEqual(out['segments'][0]['resolved_duration'],8)
 def test_unsupported_version_fails_without_a_model_rewrite(self):
  with self.assertRaisesRegex(ValueError,'Unsupported'):host.business_input('{"version":3,"work_prompt":"x","segments":[]}')
 def test_ordinary_prose_is_not_misidentified(self):
  self.assertIsNone(host.business_input('两人握手。'));self.assertIsNone(host.business_input('{"segments":[1]}'))
 def test_surrounding_instructions_preserved(self):
  out=host.business_input('保留门口。\n'+json.dumps({'work_prompt':'x','segments':[]})+'\n只改人物A。')
  self.assertIn('保留门口。',out['work_prompt']);self.assertIn('只改人物A。',out['work_prompt'])
if __name__=='__main__':unittest.main()
