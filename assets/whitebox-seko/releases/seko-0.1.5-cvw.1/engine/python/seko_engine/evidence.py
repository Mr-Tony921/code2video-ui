from pathlib import Path
from PIL import Image,ImageDraw
from .io import read,write

def build_sheets(output,shot_ids=None):
    output=Path(output);evidence=read(output/'evidence.json');sheets=[];groups={}
    for sample in evidence:
        if shot_ids is None or sample['shot'] in shot_ids:groups.setdefault(sample['segment_id'],[]).append(sample)
    folder=output/('review-scope' if shot_ids is not None else 'review');folder.mkdir(exist_ok=True)
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

def changed_shots(previous,current):
    """Conservative finite-evidence diff; changed shot plans trigger full review."""
    previous=Path(previous);current=Path(current)
    old=read(previous/'project.json');new=read(current/'project.json')
    if old['shot_plan']!=new['shot_plan']:return {s['id'] for s in new['shot_plan']}
    old_samples={(s['shot'],s['label']):s for s in read(previous/'evidence.json')};changed=set()
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
        start=times[max(0,min(diff)-1)];end=times[min(len(times)-1,max(diff)+1)]
        if not a or not b:start,end=0,new['duration']
        changed.update(s['id'] for s in new['shot_plan'] if s['start']<=end and s['end']>=start)
    return changed
