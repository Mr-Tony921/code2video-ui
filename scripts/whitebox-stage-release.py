#!/usr/bin/env python3
"""Validate and stage a future Seko business release. Never activates a release."""
import argparse,hashlib,json,shutil,tempfile,zipfile
from pathlib import Path

def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def stage(archive,out):
 archive=Path(archive).resolve();out=Path(out).resolve()
 if out.exists():raise ValueError('Use a new immutable release directory')
 with tempfile.TemporaryDirectory(prefix='seko-upgrade-') as temp:
  temp=Path(temp)
  with zipfile.ZipFile(archive) as z:
   if sum(i.file_size for i in z.infolist())>256*1024*1024:raise ValueError('Release exceeds 256 MiB limit')
   for i in z.infolist():
    target=(temp/i.filename).resolve()
    if not target.is_relative_to(temp) or (i.external_attr>>16)&0o170000==0o120000:raise ValueError('Unsafe archive entry')
   z.extractall(temp)
  manifests=list(temp.glob('*/MANIFEST.json'))
  if len(manifests)!=1:raise ValueError('Expected one integration MANIFEST.json')
  root=manifests[0].parent;manifest=json.loads(manifests[0].read_text())
  for name,expected in manifest['files'].items():
   p=(root/name).resolve()
   if not p.is_relative_to(root) or not p.is_file() or digest(p)!=expected:raise ValueError('Hash mismatch: '+name)
  required=['engine/cli.py','engine/python/seko_engine/harness.py','engine/python/seko_engine/provider.py','engine/runtime/project.js','engine/tools/probe.mjs','engine/skills/seko-blockout/SKILL.md','benchmark/01-xiangqin/input.json','benchmark/01-xiangqin/case.json']
  missing=[n for n in required if not (root/n).is_file()]
  if missing:raise ValueError('Public interface changed; manual adapter review required: '+','.join(missing))
  shutil.copytree(root,out)
  report={'package_sha256':digest(archive),'integration_version':manifest.get('version'),'engine_version':manifest.get('engine_version'),'manifest_verified':True,'status':'staged_not_active','activation_allowed':False,'required_acceptance':['adapter and model API contract review','pinned dependencies + offline render tests','whole original single-case benchmark + 8 images','project generation and review ~600s; MP4 separately timed','timing/shot count/camera and human image review','followup preserves baseline and scope','authorization/download integrity/concurrency/cancel/adoption regressions','immutable engine+host hash manifest and dev-only deployment']}
  (out/'UPGRADE-STATUS.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
  return report
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--archive',required=True);p.add_argument('--out',required=True);a=p.parse_args();print(json.dumps(stage(a.archive,a.out),ensure_ascii=False,indent=2))
