import json, sys, tempfile, unittest, uuid
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'bench'))
from core import Store, evaluation
from timing import format_elapsed, job_timing


class TimingTests(unittest.TestCase):
    def test_format_and_carry(self):
        for value, text in ((0,'00小时00分钟00秒'),(62,'00小时01分钟02秒'),
                            (3599.6,'01小时00分钟00秒'),(3661,'01小时01分钟01秒'),
                            (360000,'100小时00分钟00秒'),(None,'未记录'),(-1,'未记录'),(float('nan'),'未记录')):
            with self.subTest(value=value):self.assertEqual(format_elapsed(value),text)
    def test_persisted_timing_excludes_queue_and_keeps_precision(self):
        (ROOT/'runtime').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT/'runtime') as d:
            store=Store(d)
            job={'created_at':'2026-11-25T00:00:00Z','queued_at':'2026-11-25T00:00:03Z',
                 'started_at':'2026-11-25T00:01:03Z','finished_at':'2026-11-25T01:03:06.250Z'}
            r={'id':'run_'+str(uuid.uuid4()),'job':job,'case':{'requirements':{}}}
            store.put(r);saved=json.loads(store.path(r['id']).read_text())
            self.assertEqual(saved['timing']['execution_seconds'],3723.25)
            self.assertEqual(saved['timing']['execution_duration'],'01小时02分钟03秒')
            self.assertEqual(saved['timing']['queue_seconds'],60)
            self.assertEqual(saved['timing']['total_seconds'],3786.25)
            self.assertEqual(saved['job'],job)
            self.assertEqual(evaluation(saved)['execution_duration'],saved['timing']['execution_duration'])
    def test_missing_or_invalid_finish_is_not_zero(self):
        for end in (None,'invalid','2026-11-24T00:00:00Z'):
            t=job_timing({'started_at':'2026-11-25T00:00:00Z','finished_at':end})
            self.assertIsNone(t['execution_seconds']);self.assertEqual(t['execution_duration'],'未记录')

if __name__=='__main__':unittest.main()
