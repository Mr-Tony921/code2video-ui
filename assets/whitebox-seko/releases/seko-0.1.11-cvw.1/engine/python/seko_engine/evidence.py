from pathlib import Path
from PIL import Image,ImageDraw
from .io import read,write

def build_sheets(output,shot_ids=None,folder_name=None):
    output=Path(output);evidence=read(output/'evidence.json');sheets=[];groups={}
    for sample in evidence:
        if shot_ids is None or sample['shot'] in shot_ids:groups.setdefault(sample['segment_id'],[]).append(sample)
    folder=output/(folder_name or ('review-scope' if shot_ids is not None else 'review'));folder.mkdir(exist_ok=True)
    for si,(segment,items) in enumerate(groups.items(),1):
        for page,start in enumerate(range(0,len(items),12),1):
            batch=items[start:start+12];canvas=Image.new('RGB',(960,210*((len(batch)+2)//3)),'#101a2d');draw=ImageDraw.Draw(canvas)
            for i,s in enumerate(batch):
                x=i%3*320;y=i//3*210
                with Image.open(output/s['file']) as image:
                    image.thumbnail((320,180));canvas.paste(image,(x,y))
                draw.text((x+5,y+184),f"{s['shot']} | {s['label']} | {s['time']:.3f}s",fill='white')
            name=f'seg{si:02d}-page{page:02d}.jpg';canvas.save(folder/name,quality=87)
            sheets.append({'file':name,'segment_id':segment,'shots':list(dict.fromkeys(s['shot'] for s in batch)),'samples':batch})
    write(folder/'index.json',{'sheets':sheets,'scope':'Every shot start/middle/end, paginated by segment; use source tracks for motion/ownership facts'});return sheets

def reference_sheets(task,folder):
    folder=Path(folder);folder.mkdir(parents=True,exist_ok=True);result=[]
    for page,start in enumerate(range(0,len(task['references']),4),1):
        refs=task['references'][start:start+4];canvas=Image.new('RGB',(960,510*((len(refs)+1)//2)),'#101a2d');draw=ImageDraw.Draw(canvas)
        for i,r in enumerate(refs):
            x=i%2*480;y=i//2*510
            with Image.open(r['local_path']) as im:
                im=im.convert('RGB');im.thumbnail((480,480));canvas.paste(im,(x,y))
            draw.text((x+5,y+485),r['id'],fill='white')
        path=folder/f'reference-page-{page:02d}.jpg';canvas.save(path,quality=88);result.append((path.name,path))
    return result

def added_visibility_intervals(key,old_keys,new_keys,old_project,new_project):
    """An absent entity cannot affect its old scene. A new step-visible entity
    only affects its explicit visible intervals; invisible intervals retain
    frame/metadata checks. Existing entities and unknown track formats stay full.
    This is deliberately not a general inference from sparse screenshots.
    """
    if key[1]!='visible' or old_keys or not new_keys:return None
    old_ids={e['id'] for e in old_project.get('entities',[])}
    new_ids={e['id'] for e in new_project.get('entities',[])}
    if key[0] in old_ids or key[0] not in new_ids:return None
    duration=new_project['duration'];last=-1
    for k in new_keys:
        t=k.get('time')
        if not isinstance(t,(int,float)) or not 0<=t<=duration or t<=last:return None
        if type(k.get('value')) is not bool or k.get('interpolation') not in (None,'step'):return None
        last=t
    intervals=[]
    for i,k in enumerate(new_keys):
        start=0 if i==0 else k['time'];end=new_keys[i+1]['time'] if i+1<len(new_keys) else duration
        if k['value'] and end>=start:intervals.append((start,end))
    return intervals

def explicit_visible_windows(project,target):
    """None means unknown. Only a unique, valid boolean step track is evidence.
    A target hidden itself hides every descendant regardless of its parent.
    Compiled animation has no procedural dependency on hidden-object transforms;
    separately changed camera/attachment tracks are still checked independently.
    """
    if target=='__camera' or target not in {e['id'] for e in project.get('entities',[])}:return None
    # A hidden hand anchor can still drive a visible arm outside its subtree.
    if any(d.get('driver')==target for d in project.get('dynamic_dependencies',[])):return None
    tracks=[t for t in project['animation']['tracks'] if t['target']==target and t['property']=='visible']
    if len(tracks)!=1:return None
    keys=tracks[0]['keys'];duration=project['duration'];last=-1
    if not keys:return None
    for k in keys:
        t=k.get('time')
        if type(t) not in (int,float) or not 0<=t<=duration or t<=last or type(k.get('value')) is not bool or k.get('interpolation') not in (None,'step'):return None
        last=t
    return [(0 if n==0 else k['time'],keys[n+1]['time'] if n+1<len(keys) else duration) for n,k in enumerate(keys) if k['value']]

def keep_visible_changes(intervals,key,old,new):
    if key[0]=='__camera' or key[1] not in ('position','rotation','quaternion','scale','opacity'):return intervals
    old_ids={e['id'] for e in old.get('entities',[])};new_ids={e['id'] for e in new.get('entities',[])}
    # Absent in exactly one snapshot: the new/deleted object's own transform
    # cannot affect the scene where it does not exist. Still require an explicit
    # valid visibility track on the present side; unknown/synthetic targets and
    # all camera tracks remain conservative. Real image/metadata changes remain.
    a=[] if key[0] not in old_ids and key[0] in new_ids else explicit_visible_windows(old,key[0])
    b=[] if key[0] not in new_ids and key[0] in old_ids else explicit_visible_windows(new,key[0])
    if a is None or b is None:return intervals
    return [(max(start,left),min(end,right)) for start,end in intervals for left,right in a+b if max(start,left)<=min(end,right)]

def retain_review_findings(scope,review,issues,required):
    # Already-required rechecks retain borderline observations. This does not
    # create another call/correction if the initial review has only warnings.
    result=set(scope)|{s['id'] for s in review.get('shots',[]) if s.get('verdict')=='warning' and s.get('id') in required}
    if issues:result|=repair_shot_scope(issues,required) or required
    return result

def changed_shots(previous,current):
    """Review changed metadata/samples/track intervals; full review if story topology changes."""
    previous=Path(previous);current=Path(current)
    old=read(previous/'project.json');new=read(current/'project.json')
    topology=lambda p:[(s['id'],s.get('segment_id'),s['start'],s['end']) for s in p['shot_plan']]
    if topology(old)!=topology(new) or old['duration']!=new['duration']:return {s['id'] for s in new['shot_plan']}
    changed={b['id'] for a,b in zip(old['shot_plan'],new['shot_plan']) if a!=b}
    if old.get('reference_usage')!=new.get('reference_usage'):return {s['id'] for s in new['shot_plan']}
    old_samples={(s['shot'],s['label']):s for s in read(previous/'evidence.json')}
    for sample in read(current/'evidence.json'):
        prior=old_samples.get((sample['shot'],sample['label']))
        if not prior or prior['time']!=sample['time'] or (previous/prior['file']).read_bytes()!=(current/sample['file']).read_bytes():changed.add(sample['shot'])
    # Track changes may lie between image samples: conservatively include affected key neighborhoods.
    old_tracks={(t['target'],t['property']):t['keys'] for t in old['animation']['tracks']};new_tracks={(t['target'],t['property']):t['keys'] for t in new['animation']['tracks']}
    for key in set(old_tracks)|set(new_tracks):
        a=old_tracks.get(key,[]);b=new_tracks.get(key,[])
        if a==b:continue
        keyed_a={k['time']:k for k in a};keyed_b={k['time']:k for k in b};times=sorted(set(keyed_a)|set(keyed_b));diff=[i for i,t in enumerate(times) if keyed_a.get(t)!=keyed_b.get(t)]
        if not diff:continue
        # Separate changed neighborhoods. A pair of edits at opposite ends
        # must not automatically reopen all unchanged shots between them.
        intervals=[(times[max(0,i-1)] if i else 0, times[i+1] if i+1<len(times) else new['duration']) for i in diff]
        if not a or not b:
            visible=added_visibility_intervals(key,a,b,old,new)
            if visible is None:visible=added_visibility_intervals(key,b,a,new,old)
            intervals=visible if visible is not None else [(0,new['duration'])]
        intervals=keep_visible_changes(intervals,key,old,new)
        for start,end in intervals:
            changed.update(s['id'] for s in new['shot_plan'] if s['start']<=end and s['end']>=start)
    return changed


def repair_shot_scope(issues,allowed):
    """Only localize evidence when every blocker has an unambiguous real shot ID."""
    import json
    chosen=set()
    for issue in issues:
        if not isinstance(issue,dict):return None
        shot=issue.get('shot_id') or issue.get('shot')
        if not shot and issue.get('code')=='required_focus':
            try:shot=json.loads(issue.get('message','')).get('shot_id')
            except (ValueError,AttributeError):return None
        if shot not in allowed:return None
        chosen.add(shot)
    return chosen or None


def compact_subject_observations(observations,scope):
    """Keep full exact tool data on disk, send all relevant samples without repeated keys."""
    from .coarse_review import contact_tolerance
    rows=[]
    for row in observations['shots']:
        if row['shot_id'] not in scope:continue
        samples=row['samples'];ids=list(dict.fromkeys(o['id'] for s in samples for o in s['subjects']));subjects=[]
        for id in ids:
            points=[next((o for o in s['subjects'] if o['id']==id),{}) for s in samples]
            item={'id':id,'positions':[p.get('position') for p in points],'in_frame':[p.get('in_frame') for p in points],'point_visible':[p.get('point_visible') for p in points]}
            if any(p.get('occluder') for p in points):item['occluders']=[p.get('occluder') for p in points]
            if any(p.get('head') for p in points):item['head_points']=[p.get('head') for p in points]
            if any(p.get('missing_entity') for p in points):item['missing_entity']=True
            subjects.append(item)
        pairs={};tolerances={}
        for i,sample in enumerate(samples):
            bounds={b['id']:b.get('box') for b in sample.get('geometry_relations',{}).get('bounds',[])}
            for pair in sample.get('geometry_relations',{}).get('pairs',[]):
                key=(pair['a'],pair['b']);pairs.setdefault(key,[None]*len(samples))[i]=pair['gap']
                tolerance=contact_tolerance(bounds.get(pair['a']),bounds.get(pair['b']))
                tolerances.setdefault(key,[None]*len(samples))[i]=None if tolerance is None else round(tolerance,6)
        geometry=[{'a':a,'b':b,'opaque_aabb_gap':[None if x is None else round(x,4) for x in gaps],'coarse_contact_tolerance':tolerances[(a,b)]} for (a,b),gaps in pairs.items()]
        stationary=[{'id':b['id'],'world_root_transform_constant_over_shot':b.get('world_root_transform_constant')} for b in samples[0].get('geometry_relations',{}).get('bounds',[])]
        rows.append({'shot_id':row['shot_id'],'times':[s['time'] for s in samples],'subjects':subjects,'geometry_relations':geometry,'root_motion':stationary})
    return {'scope':observations['scope'],'sample_order':'start,middle,end','geometry_policy':'Opaque AABB gap in meters. Coarse contact tolerance is 5% of the smaller opaque object maximum extent, capped at 0.02m. A positive gap within this tolerance is a permitted proxy approximation, not alone a source defect; larger gaps contradict claimed essential contact. Zero or tolerated gaps do not prove contact; null is unknown. Use images, executable parent_id bindings and tracks together for readable ownership/support; a missing pair table alone does not invalidate otherwise supported ownership. Translucent effects excluded; character roots use registered hierarchy. world_root_transform_constant_over_shot=true proves the root and ancestors stay fixed over the full shot, not child poses, visibility variants or cameras. Required entry/arrival needs actual displacement.','shots':rows}
