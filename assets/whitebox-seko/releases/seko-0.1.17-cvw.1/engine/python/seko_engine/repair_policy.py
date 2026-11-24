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
    """Select actual edit targets, not just permission to send all findings again."""
    actionable=[i for i in current if i.get('repairable',True)]
    old={issue_identity(i) for i in previous if i.get('repairable',True)}
    failed={r['id'] for r in (previous_review or {}).get('shots',[]) if r.get('core')=='missing'}
    selected=[];deferred=[]
    technical=not scene_success or not structure_pass
    for issue in actionable:
        if technical:
            # Probe/structure diagnostics are technical, including repeated ones.
            # Carried semantic/focus findings are not part of technical recovery.
            eligible=not issue.get('problem') and not issue.get('issue_type') and issue.get('code')!='required_focus'
        else:
            shot=issue_shot(issue)
            motion_supported=new_motion is True or isinstance(new_motion,(set,list,tuple)) and shot in new_motion
            eligible=issue_identity(issue) not in old and (shot not in failed or motion_supported)
        (selected if eligible else deferred).append(issue)
    if technical and not selected:
        selected=[{'code':'technical_recovery','message':'Restore failed render or timeline structure with a minimal local fix; old semantic findings are read-only.'}]
    reason=('recover_render_or_structure' if technical else 'new_or_regressed_findings') if selected else (
        'no_demonstrated_source_defect' if not actionable else
        'remaining_previously_attempted_findings' if all(issue_identity(i) in old for i in actionable) else
        'same_failed_shot_outcomes_after_first_repair')
    return {'allow':bool(selected),'reason':reason,'strategy':'simpler_alternative',
            'allowed_findings':selected,'deferred_findings':deferred,'unresolved':len(deferred)}
