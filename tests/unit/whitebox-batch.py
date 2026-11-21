from pathlib import Path
import importlib.util, unittest, hashlib, json, tempfile, threading, time, contextlib, io
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('batch',ROOT/'scripts/whitebox-submit-batch.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class Batch(unittest.TestCase):
    def test_concurrent_submission_preserves_receipts_limits_and_idempotent_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root)
            models=[{'profile_id':'one','model':'model-one'},{'profile_id':'two','model':'model-two'}]
            (root/'models.json').write_text(json.dumps(models))
            (root/'account.json').write_text(json.dumps({'username':'fixture','password':'fixture-only'}))
            (root/'config.json').write_text(json.dumps({'storage':{'sessions_root':str(root/'sessions')}}))
            selection=lambda mid:{'profile_id':mid,'engine_release':'seko-0.1.13-cvw.1'}
            server_sessions={};server_jobs={};guard=threading.Lock();requests=[]
            class FakeClient:
                def __init__(self,base):pass
                def request(self,path,body=None,**kwargs):
                    time.sleep(.005)
                    with guard:
                        requests.append(path)
                        if path=='/api/auth/login':return {'user':{'username':'fixture','status':'active'}}
                        if path=='/api/whitebox/settings':return {'models':[{**x,'engine_release':'seko-0.1.13-cvw.1'} for x in models]}
                        if path=='/api/sessions':
                            sid='session-'+str(len(server_sessions));server_sessions[sid]=selection(body['model_id'])
                            return {'session':{'id':sid,'model_selection':server_sessions[sid]}}
                        if path.endswith('/references'):return {'items':[]}
                        if path.endswith('/jobs'):
                            sid=path.split('/')[3];key=kwargs['headers']['Idempotency-Key']
                            if key not in server_jobs:server_jobs[key]={'id':'job-'+sid,'model_selection':server_sessions[sid],'status':'QUEUED'}
                            return {'job':server_jobs[key]}
                    raise AssertionError(path)
            argv=['batch','--dataset',str(root),'--models',str(root/'models.json'),'--account',str(root/'account.json'),
                  '--out',str(root/'ledger'),'--config',str(root/'config.json'),'--base-url','http://fixture.invalid','--workers','4']
            with patch.object(m,'Client',FakeClient),patch('sys.argv',argv+['--limit','3']),contextlib.redirect_stdout(io.StringIO()):m.main()
            self.assertEqual(len(server_jobs),3)
            with patch.object(m,'Client',FakeClient),patch('sys.argv',argv),contextlib.redirect_stdout(io.StringIO()):m.main()
            self.assertEqual(len(server_jobs),4);self.assertEqual(len(server_sessions),4)
            rows=json.loads((root/'ledger/submissions.json').read_text());self.assertEqual(len(rows),4)
            self.assertEqual({r['job_id'] for r in rows.values()},{r['id'] for r in server_jobs.values()})
            self.assertTrue(all(not r['session_create_pending'] for r in rows.values()))
            before=len(requests)
            with patch.object(m,'Client',FakeClient),patch('sys.argv',argv),contextlib.redirect_stdout(io.StringIO()):m.main()
            self.assertEqual(len(server_jobs),4);self.assertNotIn('/api/sessions',requests[before:])
            first=next(iter(rows.values()));first.pop('job_id');first.pop('session_id');first['session_create_pending']=True
            (root/'ledger/submissions.json').write_text(json.dumps(rows));before=len(server_sessions)
            with patch.object(m,'Client',FakeClient),patch('sys.argv',argv),self.assertRaisesRegex(RuntimeError,'outcome unknown'):m.main()
            self.assertEqual(len(server_sessions),before)
    def fixture(self, root, indexed=True):
        tasks, records = [], []
        for group, short in [('seko','S001'),('general','G001')]:
            prompt='原始需求：两人交接。'
            task={'id':'task-'+short,'short_id':short,'group':group,'prompt':prompt,
                  'prompt_sha256':m.sha(prompt.encode()),'attachments':[]}
            filename=short+'.txt'
            submission=prompt+'\n'
            if group=='seko':
                submission=json.dumps({'work_prompt':prompt,'segments':[{'duration':10,'prompt':'镜头1：交接。'}]},ensure_ascii=False)+'\n'
                task.update(business_input_file=filename,business_input_sha256=m.sha(submission.encode()))
            (root/filename).write_text(submission)
            if indexed:
                task.update(dataset_version='0.2.0',cohort='new_200')
                records.append({'task_id':task['id'],'short_id':short,'group':group,
                    'dataset_version':'0.2.0','cohort':'new_200','input_file':filename,
                    'input_sha256':m.sha(submission.encode())})
            envelope={'prompts':[task]}
            if indexed:envelope['dataset_version']='0.2.0'
            (root/(group+'-1.json')).write_text(json.dumps(envelope,ensure_ascii=False))
            tasks.append(task)
        if indexed:(root/'tasks.jsonl').write_text('\n'.join(json.dumps(r) for r in records)+'\n')
        return tasks
    def test_variable_sized_package_preserves_exact_business_and_prose_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root)
            tasks=m.load_tasks(root)
            self.assertEqual([t['short_id'] for t in tasks],['S001','G001'])
            for task in tasks:
                self.assertEqual(task['submitted_prompt'],(root/(task['short_id']+'.txt')).read_text())
                self.assertEqual(task['submitted_sha256'],m.sha(task['submitted_prompt'].encode()))
            self.assertNotIn('version',json.loads(tasks[0]['submitted_prompt']))
            self.assertNotIn('new_200',tasks[1]['submitted_prompt'])
            manifest=m.batch_contract(tasks,[],'account','release')
            self.assertEqual(manifest['tasks'][0]['cohort'],'new_200')
    def test_legacy_package_preserves_original_resume_hashes_and_contract_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root,indexed=False)
            tasks=m.load_tasks(root)
            self.assertEqual(tasks[1]['submitted_prompt'],tasks[1]['prompt'])
            manifest=m.batch_contract(tasks,[],'account','release',version=1)
            self.assertEqual(set(manifest),{'account','release','models','tasks'})
            self.assertEqual(set(manifest['tasks'][0]),{'id','source_prompt_sha256','submitted_prompt_sha256','references'})
    def test_corrupt_input_rejected_before_queue_submission(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root)
            (root/'G001.txt').write_text('changed')
            with self.assertRaisesRegex(ValueError,'hash mismatch'):m.load_tasks(root)
    def test_mixed_versions_and_ambiguous_package_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root)
            p=root/'general-1.json';data=json.loads(p.read_text());data['dataset_version']='0.3.0';p.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError,'Mixed dataset'):m.load_tasks(root)
            (root/'general-2.json').write_text(p.read_text())
            with self.assertRaisesRegex(ValueError,'exactly one'):m.load_tasks(root)
    def test_task_count_and_reference_hash_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root)
            p=root/'general-1.json';data=json.loads(p.read_text())
            data['prompts'][0]['attachments']=[{'order':1,'package_path':'image.jpg','sha256':m.sha(b'original')}]
            (root/'image.jpg').write_bytes(b'changed');p.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError,'Reference hash mismatch'):m.load_tasks(root)
            p.rename(root/'general-2.json')
            with self.assertRaisesRegex(ValueError,'count'):m.load_tasks(root)
    def test_index_outside_package_and_missing_identity_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root)
            p=root/'tasks.jsonl';items=[json.loads(x) for x in p.read_text().splitlines()]
            items[0]['input_file']='../outside.txt';p.write_text('\n'.join(json.dumps(x) for x in items))
            with self.assertRaises(ValueError):m.load_tasks(root)
            p.write_text(json.dumps(items[1]))
            with self.assertRaisesRegex(ValueError,'Input index mismatch'):m.load_tasks(root)
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
