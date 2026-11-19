"""Business input must preserve supplied shot text without a model rewrite."""
import importlib.util,json,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('seko_run',ROOT/'apps/worker-bridge/scripts/seko-run.py');host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
class BusinessInput(unittest.TestCase):
 def test_wrapped_business_json_preserves_all_fields_and_surrounding_words(self):
  source={'version':2,'duration':300,'work_prompt':'','segments':[{'id':'original_id','prompt':'【镜头1】保留原文 {道具} 与引号 "人物"','duration':30}], 'extra':{'keep':'unchanged'}}
  raw='用户要求：全部片段一次生成。\r\n'+json.dumps(source,ensure_ascii=False)+'\n镜头之外不新增人物。'
  result=host.business_input(raw)
  self.assertEqual(result['segments'],source['segments']);self.assertEqual(result['extra'],source['extra']);self.assertEqual(result['duration'],300)
  self.assertIn('用户要求：全部片段一次生成。',result['work_prompt']);self.assertIn('镜头之外不新增人物。',result['work_prompt'])
 def test_plain_json_is_unchanged_and_prose_stays_conversational(self):
  source={'version':2,'duration':10,'segments':[],'work_prompt':'test'}
  self.assertEqual(host.business_input(json.dumps(source)),source)
  for raw in ['做一个10秒的追逐白模。','请修改 {灯光}，其余不变。','{"version":2,"segments":','{"version":1,"segments":[]}']:
   self.assertIsNone(host.business_input(raw))
if __name__=='__main__':unittest.main()
