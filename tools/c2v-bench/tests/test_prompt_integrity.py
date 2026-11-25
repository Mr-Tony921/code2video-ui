"""No model/network calls: prevent future submissions from changing business inputs."""
import copy, json, sys, tempfile, unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'bench'))
from prompts import validate_prompt, POLICY
from core import Store, evaluation
from server import App


class NoNetwork:
    def __getattr__(self,name):
        raise AssertionError('Must reject altered prompt before remote calls: '+name)


class PromptIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.suite=json.loads((ROOT/'dataset/v0.1.3/suite.json').read_text())
        (ROOT/'runtime').mkdir(exist_ok=True)
        self.tmp=tempfile.TemporaryDirectory(dir=ROOT/'runtime')
        self.store=Store(Path(self.tmp.name)/'runs')
    def tearDown(self):self.tmp.cleanup()
    def test_all_cases_are_verbatim(self):
        for c in self.suite['cases']:
            self.assertEqual(validate_prompt(c,required=True),c['prompt_original'])
        kestrel=next(c for c in self.suite['cases'] if c['id']=='04a-paper-kestrel')
        self.assertEqual(len(kestrel['requirements']['exact_text']),4)
        for phrase in kestrel['requirements']['exact_text']:
            self.assertIn(phrase,kestrel['prompt_submitted'])
        for c in self.suite['cases']:
            self.assertNotIn('以下是无图片资源的输入，纯文本',c['prompt_submitted'])
    def test_planning_rejects_rewriting_and_missing_contract(self):
        for change in ('prefix','append','both','missing'):
            suite=copy.deepcopy(self.suite);c=suite['cases'][0]
            if change=='prefix':c['prompt_submitted']='视频类型：Product Launch\n'+c['prompt_submitted']
            if change=='append':c['prompt_submitted']+='\n制作方式：使用 Anatomy'
            if change=='both':c['prompt_original']=c['prompt_submitted']='rewritten'
            if change=='missing':del c['prompt_contract']
            with self.subTest(change=change),self.assertRaises(ValueError):
                self.store.plan(suite,c['id'],{},'owner','http://unused','test')
        self.assertFalse(list(self.store.root.glob('run_*.json')))
    def test_submit_revalidates_saved_prompt_before_remote_calls(self):
        c=next(c for c in self.suite['cases'] if c['id']=='04b-paper-yeti')
        run=self.store.plan(self.suite,c['id'],{},'owner','http://unused','test')
        run['case']['prompt_submitted']+='\nextra instruction';self.store.put(run)
        app=App(ROOT,'http://unused',store=self.store,suite_version='0.1.3')
        try:
            with self.assertRaises(ValueError):app.submit(run['id'],{'owner':'owner','remote':NoNetwork()})
        finally:app.pool.shutdown(wait=False)
    def test_duration_range_is_not_reference_duration(self):
        c=next(c for c in self.suite['cases'] if c['id']=='02-manus-template')
        for seconds, expected in ((74,False),(75,True),(100,True),(120,True),(121,False)):
            r={'case':c,'job':{'status':'COMPLETED','result_asset':{'playable':True}},'probe':{'decode_ok':True,'duration_seconds':seconds,'width':1920,'height':1080},'reviews':[]}
            e=evaluation(r)
            self.assertEqual(e['duration_ok'],expected)

if __name__=='__main__':unittest.main()
