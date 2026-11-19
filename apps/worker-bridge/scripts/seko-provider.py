"""Whitebox-only model transport, complete auditable captures and no-key intranet."""
import base64,hashlib,json,mimetypes,os,time,signal,urllib.request,urllib.error,http.client
from pathlib import Path

class ContextLimitError(RuntimeError): pass

def model_image(path,capture_root=None):
    """Keep originals; encode only large images for model transport, with provenance."""
    from PIL import Image,ImageOps
    from io import BytesIO
    p=Path(path);original=p.read_bytes();original_sha=hashlib.sha256(original).hexdigest()
    with Image.open(BytesIO(original)) as opened:
        opened.load();image=ImageOps.exif_transpose(opened);size=image.size
        data=original;mime=Image.MIME.get(opened.format) or mimetypes.guess_type(p.name)[0] or 'image/png';policy='original'
        if len(original)>262144 or max(size)>2048:
            image.thumbnail((2048,2048),Image.Resampling.LANCZOS)
            if 'A' in image.getbands() or 'transparency' in image.info:
                image=image.convert('RGBA')
                background=Image.new('RGB',image.size,'white');background.paste(image,mask=image.getchannel('A'));image=background
            encoded=BytesIO();image.convert('RGB').save(encoded,format='JPEG',quality=88,optimize=True)
            if len(encoded.getvalue())<len(original) or image.size!=size:
                data=encoded.getvalue();mime='image/jpeg';policy='jpeg_q88_max2048'
        sent_size=image.size if policy!='original' else size
    digest=hashlib.sha256(data).hexdigest();sent_path=None
    if capture_root:
        sent_path=Path(capture_root)/'model-media'/(digest+('.jpg' if mime=='image/jpeg' else p.suffix.lower()))
        sent_path.parent.mkdir(parents=True,exist_ok=True)
        if not sent_path.exists():sent_path.write_bytes(data)
    return data,mime,{'original_path':str(p),'original_sha256':original_sha,'original_bytes':len(original),'original_size':size,
        'path':str(sent_path) if sent_path else str(p),'sha256':digest,'sent_bytes':len(data),'sent_size':sent_size,'encoding':policy}


