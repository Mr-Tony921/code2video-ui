"""Review only actual curve changes while retaining unresolved evidence."""
import importlib.util
import os
from pathlib import Path
import sys
import unittest

R = Path(__file__).resolve().parents[2]
E = R/'assets/whitebox-seko/releases'/os.environ.get('SEKO_TEST_RELEASE', 'seko-0.1.12-cvw.1')/'engine'
sys.path.insert(0, str(E/'python'))
from seko_engine.track_scope import changed_curve_intervals
from seko_engine.evidence import retain_review_findings
spec = importlib.util.spec_from_file_location('flow', R/'tests/unit/whitebox-flow.py')
f = importlib.util.module_from_spec(spec); spec.loader.exec_module(f)


def keys(rows, mode='linear'):
    return [{'time':t, 'value':v, 'interpolation':mode} for t, v in rows]


class Curves(unittest.TestCase):
    def test_earlier_arrival_does_not_reopen_long_stationary_tail(self):
        old = keys([(0,[0,0,0]),(10,[0,0,0]),(18,[4,0,0]),(100,[4,0,0])])
        new = keys([(0,[0,0,0]),(10,[0,0,0]),(15,[4,0,0]),(100,[4,0,0])])
        self.assertEqual(changed_curve_intervals(old,new,100),[(10,18)])
    def test_redundant_linear_and_constant_keys_do_not_change_motion(self):
        old = keys([(0,0),(20,20),(100,20)])
        new = keys([(0,0),(5,5),(20,20),(40,20),(100,20)])
        self.assertEqual(changed_curve_intervals(old,new,100),[])
    def test_step_change_stops_at_next_step(self):
        self.assertEqual(changed_curve_intervals(keys([(0,False),(12,True),(18,False)],'step'),keys([(0,False),(14,True),(18,False)],'step'),60),[(12,14)])
    def test_narrow_event_between_images_is_not_lost(self):
        self.assertEqual(changed_curve_intervals(keys([(0,0),(60,0)]),keys([(0,0),(11.1,0),(11.2,1),(11.3,0),(60,0)]),60),[(11.1,11.3)])
    def test_smooth_curve_difference_even_if_endpoints_and_midpoint_equal(self):
        self.assertEqual(changed_curve_intervals(keys([(0,0),(10,1)]),keys([(0,0),(10,1)],'smooth'),10),[(0,10)])
    def test_subdivision_of_smooth_curve_is_not_equivalent(self):
        self.assertTrue(changed_curve_intervals(keys([(0,0),(10,1)],'smooth'),keys([(0,0),(5,.5),(10,1)],'smooth'),10))
    def test_initial_and_terminal_hold_and_endpoint_jump(self):
        self.assertEqual(changed_curve_intervals(keys([(10,1),(30,2)],'step'),keys([(10,3),(30,2)],'step'),60),[(0,30)])
        self.assertEqual(changed_curve_intervals(keys([(0,1),(60,1)],'step'),keys([(0,1),(60,2)],'step'),60),[(60,60)])
    def test_unsupported_and_ambiguous_tracks_fall_back(self):
        for new in [keys([(0,1),(0,2)]),keys([(0,1),(60,2)],'bezier'),keys([(0,0),(60,[1,2])]),[]]:
            self.assertEqual(changed_curve_intervals(keys([(0,0),(60,1)]),new,60),[(0,60)])
    def test_tiny_real_change_is_not_tolerance_filtered(self):
        self.assertTrue(changed_curve_intervals(keys([(0,0),(60,0)]),keys([(0,0),(60,1e-12)]),60))
    def test_optional_accepted_warning_is_inherited_but_uncertain_kept(self):
        review={'shots':[{'id':'s1','core':'met','verdict':'warning'}, {'id':'s2','core':'uncertain','verdict':'blocker'}, {'id':'s3','core':'missing','verdict':'blocker'}, {'id':'s4','verdict':'warning'}]}
        self.assertEqual(retain_review_findings({'s5'},review,[],{'s1','s2','s3','s4','s5'}),{'s2','s3','s4','s5'})
        self.assertEqual(retain_review_findings(set(),review,[{'shot_id':'s1'}],{'s1'}),{'s1'})
    def test_unknown_blocker_keeps_global_review(self):
        self.assertEqual(retain_review_findings(set(),{},[{'technical':'unlocalized'}],{'s1','s2'}),{'s1','s2'})


class ShotScopes(unittest.TestCase):
    scope=f.Flow.scope
    def test_arrival_edit_only_affects_its_shot_not_stationary_later_shots(self):
        def before(p):
            p['animation']['tracks']=[{'target':'actor','property':'position','keys':keys([(0,[0,0,0]),(11,[0,0,0]),(18,[4,0,0]),(60,[4,0,0])])}]
        def after(p):p['animation']['tracks'][0]['keys'][2]['time']=15
        self.assertEqual(self.scope(after,before),{'s1'})
    def test_cut_boundary_keeps_adjacent_shots(self):
        def before(p):p['animation']['tracks']=[{'target':'__camera','property':'fov','keys':keys([(0,40),(10,40),(20,50),(60,50)])}]
        def after(p):p['animation']['tracks'][0]['keys'][2]['time']=18
        self.assertEqual(self.scope(after,before),{'s0','s1','s2'})

if __name__=='__main__':unittest.main()
