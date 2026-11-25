"""Policy regressions: no network, no user data, bounded intake/repair contracts."""
import copy,json,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from seko_engine import intake
from seko_engine.repair_policy import second_correction
from seko_engine.review_contract import validated_review,ReviewContractError

class TargetedPolicy(unittest.TestCase):
    def intake(self,source,raw):
        calls=[];written={}
        class Provider:
            context='kept'
            def call(self,prompt,images,**kwargs):
                calls.append((prompt,images,kwargs,self.context));return {'text':json.dumps(raw)}
        p=Provider()
        result=intake.decide(p,json.loads,[{'user':source}],[('reference.jpg',None)],lambda f,x:written.__setitem__(f.name,x),Path('/unused'))
        self.assertEqual(p.context,'kept')
        return result,calls,written
    def test_unspecified_duration_and_generated_marker_keep_original(self):
        source='两人相遇，交接书包后离开。'
        raw={'action':'generate','planned_segments':[{'duration':16,'prompt':'Shot 1: 两人相遇。\nShot 2 — 交接后离开。'}]}
        out,calls,w=self.intake(source,raw)
        self.assertEqual(out['input']['duration'],16);self.assertEqual(out['input']['work_prompt'],source)
        self.assertEqual(len(calls),1);self.assertEqual(calls[0][1],[])
        self.assertIn('reference.jpg',calls[0][0]);self.assertIn('An omitted duration alone is never a reason to clarify',calls[0][0])
        self.assertEqual(w['intake-decision.json'],raw);self.assertEqual(w['intake-policy.json']['extra_model_calls'],0)
        self.assertIn('分镜2 交接后离开。',out['input']['segments'][0]['prompt'])
    def test_timed_business_blocks_stay_zero_call_and_verbatim(self):
        source='总时长10秒\n片段1：见面\n时长：6秒\n分镜1 两人握手\n片段2：离开\n时长：4秒\n分镜1 两人离开'
        out,calls,w=self.intake(source,{})
        self.assertEqual(calls,[]);self.assertEqual(out['input']['duration'],10)
        self.assertEqual([s['duration'] for s in out['input']['segments']],[6,4])
        self.assertIn('分镜1 两人握手',out['input']['segments'][0]['prompt'])
    def test_unresolvable_input_fails_explicitly_without_waiting_and_over_limit_rejected(self):
        for action in ['clarify','error']:
            with self.assertRaises(ValueError):self.intake('总长10秒，但片段1必须20秒。',{'action':action,'text':'时间硬约束冲突'})
        with self.assertRaisesRegex(ValueError,'300-second'):
            self.intake('两人相遇',{'action':'generate','planned_segments':[{'duration':301,'prompt':'分镜1 相遇'}]})
    def issue(self,shot,id):
        return {'shot_id':shot,'problem_id':id,'issue_type':'visibility','problem':'required actor hidden','entity_ids':['actor']}
    def test_mixed_old_and_new_only_new_sent_for_second_edit(self):
        old=self.issue('a','old');new=self.issue('b','new');prior={'shots':[{'id':'a','core':'missing'},{'id':'b','core':'met'}]}
        result=second_correction([old],[old,new],True,True,prior)
        self.assertTrue(result['allow']);self.assertEqual(result['allowed_findings'],[new]);self.assertEqual(result['deferred_findings'],[old])
    def test_renamed_old_issue_is_not_smuggled_alongside_new(self):
        old=self.issue('a','old');renamed=self.issue('a','renamed');new=self.issue('b','new')
        result=second_correction([old],[renamed,new],True,True,{'shots':[{'id':'a','core':'missing'},{'id':'b','core':'met'}]})
        self.assertEqual(result['allowed_findings'],[new]);self.assertEqual(result['deferred_findings'],[renamed])
    def test_technical_recovery_does_not_include_old_semantics(self):
        old=self.issue('a','old');broken={'technical':'syntax error'}
        result=second_correction([old],[old,broken],False,False)
        self.assertEqual(result['allowed_findings'],[broken]);self.assertEqual(result['deferred_findings'],[old])
    def test_motion_regression_is_local_not_global_permission(self):
        a=self.issue('a','new-a');b=self.issue('b','new-b')
        result=second_correction([], [a,b],True,True,{'shots':[{'id':'a','core':'missing'},{'id':'b','core':'missing'}]}, {'a'})
        self.assertEqual(result['allowed_findings'],[a]);self.assertEqual(result['deferred_findings'],[b])
    def review(self):
        return {'seen':['page.jpg'],'shots':[{'id':'s','requirement':'required actor and object visible','observed':'visible in actual frame','core':'met','simplification':'none','evidence':['page.jpg']}],'issues':[],'warnings':[]}
    def test_optional_contact_error_keeps_good_image_evidence_and_raw_claim(self):
        facts={'shots':[{'shot_id':'s','times':[1],'geometry_relations':[]}]}
        for contacts in (None,[{'a':'actor','b':'cup','times':[999]}],['invalid']):
            raw=self.review();raw['shots'][0]['contacts']=contacts;before=copy.deepcopy(raw)
            out=validated_review(raw,{'s'},{'page.jpg'},facts)
            self.assertEqual(raw,before);self.assertEqual(out['issues'],[]);self.assertTrue(out['contact_diagnostics'])
            self.assertEqual(out['shots'][0]['contact_verification'][0]['status'],'unavailable')
        out=validated_review(self.review(),{'s'},{'page.jpg'},facts)
        self.assertEqual(out['contact_diagnostics'],[])
    def test_bad_optional_claim_does_not_erase_missing_or_uncertain(self):
        for core in ['missing','uncertain']:
            raw=self.review();raw['shots'][0].update(core=core,contacts=[{'times':[999]}])
            out=validated_review(raw,{'s'},{'page.jpg'},{'shots':[]})
            self.assertEqual(out['shots'][0]['verdict'],'blocker');self.assertEqual(out['issues'][0]['repairable'],core=='missing')
    def test_conservative_decisions_survive_and_result_has_no_question(self):
        out,calls,w=self.intake('两人见面',{'action':'generate','assumptions':['未指定时长，按简短见面安排12秒。'],'planned_segments':[{'duration':12,'prompt':'分镜1 两人见面'}]})
        self.assertEqual(out['input']['input_assumptions'],out['assumptions'])
        notes=intake.result_notes(out['assumptions'],[{'problem':'交接终点遮挡'}])
        self.assertEqual(len(notes),2);self.assertIn('本轮不继续修复',notes[1])
    def test_fabricated_images_or_missing_shot_still_fail(self):
        raw=self.review();raw['shots'][0]['evidence']=['invented.jpg']
        with self.assertRaises(ReviewContractError):validated_review(raw,{'s'},{'page.jpg'},{'shots':[]})
        with self.assertRaises(ReviewContractError):validated_review(self.review(),{'s','missing'},{'page.jpg'},{'shots':[]})

if __name__=='__main__':unittest.main()
