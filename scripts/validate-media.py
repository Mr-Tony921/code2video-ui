#!/usr/bin/env python3
"""Decode only this checkout's saved acceptance videos and save metadata."""
from pathlib import Path
import subprocess
import json
ROOT=Path(__file__).resolve().parents[1]
subprocess.run(['python3',str(ROOT/'scripts/guard-isolation.py')],check=True)
r=ROOT/'runtime/validation'
results=[]
for p in sorted(r.glob('*/*.mp4')):
    meta=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height,r_frame_rate,nb_frames','-show_entries','format=duration','-of','json',str(p)],text=True))
    subprocess.run(['ffmpeg','-v','error','-i',str(p),'-f','null','-'],check=True,capture_output=True)
    results.append({'file':str(p),'decode_passed':True,'metadata':meta})
for stem in ['first','blockout','revision']:
    subprocess.run(['ffmpeg','-v','error','-y','-ss','1','-i',str(r/'refactored'/f'{stem}.mp4'),'-frames:v','1',str(r/'refactored'/f'{stem}.png')],check=True,capture_output=True)
(r/'media-validation.json').write_text(json.dumps(results,indent=2))
print('Full decode and metadata:',len(results),'MP4 files passed')
