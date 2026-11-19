import importlib.util,json,pathlib,shutil,sys,tempfile,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[2]

class Mcp(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name)
  self.host=self.root/'.whitebox/job1';self.host.mkdir(parents=True)
  self.inputs=self.root/'work/job1-inputs';self.inputs.mkdir(parents=True)
  self.job=self.root/'work/job1';self.job.mkdir();(self.job/'output').mkdir()
  self.refs=self.root/'.claude/skills/only/references';self.refs.mkdir(parents=True)
  for name in ['brief.md','action-scope.md','compact.md','interaction-motion.md','technical-profile.md','model-patches.md','factual-review.md','review-protocol.md','user-edits.md']:
   (self.refs/name).write_text(name)
  schema={'properties':{'shots':{'items':{'properties':{'camera':{'properties':{'type':{'enum':['static','pull','orbit']},'framing':{'enum':['wide','full','medium','close','insert']}}}}}}}}
  (self.refs/'scene.schema.json').write_text(json.dumps(schema))
  cfg={'workspace':str(self.root),'job':'work/job1','inputs':'work/job1-inputs','skill':'.claude/skills/only','python':sys.executable,'continued':False,'require_facts':True,'user_prompt':'原始用户文字'}
  (self.host/'config.json').write_text(json.dumps(cfg));self.save({'started_at':0,'repairs':0,'max_repairs':2,'seen':{},'mcp_phase':'brief'})
  for source,target in [('whitebox-cc-host.py','host.py'),('whitebox-mcp.py','mcp.py')]:shutil.copyfile(ROOT/'apps/worker-bridge/scripts'/source,self.host/target)
  self.previous=sys.modules.get('host');spec=importlib.util.spec_from_file_location('host',self.host/'host.py');self.h=importlib.util.module_from_spec(spec);sys.modules['host']=self.h;spec.loader.exec_module(self.h)
  self.previous_edits=sys.modules.get('edit_evidence');spec=importlib.util.spec_from_file_location('edit_evidence',ROOT/'apps/worker-bridge/scripts/whitebox-edit-evidence.py');mod=importlib.util.module_from_spec(spec);sys.modules['edit_evidence']=mod;spec.loader.exec_module(mod)
  spec=importlib.util.spec_from_file_location('whitebox_test_mcp',self.host/'mcp.py');self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
 def tearDown(self):
  if self.previous:sys.modules['host']=self.previous
  else:sys.modules.pop('host',None)
  if self.previous_edits:sys.modules['edit_evidence']=self.previous_edits
  else:sys.modules.pop('edit_evidence',None)
  self.tmp.cleanup()
 def save(self,s):(self.host/'state.json').write_text(json.dumps(s))
 def call(self,kind,data):return self.m.handle('tools/call',{'name':'submit','arguments':{'kind':kind,'data':data}})
 def test_init_replay_keeps_frozen_brief_and_exact_next_stage(self):
  brief={'title':'场景','duration':90,'story':'原故事','cast':{'A':'人'},'events':[{'id':'e','description':'移动','subjects':['A']}]}
  def init(*a):
   self.assertEqual(a[0],'init');shutil.copyfile(a[2],self.job/'brief.json');(self.job/'job.json').write_text('{}')
  with patch.object(self.m,'run',side_effect=init) as run:
   first=self.call('brief',brief);again=self.call('brief',brief)
   self.assertEqual(first,again);self.assertEqual(run.call_count,1)
  self.assertEqual(self.h.state()['mcp_phase'],'draft');self.assertEqual(self.h.state()['repairs'],0)
  self.assertIn('compact.md',first['content'][1]['text'])
  with self.assertRaisesRegex(ValueError,'Current phase'):self.call('brief',{**brief,'story':'弱化故事'})
 def test_schema_errors_before_freezing_and_no_escape_after_draft(self):
  with self.assertRaisesRegex(ValueError,'Brief requires'):self.call('brief',{})
  s=self.h.state();s['mcp_phase']='facts';self.save(s)
  with self.assertRaisesRegex(ValueError,'intake decision'):self.call('answer',{'text':'不做了'})
 def test_invalid_camera_constraint_cannot_be_frozen(self):
  brief={'title':'cafe','duration':90,'story':'拉远','cast':{'A':'waiter'},'events':[{'id':'e1','description':'拉远','subjects':['A']}],
   'camera_constraints':[{'shot_id':'s1','type':'pullback','framing':'wide'}]}
  with patch.object(self.m,'run') as native:
   with self.assertRaisesRegex(ValueError,'Before freezing'):self.call('brief',brief)
   native.assert_not_called()
  self.assertFalse((self.inputs/'brief.json').exists());self.assertEqual(self.h.state()['mcp_phase'],'brief')
  self.assertEqual(self.h.state()['repairs'],0);self.assertFalse(self.h.state().get('needs_repair'))
  brief['camera_constraints'][0]['type']='pull';self.m.validate_brief(brief)
  description=self.m.handle('tools/list',{})['tools'][0]['description']
  self.assertIn('pull',description);self.assertNotIn('pullback',description)
 def test_singleton_patch_unwrap_preserves_content_and_does_not_drop_extras(self):
  data={'shots':[{'id':'s8','camera':{'type':'pull'}}],'entities':{'A':{'color':'#abcdef'}}}
  self.assertEqual(self.m.unwrap_envelope('patch',{'patch':data}),data)
  extra={'patch':data,'extra':'must preserve'};self.assertEqual(self.m.unwrap_envelope('patch',extra),extra)
  other={'draft':data};self.assertEqual(self.m.unwrap_envelope('patch',other),other)
 def test_clarification_does_not_initialize_or_manufacture_video(self):
  out=self.call('clarify',{'question':'发生在什么地方？'})
  self.assertEqual(self.h.state()['mcp_phase'],'waiting_user');self.assertFalse((self.job/'job.json').exists())
  self.assertIn('发生在什么地方',out['content'][0]['text'])
  self.assertEqual(self.h.hook({'hook_event_name':'Stop'}),{})
 def test_counter_limits_and_receipt_provenance(self):
  (self.job/'brief.json').write_text('{}');(self.host/'current-draft.json').write_text('{}')
  s=self.h.state();s.update(mcp_phase='patch',repairs=2);self.save(s)
  with patch.object(self.m,'finish',return_value={'reference':True}) as finish:
   self.assertEqual(self.m.correction({'error':'blocked'}),{'reference':True});finish.assert_called_once_with(True)
  (self.job/'output/story-facts.json').write_text('{"scene_sha256":"real-scene","brief_sha256":"real-brief"}')
  s=self.h.state();s.update(mcp_phase='facts',repairs=0,candidates=1);self.save(s)
  with patch.object(self.m,'validate_facts_receipt'),patch.object(self.m,'run',return_value=True),patch.object(self.m,'preview_packet',return_value={'preview':True}):
   self.call('facts',{'scene_sha256':'invented','events':[]})
  receipt=self.h.read(self.inputs/'facts-review.json');self.assertEqual(receipt['scene_sha256'],'real-scene');self.assertEqual(receipt['brief_sha256'],'real-brief')
 def test_model_specific_rules_survive_each_independent_stage(self):
  marker='SELECTED_MODEL_REQUIRED_RULE';other='OTHER_MODEL_RULE'
  (self.refs/'model-patches.md').write_text(marker+'\n## Other models\n'+other)
  (self.job/'brief.json').write_text('{}');(self.host/'current-draft.json').write_text('{}')
  repair=self.m.correction({'errors':['wrong ownership']})
  self.assertIn(marker,repair['content'][1]['text']);self.assertNotIn(other,repair['content'][1]['text'])
  out=self.job/'output';(out/'review').mkdir()
  (out/'review/index.json').write_text('{"scene_sha256":"s","pages":[],"events":[]}')
  (out/'effective-scene.json').write_text('{"entities":[],"shots":[]}');(out/'checks.json').write_text('{}')
  with patch.object(self.m,'run',return_value=True):review=self.m.preview_packet()
  self.assertIn(marker,review['content'][1]['text']);self.assertNotIn(other,review['content'][1]['text'])
  self.h.CFG['require_facts']=False
  with patch.object(self.m,'run',return_value=True):review=self.m.preview_packet()
  self.assertNotIn(marker,review['content'][1]['text'])
  self.assertNotIn(marker,self.m.correction({'errors':['actual failure']})['content'][1]['text'])
 def test_intake_keeps_original_user_beat_order(self):
  description=self.m.handle('tools/list',{})['tools'][0]['description']
  self.assertIn('original clause',description);self.assertIn('Do not merge, duplicate, swap',description)
 def test_malformed_fact_receipt_does_not_repair_scene_or_raise_effort(self):
  (self.job/'output/story-facts.json').write_text('{"scene_sha256":"s","brief_sha256":"b","original_brief":{"events":[{"id":"e"}]}}')
  s=self.h.state();s.update(mcp_phase='facts',candidates=1,repairs=0);self.save(s)
  with patch.object(self.m,'validate_facts_receipt',side_effect=ValueError('coverage')),patch.object(self.m,'run') as run:
   with self.assertRaisesRegex(ValueError,'same candidate'):self.call('facts',{'events':[{'id':'invented'}]})
   run.assert_not_called()
  self.assertEqual(self.h.state()['mcp_phase'],'facts');self.assertEqual(self.h.state()['repairs'],0)
  self.assertFalse(self.h.state().get('needs_repair'));self.assertFalse((self.inputs/'facts-review.json').exists())
  # A well-formed actual blocker still takes the normal correction path.
  with patch.object(self.m,'validate_facts_receipt'),patch.object(self.m,'run',return_value=False),patch.object(self.m,'diagnostic_correction',return_value={'blocked':True}) as correction:
   self.assertEqual(self.call('facts',{'events':[{'id':'e','verdict':'blocker'}]}),{'blocked':True})
   correction.assert_called_once()
 def test_nested_review_envelope_is_lossless_and_format_error_is_not_scene_repair(self):
  value={'status':'complete','criteria':{'story':'blocker'},'events':[{'id':'e','verdict':'blocker'}],'findings':[{'description':'Actual hidden prop'}]}
  self.assertEqual(self.m.unwrap_envelope('review',{'kind':'review','review':value}),value)
  extras={'kind':'review','review':value,'additional_finding':'must not discard'}
  self.assertEqual(self.m.unwrap_envelope('review',extras),extras)
  (self.job/'output/review').mkdir();(self.job/'output/review/index.json').write_text('{"scene_sha256":"real","pages":[]}')
  s=self.h.state();s.update(mcp_phase='review',candidates=1);self.save(s)
  with patch.object(self.m,'validate_visual_receipt',side_effect=ValueError('bad format')),patch.object(self.m,'run') as native:
   with self.assertRaisesRegex(ValueError,'same candidate'):self.call('review',extras)
   native.assert_not_called()
  self.assertEqual(self.h.state()['repairs'],0);self.assertFalse(self.h.state().get('needs_repair'))
  self.assertFalse((self.inputs/'visual-review.json').exists())
  with patch.object(self.m,'validate_visual_receipt'),patch.object(self.m,'run',return_value=False) as native,patch.object(self.m,'correction',return_value={'blocked':True}) as correction:
   self.assertEqual(self.call('review',{'kind':'review','review':value}),{'blocked':True})
   native.assert_called_once();correction.assert_called_once()
   receipt=self.h.read(self.inputs/'visual-review.json');self.assertEqual(receipt['criteria']['story'],'blocker');self.assertEqual(receipt['findings'],value['findings'])
 def test_factual_failure_collects_preview_before_one_consolidated_correction(self):
  before=self.h.state();preview={'errors':[{'code':'occluded','message':'tray hidden'}]}
  with patch.object(self.h,'run_skill',return_value=(1,preview)) as native,patch.object(self.m,'correction',return_value={'repair':True}) as correction:
   self.assertEqual(self.m.diagnostic_correction({'factual_review':{'critical_issues':['wrong camera']}}),{'repair':True})
   self.assertEqual(native.call_args.args[1],['preview',str(self.job),'--software'])
   self.assertEqual(correction.call_args.args[0]['diagnostic_preview'],preview)
   self.assertIn('factual_review',correction.call_args.args[0])
  self.assertEqual(self.h.state(),before)
  # No extra diagnostic/review/correction after the selected skill allowance.
  before['repairs']=2;self.save(before)
  with patch.object(self.h,'run_skill') as native,patch.object(self.m,'correction'):
   self.m.diagnostic_correction({'factual_review':{'critical_issues':['still blocked']}});native.assert_not_called()
 def test_numeric_failure_diagnoses_only_the_fresh_compiled_candidate(self):
  current={'shots':[{'id':'s1'}]};self.h.save(self.host/'current-draft.json',current)
  def compiled(*args):self.h.save(self.job/'draft.json',current);return False
  with patch.object(self.m,'run',side_effect=compiled),patch.object(self.m,'diagnostics',return_value={'errors':['teleport']}),patch.object(self.m,'diagnostic_correction',return_value={'merged':True}) as diag:
   self.assertEqual(self.m.candidate('compile','--draft','input'),{'merged':True});diag.assert_called_once_with({'numeric_checks':{'errors':['teleport']}})
  # A failed patch or schema parse leaves the OLD native draft untouched.
  with patch.object(self.m,'run',return_value=False),patch.object(self.m,'diagnostic_correction') as diag,patch.object(self.m,'correction',return_value={'format':True}):
   self.assertEqual(self.m.candidate('repair','--patch','bad'),{'format':True});diag.assert_not_called()
 def test_source_evidence_is_bound_to_scene_and_edit_scope(self):
  (self.job/'scene.json').write_text('{"shots":[]}')
  index={'scene_sha256':self.h.digest(self.job/'scene.json'),'pages':[{'file':'review/continuity-01.jpg'}],
   'shots':[{'id':'s1'},{'id':'s2'}],'event_samples':[{'file':'event-frames/001.jpg'}]}
  allowed=self.m.allowed_evidence(index)
  self.assertIn('frames/002_c.jpg',allowed);self.assertIn('event-frames/001.jpg',allowed)
  self.assertNotIn('frames/003_a.jpg',allowed);self.assertNotIn('../baseline/frames/001_a.jpg',allowed)
  index['edit_scope']={'review_shots':['s2']};allowed=self.m.allowed_evidence(index)
  self.assertNotIn('frames/001_a.jpg',allowed);self.assertIn('frames/002_a.jpg',allowed)
  (self.job/'scene.json').write_text('{"changed":true}')
  with self.assertRaisesRegex(ValueError,'stale'):self.m.allowed_evidence(index)
 def test_actual_image_bytes_and_traversal_guard(self):
  import base64,hashlib
  image=b'actual-observed-bytes';(self.job/'output/page.png').write_bytes(image)
  blocks=self.m.image_blocks(['page.png']);self.assertEqual(base64.b64decode(blocks[1]['data']),image)
  self.assertEqual(self.h.state()['seen'][str(self.job/'output/page.png')],hashlib.sha256(image).hexdigest())
  with self.assertRaisesRegex(ValueError,'Unknown current'):self.m.image_blocks(['../../secret.png'])
 def test_color_spelling_preserves_scene_and_raw_model_arguments(self):
  original={'stages':[{'id':'s','environment':{'modules':[{'kind':'rail','color':'#Ab3','size':[1,2,3]}]}}],
   'color':'#123456','beat':'Keep literal #777 in user prose','invalid':{'color':'#xyz'}}
  before=json.loads(json.dumps(original));canonical=self.m.canonicalize_colors(original)
  self.assertEqual(original,before)
  self.assertEqual(canonical['stages'][0]['environment']['modules'][0]['color'],'#AAbb33')
  expected=json.loads(json.dumps(before));expected['stages'][0]['environment']['modules'][0]['color']='#AAbb33'
  self.assertEqual(canonical,expected)
  self.assertIn('css-rgb-shorthand-v1',(self.host/'events.jsonl').read_text())
 def test_failed_preview_goes_to_repair_without_image_review(self):
  (self.job/'brief.json').write_text('{}');(self.host/'current-draft.json').write_text('{}')
  with patch.object(self.m,'run',return_value=False),patch.object(self.m,'diagnostics',return_value={'errors':['occluded']}):
   r=self.m.preview_packet()
  self.assertEqual(self.h.state()['mcp_phase'],'patch');self.assertIn('occluded',r['content'][0]['text'])
 def test_edit_uses_exact_user_wording_and_actual_inherited_draft(self):
  self.h.CFG.update(continued=True,base_job='work/base');s=self.h.state();s['mcp_phase']='edit';self.save(s)
  (self.job/'draft.json').write_text('{"shots":[{"id":"s1"}]}');(self.job/'brief.json').write_text('{}')
  with patch.object(self.m,'run',return_value=None),patch.object(self.m.edits,'evidence',return_value={'ok':True}):
   out=self.call('edit',{'user_request':'改写过的文字','targets':[]})
  self.assertEqual(self.h.read(self.inputs/'edit-request.json')['user_request'],'原始用户文字')
  self.assertIn('s1',out['content'][0]['text']);self.assertEqual(self.h.state()['mcp_phase'],'patch')

if __name__=='__main__':unittest.main()
