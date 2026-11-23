"""Geometry is evidence; coarse semantic and protocol failures remain visible."""
import sys,unittest,copy
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from seko_engine.review_contract import validated_review,ReviewContractError

class CoarseBoundary(unittest.TestCase):
    def fixtures(self,gap=0.15):
        raw={'seen':['a.jpg'],'shots':[{'id':'s','requirement':'Carry the cup to the table','observed':'Owner and cup travel together; approximate grip','core':'met','simplification':'fine_acting','evidence':['a.jpg'],'contacts':[{'a':'person','b':'cup','times':[1]}]}],'issues':[],'warnings':[]}
        facts={'shots':[{'shot_id':'s','times':[1],'geometry_relations':[{'a':'person','b':'cup','opaque_aabb_gap':[gap],'coarse_contact_tolerance':[.01]}]}]}
        return raw,facts
    def test_gap_does_not_manufacture_source_repair(self):
        raw,facts=self.fixtures();before=copy.deepcopy(raw)
        out=validated_review(raw,{'s'},{'a.jpg'},facts)
        self.assertEqual(out['issues'],[]);self.assertEqual(out['shots'][0]['core'],'met')
        self.assertEqual(out['shots'][0]['contact_verification'][0]['status'],'separation_observed_advisory')
        self.assertEqual(raw,before)
    def test_visible_drift_still_fails_even_if_aabb_touch(self):
        raw,facts=self.fixtures(0);raw['shots'][0].update(core='missing',observed='Cup keeps travelling after its owner stops; ownership is lost')
        out=validated_review(raw,{'s'},{'a.jpg'},facts)
        self.assertEqual(out['shots'][0]['core'],'missing');self.assertTrue(out['issues'][0]['repairable'])
    def test_uncertain_evidence_not_converted_to_pass_or_edit(self):
        raw,facts=self.fixtures();raw['shots'][0].update(core='uncertain',observed='The transfer endpoint is not sampled')
        out=validated_review(raw,{'s'},{'a.jpg'},facts)
        self.assertEqual(out['shots'][0]['core'],'uncertain');self.assertFalse(out['issues'][0]['repairable'])
    def test_fake_contact_receipt_still_rejected(self):
        raw,facts=self.fixtures();raw['shots'][0]['contacts'][0]['times']=[9]
        with self.assertRaises(ReviewContractError):validated_review(raw,{'s'},{'a.jpg'},facts)

if __name__=='__main__':unittest.main()
