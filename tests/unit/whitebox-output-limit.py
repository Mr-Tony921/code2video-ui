"""Real local HTTP capture: token exhaustion is typed; other failures are not."""
import importlib.util,json,os,sys,tempfile,threading,unittest
from pathlib import Path
from http.server import BaseHTTPRequestHandler,HTTPServer
from unittest.mock import patch
R=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(R/'assets/whitebox-seko/releases'/os.getenv('SEKO_TEST_RELEASE','seko-0.1.18-cvw.1')/'engine/python'))
from seko_engine import provider as engine_provider
spec=importlib.util.spec_from_file_location('web_provider',R/'apps/worker-bridge/scripts/seko-provider.py')
host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)

class OutputCapture(unittest.TestCase):
    def scenario(self,protocol,body,expected=True,legacy=False):
        requests=[];raw=json.dumps(body).encode()
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        server=HTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever);thread.start()
        try:
            with tempfile.TemporaryDirectory() as d:
                root=Path(d);cfg=root/'config.json';cfg.write_text(json.dumps({'models':{'selected':{'kind':'intranet','family':'opus' if protocol=='anthropic' else 'gpt' if protocol=='responses' else 'deepseek','protocol':protocol,'model':'fixture','endpoint':f'http://127.0.0.1:{server.server_port}','max_context_tokens':200000,'max_output_tokens':65536}}}))
                host.Provider.count=0;host.Provider.context='';host.Provider.capture_root=root/'capture'
                with patch.object(engine_provider,'OutputLimitError',None) if legacy else context():
                    with self.assertRaises(RuntimeError) as error:host.Provider(cfg,'selected').call('Return a complete module')
                self.assertEqual(bool(getattr(error.exception,'output_limit',False)),expected)
                cap=root/'capture/0001';self.assertEqual((cap/'response.raw').read_bytes(),raw)
                self.assertEqual(json.loads((cap/'response.json').read_text()),body)
                self.assertTrue((cap/'request.json').exists());self.assertTrue((cap/'transport.json').exists())
                receipt=json.loads((cap/'receipt.json').read_text());self.assertFalse(receipt['complete']);self.assertEqual(receipt.get('failure_kind')=='output_limit',expected);self.assertEqual(len(requests),1)
                if expected:self.assertEqual(error.exception.max_output_tokens,65536)
        finally:server.shutdown();thread.join();server.server_close()
    def test_anthropic_thinking_and_signature_survive(self):
        self.scenario('anthropic',{'stop_reason':'max_tokens','content':[{'type':'thinking','thinking':'actual server block','signature':'opaque signature'},{'type':'text','text':'partial code'}]})
    def test_responses_output_limit(self):self.scenario('responses',{'status':'incomplete','incomplete_details':{'reason':'max_output_tokens'},'output':[]})
    def test_chat_length(self):self.scenario('chat',{'choices':[{'finish_reason':'length','message':{'content':'partial'}}]})
    def test_content_filter_is_not_token_recovery(self):self.scenario('chat',{'choices':[{'finish_reason':'content_filter','message':{'content':''}}]},False)
    def test_older_engine_keeps_generic_error(self):self.scenario('anthropic',{'stop_reason':'max_tokens','content':[]},False,True)

from contextlib import nullcontext as context
if __name__=='__main__':unittest.main()
