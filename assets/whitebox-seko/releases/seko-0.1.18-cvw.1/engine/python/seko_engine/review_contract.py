"""Review findings are evidence; a missing core result cannot be a warning.

This validator checks the review protocol, not image semantics. It cannot prove
the model's observations true. Raw answers, images and independent audits stay
authoritative. Invalid review data must not trigger source edits.
"""
from copy import deepcopy
import math

class ReviewContractError(RuntimeError):
    def __init__(self, errors):
        self.errors=errors
        super().__init__('Incomplete visual review contract: '+'; '.join(errors))

DETAILS={'none','appearance','fine_acting','decorative_camera'}

def validated_review(raw,scope,pages,observations=None):
    errors=[];scope=set(scope);pages=set(pages)
    if not isinstance(raw,dict):raise ReviewContractError(['review must be an object'])
    rows=raw.get('shots');seen=raw.get('seen');issues=raw.get('issues');warnings=raw.get('warnings',[])
    if not isinstance(rows,list) or not all(isinstance(x,dict) for x in rows):raise ReviewContractError(['shots must be objects'])
    ids=[r.get('id') for r in rows]
    if any(not isinstance(x,str) for x in ids) or len(ids)!=len(scope) or set(ids)!=scope:errors.append('each scoped original shot must occur exactly once')
    if not isinstance(seen,list) or not all(isinstance(x,str) for x in seen) or not pages.issubset(seen):errors.append('all supplied image pages must be inspected')
    if not isinstance(issues,list) or not all(isinstance(x,dict) for x in issues):errors.append('issues must be objects');issues=[]
    if not isinstance(warnings,list) or not all(isinstance(x,str) for x in warnings):errors.append('warnings must be text')
    for row in rows:
        id=row.get('id');evidence=row.get('evidence')
        for key in ('requirement','observed'):
            if not isinstance(row.get(key),str) or not row[key].strip():errors.append(f'{id}: missing {key}')
        if row.get('core') not in ('met','missing','uncertain'):errors.append(f'{id}: core must be met/missing/uncertain')
        if not isinstance(row.get('simplification'),str) or row['simplification'] not in DETAILS:errors.append(f'{id}: invalid simplification')
        if not isinstance(evidence,list) or not evidence or not all(isinstance(x,str) for x in evidence) or not set(evidence).issubset(pages):errors.append(f'{id}: invalid evidence')
    for issue in issues:
        if not isinstance(issue.get('shot_id'),str) or issue['shot_id'] not in scope:errors.append('issue must identify a scoped original shot')
        evidence=issue.get('evidence')
        if not isinstance(evidence,list) or not evidence or not all(isinstance(x,str) for x in evidence) or not set(evidence).issubset(pages):errors.append('issue must cite actual supplied evidence')
        if not isinstance(issue.get('problem'),str) or not issue['problem'].strip():errors.append('issue must state a concrete problem')
    if errors:raise ReviewContractError(errors)
    out=deepcopy(raw);out['issues']=deepcopy(issues);out['contract']='coarse-outcome-v3';out['verdict_authority']='host from model core assessment; not independent semantic proof'
    if observations is not None:check_contact_claims(out,observations)
    for row in out['shots']:
        original=row.get('verdict');id=row['id'];has_issue=any(x['shot_id']==id for x in out['issues'])
        verdict='blocker' if row['core']!='met' or has_issue else ('pass' if row['simplification']=='none' else 'warning')
        if original is not None:row['reported_verdict']=original
        row['verdict']=verdict
        if verdict=='blocker' and not has_issue:
            out['issues'].append({'code':'core_outcome','shot_id':id,'requirement':row['requirement'],'evidence':row['evidence'],'problem':row['observed'],'fix':row.get('fix') or 'Restore the original coarse subject/state/framing result with the smallest local source change. Preserve simple geometry and unrelated shots.'})
    # Quality uncertainty is retained as a blocker, but missing evidence is not
    # a demonstrated geometry defect. Never spend a source edit to fabricate proof.
    cores={row['id']:row['core'] for row in out['shots']}
    for issue in out['issues']:
        issue['repairable']=cores[issue['shot_id']]!='uncertain'
    return out


def contact_claim_errors(rows,observations):
    errors=[];facts={r['shot_id']:r for r in observations['shots']}
    for row in rows:
        id=row.get('id');claims=row.get('contacts',[])
        if not isinstance(claims,list):errors.append(f'{id}: contacts must list required contact claims or []');continue
        if id not in facts:errors.append(f'{id}: missing actual geometry samples');continue
        fact=facts[id]
        pairs={frozenset((p['a'],p['b'])) for p in fact.get('geometry_relations',[])}
        for claim in claims:
            if not isinstance(claim,dict) or set(claim)!={'a','b','times'}:
                errors.append(f'{id}: contact needs exactly a,b,times');continue
            if not isinstance(claim['a'],str) or not isinstance(claim['b'],str) or claim['a']==claim['b']:
                errors.append(f'{id}: invalid contact entity IDs');continue
            if frozenset((claim['a'],claim['b'])) not in pairs:
                errors.append(f'{id}: contact pair absent from supplied geometry table');continue
            times=claim['times']
            if not isinstance(times,list) or not times or any(type(t) not in (int,float) or not any(abs(t-f)<1e-6 for f in fact.get('times',[])) for t in times):
                errors.append(f'{id}: contact times must cite actual supplied sample times')
    return errors


def check_contact_claims(out,observations):
    facts={r['shot_id']:r for r in observations['shots']}
    diagnostics=[]
    for row in out['shots']:
        fact=facts.get(row['id'],{});results=[]
        claims=row.get('contacts',[])
        if not isinstance(claims,list):
            diagnostics.append({'shot_id':row['id'],'errors':['optional contacts must be a list'],'status':'unavailable'})
            row['contact_verification']=[{'status':'unavailable','raw_claims':deepcopy(claims)}]
            continue
        for claim in claims:
            errors=contact_claim_errors([{**row,'contacts':[claim]}],observations)
            if errors:
                diagnostics.append({'shot_id':row['id'],'errors':errors,'status':'unavailable'})
                results.append({'raw_claim':deepcopy(claim),'status':'unavailable','errors':errors})
                continue
            pair=next(p for p in fact['geometry_relations'] if {p['a'],p['b']}=={claim['a'],claim['b']})
            samples=[]
            for time in claim['times']:
                i=next(i for i,t in enumerate(fact['times']) if abs(t-time)<1e-6)
                tolerances=pair.get('coarse_contact_tolerance',[])
                tolerance=tolerances[i] if i<len(tolerances) else None
                if type(tolerance) not in (int,float) or not math.isfinite(tolerance) or not 0<=tolerance<=0.02:tolerance=0
                samples.append({'time':time,'opaque_aabb_gap':pair['opaque_aabb_gap'][i],'coarse_contact_tolerance':tolerance})
            disjoint=[s for s in samples if s['opaque_aabb_gap'] is not None and s['opaque_aabb_gap']>s['coarse_contact_tolerance']+0.000001]
            results.append({**claim,'samples':samples,
                            'status':'separation_observed_advisory' if disjoint else 'not_disproved_not_certified'})
            # AABB gap is not ownership drift or a story contradiction. Keep
            # source-independent evidence without manufacturing a repair.
        row['contact_verification']=results
    out['contact_diagnostics']=diagnostics
    out['contact_policy']='coarse-contact-v3: optional invalid claims retained as unavailable; other valid evidence remains usable; raw gap evidence only; no metric-only pass/fail. Static contact intersections and rough grip are permitted. Visible ownership drift, missing support outcomes and route penetration still require semantic assessment. No extra model call.'
