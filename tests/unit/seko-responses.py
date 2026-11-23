import sys
import importlib.util,json,tempfile,threading,unittest,os,base64
from pathlib import Path
from http.server import BaseHTTPRequestHandler,HTTPServer
ROOT=Path(__file__).resolve().parents[2]
E=ROOT/'assets/whitebox-seko/releases'/os.environ.get('SEKO_TEST_RELEASE','seko-0.1.13-cvw.1')/'engine'
sys.path.insert(0,str(E/'python'))
spec=importlib.util.spec_from_file_location('seko_provider',ROOT/'apps/worker-bridge/scripts/seko-provider.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Responses(unittest.TestCase):
 def test_actual_responses_media_memory_raw_capture_and_incomplete_guards(self):
  from PIL import Image
  from io import BytesIO
  seen=[];mode='complete'
  complete={'id':'resp_fixture','status':'completed','model':'gpt-fixture','output':[{'type':'reasoning','id':'rs_fixture','encrypted_content':'encrypted-preserved','summary':[{'type':'summary_text','text':'observed reasoning summary'}]},{'type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':'{"ok":true}'}]}],'usage':{'input_tokens':123,'output_tokens':7,'output_tokens_details':{'reasoning_tokens':3}}}
  class Handler(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_POST(self):
    self.server.body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));seen.append(self.server.body)
    assert self.path=='/v1/responses';assert self.headers.get('Authorization') is None
    body=json.loads(json.dumps(complete));code=200
    if mode=='context':body={'error':{'code':'context_length_exceeded','message':'maximum context length exceeded'}};code=400
    if mode=='incomplete':body['status']='incomplete';body['incomplete_details']={'reason':'max_output_tokens'}
    if mode=='item_incomplete':body['output'][1]['status']='in_progress'
    if mode=='refusal':body['output'][1]['content']=[{'type':'refusal','refusal':'no'}]
    self.send_response(code);self.end_headers();self.wfile.write(json.dumps(body).encode())
  server=HTTPServer(('127.0.0.1',0),Handler);t=threading.Thread(target=server.serve_forever);t.start()
  try:
   with tempfile.TemporaryDirectory() as temp:
    root=Path(temp);cfg=root/'config.json';cfg.write_text(json.dumps({'models':{'selected':{'kind':'intranet','family':'gpt','protocol':'responses','model':'gpt-fixture','endpoint':f'http://127.0.0.1:{server.server_port}','max_context_tokens':16384,'http_timeout_seconds':3}}}))
    pic=root/'large.png';Image.new('RGB',(2048,800),'orange').save(pic);original=pic.read_bytes()
    m.Provider.count=0;m.Provider.context=json.dumps([{'user':'old'*8000},{'user':'keep exact latest requested edit'}]);m.Provider.capture_root=root/'capture';m.Provider.image_optimizer=None;p=m.Provider(cfg,'selected')
    result=p.call('CURRENT_SOURCE authoritative geometry; Return JSON.',[(f'reference_{i}',pic) for i in range(100)],effort='high',json_mode=True)
    self.assertEqual(result['text'],'{"ok":true}');self.assertTrue(result['reasoning_present']);body=seen[0]
    for unexpected in ['messages','max_tokens','response_format','thinking']:self.assertNotIn(unexpected,body)
    self.assertFalse(body['store']);self.assertEqual(body['reasoning'],{'effort':'high'});self.assertEqual(body['include'],['reasoning.encrypted_content']);self.assertEqual(body['text'],{'format':{'type':'json_object'}})
    content=next(item['content'] for item in body['input'] if item['role']=='user');self.assertEqual(content[0]['type'],'input_text');self.assertIn('authoritative geometry',content[0]['text']);self.assertIn('keep exact latest requested edit',content[0]['text']);self.assertNotIn('old'*10,content[0]['text'])
    if (E/'python/seko_engine/policy.py').exists():
     from seko_engine.policy import SYSTEM_PROMPT
     self.assertEqual(body['input'][0],{'role':'system','content':SYSTEM_PROMPT});self.assertNotIn('tools',body)
    images=[b for b in content if b['type']=='input_image'];self.assertEqual(len(images),100)
    for b in images:
     with Image.open(BytesIO(base64.b64decode(b['image_url'].split(',',1)[1]))) as im:self.assertLessEqual(max(im.size),1024)
    self.assertEqual(pic.read_bytes(),original)
    cap=root/'capture/0001';self.assertEqual(json.loads((cap/'response.raw').read_bytes()),complete);self.assertEqual(json.loads((cap/'response.json').read_text()),complete)
    meta=json.loads((cap/'metadata.json').read_text());self.assertEqual(meta['context_policy']['compression_model_calls'],0);self.assertEqual(meta['context_policy']['repair_budget_used'],0);self.assertEqual(len(meta['media']),100)
    for mode in ['incomplete','item_incomplete','refusal','context']:
     with self.assertRaises(m.ContextLimitError if mode=='context' else RuntimeError):p.call('Current source preserved. JSON.',effort='low')
     receipt=json.loads((root/'capture'/f'{m.Provider.count:04d}'/'receipt.json').read_text());self.assertFalse(receipt['complete']);self.assertEqual(seen[-1]['reasoning'],{'effort':'low'})
    self.assertEqual(len(seen),5)
  finally:server.shutdown();t.join();server.server_close()
if __name__=='__main__':unittest.main()
