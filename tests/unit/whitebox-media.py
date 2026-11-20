from pathlib import Path
import importlib.util,sys,io,json,hashlib,tempfile,threading,unittest,os
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from unittest.mock import patch
from PIL import Image,ImageDraw
R=Path(__file__).resolve().parents[2];E=R/'assets/whitebox-seko/releases'/os.environ.get('SEKO_TEST_RELEASE','seko-0.1.10-cvw.1')/'engine';sys.path.insert(0,str(E/'python'))
from seko_engine.media import optimize_image,POLICY
spec=importlib.util.spec_from_file_location('media_host',R/'apps/worker-bridge/scripts/seko-provider.py');host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
def fixture():
 im=Image.new('RGB',(960,840),'#303040');d=ImageDraw.Draw(im)
 for row in range(4):
  for col in range(3):
   x=col*320;y=row*210;d.rectangle((x,y,x+318,y+179),fill='#b9c6ce');d.rectangle((x+100,y+60,x+130,y+170),fill='#ad7738');d.ellipse((x+96,y+15,x+136,y+55),fill='#ad7738');d.text((x+5,y+185),'shot_%03d | 50.000s'%(row*3+col+1),fill='white')
 b=io.BytesIO();im.save(b,'JPEG',quality=90);return b.getvalue()
class Media(unittest.TestCase):
 def test_smaller_same_dimensions_and_bounded_pixel_loss(self):
  raw=fixture();data,mime,a=optimize_image(raw,'image/jpeg');self.assertTrue(a['applied'],a);self.assertEqual(mime,'image/webp');self.assertEqual(Image.open(io.BytesIO(data)).size,(960,840));self.assertLessEqual(len(data),len(raw)*.8);self.assertGreaterEqual(a['psnr_vs_base_jpeg_db'],40);self.assertEqual(a['model_calls'],0)
 def test_non_jpeg_is_preserved(self):
  im=Image.new('RGBA',(16,16),(0,255,0,40));b=io.BytesIO();im.save(b,'PNG');raw=b.getvalue();self.assertEqual(optimize_image(raw,'image/png')[:2],(raw,'image/png'))
 def test_quality_gate_preserves_original(self):
  raw=fixture()
  with patch.dict(POLICY,{'min_psnr_db':1000}):data,mime,a=optimize_image(raw,'image/jpeg')
  self.assertFalse(a['applied']);self.assertEqual(data,raw);self.assertEqual(mime,'image/jpeg')
 def test_default_host_does_not_opt_in_to_webp(self):
  self.assertIsNone(host.Provider.image_optimizer)
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'frame.jpg';raw=fixture();p.write_bytes(raw);data,mime,a=host.model_image(p);self.assertEqual(mime,'image/jpeg');self.assertNotIn('optimization',a);self.assertEqual(a['policy']['version'],'whitebox-media-v2');self.assertEqual(a['original_sha256'],hashlib.sha256(raw).hexdigest())
 def test_wire_capture_matches_actual_images_and_other_protocol_bypasses_optimizer(self):
  requests=[]
  class H(BaseHTTPRequestHandler):
   def log_message(self,*a):pass
   def do_POST(self):
    d=json.loads(self.rfile.read(int(self.headers['content-length'])));requests.append(d)
    body={'content':[{'type':'text','text':'ok'}],'stop_reason':'end_turn','usage':{}} if self.path.endswith('messages') else {'choices':[{'message':{'content':'ok'},'finish_reason':'stop'}],'usage':{}}
    b=json.dumps(body).encode();self.send_response(200);self.send_header('content-length',str(len(b)));self.end_headers();self.wfile.write(b)
  server=ThreadingHTTPServer(('127.0.0.1',0),H);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  try:
   with tempfile.TemporaryDirectory() as t,patch.dict(os.environ,{'CVW_SEKO_API_KEY':'test-only'}):
    t=Path(t);image=t/'fixture.jpg';image.write_bytes(fixture());original=hashlib.sha256(image.read_bytes()).hexdigest();cfg={'kind':'tokenhub','endpoint':'http://127.0.0.1:'+str(server.server_port),'model':'fixture','family':'deepseek','protocol':'chat','http_timeout_seconds':10};config=t/'config.json';config.write_text(json.dumps({'models':{'x':cfg}}));host.Provider.count=0;host.Provider.capture_root=t/'capture';host.Provider.image_optimizer=staticmethod(optimize_image);p=host.Provider(config,'x');p.call('Describe the image',[('image1',image),('image2',image)],'low',False)
    capture=t/'capture/0001';m=json.loads((capture/'metadata.json').read_text());self.assertEqual(len(m['media']),2);self.assertEqual(m['context_policy']['compression_model_calls'],0);self.assertEqual(m['context_policy']['repair_budget_used'],0)
    import base64
    sent=[x['image_url']['url'] for x in requests[0]['messages'][0]['content'] if x['type']=='image_url'];self.assertEqual(len(sent),2)
    for uri,media in zip(sent,m['media']):
     self.assertTrue(uri.startswith('data:image/webp;base64,'));data=base64.b64decode(uri.split(',',1)[1]);self.assertEqual(Path(media['path']).suffix,'.webp');self.assertEqual(data,Path(media['path']).read_bytes());self.assertEqual(media['sha256'],hashlib.sha256(data).hexdigest());self.assertEqual(media['original_sha256'],original);self.assertEqual(media['encoding'],'bounded_webp')
    self.assertEqual(hashlib.sha256(image.read_bytes()).hexdigest(),original)
    cfg.update(family='opus',protocol='anthropic');config.write_text(json.dumps({'models':{'x':cfg}}))
    def must_not_run(*args):raise AssertionError('Unverified channel used WebP optimizer')
    host.Provider.image_optimizer=staticmethod(must_not_run);host.Provider(config,'x').call('Describe',[('image',image)],'low',False);self.assertEqual(requests[-1]['messages'][0]['content'][-1]['source']['media_type'],'image/jpeg')
  finally:server.shutdown();server.server_close();thread.join()
if __name__=='__main__':unittest.main()
