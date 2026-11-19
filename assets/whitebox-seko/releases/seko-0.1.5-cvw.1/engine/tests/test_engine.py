import copy,json,os,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from seko_engine.provider import parse_source,apply_source_patch
from seko_engine.harness import carry_failures
from seko_engine.revisions import apply_operations,create_workspace,publish,manual_edit
from seko_engine.io import read,write
from seko_engine.normalize import normalize
from seko_engine.scheduler import enqueue,list_jobs,cancel

class Contracts(unittest.TestCase):
    def setUp(self):
        root=Path(os.environ.get('SEKO_TEST_TMP',Path(__file__).parent/'.tmp'));root.mkdir(parents=True,exist_ok=True)
        self.tmp=tempfile.TemporaryDirectory(dir=root);self.root=Path(self.tmp.name)
        self.project={'revision':0,'duration':10,'segments':[{'id':'seg_a','start':0,'end':10}],'shot_plan':[{'id':'shot_001','start':0,'end':4},{'id':'shot_002','start':4,'end':10}],'entities':[{'id':'actor'}],'provenance':{},'edits':[],'animation':{'tracks':[]},'scene':{'original':'unchanged'}}
    def tearDown(self):self.tmp.cleanup()
    def test_invalid_patch_keeps_story_feedback(self):
        prior=[{'shot_id':'shot_003','error':'actor absent'}]
        result=carry_failures(prior,{'code':'candidate_error'})
        self.assertEqual(result[0],prior[0]);self.assertEqual(len(prior),1);self.assertEqual(len(result),2)
    def test_patch_requires_unique_exact_match(self):
        source='export async function buildScene(){return 1;}\n'
        self.assertIn('return 2',apply_source_patch(source,json.dumps({'replacements':[{'old':'return 1','new':'return 2'}]})))
        with self.assertRaises(ValueError):apply_source_patch(source,json.dumps({'replacements':[{'old':'missing','new':'x'}]}))
        self.assertEqual(parse_source('async function buildScene(){}'),'export async function buildScene(){}\n')
    def test_scoped_edit_never_rewrites_scene(self):
        op={'kind':'freeze_position','entity_id':'actor','start':4,'end':10,'position':[1,0,2]}
        result=apply_operations(self.project,[op],'shot_002',{'actor'})
        self.assertEqual(result['scene'],self.project['scene']);self.assertEqual(result['animation'],self.project['animation']);self.assertEqual(self.project['edits'],[])
        for change in [{'start':0},{'entity_id':'__camera'},{'position':[float('nan'),0,0]}]:
            with self.assertRaises(ValueError):apply_operations(self.project,[op|change],'shot_002',{'actor'})
    def test_head_compare_and_swap_preserves_newer_manual_edit(self):
        write(self.root/'project.json',self.project);write(self.root/'task.json',{})
        workspace=self.root/'work';head=create_workspace(self.root/'project.json',self.root/'task.json',workspace)
        op={'kind':'translate','entity_id':'actor','start':0,'end':10,'delta':[1,0,0]}
        manual_edit(workspace,[op],0)
        with self.assertRaises(ValueError):publish(workspace,head,self.project,{})
        self.assertEqual(read(workspace/'head.json')['revision'],1)
    def test_queue_cancel_claims_only_queued(self):
        db=self.root/'queue.sqlite';job=enqueue(db,'generate',['--out',str(self.root/'job')]);self.assertTrue(cancel(db,job));self.assertFalse(cancel(db,job));self.assertEqual(list_jobs(db)[0]['status'],'cancelled')
    def test_normalizer_preserves_explicit_durations(self):
        source={'version':2,'work_prompt':'test','duration':10,'segments':[{'id':'s','title':'seg','start':0,'end':10,'duration':10,'resolved_duration':10,'prompt':'【镜头1】时长：4秒。甲站立。\n【镜头2】时长：6秒。甲坐下。'}]}
        path=self.root/'input.txt';path.write_text('用户输入\n'+json.dumps(source,ensure_ascii=False)+'\n结束')
        task=normalize(path,None);self.assertEqual([s['explicit_duration'] for s in task['segments'][0]['shots']],[4,6])
        source['segments'][0]['end']=11;path.write_text(json.dumps(source))
        with self.assertRaises(ValueError):normalize(path,None)

if __name__=='__main__':unittest.main()
