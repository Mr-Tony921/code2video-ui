#!/usr/bin/env python3
"""Restart this checkout's worker while a known acceptance job is running."""
import json
from pathlib import Path
import subprocess
import time
import socket
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
subprocess.run(['python3',str(ROOT/'scripts/guard-isolation.py')],check=True)
report=json.loads((ROOT/'runtime/validation/refactored/report.json').read_text())
allowed={j['id'] for j in report['jobs']}
cfg=json.loads((ROOT/'config/backend.json').read_text())
local_ips=socket.gethostbyname_ex(socket.gethostname())[2]
worker=next(w['worker_id'] for w in cfg['workers'] if w['bridge']['host'] in local_ips)
port=next(w['bridge']['port'] for w in cfg['workers'] if w['worker_id']==worker)
records=[]
for f in (ROOT/'runtime/bridge'/worker/'running').glob('*.json'):
    idx=json.loads(f.read_text())
    side=json.loads((Path(idx['job_dir'])/'.running.json').read_text())
    if side['job_id'] in allowed:
        records.append(side)
assert records, 'No live acceptance job on target worker'
def ticks(pid):
    return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
for side in records:
    assert ticks(side['pid'])==str(side['start_ticks'])
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def health():
    return json.load(opener.open(f'http://127.0.0.1:{port}/health',timeout=5))
before=health()
subprocess.run(['python3',str(ROOT/'scripts/service.py'),'bridge','restart',worker],check=True)
after=health()
for side in records:
    assert ticks(side['pid'])==str(side['start_ticks']), 'Agent process was replaced or terminated'
    assert side['job_id'] in json.dumps(after.get('adopted_jobs',[])), 'Job not adopted'
result={'checked_at':time.time(),'worker':worker,'jobs':[{'id':s['job_id'],'pid':s['pid'],'start_ticks':s['start_ticks']} for s in records],
        'before':before,'after':after,'agent_pid_preserved':True,'adopted':True}
(ROOT/'runtime/validation/refactored/adoption.json').write_text(json.dumps(result,indent=2))
print('PASS: worker restarted, exact agent PID/start time preserved and job adopted')