class Provider:
    context=''
    capture_root=None
    count=0
    def __init__(self,config,model):
        self.cfg=json.loads(Path(config).read_text())['models'][model]
        self.family=self.cfg['family'];self.secret=os.environ.get('CVW_SEKO_API_KEY','')
    def clean(self,text): return str(text).replace(self.secret,'[REDACTED]') if self.secret else str(text)
    def call(self,prompt,images=(),effort='low',json_mode=False):
        if effort not in ('low','medium','high'):raise ValueError('Invalid effort')
        if self.cfg['kind']=='tokenhub' and not self.secret:raise ValueError('Missing configured model key')
        Provider.count+=1;start=time.monotonic();anthropic=self.cfg.get('protocol')=='anthropic'
        limit=int(self.cfg.get('max_context_tokens') or 262144)
        output=min(self.cfg.get('max_output_tokens') or 98304, max(4096,limit//3))
        budget=limit-output-4096
        # UTF-8 bytes bound text tokens conservatively; image allowance is per observation.
        # No model summary calls; no candidate/repair counters are touched here.
        try:turns=json.loads(self.context) if self.context else []
        except ValueError:turns=[{'saved_context':self.context}]
        kept=list(turns);removed=[]
        def compose():return prompt+('\nSAVED_CONVERSATION (recent turns verbatim; earlier edits are in CURRENT_SOURCE/latest delivered project):\n'+json.dumps(kept,ensure_ascii=False) if kept else '')
        text=compose()
        while len(text.encode())+len(images)*4096>budget and len(kept)>1:
            removed.append(kept.pop(0));text=compose()
        if len(text.encode())+len(images)*4096>budget:
            raise ContextLimitError('必要的当前工程、需求和图片超出模型上下文上限。上一版已保留，请收窄本轮修改范围或联系管理员核对模型上下文配置。')
        content=[{'type':'text','text':text}];media=[]
        for label,p in images:
            data,mime,provenance=model_image(p,self.capture_root);encoded=base64.b64encode(data).decode()
            content.append({'type':'text','text':'Image evidence: '+label})
            content.append({'type':'image','source':{'type':'base64','media_type':mime,'data':encoded}} if anthropic else {'type':'image_url','image_url':{'url':f'data:{mime};base64,{encoded}'}})
            media.append({'label':label,**provenance})
        settings={'max_tokens':output,'stream':False}
        if self.family=='deepseek': settings.update(thinking={'type':'enabled'},reasoning_effort=effort)
        elif self.family=='opus':settings.update(thinking={'type':'adaptive'},output_config={'effort':effort})
        if json_mode and not anthropic:settings['response_format']={'type':'json_object'}
        body={'model':self.cfg['model'],'messages':[{'role':'user','content':content}],**settings}
        endpoint=self.cfg['endpoint'].rstrip('/')+('/v1/messages' if anthropic else '/v1/chat/completions')
        headers={'Content-Type':'application/json'}
        if anthropic:headers['anthropic-version']='2023-06-01'
        if self.cfg['kind']=='tokenhub':headers['x-api-key' if anthropic else 'Authorization']=self.secret if anthropic else 'Bearer '+self.secret
        capture=Path(self.capture_root)/f'{Provider.count:04d}' if self.capture_root else None
        def save(name,value):
            if capture:
                capture.mkdir(parents=True,exist_ok=True)
                (capture/name).write_text(json.dumps(value,ensure_ascii=False,indent=2))
        save('request.json',body);save('metadata.json',{'endpoint':endpoint,'model':self.cfg['model'],'protocol':self.cfg.get('protocol'),'media':media,'effort':effort,'started_at':time.time(),'context_policy':{'max_tokens':limit,'reserved_output_tokens':output,'text_utf8_upper_bound':len(text.encode()),'images':len(images),'kept_rounds':len(kept),'archived_earlier_rounds':len(removed),'source_and_current_request_truncated':False,'compression_model_calls':0,'repair_budget_used':0}})
        encoded_body=json.dumps(body).encode()
        transport={'request_bytes':len(encoded_body),'connect_seconds':0,'submit_seconds':0,'response_headers_seconds':0,'response_body_seconds':0}
        # Measure phases; do not confuse slow upload with reasoning or skill reflection.
        class Meter:
            def connect(self):
                began=time.monotonic()
                try:return super().connect()
                finally:transport['connect_seconds']+=time.monotonic()-began
            def send(self,data):
                began=time.monotonic()
                try:return super().send(data)
                finally:
                    if data is encoded_body:transport['submit_seconds']+=time.monotonic()-began
            def getresponse(self):
                began=time.monotonic()
                try:return super().getresponse()
                finally:transport['response_headers_seconds']+=time.monotonic()-began
        class HTTP(Meter,http.client.HTTPConnection):pass
        class HTTPS(Meter,http.client.HTTPSConnection):pass
        class HTTPHandler(urllib.request.HTTPHandler):
            def http_open(self,req):return self.do_open(HTTP,req)
        class HTTPSHandler(urllib.request.HTTPSHandler):
            def https_open(self,req):return self.do_open(HTTPS,req,context=self._context)
        def deadline(signum, frame): raise TimeoutError('Model request exceeded configured overall deadline')
        previous_alarm=signal.signal(signal.SIGALRM,deadline)
        signal.setitimer(signal.ITIMER_REAL,self.cfg.get('http_timeout_seconds',1200))
        try:
            req=urllib.request.Request(endpoint,encoded_body,headers)
            with urllib.request.build_opener(urllib.request.ProxyHandler({}),HTTPHandler(),HTTPSHandler()).open(req,timeout=self.cfg.get('http_timeout_seconds',1200)) as response:
                save('headers.json',{k:v for k,v in response.headers.items() if k.lower() in ('content-type','x-request-id','request-id','x-trace-id')})
                began=time.monotonic();raw=response.read();transport['response_body_seconds']=time.monotonic()-began;status=response.status
            if capture:(capture/'response.raw').write_bytes(raw)
            data=json.loads(raw);save('response.json',data)
            if data.get('error'):raise ValueError('Model returned an error object')
            if anthropic:
                answer=''.join(b.get('text','') for b in data.get('content',[]) if b.get('type')=='text');finish=data.get('stop_reason');thinking=any(b.get('type') in ('thinking','redacted_thinking') for b in data.get('content',[]))
                complete=finish in ('end_turn','stop_sequence')
            else:
                choice=data['choices'][0];m=choice['message'];answer=m.get('content') or '';finish=choice.get('finish_reason');thinking=bool(m.get('reasoning_content') or m.get('reasoning'));complete=finish in ('stop','end_turn')
            if not complete or not isinstance(answer,str) or not answer.strip():raise ValueError('Incomplete model output: '+str(finish))
            seconds=time.monotonic()-start;result={'text':answer,'usage':data.get('usage'),'response_model':data.get('model'),'finish_reason':finish,'reasoning_present':thinking,'effort_requested':effort,'effort_effective':'provider mapping unverified','settings':settings,'attempts':[{'channel':self.cfg['model'],'seconds':seconds,'http':status}],'seconds':seconds}
            save('receipt.json',{'complete':True,'seconds':seconds,'http':status,'finish_reason':finish});return result
        except urllib.error.HTTPError as e:
            raw=e.read()
            if capture:(capture/'response.raw').write_bytes(raw)
            save('receipt.json',{'complete':False,'http':e.code,'seconds':time.monotonic()-start})
            raise RuntimeError(f'Model API HTTP {e.code}') from None
        except Exception as e:
            save('receipt.json',{'complete':False,'seconds':time.monotonic()-start,'error':self.clean(e)})
            raise RuntimeError(self.clean(e)) from None

        finally:
            signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous_alarm)
            save('transport.json',transport)
