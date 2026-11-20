"""Coarse previews tolerate small proxy gaps without accepting floating actors."""
import copy
import os
import sys
import unittest
from pathlib import Path

R = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(R / 'assets/whitebox-seko/releases' / os.environ.get('SEKO_TEST_RELEASE', 'seko-0.1.11-cvw.1') / 'engine/python'))
from seko_engine.coarse_review import contact_tolerance, review_entities
from seko_engine.evidence import compact_subject_observations
from seko_engine.review_contract import validated_review


def evidence(gap):
    return {'scope': ['s1'], 'shots': [{'shot_id': 's1', 'samples': [{
        'time': 1, 'subjects': [], 'geometry_relations': {
            'bounds': [
                {'id': 'prop', 'box': [[0, 0, 0], [.2, .2, .2]]},
                {'id': 'support', 'box': [[0, 0, 0], [2, 1, 2]]},
            ],
            'pairs': [{'a': 'prop', 'b': 'support', 'gap': gap}],
        },
    }]}]}


def review():
    return {'seen': ['sheet.jpg'], 'shots': [{
        'id': 's1', 'requirement': 'The prop rests on its support.',
        'observed': 'Readable placement in the actual image and track.',
        'core': 'met', 'simplification': 'none', 'evidence': ['sheet.jpg'],
        'contacts': [{'a': 'prop', 'b': 'support', 'times': [1]}],
    }], 'issues': [], 'warnings': []}


class CoarseReview(unittest.TestCase):
    def assess(self, gap):
        raw = evidence(gap)
        before = copy.deepcopy(raw)
        facts = compact_subject_observations(raw, {'s1'})
        out = validated_review(review(), {'s1'}, {'sheet.jpg'}, facts)
        self.assertEqual(raw, before)
        self.assertEqual(facts['shots'][0]['geometry_relations'][0]['opaque_aabb_gap'], [gap])
        return out

    def test_visible_proxy_with_small_separation_does_not_spend_repair(self):
        out = self.assess(.003)
        self.assertEqual(out['shots'][0]['core'], 'met')
        self.assertEqual(out['issues'], [])
        self.assertEqual(out['shots'][0]['contact_verification'][0]['status'], 'not_disproved_not_certified')

    def test_clearly_floating_prop_overrides_model_pass(self):
        out = self.assess(.15)
        self.assertEqual(out['shots'][0]['core'], 'missing')
        self.assertTrue(out['issues'][0]['repairable'])
        self.assertEqual(out['issues'][0]['code'], 'contact_contradiction')

    def test_even_large_geometry_cannot_hide_a_visible_8cm_gap(self):
        big = [[0, 0, 0], [100, 100, 100]]
        self.assertLess(contact_tolerance(big, big), .08)

    def test_miniature_prop_does_not_get_a_human_scale_allowance(self):
        small = [[0, 0, 0], [.001, .001, .001]]
        self.assertLess(contact_tolerance(small, [[0, 0, 0], [1, 1, 1]]), .0001)

    def test_unknown_or_nonfinite_geometry_is_not_contact_proof(self):
        for box in [None, [[0, 0, 0], [float('nan'), 1, 1]], [[0, 0, 0], [-1, 1, 1]]]:
            self.assertIsNone(contact_tolerance(box, [[0, 0, 0], [1, 1, 1]]))

    def test_attachment_facts_expose_only_real_registered_parent_links(self):
        project = {'entities': [
            {'id': 'actor', 'uuid': 'u1', 'parent': 'scene', 'character': True},
            {'id': 'hand', 'uuid': 'u2', 'parent': 'u1'},
            {'id': 'prop', 'uuid': 'u3', 'parent': 'u2'},
            {'id': 'free', 'uuid': 'u4', 'parent': 'unregistered'},
        ]}
        before = copy.deepcopy(project)
        rows = review_entities(project)
        self.assertEqual(rows[2]['parent_id'], 'hand')
        self.assertEqual(rows[1]['parent_id'], 'actor')
        self.assertNotIn('parent_id', rows[3])
        self.assertEqual(project, before)

    def test_optional_pose_simplification_does_not_create_an_issue(self):
        raw = review()
        raw['shots'][0].update(simplification='fine_acting', contacts=[], observed='Required meeting and positions read clearly; incidental arm pose omitted.')
        out = validated_review(raw, {'s1'}, {'sheet.jpg'}, compact_subject_observations(evidence(1), {'s1'}))
        self.assertEqual(out['shots'][0]['verdict'], 'warning')
        self.assertFalse(out['issues'])

    def test_tolerance_does_not_silence_a_different_demonstrated_story_failure(self):
        raw = review()
        raw['shots'][0].update(core='missing', observed='The required arrival never happens.')
        out = validated_review(raw, {'s1'}, {'sheet.jpg'}, compact_subject_observations(evidence(.003), {'s1'}))
        self.assertEqual(out['shots'][0]['verdict'], 'blocker')
        self.assertTrue(out['issues'][0]['repairable'])


if __name__ == '__main__':
    unittest.main()
