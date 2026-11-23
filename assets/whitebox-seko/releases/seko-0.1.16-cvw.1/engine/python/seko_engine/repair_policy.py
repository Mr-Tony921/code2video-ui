"""Stop repeated semantic repair without mislabelling unresolved output as pass."""
import json

def issue_shot(issue):
    if issue.get('shot_id'):return issue['shot_id']
    if issue.get('code')=='required_focus':
        try:return json.loads(issue.get('message','{}')).get('shot_id')
        except (ValueError,TypeError,AttributeError):pass
    return None

def issue_identity(issue):
    # Reviews preserve these identifiers between passes. Legacy rows fall back
    # to exact problem text, never equate every defect in one shot.
    if issue.get('code')=='required_focus':
        try:return ('required_focus',issue_shot(issue),json.loads(issue['message']).get('entity_id'))
        except (ValueError,TypeError,AttributeError,KeyError):pass
    return (issue_shot(issue), issue.get('issue_type') or issue.get('code'),
            tuple(sorted(issue.get('entity_ids', []))),
            issue.get('problem_id') or issue.get('problem'))

def second_correction(previous, current, scene_success, structure_pass, previous_review=None, new_motion=False):
    if not scene_success or not structure_pass:
        return {'allow': True, 'reason': 'recover_render_or_structure', 'strategy': 'simpler_alternative'}
    actionable = [i for i in current if i.get('repairable', True)]
    if not actionable:
        return {'allow': False, 'reason': 'no_demonstrated_source_defect'}
    old = {issue_identity(i) for i in previous if i.get('repairable', True)}
    new = [i for i in actionable if issue_identity(i) not in old]
    if not new:
        return {'allow': False, 'reason': 'remaining_previously_attempted_findings', 'unresolved': len(actionable)}
    if previous_review is not None and not new_motion:
        # A model can reword/rename a broad first finding into several specific
        # findings in the same already-failed shot. This is not proof of a new
        # regression. Keep them unresolved, but do not buy another repair merely
        # because their text/IDs changed. Newly failed formerly-met shots remain
        # eligible. Technical recovery is handled above.
        failed={r['id'] for r in previous_review.get('shots',[]) if r.get('core')=='missing'}
        affected={issue_shot(i) for i in actionable}
        if affected and None not in affected and affected.issubset(failed):
            return {'allow': False, 'reason': 'same_failed_shot_outcomes_after_first_repair',
                    'unresolved': len(actionable), 'shots': sorted(affected),
                    'note': 'Renamed findings on already-failed outcomes are not demonstrated new regressions; quality stays unresolved.'}
    return {'allow': True, 'reason': 'new_or_regressed_findings', 'new_findings': len(new), 'strategy': 'simpler_alternative'}
