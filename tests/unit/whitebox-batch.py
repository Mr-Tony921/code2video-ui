from pathlib import Path
import importlib.util, unittest, hashlib
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('batch',ROOT/'scripts/whitebox-submit-batch.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class Batch(unittest.TestCase):
    def test_resume_preserves_existing_idempotency_contract(self):
        path=ROOT/'runtime/unused/manifest.json'; key='case:profile'
        expected='whitebox:'+hashlib.sha256((str(path.resolve())+':'+key).encode()).hexdigest()
        self.assertEqual(m.job_idempotency_key(path,key,{}),expected)
        self.assertEqual(m.job_idempotency_key(path,key,{'submission_attempt':0}),expected)
        self.assertEqual(m.job_idempotency_key(path,key,{'job_id':'old'}),expected)
    def test_explicit_rerun_gets_stable_distinct_key(self):
        path=ROOT/'runtime/unused/manifest.json'; key='case:profile'
        first=m.job_idempotency_key(path,key,{'submission_attempt':1})
        self.assertNotEqual(first,m.job_idempotency_key(path,key,{}))
        self.assertEqual(first,m.job_idempotency_key(path,key,{'submission_attempt':1,'session_id':'x'}))
        self.assertNotEqual(first,m.job_idempotency_key(path,key,{'submission_attempt':2}))
    def test_invalid_attempt_cannot_silently_create_a_job(self):
        for attempt in (-1,True,'1',1.2):
            with self.assertRaises(ValueError): m.job_idempotency_key(ROOT/'manifest.json','case:profile',{'submission_attempt':attempt})
if __name__=='__main__': unittest.main()
