#!/usr/bin/env python3
"""Explicit, fingerprinted host compatibility for the supplied 0.9.3 and 0.11.1 packages.
Original uploaded archive remains immutable. All edits to the executable copy are audited.
"""
import hashlib,json,sys
from pathlib import Path
ORIGINAL_SHA='0050e9dc5bd3aaa0736d2a625f7d0a7de469518edd6d0c454faba204dde8d739'
RENDER_SHA='9f73651fb5706d50b2b07d30609c425f8d36c73f1f49acd05ba2a4cc76fff39c'
SCENE_SHA='a7533faefc6480119b397345a1229859d873845b47ef520d62c68b4859064760'
def adapt_093(root):
 path=root/'scripts/job.py'
 if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=ORIGINAL_SHA:return None
 render_path=root/'scripts/render.mjs';scene_path=root/'assets/scene.js'
 if any(not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=sha for p,sha in [(render_path,RENDER_SHA),(scene_path,SCENE_SHA)]):return None
 s=path.read_text()
 replacements={
  "ap.add_argument('--budget',type=int,default=600)":"ap.add_argument('--budget',type=int,default=0)",
  "job.mkdir(parents=True,exist_ok=True);shutil.copyfile(a.brief,job/'brief.json');now=time.time()":"if a.budget<0:raise ValueError('Budget must be non-negative; zero records time without a deadline')\n  job.mkdir(parents=True,exist_ok=True);shutil.copyfile(a.brief,job/'brief.json');now=time.time()",
  "'deadline':now+a.budget":"'deadline':now+a.budget if a.budget else None",
  "'remaining_seconds':a.budget":"'remaining_seconds':a.budget or None",
  "remaining=state['deadline']-time.time()":"remaining=state['deadline']-time.time() if state['deadline'] is not None else float('inf')",
  "'remaining_seconds':max(0,remaining)":"'remaining_seconds':max(0,remaining) if state['deadline'] is not None else None",
  "max_seconds=max(.1,state['deadline']-time.time())":"max_seconds=max(.1,state['deadline']-time.time()) if state['deadline'] is not None else 240",
  "if time.time()>state['deadline']:":"if state['deadline'] is not None and time.time()>state['deadline']:",
  "'seconds_remaining':max(0,state['deadline']-time.time())":"'seconds_remaining':max(0,state['deadline']-time.time()) if state['deadline'] is not None else None",
  "limit=min(20,state['deadline']-time.time())":"limit=min(20,state['deadline']-time.time()) if state['deadline'] is not None else 20",
  "limit=min(240 if mode=='video' else 45,remaining-5)":"limit=min(240 if mode=='video' else 180,remaining-5)",
 }
 for old,new in replacements.items():
  if old not in s:raise ValueError('Unexpected original skill source')
  s=s.replace(old,new)
 render=render_path.read_text()
 render=render.replace("profileDir=fs.mkdtempSync(path.join(out,'.browser-'));", "profileDir=fs.mkdtempSync('/dev/shm/cvw-whitebox-');")
 render=render.replace("'--disable-background-timer-throttling'", "'--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'")
 render=render.replace("'-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`", "'-f','image2pipe','-c:v','png'").replace("'-vf','vflip',",'')
 render=render.replace('headless:true,args:chromeArgs,protocolTimeout:', 'headless:true,args:chromeArgs,timeout:120000,protocolTimeout:')
 render=render.replace('maxPayload:width*height*4+1000', 'maxPayload:width*height*4+65536').replace('buffer.length!==width*height*4', 'buffer.length<8||buffer.readUInt32BE(0)!==0x89504e47')
 scene=scene_path.read_text().replace('const pixels=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);',"const b64=renderer.domElement.toDataURL('image/png').split(',')[1];const pixels=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));")
 path.write_text(s);render_path.write_text(render);scene_path.write_text(scene)
 record={'adapter':'cvw-blockout-093-host-v1','original_job_py_sha256':ORIGINAL_SHA,'adapted_job_py_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'changes':['Default --budget 0 records elapsed time without a whole-job deadline','Lossless PNG frame transport avoids measured raw RGBA WebSocket delays; renderer, scene semantics, dimensions and fps are unchanged','Temporary Chrome profile uses local shared memory and disables renderer background throttling; Chrome launch timeout is 120 seconds to allow measured cold shared-filesystem startup','Preview tool timeout is 180 seconds for the measured shared-host startup; render remains 240 seconds and max_repairs remains 2'],'original_archive_preserved':True,'transport':{'format':'lossless-png','original_render_sha256':RENDER_SHA,'adapted_render_sha256':hashlib.sha256(render_path.read_bytes()).hexdigest(),'original_scene_sha256':SCENE_SHA,'adapted_scene_sha256':hashlib.sha256(scene_path.read_bytes()).hexdigest()}}
 (root/'CVW-COMPAT.json').write_text(json.dumps(record,indent=2)+'\n')
 return record
NEW_SHA = {
 'SKILL.md': 'c14bbe35c4d865715a55218d7eca8d93bf5d90d1e16e138c4a267047edd84309',
 'scripts/job.py': '8aeb1af01671a6cec4568f5d58d1d592c9cf1d38d226035206f309c55cf0056b',
 'scripts/render.mjs': 'aede7eaa93a7c9700046b36efe9366715823fe2b67f26388ef514ae943247503',
 'assets/scene.js': 'c541ce5c49b304be810a96f0d5e891b180061cb0f7ca58c268e4855a924fd2a9',
}
def adapt_0111(root):
 if any(not (root/f).is_file() or hashlib.sha256((root/f).read_bytes()).hexdigest()!=sha for f,sha in NEW_SHA.items()):return None
 render_path=root/'scripts/render.mjs';scene_path=root/'assets/scene.js'
 render=render_path.read_text()
 replacements={
  "profileDir=fs.mkdtempSync(path.join(out,'.browser-'));":"profileDir=fs.mkdtempSync('/dev/shm/cvw-whitebox-');",
  "'--disable-background-timer-throttling'":"'--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'",
  "headless:true,args:chromeArgs,protocolTimeout:":"headless:true,args:chromeArgs,timeout:120000,protocolTimeout:",
  "'-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`":"'-f','image2pipe','-c:v','png'",
  "'-vf','vflip',":"",
  'maxPayload:width*height*4+1000':'maxPayload:width*height*4+65536',
  'buffer.length!==width*height*4':'buffer.length<8||buffer.readUInt32BE(0)!==0x89504e47',
 }
 for old,new in replacements.items():
  if render.count(old)!=1:raise ValueError('Unexpected 0.11.1 renderer source')
  render=render.replace(old,new)
 scene=scene_path.read_text();old='const pixels=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);'
 if scene.count(old)!=1:raise ValueError('Unexpected 0.11.1 export source')
 scene=scene.replace(old,"const b64=renderer.domElement.toDataURL('image/png').split(',')[1];const pixels=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));")
 render_path.write_text(render);scene_path.write_text(scene)
 record={'adapter':'cvw-blockout-0111-host-v1','skill_version':'0.11.1','original_archive_preserved':True,
  'original_files_sha256':NEW_SHA,'adapted_files_sha256':{f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in NEW_SHA},
  'transport':{'format':'lossless-png'},'budget_policy':'soft_target','delivery_target':'video',
  'changes':['Lossless PNG frame transport; scene, dimensions, fps and encoding are unchanged',
  'Local temporary Chrome profile, disabled background throttling and 120-second cold-start allowance',
  'Upstream job.py and SKILL.md unchanged: 600 seconds is soft telemetry, two repairs for new films and one for scoped user edits']}
 (root/'CVW-COMPAT.json').write_text(json.dumps(record,indent=2)+'\n')
 return record

def adapt(root):
 return adapt_093(root) or adapt_0111(root)

if __name__=='__main__': print(json.dumps(adapt(Path(sys.argv[1]))))
