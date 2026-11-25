"""Failure-boundary regression: finite recovery, original task, no partial compile."""
import contextlib,io,json,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from seko_engine import harness as h
from seko_engine.provider import OutputLimitError

SOURCE='export async function buildScene(){ return {fixed:true}; }\n'
REVIEW=json.dumps({'shots':[{'id':'s1','core':'met','simplification':'none','requirement':'A gives B a parcel','observed':'parcel received','evidence':['seg01-page01.jpg']}],'seen':['seg01-page01.jpg'],'issues':[]})

class Recovery(unittest.TestCase):
    def scenario(self,answers,seed=False,family='opus',defect=False):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);root=Path(temp.name)
        image=root/'reference.png';Image.new('RGB',(8,8),'gray').save(image)
        task={'references':[{'id':'reference_1','filename':'reference.png','local_path':str(image)}],'segments':[],'duration':1,'work_prompt':'A gives B a parcel'}
        project={'revision':0,'duration':1,'shot_plan':[{'id':'s1','segment_id':'seg1','start':0,'end':1}],'entities':[],'animation':{'tracks':[]},'reference_usage':[]}
        calls=[];compiled=[];configs=[]
        class Provider:
            def __init__(self,*a):self.cfg={'max_output_tokens':32768};self.family=family;configs.append(self)
            def clean(self,s):return str(s)
            def call(self,prompt,images,effort,json_mode):
                calls.append({'prompt':prompt,'images':images,'effort':effort,'json':json_mode,'cap':self.cfg['max_output_tokens'],'stage':self.current_stage})
                value=answers[len(calls)-1]
                if isinstance(value,Exception):raise value
                return {'text':value,'seconds':0}
        def fixture(out):
            out.mkdir(parents=True,exist_ok=True)
            values={'project.json':project,'probe.json':{'ok':True,'errors':[]},'checks.json':{'pass':True,'errors':[]},'focus-checks.json':{'pass':not defect,'errors':[{'code':'required_focus','shot_id':'s1','message':'hidden parcel'}] if defect else []},'determinism.json':{},'evidence.json':[{'shot':'s1','segment_id':'seg1','label':'middle','time':.5,'file':'frame.jpg'}]}
            for n,v in values.items():(out/n).write_text(json.dumps(v))
            Image.new('RGB',(8,8),'gray').save(out/'frame.jpg')
        def compile(command,**kw):
            if any('camera-proposals' in str(s) for s in command):raise RuntimeError('optional fixture unavailable')
            compiled.append(Path(command[command.index('--source')+1]).read_text())
            fixture(Path(command[command.index('--out')+1]));return types.SimpleNamespace(stdout='',stderr='',returncode=0)
        seedpath=None
        if seed:
            seedpath=root/'seed';fixture(seedpath/'candidate-00/output');(seedpath/'candidate-00/source.js').write_text(SOURCE)
            for n,v in {'task.json':task,'artifact.json':{'source':'candidate-00/source.js','project':'candidate-00/output/project.json'}}.items():(seedpath/n).write_text(json.dumps(v))
        with patch.object(h,'Provider',Provider),patch.object(h,'normalize',lambda *a:task),patch.object(h,'reference_sheets',lambda *a:[]),patch.object(h.subprocess,'run',compile),contextlib.redirect_stdout(io.StringIO()):
            result=h.run('unused',None,None,'fake',root/'run',seed_run=seedpath,refinement_request='Move A slightly' if seed else None)
        self.assertEqual(configs[0].cfg['max_output_tokens'],32768)
        self.assertLessEqual(result['repair_requests'],1 if seed else 2)
        return result,calls,compiled,root
    def test_empty_truncated_author_recovers_with_original_task_refs(self):
        r,c,compiled,root=self.scenario([OutputLimitError('', 'max_tokens',32768),SOURCE,REVIEW])
        self.assertEqual(r['status'],'self_checked');self.assertEqual(r['repair_requests'],1)
        self.assertEqual([x['stage'] for x in c],['plan','repair-1','review-1']);self.assertEqual([x['cap'] for x in c],[32768,65536,32768])
        self.assertEqual(c[1]['effort'],'low');self.assertFalse(c[1]['json']);self.assertIn('A gives B a parcel',c[1]['prompt']);self.assertEqual(c[0]['images'],c[1]['images']);self.assertEqual(compiled,[SOURCE])
        self.assertTrue((root/'run/repair-1-recovery.json').exists())
    def test_truncated_recovery_stops_without_third_generation(self):
        r,c,compiled,root=self.scenario([OutputLimitError('partial', 'max_tokens',32768),OutputLimitError('still partial','max_tokens',65536)])
        self.assertEqual(r['status'],'failed');self.assertEqual(len(c),2);self.assertEqual(compiled,[]);self.assertFalse((root/'run/artifact.json').exists())
    def test_first_technical_repair_truncation_uses_only_last_slot(self):
        r,c,compiled,root=self.scenario(['not a module',OutputLimitError('','max_tokens',32768),SOURCE,REVIEW])
        self.assertEqual(r['status'],'self_checked');self.assertEqual(r['repair_requests'],2);self.assertEqual(c[2]['stage'],'repair-2');self.assertEqual(c[2]['cap'],65536);self.assertEqual(compiled,[SOURCE])
    def test_existing_scene_truncated_repair_keeps_it_without_reauthoring(self):
        r,c,compiled,root=self.scenario([SOURCE,REVIEW,OutputLimitError('','max_tokens',32768)],defect=True)
        self.assertEqual(r['status'],'renderable_with_issues');self.assertEqual(len(c),3);self.assertNotIn('output_recoveries',r);self.assertEqual(compiled,[SOURCE]);self.assertEqual(r['selected_candidate'],'candidate-00')
    def test_review_truncation_is_not_source_recovery(self):
        r,c,compiled,root=self.scenario([SOURCE,OutputLimitError('','max_tokens',32768)])
        self.assertEqual(r['status'],'renderable_with_issues');self.assertEqual(len(c),2);self.assertEqual(r['repair_requests'],0)
    def test_followup_truncation_preserves_previous_scene(self):
        r,c,compiled,root=self.scenario([OutputLimitError('','max_tokens',32768)],seed=True)
        self.assertEqual(r['selected_candidate'],'candidate-base');self.assertEqual(len(c),1);self.assertEqual((root/'seed/candidate-00/source.js').read_text(),SOURCE)
    def test_network_failure_does_not_spend_source_repair(self):
        r,c,compiled,root=self.scenario([BrokenPipeError('network')])
        self.assertEqual(r['status'],'failed');self.assertEqual(len(c),1);self.assertEqual(r['repair_requests'],0)
    def test_other_provider_keeps_configured_cap(self):
        r,c,compiled,root=self.scenario([OutputLimitError('','length',32768),SOURCE,REVIEW],family='deepseek')
        self.assertEqual(r['status'],'self_checked');self.assertEqual(c[1]['cap'],32768)

if __name__=='__main__':unittest.main()
