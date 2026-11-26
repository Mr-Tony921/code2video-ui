#!/usr/bin/env python3
"""Orchestrate the same image -> video CLI while the agent can prepare code."""
import fcntl,json,subprocess,sys,time
from pathlib import Path


def run(plan_file):
    plan_path=Path(plan_file).resolve();p=json.loads(plan_path.read_text())
    state_path=Path(str(plan_path)+'.pipeline.json')
    with Path(str(plan_path)+'.pipeline.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if state_path.exists():
            old=json.loads(state_path.read_text())
            if old['status']=='downloaded': print(json.dumps(old));return
            raise RuntimeError('Pipeline already started. Read receipts and resume the saved video task; never recreate the chain.')
        for k in ['image_prompt_file','video_prompt_file','image_out','video_out','seconds']:
            if k not in p:raise ValueError('Missing '+k)
        if not 4<=int(p['seconds'])<=30:raise ValueError('seconds must be 4..30')
        state={'status':'running','stage':'image','started_at':time.time()}
        def save():
            tmp=Path(str(state_path)+'.tmp');tmp.write_text(json.dumps(state,indent=2));tmp.replace(state_path)
        save()
        cli=str(Path(__file__).with_name('media.py'))
        image=[sys.executable,cli,'image','--prompt-file',p['image_prompt_file'],'--out',p['image_out']]
        for ref in p.get('references',[]):image+=['--reference',ref]
        video=[sys.executable,cli,'video','--prompt-file',p['video_prompt_file'],'--reference',p['image_out'],
            '--out',p['video_out'],'--seconds',str(p['seconds']),'--resolution',p.get('resolution','720p')]
        if p.get('audio',False):video+=['--audio']
        try:
            subprocess.run(image,check=True)
            state.update(stage='video',image_ready_at=time.time());save()
            subprocess.run(video,check=True)
            state.update(stage='complete',status='downloaded',finished_at=time.time(),video_out=p['video_out']);save()
            print(json.dumps(state),flush=True)
        except Exception as exc:
            state.update(status='failed',finished_at=time.time(),error=type(exc).__name__)
            save();raise


if __name__=='__main__':
    if len(sys.argv)!=2:raise SystemExit('Usage: pipeline.py work/media-plan.json')
    run(sys.argv[1])
