import json,re
from pathlib import Path
from .io import sha,write

MARKER=re.compile(r'(?:分镜\s*(\d+)|【?镜头\s*(\d+)(?:】|(?=[（(:：\s]|$)))')

def normalize(input_file,references=None):
    path=Path(input_file);raw=path.read_text();begin=raw.find('{')
    if begin<0:raise ValueError('Input must contain business work JSON')
    data,_=json.JSONDecoder().raw_decode(raw[begin:])
    if data.get('version')!=2:raise ValueError('Expected input version 2')
    duration=float(data['duration'])
    if not 0<duration<=300:raise ValueError('Story must be between 0 and 300 seconds; no silent truncation')
    out=[];cursor=0;ordinal=0;ids=set()
    for seg in data['segments']:
        if seg['id'] in ids:raise ValueError('Duplicate segment ID')
        ids.add(seg['id']);start=float(seg['start']);end=float(seg['end']);d=float(seg['resolved_duration'])
        if abs(start-cursor)>.001 or abs(end-start-d)>.001 or abs(float(seg['duration'])-d)>.001:raise ValueError('Inconsistent segment times '+seg['id'])
        prompt=seg['prompt'];marks=list(MARKER.finditer(prompt));shots=[];nums=set()
        if not marks:raise ValueError('No recognized shot markers; explicit input clarification needed')
        for i,m in enumerate(marks):
            n=int(m.group(1) or m.group(2));ordinal+=1
            if n in nums:raise ValueError('Duplicate shot number inside segment')
            nums.add(n);text=prompt[m.start():marks[i+1].start() if i+1<len(marks) else len(prompt)]
            times=re.findall(r'时长\s*[：:]\s*([\d.]+)\s*[s秒]',text)
            if len(times)>1:raise ValueError('Ambiguous shot duration')
            interval=re.match(r'\s*[（(]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\s*[）)]',prompt[m.end():])
            explicit=float(times[0]) if times else None
            span=None
            if interval:
                a,b=map(float,interval.groups());span=[a,b]
                if b<=a or explicit is not None and abs(explicit-(b-a))>.001:raise ValueError('Contradictory shot interval')
                explicit=b-a
            shots.append({'id':f'shot_{ordinal:03d}','source_number':n,'prompt':text,'explicit_duration':explicit,**({'explicit_source_interval':span} if span else {})})
        if all('explicit_source_interval' in s for s in shots):
            first=shots[0]['explicit_source_interval'][0]
            if abs(first)>.001 and abs(first-start)>.001:raise ValueError('Shot intervals must begin at segment or local zero')
            expected=first
            for shot in shots:
                a,b=shot['explicit_source_interval']
                if abs(a-expected)>.001:raise ValueError('Shot intervals have a gap or overlap')
                expected=b
            if abs(expected-first-d)>.001:raise ValueError('Shot intervals contradict segment duration')
        known=sum(s['explicit_duration'] or 0 for s in shots)
        if known>d+.001 or all(s['explicit_duration'] is not None for s in shots) and abs(known-d)>.001:raise ValueError('Shot durations contradict segment')
        out.append({**seg,'start':start,'end':end,'duration':d,'shots':shots});cursor=end
    if abs(cursor-duration)>.001:raise ValueError('Story duration mismatch')
    images=[]
    if references:
        candidates=[p for p in Path(references).iterdir() if p.suffix.lower() in ('.jpg','.jpeg','.png','.webp')]
        def natural(p):return [int(x) if x.isdigit() else x for x in re.split(r'(\d+)',p.name)]
        for i,p in enumerate(sorted(candidates,key=natural),1):images.append({'id':f'reference_{i}','filename':p.name,'sha256':sha(p),'local_path':str(p.resolve())})
    title=next((x.strip() for x in data.get('work_prompt','').splitlines() if x.strip()),path.parent.name)
    return {'schema_version':'0.1.0','title':title[:120],'duration':duration,'work_prompt':data.get('work_prompt',''),'segments':out,'references':images,'source_sha256':sha(path),'source_input':str(path.resolve()),'input_assumptions':data.get('input_assumptions',[])}
