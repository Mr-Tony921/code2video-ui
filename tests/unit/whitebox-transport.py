import importlib.util,json,tempfile,threading,time,unittest
from pathlib import Path
from http.server import BaseHTTPRequestHandler,HTTPServer
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('provider',ROOT/'apps/worker-bridge/scripts/seko-provider.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
BODY=json.dumps({'choices':[{'message':{'content':'OK','reasoning_content':'retained thought','reasoning_signature':'retained-signature'},'finish_reason':'stop'}]}).encode()
class Capture(unittest.TestCase):
 def scenario(self,mode):
  calls=[]
  class Handler(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_POST(self):
    self.rfile.read(int(self.headers['Content-Length']));calls.append(self.path)
    self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(BODY)));self.end_headers()
    self.wfile.write(BODY[:12]);self.wfile.flush()
    if mode=='timeout':time.sleep(.45);return
    if mode=='truncated':return
    time.sleep(.02);self.wfile.write(BODY[12:]);self.wfile.flush()
  server=HTTPServer(('127.0.0.1',0),Handler);t=threading.Thread(target=server.serve_forever);t.start()
  try:
   with tempfile.TemporaryDirectory() as temp:
    root=Path(temp);cfg=root/'cfg.json';cfg.write_text(json.dumps({'models':{'selected':{'kind':'intranet','family':'generic','protocol':'chat','model':'fixture','endpoint':f'http://127.0.0.1:{server.server_port}','http_timeout_seconds':.2 if mode=='timeout' else 3}}}))
    m.Provider.count=0;m.Provider.context='';m.Provider.capture_root=root/'capture';p=m.Provider(cfg,'selected')
    if mode=='complete':self.assertEqual(p.call('Reply OK')['text'],'OK')
    else:
     with self.assertRaises(RuntimeError):p.call('Reply OK')
    cap=root/'capture/0001';receipt=json.loads((cap/'receipt.json').read_text());transport=json.loads((cap/'transport.json').read_text())
    self.assertEqual(len(calls),1);self.assertEqual(transport['http_status'],200)
    self.assertEqual(receipt['complete'],mode=='complete')
    self.assertEqual((cap/'response.raw').read_bytes(),BODY if mode=='complete' else BODY[:12])
    self.assertEqual(transport['response_bytes'],len(BODY) if mode=='complete' else 12)
    if mode=='timeout':self.assertGreater(transport['response_body_seconds'],.1)
    if mode=='complete':self.assertEqual(json.loads((cap/'response.json').read_text())['choices'][0]['message']['reasoning_signature'],'retained-signature')
    else:self.assertFalse((cap/'response.json').exists())
  finally:server.shutdown();t.join();server.server_close()
 def test_complete_bytes_signatures_unchanged(self):self.scenario('complete')
 def test_deadline_retains_partial_body_and_elapsed_wait(self):self.scenario('timeout')
 def test_truncated_content_length_is_not_success(self):self.scenario('truncated')
if __name__=='__main__':unittest.main()
