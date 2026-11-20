from pathlib import Path
import importlib.util,json,unittest,tempfile
R=Path(__file__).resolve().parents[2];E=R/'assets/whitebox-seko/releases/seko-0.1.10-cvw.1/engine';sp=importlib.util.spec_from_file_location('fast_intake',E/'python/seko_engine/intake.py');m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
SOURCE='作品：两人见面，总时长10秒\n\n片段1：走近\n时长：6秒\n分镜1 A走到B身边\n音效：脚步\n\n片段2：停下\n时长：4秒\n分镜1 A停下\n音效：无'
class Provider:
 context='saved'
 def __init__(self):self.calls=[]
 def call(self,*a,**kw):self.calls.append((a,kw));return {'text':json.dumps({'action':'clarify','text':'希望视频多长时间？'},ensure_ascii=False)}
class Fast(unittest.TestCase):
 def test_exact_explicit_blocks_need_no_model(self):
  provider=Provider();written={};result=m.decide(provider,json.loads,[{'user':SOURCE}],[],lambda p,v:written.__setitem__(p.name,v),Path('/unused'))
  self.assertEqual(provider.calls,[]);self.assertEqual(provider.context,'saved');self.assertEqual(result['input']['duration'],10);self.assertEqual(written['intake-input-map.json']['model_calls'],0);self.assertTrue(result['input']['segments'][0]['prompt'].endswith('音效：脚步'));self.assertTrue(result['input']['segments'][1]['prompt'].endswith('音效：无'))
 def test_wish_falls_back_to_model_clarification(self):
  p=Provider();r=m.decide(p,json.loads,[{'user':'两个角色在雨天相遇。'}],[],lambda *a:None,Path('/unused'));self.assertEqual(r['action'],'clarify');self.assertEqual(len(p.calls),1);self.assertEqual(p.context,'saved')
 def test_followup_clarification_retains_conversation_path(self):
  p=Provider();m.decide(p,json.loads,[{'user':'想拍见面','assistant':'希望多久？'},{'user':SOURCE}],[],lambda *a:None,Path('/unused'));self.assertEqual(len(p.calls),1);self.assertEqual(p.context,'saved')
 def test_total_conflict_falls_back(self):self.assertIsNone(m.explicit_story_decision(SOURCE.replace('总时长10秒','总时长12秒')))
 def test_segment_duration_missing_falls_back(self):self.assertIsNone(m.explicit_story_decision(SOURCE.replace('时长：4秒','节奏轻快')))
 def test_unknown_header_falls_back(self):self.assertIsNone(m.explicit_story_decision('第一幕\n分镜1 见面'))
 def test_over_300_seconds_falls_back(self):self.assertIsNone(m.explicit_story_decision('片段1\n时长：301秒\n分镜1 看门'))
 def test_explicit_shot_time_conflict_falls_back(self):self.assertIsNone(m.explicit_story_decision('片段1\n时长：10秒\n分镜1 看门\n时长：12秒'))
 def test_explicit_shots_sum_must_match(self):self.assertIsNone(m.explicit_story_decision('片段1\n时长：10秒\n分镜1 看门\n时长：3秒\n分镜2 开门\n时长：4秒'))
 def test_clear_beat_intervals(self):
  source='**【Beat1】(0s-30s)|见面**\n【镜头1】两人见面\n\n**【Beat2】(30s-60s)|离开**\n【镜头1】两人走开';d=m.explicit_story_decision(source);self.assertEqual([s['duration'] for s in d['segments']],[30,30]);self.assertEqual(m.assemble(d,source)[0]['input']['duration'],60)
 def test_beat_interval_gap_falls_back(self):self.assertIsNone(m.explicit_story_decision('【Beat1】(0s-30s)\n【镜头1】两人见面\n【Beat2】(31s-60s)\n【镜头1】两人走开'))
 def test_analysis_only_request_falls_back(self):self.assertIsNone(m.explicit_story_decision('只分析，不要生成\n'+SOURCE))
 def test_global_suffix_timing_conflict_falls_back(self):self.assertIsNone(m.explicit_story_decision(SOURCE+'\n全局要求：\n总时长20秒'))
 def test_ambiguous_extra_timing_falls_back(self):self.assertIsNone(m.explicit_story_decision('前3秒不动，其他正常\n'+SOURCE))
if __name__=='__main__':unittest.main()
