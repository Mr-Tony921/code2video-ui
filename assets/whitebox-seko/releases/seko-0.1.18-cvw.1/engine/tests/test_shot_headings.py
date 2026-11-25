import json,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from seko_engine.normalize import normalize

class Headings(unittest.TestCase):
    def parse(self,prompt,duration=24):
        data={'version':2,'duration':duration,'work_prompt':'Original story','segments':[{'id':'seg','start':0,'end':duration,'duration':duration,'resolved_duration':duration,'prompt':prompt}]}
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'input.json';p.write_text(json.dumps(data,ensure_ascii=False));return normalize(p)['segments'][0]['shots']
    def test_inline_references_remain_in_original_shot(self):
        text='分镜1 固定机位\n分镜2 指挥示意\n分镜3 与分镜1相同机位，回看镜头2 的站位\n分镜4 从成员视角'
        shots=self.parse(text);self.assertEqual([s['source_number'] for s in shots],[1,2,3,4]);self.assertIn('与分镜1相同机位',shots[2]['prompt']);self.assertEqual(''.join(s['prompt'] for s in shots),text)
    def test_inline_timed_storyboard_remains_supported(self):
        shots=self.parse('片段1（0–12秒）：镜头1（0–6秒），A持物。镜头2（6–12秒），放下。',12)
        self.assertEqual([s['explicit_duration'] for s in shots],[6,6])
    def test_real_duplicate_heading_still_fails(self):
        with self.assertRaisesRegex(ValueError,'Duplicate shot'):self.parse('分镜1 固定\n分镜1 后拉')
    def test_bracket_and_markdown_headings(self):
        shots=self.parse('## 镜头1：站立\n【镜头02】\n时长：12s\n坐下\n')
        self.assertEqual([s['source_number'] for s in shots],[1,2])
    def test_duration_conflict_still_fails(self):
        with self.assertRaisesRegex(ValueError,'durations contradict'):self.parse('分镜1\n时长：15s\n分镜2\n时长：15s')

if __name__=='__main__':unittest.main()
