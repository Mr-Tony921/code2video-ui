import importlib.util,json,hashlib,pathlib,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('edits',ROOT/'apps/worker-bridge/scripts/whitebox-edit-evidence.py');e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
class EditEvidence(unittest.TestCase):
 def test_declare_direction_before_mutating_numeric_camera_fields(self):
  r={'targets':[{'path':'/shots/s01/distance'}]}
  with self.assertRaisesRegex(ValueError,'Declare'):e.validate_checks(r)
  r['acceptance_checks']=[{'shot_id':'s01','metric':'camera_distance','direction':'increase'}];e.validate_checks(r)
  r['acceptance_checks'][0]['shot_id']='unrelated'
  with self.assertRaisesRegex(ValueError,'scoped'):e.validate_checks(r)
 def test_pull_back_cannot_pass_when_actual_distance_decreases(self):
  with tempfile.TemporaryDirectory() as temp:
   p=pathlib.Path(temp);(p/'baseline').mkdir()
   request={'user_request':'镜头拉远，其他不变','targets':[{'path':'/shots/s01/distance'}],'acceptance_checks':[{'shot_id':'s01','metric':'camera_distance','direction':'increase'}]}
   (p/'edit-request.json').write_text(json.dumps(request))
   def scene(distance):return {'shots':[{'id':'s01','camera':{'type':'orbit','from':[0,1,distance],'to':[distance,1,0],'look':[0,1,0],'fov':50},'actors':{'A':{'from':[0,0,0],'to':[0,0,0]}}}]}
   (p/'baseline/scene.json').write_text(json.dumps(scene(6.577)));(p/'scene.json').write_text(json.dumps(scene(6.241)))
   before=(p/'baseline/scene.json').read_bytes();result=e.evidence(p)
   self.assertFalse(result['ok']);self.assertLess(result['acceptance_checks'][0]['delta'][0],0)
   (p/'scene.json').write_text(json.dumps(scene(8)));self.assertTrue(e.evidence(p)['ok']);self.assertEqual(before,(p/'baseline/scene.json').read_bytes())
 def test_rendered_camera_is_authoritative_only_for_current_candidate(self):
  with tempfile.TemporaryDirectory() as temp:
   p=pathlib.Path(temp);(p/'output/review').mkdir(parents=True);(p/'scene.json').write_text('{}');(p/'output/effective-scene.json').write_text('{"actual":true}')
   index=p/'output/review/index.json';index.write_text('{"scene_sha256":"old"}')
   self.assertEqual(e.selected_scene(p),p/'scene.json')
   index.write_text(json.dumps({'scene_sha256':hashlib.sha256((p/'scene.json').read_bytes()).hexdigest()}))
   self.assertEqual(e.selected_scene(p),p/'output/effective-scene.json')
if __name__=='__main__':unittest.main()
