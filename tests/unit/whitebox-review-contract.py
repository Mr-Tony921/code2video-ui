import copy,json,os,sys,unittest
from pathlib import Path
R=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(R/'assets/whitebox-seko/releases'/os.environ.get('SEKO_TEST_RELEASE','seko-0.1.10-cvw.1')/'engine/python'))
from seko_engine.review_contract import validated_review,ReviewContractError
def response(core='met',simplification='none',verdict='pass'):
 return {'seen':['page.jpg'],'shots':[{'id':'s1','requirement':'actor supports object','observed':'actual coarse state','core':core,'simplification':simplification,'verdict':verdict,'evidence':['page.jpg']}],'issues':[],'warnings':[]}
class Contract(unittest.TestCase):
 def test_actual_missing_result_cannot_be_downgraded_to_warning(self):
  raw=response('missing','fine_acting','warning');old=copy.deepcopy(raw);out=validated_review(raw,{'s1'},{'page.jpg'})
  self.assertEqual(raw,old);self.assertEqual(out['shots'][0]['verdict'],'blocker');self.assertEqual(out['shots'][0]['reported_verdict'],'warning');self.assertEqual(out['issues'][0]['shot_id'],'s1');self.assertEqual(out['issues'][0]['evidence'],['page.jpg'])
 def test_uncertain_result_is_not_pass(self):self.assertEqual(validated_review(response('uncertain'),{'s1'},{'page.jpg'})['shots'][0]['verdict'],'blocker')
 def test_optional_detail_does_not_create_source_repair(self):
  for detail in ('appearance','fine_acting','decorative_camera'):
   out=validated_review(response('met',detail),{'s1'},{'page.jpg'});self.assertEqual(out['shots'][0]['verdict'],'warning');self.assertFalse(out['issues'])
 def test_met_core_without_deviation_passes(self):self.assertEqual(validated_review(response(),{'s1'},{'page.jpg'})['shots'][0]['verdict'],'pass')
 def test_concrete_issue_cannot_be_erased_by_pass_label(self):
  raw=response();raw['issues']=[{'shot_id':'s1','problem':'floating object','evidence':['page.jpg']}];self.assertEqual(validated_review(raw,{'s1'},{'page.jpg'})['shots'][0]['verdict'],'blocker')
 def test_bad_or_missing_contract_fails_closed_without_fake_core(self):
  for change in [lambda r:r['shots'][0].pop('core'),lambda r:r['shots'][0].update(core='good'),lambda r:r['shots'][0].update(simplification=[]),lambda r:r['shots'][0].update(id=[]),lambda r:r.update(shots=[]),lambda r:r['shots'].append(copy.deepcopy(r['shots'][0])),lambda r:r['shots'][0].update(requirement=''),lambda r:r.update(seen=[]),lambda r:r['shots'][0].update(evidence=['invented.jpg']),lambda r:r.update(issues=[{'shot_id':'not-in-scope','problem':'x','evidence':['page.jpg']}])]:
   raw=response();change(raw)
   with self.assertRaises(ReviewContractError):validated_review(raw,{'s1'},{'page.jpg'})
if __name__=='__main__':unittest.main()
