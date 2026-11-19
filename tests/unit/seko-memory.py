import importlib.util,json,tempfile,threading,unittest,os,hashlib,base64
from pathlib import Path
from http.server import BaseHTTPRequestHandler,HTTPServer
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('provider',ROOT/'apps/worker-bridge/scripts/seko-provider.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Memory(unittest.TestCase):
 def test_round_budget_keeps_current_source_and_request_without_repair_calls(self):
  seen=[]
  class Handler(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_POST(self):
    seen.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))));assert 'Authorization' not in self.headers
    if seen[-1]['messages'][0]['content'][0]['text'].startswith('REJECT_AS_CONTEXT_LIMIT:'):
     self.send_response(400);self.end_headers();self.wfile.write(json.dumps({'error':{'code':'context_length_exceeded','message':'maximum context length exceeded'}}).encode());return
    self.send_response(200);self.end_headers();self.wfile.write(json.dumps({'choices':[{'message':{'content':'OK','reasoning_signature':'actual-test-signature','reasoning_content':'actual test reasoning'},'finish_reason':'stop'}]}).encode())
  server=HTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever);thread.start()
  try:
   with tempfile.TemporaryDirectory() as tmp:
    config=Path(tmp)/'config.json';config.write_text(json.dumps({'models':{'selected':{'kind':'intranet','protocol':'chat','family':'generic','model':'test','endpoint':f'http://127.0.0.1:{server.server_port}','max_context_tokens':16384}}}))
    m.Provider.capture_root=Path(tmp)/'captures';m.Provider.context=json.dumps([{'user':'earlier'*4000},{'user':'make camera closer'}]);m.Provider.count=0
    p=m.Provider(config,'selected');r=p.call('CURRENT_SOURCE: authoritative scene; ORIGINAL_TASK: original story')
    self.assertEqual(len(seen),1);self.assertIn('authoritative scene',seen[0]['messages'][0]['content'][0]['text']);self.assertIn('make camera closer',seen[0]['messages'][0]['content'][0]['text']);self.assertNotIn('earlier'*10,seen[0]['messages'][0]['content'][0]['text'])
    receipt=json.loads((Path(tmp)/'captures/0001/metadata.json').read_text())['context_policy'];self.assertEqual(receipt['repair_budget_used'],0);self.assertEqual(receipt['compression_model_calls'],0)
    raw=json.loads((Path(tmp)/'captures/0001/response.json').read_text());self.assertEqual(raw['choices'][0]['message']['reasoning_signature'],'actual-test-signature')
    # A conservative UTF-8 bound cannot reject compressible text that the
    # actual model tokenizer accepts. Essential input must remain intact.
    answer=p.call('CURRENT_SOURCE:'+'x'*20000);self.assertEqual(answer['text'],'OK')
    meta=json.loads((Path(tmp)/'captures/0002/metadata.json').read_text())['context_policy'];self.assertTrue(meta['local_upper_bound_exceeded']);self.assertFalse(meta['source_and_current_request_truncated']);self.assertEqual(meta['repair_budget_used'],0)
    with self.assertRaises(m.ContextLimitError):p.call('REJECT_AS_CONTEXT_LIMIT:'+'x'*20000)
    receipt=json.loads((Path(tmp)/'captures/0003/receipt.json').read_text());self.assertEqual(receipt['failure_kind'],'context_limit');self.assertEqual(len(seen),3)
  finally:server.shutdown();thread.join();server.server_close()
 def test_media_budget_preserves_originals_and_captures_actual_sent_pixels(self):
  from PIL import Image
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);p=root/'original.png';Image.frombytes('RGB',(1280,720),os.urandom(1280*720*3)).save(p)
   original=p.read_bytes();data,mime,meta=m.model_image(p,root/'capture')
   self.assertEqual(meta['original_sha256'],hashlib.sha256(original).hexdigest());self.assertEqual(p.read_bytes(),original)
   self.assertLessEqual(max(meta['sent_size']),1024);self.assertLessEqual(len(data),96*1024);self.assertEqual(meta['original_size'],(1280,720));self.assertEqual(mime,'image/jpeg')
   self.assertEqual(meta['policy']['version'],'whitebox-media-v2');self.assertAlmostEqual(meta['sent_size'][0]/meta['sent_size'][1],1280/720,delta=.01)
   from io import BytesIO
   with Image.open(BytesIO(data)) as actual:self.assertEqual(actual.size,meta['sent_size'])
   second,_,again=m.model_image(p,root/'capture');self.assertEqual(second,data);self.assertEqual(again['sha256'],meta['sha256'])
   self.assertLess(len(data),len(original));self.assertEqual(Path(meta['path']).read_bytes(),data);self.assertEqual(meta['sha256'],hashlib.sha256(data).hexdigest())
   p=root/'small.png';Image.new('RGB',(16,16),'white').save(p);original=p.read_bytes();data,mime,meta=m.model_image(p,root/'capture');self.assertEqual(data,original);self.assertEqual(meta['encoding'],'original')
 def test_orientation_and_transparency_are_normalized_without_cropping(self):
  from PIL import Image
  from io import BytesIO
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);p=root/'oriented.jpg';im=Image.new('RGB',(1200,600),'blue');exif=Image.Exif();exif[274]=6;im.save(p,exif=exif)
   before=p.read_bytes();data,mime,meta=m.model_image(p,root/'capture')
   self.assertEqual(p.read_bytes(),before);self.assertEqual(meta['original_size'],(1200,600));self.assertEqual(meta['sent_size'],(512,1024));self.assertTrue(meta['orientation_normalized'])
   p=root/'transparent.png';Image.new('RGBA',(1500,1500),(255,0,0,0)).save(p)
   data,mime,meta=m.model_image(p,root/'capture')
   with Image.open(BytesIO(data)) as actual:self.assertEqual(actual.size,(1024,1024));self.assertTrue(all(v>245 for v in actual.getpixel((10,10))))
 def test_anthropic_intranet_keeps_raw_thinking_and_signature_without_auth(self):
  seen=[]
  class Handler(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_POST(self):
    self.rfile.read(int(self.headers['Content-Length']));seen.append((self.path,dict(self.headers)))
    self.send_response(200);self.end_headers();self.wfile.write(json.dumps({'model':'fixture','content':[{'type':'thinking','thinking':'actual fixture thought','signature':'original-signed-block'},{'type':'text','text':'OK'}],'stop_reason':'end_turn'}).encode())
  server=HTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever);thread.start()
  try:
   with tempfile.TemporaryDirectory() as tmp:
    root=Path(tmp);cfg=root/'config.json';cfg.write_text(json.dumps({'models':{'selected':{'kind':'intranet','protocol':'anthropic','family':'generic','model':'fixture','endpoint':f'http://127.0.0.1:{server.server_port}'}}}));m.Provider.context='';m.Provider.count=0;m.Provider.capture_root=root/'capture'
    answer=m.Provider(cfg,'selected').call('reply OK',json_mode=True);self.assertEqual(answer['text'],'OK');self.assertEqual(seen[0][0],'/v1/messages');headers={k.lower():v for k,v in seen[0][1].items()};self.assertNotIn('authorization',headers);self.assertNotIn('x-api-key',headers);self.assertEqual(headers['anthropic-version'],'2023-06-01')
    response=json.loads((root/'capture/0001/response.json').read_text());self.assertEqual(response['content'][0]['signature'],'original-signed-block')
  finally:server.shutdown();thread.join();server.server_close()
if __name__=='__main__':unittest.main()
