"""Whitelist-only engine and portable skill archives, without internal case data."""
import argparse,hashlib,json,re,zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
FILES=['cli.py','package.json','package-lock.json','requirements.txt','config.example.json','README.md','CHANGELOG.md']
DIRECTORIES=['python','runtime','tools','contracts','skills','tests','docs','packaging']
def files():
    paths=[ROOT/p for p in FILES]
    for folder in DIRECTORIES:paths.extend(p for p in (ROOT/folder).rglob('*') if p.is_file() and not {'__pycache__','.tmp','node_modules'}.intersection(p.parts))
    for p in paths:
        if p.is_symlink():raise ValueError('Symlink not allowed '+str(p))
        if re.search(rb'sk-[A-Za-z0-9_-]{20,}',p.read_bytes()):raise ValueError('Possible credential in '+str(p))
    return sorted(set(paths))
def build(out):
    out=Path(out);out.mkdir(parents=True,exist_ok=True);version=json.loads((ROOT/'package.json').read_text())['version'];items=files()
    manifest={'product':'seko-engine','version':version,'status':'candidate_pending_user_acceptance','files':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in items},'excluded':['workbench','testcase','analysis','data','node_modules','credentials','model responses']}
    engine=out/f'seko-engine-{version}.zip'
    if engine.exists():raise ValueError('Release exists; bump version or verify existing immutable archive')
    with zipfile.ZipFile(engine,'w',zipfile.ZIP_DEFLATED) as z:
        for p in items:z.write(p,'seko-engine/'+str(p.relative_to(ROOT)))
        z.writestr('seko-engine/RELEASE-MANIFEST.json',json.dumps(manifest,ensure_ascii=False,indent=2))
    skill=out/f'seko-blockout-{version}.zip';skillroot=ROOT/'skills/seko-blockout'
    with zipfile.ZipFile(skill,'w',zipfile.ZIP_DEFLATED) as z:
        for p in skillroot.rglob('*'):
            if p.is_file():z.write(p,'seko-blockout/'+str(p.relative_to(skillroot)))
        for p in items:z.write(p,'seko-blockout/scripts/engine/'+str(p.relative_to(ROOT)))
        z.writestr('seko-blockout/RELEASE-MANIFEST.json',json.dumps(manifest,ensure_ascii=False,indent=2))
    manifest['archives']={p.name:{'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size} for p in [engine,skill]}
    (out/f'manifest-{version}.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n');return manifest['archives']
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);a=p.parse_args();print(json.dumps(build(a.out)))
