import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from seko_engine.repair_policy import second_correction

def issue(n,problem='old'):
    return {'shot_id':'s','problem_id':str(n),'issue_type':'visibility','entity_ids':['actor'],'problem':problem,'repairable':True}

class RepairPolicy(unittest.TestCase):
    def test_two_of_ten_remaining_stops_despite_changed_wording(self):
        self.assertFalse(second_correction([issue(i) for i in range(10)],[issue(8,'still hidden'),issue(9,'new wording')],True,True)['allow'])
    def test_new_regression_allows_one_alternative(self):
        self.assertTrue(second_correction([issue(1)],[issue(2)],True,True)['allow'])
    def test_invalid_source_or_structure_can_recover_even_with_old_issues(self):
        for render,structure in [(False,False),(True,False)]:self.assertTrue(second_correction([issue(1)],[issue(1)],render,structure)['allow'])
    def test_uncertainty_alone_never_repairs(self):
        self.assertFalse(second_correction([], [{**issue(1),'repairable':False}],True,True)['allow'])
    def test_renaming_remaining_findings_in_failed_shot_does_not_buy_another_call(self):
        prior={'shots':[{'id':'s','core':'missing'},{'id':'t','core':'met'}]}
        self.assertFalse(second_correction([issue(1)],[issue(99,'reworded')],True,True,prior)['allow'])
        self.assertTrue(second_correction([issue(1)],[{**issue(99),'shot_id':'t'}],True,True,prior)['allow'])
    def test_actual_new_crossing_or_first_semantic_review_after_technical_repair_can_use_last_attempt(self):
        prior={'shots':[{'id':'s','core':'missing'}]}
        self.assertTrue(second_correction([issue(1)],[issue(99)],True,True,prior,new_motion=True)['allow'])
        self.assertTrue(second_correction([issue(1)],[issue(99)],True,True,None)['allow'])

if __name__=='__main__':unittest.main()
