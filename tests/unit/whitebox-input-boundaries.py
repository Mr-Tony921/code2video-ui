from pathlib import Path
import importlib.util,json,unittest
R=Path(__file__).resolve().parents[2];E=R/'assets/whitebox-seko/releases/seko-0.1.10-cvw.1/engine';spec=importlib.util.spec_from_file_location('intake_a9',E/'python/seko_engine/intake.py');i=importlib.util.module_from_spec(spec);spec.loader.exec_module(i)
class Boundary(unittest.TestCase):
 def test_final_shot_suffix_stays_in_its_segment(self):
  source='全片10秒\n\n片段1：见面\n时长：10秒\n分镜1 人物靠近门\n配音台词：无\n背景音效：脚步声'
  d={'action':'generate','segments':[{'first_line':3,'last_line':6,'duration':10}]};x,a=i.assemble(d,source);self.assertEqual(x['input']['segments'][0]['prompt'],'\n'.join(source.splitlines()[2:]));self.assertNotIn('脚步声',x['input']['work_prompt']);self.assertEqual(a['boundary_corrections'][0]['original'],[3,6]);self.assertEqual(a['model_calls'],1);self.assertEqual(a['repair_budget_used'],0)
 def test_intermediate_suffix_remains_with_previous_shot(self):
  source='片段1\n分镜1 A\n音效：脚步\n\n片段2\n分镜2 B\n音效：关门'
  d={'action':'generate','segments':[{'first_line':1,'last_line':2,'duration':3},{'first_line':5,'last_line':6,'duration':3}]};x,a=i.assemble(d,source);self.assertTrue(x['input']['segments'][0]['prompt'].endswith('音效：脚步'));self.assertTrue(x['input']['segments'][1]['prompt'].endswith('音效：关门'));self.assertFalse(x['input']['work_prompt'].strip())
 def test_explicit_global_section_is_not_absorbed(self):
  source='片段1\n分镜1 人物看门\n音效：无\n\n全局要求：\n所有场景偏暖色'
  d={'action':'generate','segments':[{'first_line':1,'last_line':2,'duration':5}]};x,a=i.assemble(d,source);self.assertEqual(x['input']['segments'][0]['prompt'],'片段1\n分镜1 人物看门\n音效：无');self.assertIn('所有场景偏暖色',x['input']['work_prompt'])
 def test_no_segment_headings_does_not_invent_boundary(self):
  source='整体10秒\n分镜1 走到门口\n全局用冷色';d={'action':'generate','segments':[{'first_line':2,'last_line':2,'duration':10}]};x,a=i.assemble(d,source);self.assertEqual(a['boundary_corrections'],[]);self.assertIn('全局用冷色',x['input']['work_prompt'])
if __name__=='__main__':unittest.main()
