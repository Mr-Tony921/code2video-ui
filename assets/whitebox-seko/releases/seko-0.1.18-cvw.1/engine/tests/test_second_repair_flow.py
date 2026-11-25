"""Actual harness request assembly keeps old findings read-only on repair 2."""
import contextlib,io,json,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from seko_engine import harness as h

class SecondRepairFlow(unittest.TestCase):
    def test_new_issue_does_not_reopen_old_edit_target(self):
        source='export async function buildScene(){ return {}; }\n'
        task={'references':[],'segments':[],'duration':2}
        project={'revision':0,'duration':2,'shot_plan':[{'id':x,'segment_id':'seg','start':i,'end':i+1} for i,x in enumerate(['a','b'])],'entities':[],'animation':{'tracks':[]},'reference_usage':[]}
        def review(new=False):
            ids=['a','b'] if new else ['a']
            return {'seen':['seg01-page01.jpg'],'shots':[{'id':x,'requirement':'actor visible','observed':'hidden' if x in ids else 'visible','core':'missing' if x in ids else 'met','simplification':'none','evidence':['seg01-page01.jpg']} for x in ['a','b']], 'issues':[{'shot_id':x,'problem_id':x,'problem':'actor hidden','issue_type':'visibility','evidence':['seg01-page01.jpg']} for x in ids],'warnings':[]}
        calls=[]
        class Provider:
            def __init__(self,*args):pass
            def clean(self,x):return str(x)
            def call(self,prompt,images,effort,json_mode):
                calls.append(prompt)
                answers=[source,json.dumps(review()),json.dumps({'replacements':[{'old':'return {};','new':'return {r:1};'}]}),json.dumps(review(True)),json.dumps({'replacements':[{'old':'return {r:1};','new':'return {r:2};'}]}),json.dumps(review())]
                return {'text':answers[len(calls)-1],'seconds':0}
        def compile(command,**kwargs):
            if any('camera-proposals' in str(s) for s in command):raise RuntimeError('fixture skips optional camera proposal')
            out=Path(command[command.index('--out')+1]);out.mkdir(parents=True,exist_ok=True)
            values={'project.json':project,'probe.json':{'ok':True,'errors':[]},'checks.json':{'pass':True,'errors':[]},'focus-checks.json':{'pass':True,'errors':[]},'determinism.json':[],'evidence.json':[{'shot':x,'segment_id':'seg','label':'middle','time':i+.5,'file':'frame.jpg'} for i,x in enumerate(['a','b'])]}
            for n,v in values.items():(out/n).write_text(json.dumps(v))
            Image.new('RGB',(8,8),'gray').save(out/'frame.jpg')
            return types.SimpleNamespace(stdout='',stderr='',returncode=0)
        with tempfile.TemporaryDirectory() as temp:
            out=Path(temp)/'run'
            with patch.object(h,'Provider',Provider),patch.object(h,'normalize',lambda *a:task),patch.object(h.subprocess,'run',compile),patch.object(h,'changed_shots',lambda *a:{'a','b'}),contextlib.redirect_stdout(io.StringIO()):
                result=h.run('unused',[],{},'fixture',out)
            self.assertEqual(result['repair_requests'],2);self.assertEqual(result['status'],'renderable_with_issues')
            request=json.loads((out/'repair-2-request.json').read_text())['prompt']
            failures=json.JSONDecoder().raw_decode(request.split('\nFAILURES:',1)[1])[0]
            self.assertEqual([x['problem_id'] for x in failures],['b'])
            deferred=json.JSONDecoder().raw_decode(request.split('\nPREVIOUSLY_ATTEMPTED_FINDINGS_READ_ONLY_DO_NOT_EDIT:',1)[1])[0]
            self.assertEqual([x['problem_id'] for x in deferred],['a'])
            final=json.loads((out/'candidate-02/issues.json').read_text())
            self.assertTrue(any(x.get('problem_id')=='a' for x in final));self.assertEqual(len(calls),6)

if __name__=='__main__':unittest.main()
