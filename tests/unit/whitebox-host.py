import json, tempfile, pathlib, subprocess, shutil, unittest, concurrent.futures, zipfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
class Guard(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);self.host=self.root/'.whitebox/job1';self.host.mkdir(parents=True)
  (self.root/'work/job1-inputs').mkdir(parents=True);self.inputs=self.root/'work/job1-inputs'
  shutil.copyfile(ROOT/'apps/worker-bridge/scripts/whitebox-cc-host.py',self.host/'host.py')
  cfg={'workspace':str(self.root),'job':'work/job1','inputs':'work/job1-inputs','skill':'.claude/skills/only','python':'/usr/bin/python3','continued':False,'require_facts':True}
  (self.host/'config.json').write_text(json.dumps(cfg));self.save({'started_at':0,'phase':'initial','repairs':0,'max_repairs':2,'seen':{}})
 def tearDown(self):self.tmp.cleanup()
 def save(self,s):(self.host/'state.json').write_text(json.dumps(s))
 def state(self):return json.loads((self.host/'state.json').read_text())
 def hook(self,event,name,**inp):
  r=subprocess.run(['python3',str(self.host/'host.py'),'hook'],input=json.dumps({'hook_event_name':event,'tool_name':name,'tool_input':inp}),text=True,capture_output=True,check=True)
  return json.loads(r.stdout)
 def test_corrections_before_compile_and_fresh_receipts(self):
  p=self.inputs/'draft.json'
  self.assertEqual(self.hook('PreToolUse','Write',file_path=str(p),content='{}'),{});p.write_text('{}')
  self.assertEqual(self.hook('PreToolUse','Write',file_path=str(p),content='{"v":2}'),{});p.write_text('{"v":2}')
  self.assertEqual(self.state()['repairs'],1)
  self.hook('PreToolUse','Edit',file_path=str(p));self.assertEqual(self.state()['repairs'],2)
  self.assertEqual(self.hook('PreToolUse','Edit',file_path=str(p))['hookSpecificOutput']['permissionDecision'],'deny')
  q=self.inputs/'facts-review.json';q.write_text('{}');s=self.state();s['candidates']=2;s['input_versions'][str(q)]=1;self.save(s)
  self.assertEqual(self.hook('PreToolUse','Write',file_path=str(q),content='{"new":1}'),{});self.assertEqual(self.state()['repairs'],2)
 def test_no_counter_reset_or_base_edit_or_renderer_change(self):
  self.assertEqual(self.hook('PreToolUse','Write',file_path=str(self.inputs/'draft-new.json'),content='{}')['hookSpecificOutput']['permissionDecision'],'deny')
  self.assertEqual(self.hook('PreToolUse','Write',file_path=str(self.root/'work/base/scene.json'),content='{}')['hookSpecificOutput']['permissionDecision'],'deny')
  self.assertEqual(self.hook('PreToolUse','Bash',command='python engine.py')['hookSpecificOutput']['permissionDecision'],'deny')
  self.assertEqual(self.hook('PreToolUse','Bash',command=f'/usr/bin/python3 {self.host}/host.py status'),{})
 def test_images_require_facts_and_actual_read_hash(self):
  p=self.root/'work/fixture.png';p.write_bytes(b'actual image bytes')
  self.assertEqual(self.hook('PreToolUse','Read',file_path=str(p))['hookSpecificOutput']['permissionDecision'],'deny')
  s=self.state();s['facts_recorded']=True;self.save(s)
  self.assertEqual(self.hook('PreToolUse','Read',file_path=str(p)),{})
  self.hook('PostToolUse','Read',file_path=str(p));self.assertIn(str(p),self.state()['seen'])
 def test_auto_compile_delivers_facts_without_another_model_turn(self):
  skill=self.root/'.claude/skills/only/scripts';skill.mkdir(parents=True)
  (skill.parent/'references').mkdir();(skill.parent/'references/factual-review.md').write_text('Factual review instruction')
  (skill/'job.py').write_text('''import sys,json,pathlib
command=sys.argv[1];job=pathlib.Path(sys.argv[2]);(job/'output').mkdir(parents=True,exist_ok=True)
if command=='compile':(job/'scene.json').write_text('{}')
if command=='facts':(job/'output/story-facts.json').write_text('{"original_brief":{"id":"frozen"},"actual_scene":{"x":1}}')
print(json.dumps({'ok':True,'command':command}))
''')
  job=self.root/'work/job1';job.mkdir();(job/'job.json').write_text('{}')
  p=self.inputs/'draft.json';p.write_text('{"shots":[]}')
  reply=self.hook('PostToolUse','Write',file_path=str(p),content=p.read_text())
  context=reply['hookSpecificOutput']['additionalContext']
  self.assertIn('actual_scene',context);self.assertIn('facts-review.json',context)
  self.assertEqual(self.state()['candidates'],1);self.assertEqual(self.state()['repairs'],0)
  # A repeated explicit compile is idempotent and cannot consume a repair.
  subprocess.run(['python3',str(self.host/'host.py'),'compile','--draft',str(p)],capture_output=True,check=True)
  self.assertEqual(self.state()['candidates'],1);self.assertEqual(self.state()['repairs'],0)
 def test_parallel_read_hooks_keep_all_image_observations(self):
  s=self.state();s['facts_recorded']=True;self.save(s)
  images=[]
  for i in range(8):
   p=self.root/f'work/image-{i}.png';p.write_bytes(str(i).encode());images.append(p)
  with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
   results=list(pool.map(lambda p:self.hook('PostToolUse','Read',file_path=str(p)),images))
  self.assertTrue(all(r=={} for r in results));self.assertEqual(len(self.state()['seen']),8)
 def test_non_deepseek_cannot_accidentally_add_fact_review(self):
  cfg=json.loads((self.host/'config.json').read_text());cfg['require_facts']=False;(self.host/'config.json').write_text(json.dumps(cfg))
  p=self.inputs/'facts-review.json'
  reply=self.hook('PreToolUse','Write',file_path=str(p),content='{}')
  self.assertEqual(reply['hookSpecificOutput']['permissionDecision'],'deny');self.assertEqual(self.state()['repairs'],0)
  r=subprocess.run(['python3',str(self.host/'host.py'),'facts'],capture_output=True,text=True)
  # Job initialization is checked before manual phase dispatch.
  self.assertEqual(r.returncode,1)
 def test_review_failure_raises_effort_before_model_plans_correction(self):
  skill=self.root/'.claude/skills/only/scripts';skill.mkdir(parents=True)
  (skill/'job.py').write_text('import sys;print(\'{"ok":false,"error":"invalid review"}\');sys.exit(1)')
  job=self.root/'work/job1';job.mkdir();(job/'job.json').write_text('{}')
  p=self.inputs/'visual-review.json';p.write_text('{"seen":[]}')
  self.hook('PostToolUse','Write',file_path=str(p),content=p.read_text())
  self.assertTrue(self.state()['needs_repair']);self.assertEqual(self.state()['repairs'],0)
  # Malformed JSON must select high before composing its correction too.
  s=self.state();s['needs_repair']=False;self.save(s);p.write_text('{bad json')
  self.hook('PostToolUse','Write',file_path=str(p),content=p.read_text())
  self.assertTrue(self.state()['needs_repair']);self.assertEqual(self.state()['repairs'],0)
 def test_new_film_compact_patch_uses_native_patch_then_compile(self):
  skill=self.root/'.claude/skills/only/scripts';skill.mkdir(parents=True)
  with zipfile.ZipFile(ROOT/'assets/experimental-skills/blockout-previs/0.11.1.zip') as z:
   name=next(n for n in z.namelist() if n.endswith('scripts/patch_draft.py'))
   (skill/'patch_draft.py').write_bytes(z.read(name))
  (skill/'compile_plan.py').write_text('def normalize_draft(draft):return draft,[]')
  (skill/'job.py').write_text('''import json,sys,pathlib
job=pathlib.Path(sys.argv[2]);command=sys.argv[1]
if command=='compile':
 data=json.load(open(sys.argv[sys.argv.index('--draft')+1]));(job/'draft.json').write_text(json.dumps(data));(job/'scene.json').write_text('{}')
print('{"ok":true}')
''')
  job=self.root/'work/job1';job.mkdir();(job/'job.json').write_text('{}')
  draft=self.inputs/'draft.json';draft.write_text('{"shots":[{"id":"s01","move":{"A":[0,0,0]}}],"entities":[],"stages":[]}')
  subprocess.run(['python3',str(self.host/'host.py'),'compile','--draft',str(draft)],capture_output=True,check=True)
  patch=self.inputs/'patch.json';patch.write_text('{"shots":[{"id":"s01","move":{"A":[2,0,0]}}]}')
  subprocess.run(['python3',str(self.host/'host.py'),'repair','--patch',str(patch)],capture_output=True,check=True)
  self.assertEqual(json.loads((job/'draft.json').read_text())['shots'][0]['move']['A'],[2,0,0])
  self.assertEqual(self.state()['repairs'],1);self.assertEqual(self.state()['candidates'],2)
  events=[json.loads(x) for x in (self.host/'events.jsonl').read_text().splitlines()]
  self.assertTrue(any(e.get('command')=='patch-draft' for e in events))
  self.assertFalse(any(e.get('script')=='edit_scope.py' for e in events))
  self.assertFalse((job/'edit-request.json').exists())
 def test_numerically_invalid_candidate_does_not_spend_fact_or_visual_round(self):
  skill=self.root/'.claude/skills/only/scripts';skill.mkdir(parents=True)
  (skill/'job.py').write_text('''import json,sys,pathlib
command=sys.argv[1];job=pathlib.Path(sys.argv[2]);(job/'scene.json').write_text('{}')
print(json.dumps({'ok':False,'errors':[{'code':'move_min','message':'A did not move'}]}));sys.exit(1)
''')
  job=self.root/'work/job1';job.mkdir();(job/'job.json').write_text('{}')
  p=self.inputs/'draft.json';p.write_text('{"shots":[]}')
  context=self.hook('PostToolUse','Write',file_path=str(p),content=p.read_text())['hookSpecificOutput']['additionalContext']
  self.assertIn('A did not move',context);self.assertIn('Do not run factual/image review',context)
  commands=[e['command'] for e in [json.loads(x) for x in (self.host/'events.jsonl').read_text().splitlines()] if e['kind']=='tool']
  self.assertEqual(commands,['compile','check']);self.assertTrue(self.state()['needs_repair'])
 def test_manual_export_gets_full_foreground_tool_timeout(self):
  command=f'/usr/bin/python3 {self.host}/host.py finish --reference'
  result=self.hook('PreToolUse','Bash',command=command,description='Export reference')
  updated=result['hookSpecificOutput']['updatedInput']
  self.assertEqual(updated['command'],command);self.assertEqual(updated['timeout'],600000)
  self.assertEqual(updated['description'],'Export reference')
  self.assertEqual(self.hook('PreToolUse','Bash',command=command,timeout=600000),{})
  self.assertEqual(self.hook('PreToolUse','Bash',command=command,run_in_background=True)['hookSpecificOutput']['permissionDecision'],'deny')
 def test_auto_init_followed_by_manual_init_is_idempotent_and_keeps_budget(self):
  skill=self.root/'.claude/skills/only/scripts';skill.mkdir(parents=True)
  (skill/'job.py').write_text('''import json,sys,pathlib,shutil
job=pathlib.Path(sys.argv[2]);job.mkdir(parents=True)
(job/'job.json').write_text('{}')
shutil.copyfile(sys.argv[sys.argv.index('--brief')+1],job/'brief.json')
print('{"ok":true}')
''')
  brief=self.inputs/'brief.json';brief.write_text('{"title":"Original user story","duration":90}')
  context=self.hook('PostToolUse','Write',file_path=str(brief),content=brief.read_text())['hookSpecificOutput']['additionalContext']
  self.assertNotIn('host_stage_error',context)
  s=self.state();s['repairs']=1;self.save(s)
  for args in (['init','--brief',str(brief)],['init']):
   r=subprocess.run(['python3',str(self.host/'host.py'),*args],text=True,capture_output=True,check=True)
   self.assertTrue(json.loads(r.stdout)['already_initialized'])
  self.assertEqual(self.state()['started_at'],0);self.assertEqual(self.state()['repairs'],1)
  self.assertFalse(self.state().get('needs_repair',False))
  events=[json.loads(x) for x in (self.host/'events.jsonl').read_text().splitlines()]
  self.assertEqual(len([e for e in events if e['kind']=='tool' and e['command']=='init']),1)
 def test_frozen_brief_cannot_be_rewritten_or_reinitialized_with_different_story(self):
  job=self.root/'work/job1';job.mkdir();(job/'job.json').write_text('{}')
  original='{"title":"Original user story","duration":90}'
  (job/'brief.json').write_text(original)
  brief=self.inputs/'brief.json';brief.write_text(original)
  self.assertEqual(self.hook('PreToolUse','Write',file_path=str(brief),content=original),{})
  denial=self.hook('PreToolUse','Write',file_path=str(brief),content='{"title":"Easier story"}')
  self.assertEqual(denial['hookSpecificOutput']['permissionDecision'],'deny')
  self.assertEqual(self.state()['repairs'],0)
  brief.write_text('{"title":"Easier story"}')
  r=subprocess.run(['python3',str(self.host/'host.py'),'init','--brief',str(brief)],text=True,capture_output=True)
  self.assertEqual(r.returncode,1);self.assertIn('different frozen brief',r.stdout)
  self.assertEqual((job/'brief.json').read_text(),original);self.assertEqual(self.state()['started_at'],0)
if __name__=='__main__':unittest.main()
