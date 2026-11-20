import os,sys,tempfile,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
engine=ROOT/'assets/whitebox-seko/releases'/os.getenv('SEKO_TEST_RELEASE','seko-0.1.10-cvw.1')/'engine'
sys.path.insert(0,str(engine/'python'))
from seko_engine.intake import assemble
from seko_engine.normalize import normalize
source='总时长24秒。\n片段1（0–12秒）：镜头1（0–6秒），A持物走近。镜头2（6–12秒），把物体放下。\n片段2（12–24秒）：镜头3（12–18秒），B坐着。镜头4（18–24秒），镜头后拉。'
decision={'action':'generate','segments':[{'title':'第一段','first_line':2,'last_line':2,'duration':12},{'title':'第二段','first_line':3,'last_line':3,'duration':12}]}
result,audit=assemble(decision,source)
assert [s['prompt'] for s in result['input']['segments']]==source.splitlines()[1:]
root=ROOT/'runtime/validation';root.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='prose-marker-',dir=root) as temp:
    p=Path(temp)/'input.json';p.write_text(json.dumps(result['input'],ensure_ascii=False))
    task=normalize(p)
    assert task['duration']==24 and len(task['segments'])==2
    shots=[s for seg in task['segments'] for s in seg['shots']]
    assert len(shots)==4 and [s['explicit_duration'] for s in shots]==[6,6,6,6]
    assert [s['explicit_source_interval'] for s in shots]==[[0,6],[6,12],[12,18],[18,24]]
    # Explicit gaps must fail, never be silently redistributed.
    bad=json.loads(p.read_text());bad['segments'][0]['prompt']=bad['segments'][0]['prompt'].replace('6–12秒','7–12秒')
    p.write_text(json.dumps(bad,ensure_ascii=False))
    try:normalize(p)
    except ValueError as e:assert 'gap or overlap' in str(e),str(e)
    else:raise AssertionError('explicit gap accepted')
print('plain inline shot markers: original text retained, timing preserved, gaps rejected')
