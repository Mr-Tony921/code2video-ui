"""Whitebox-only model transport, complete auditable captures and no-key intranet."""
import base64,hashlib,json,mimetypes,os,time,signal,urllib.request,urllib.error,http.client
from pathlib import Path

class ContextLimitError(RuntimeError): pass

# Fixed whitebox-only media policy. Originals remain immutable. Contact sheets
# produced by the engine (960px wide) retain their layout and labels.
MEDIA_POLICY = {'version':'whitebox-media-v2','max_edge':1024,
    'target_bytes':64*1024,'max_bytes':96*1024,'jpeg_qualities':[82,76,70,64]}

def model_image(path,capture_root=None,optimizer=None):
    """Bound actual model payloads, retain pixels' provenance and original files."""
    from PIL import Image,ImageOps
    from io import BytesIO
    p=Path(path);original=p.read_bytes();original_sha=hashlib.sha256(original).hexdigest()
    quality=None
    with Image.open(BytesIO(original)) as opened:
        opened.load();orientation=opened.getexif().get(274,1);original_size=opened.size
        image=ImageOps.exif_transpose(opened);size=image.size;sent_size=size
        data=original;mime=Image.MIME.get(opened.format) or mimetypes.guess_type(p.name)[0] or 'image/png';policy='original'
        if len(original)>MEDIA_POLICY['max_bytes'] or max(size)>MEDIA_POLICY['max_edge'] or orientation!=1:
            if 'A' in image.getbands() or 'transparency' in image.info:
                image=image.convert('RGBA');background=Image.new('RGB',image.size,'white')
                background.paste(image,mask=image.getchannel('A'));image=background
            base=image.convert('RGB');edge=MEDIA_POLICY['max_edge']
            while True:
                candidate=base.copy();candidate.thumbnail((edge,edge),Image.Resampling.LANCZOS)
                for quality in MEDIA_POLICY['jpeg_qualities']:
                    encoded=BytesIO();candidate.save(encoded,format='JPEG',quality=quality,optimize=True)
                    data=encoded.getvalue()
                    if len(data)<=MEDIA_POLICY['target_bytes']:break
                if len(data)<=MEDIA_POLICY['max_bytes']:break
                if edge<=128:raise ValueError('Unable to encode reference within whitebox media limit')
                edge=max(128,int(edge*.85))
            sent_size=candidate.size;mime='image/jpeg';policy='bounded_jpeg'
    optimization=None
    if optimizer is not None:
        data,mime,optimization=optimizer(data,mime)
        optimization['base_encoding']=policy
        if optimization.get('applied'):policy='bounded_webp'
    digest=hashlib.sha256(data).hexdigest();sent_path=None
    if capture_root:
        sent_path=Path(capture_root)/'model-media'/(digest+{'image/jpeg':'.jpg','image/webp':'.webp','image/png':'.png'}.get(mime,p.suffix.lower()))
        sent_path.parent.mkdir(parents=True,exist_ok=True)
        if not sent_path.exists():sent_path.write_bytes(data)
    return data,mime,{'original_path':str(p),'original_sha256':original_sha,'original_bytes':len(original),
        'original_size':original_size,'oriented_size':size,'orientation_normalized':orientation!=1,
        'path':str(sent_path) if sent_path else (str(p) if policy=='original' else None),
        'sha256':digest,'sent_bytes':len(data),'sent_size':sent_size,'encoding':policy,
        'jpeg_quality':quality,'policy':MEDIA_POLICY.copy(),**({'optimization':optimization} if optimization is not None else {})}


class Provider:
    context=''
    capture_root=None
    image_optimizer=None
    count=0
    def __init__(self,config,model):
        self.cfg=json.loads(Path(config).read_text())['models'][model]
        self.family=self.cfg['family'];self.secret=os.environ.get('CVW_SEKO_API_KEY','')
    def clean(self,text): return str(text).replace(self.secret,'[REDACTED]') if self.secret else str(text)
    def call(self,prompt,images=(),effort='low',json_mode=False):
        if effort not in ('low','medium','high'):raise ValueError('Invalid effort')
        if self.cfg['kind']=='tokenhub' and not self.secret:raise ValueError('Missing configured model key')
        Provider.count+=1;start=time.monotonic();anthropic=self.cfg.get('protocol')=='anthropic';responses=self.cfg.get('protocol')=='responses'
        try:
            from seko_engine.policy import SYSTEM_PROMPT,POLICY_VERSION,SYSTEM_SHA256
        except ImportError:
            SYSTEM_PROMPT='';POLICY_VERSION=None;SYSTEM_SHA256=None
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
        while len(text.encode())+len(SYSTEM_PROMPT.encode())+len(images)*4096>budget and len(kept)>1:
            removed.append(kept.pop(0));text=compose()
        # An upper bound above the limit is not proof that actual tokens exceed it.
        # Keep necessary source/evidence intact and let the model service enforce
        # its tokenizer's real limit. A confirmed limit error is a control failure,
        # never an instruction to spend a scene-repair attempt.
        upper_bound_exceeded=len(text.encode())+len(SYSTEM_PROMPT.encode())+len(images)*4096>budget
        content=[{'type':'input_text' if responses else 'text','text':text}];media=[]
        for label,p in images:
            data,mime,provenance=model_image(p,self.capture_root,self.image_optimizer if self.family=='deepseek' and not anthropic else None);encoded=base64.b64encode(data).decode()
            content.append({'type':'input_text' if responses else 'text','text':'Image evidence: '+label})
            content.append({'type':'input_image','image_url':f'data:{mime};base64,{encoded}'} if responses else ({'type':'image','source':{'type':'base64','media_type':mime,'data':encoded}} if anthropic else {'type':'image_url','image_url':{'url':f'data:{mime};base64,{encoded}'}}))
            media.append({'label':label,**provenance})
        if responses:
            # Stateless Responses calls retain complete raw reasoning/encrypted
            # blocks in capture. Latest source + necessary history remain the
            # explicit memory; no provider-side stored conversation is required.
            settings={'max_output_tokens':output,'stream':False,'store':False,
                'reasoning':{'effort':effort},'include':['reasoning.encrypted_content']}
            if json_mode:settings['text']={'format':{'type':'json_object'}}
            body={'model':self.cfg['model'],'input':[{'role':'user','content':content}],**settings}
        else:
            settings={'max_tokens':output,'stream':False}
            if self.family=='deepseek': settings.update(thinking={'type':'enabled'},reasoning_effort=effort)
            elif self.family=='opus':settings.update(thinking={'type':'adaptive'},output_config={'effort':effort})
            if json_mode and not anthropic:settings['response_format']={'type':'json_object'}
            body={'model':self.cfg['model'],'messages':[{'role':'user','content':content}],**settings}
        if SYSTEM_PROMPT:
            if responses:body['input'].insert(0,{'role':'system','content':SYSTEM_PROMPT})
            elif anthropic:body['system']=SYSTEM_PROMPT
            else:body['messages'].insert(0,{'role':'system','content':SYSTEM_PROMPT})
        endpoint=self.cfg['endpoint'].rstrip('/')+('/v1/responses' if responses else '/v1/messages' if anthropic else '/v1/chat/completions')
        headers={'Content-Type':'application/json'}
        if anthropic:headers['anthropic-version']='2023-06-01'
        if self.cfg['kind']=='tokenhub':headers['x-api-key' if anthropic else 'Authorization']=self.secret if anthropic else 'Bearer '+self.secret
        capture=Path(self.capture_root)/f'{Provider.count:04d}' if self.capture_root else None
        def save(name,value):
            if capture:
                capture.mkdir(parents=True,exist_ok=True)
                (capture/name).write_text(json.dumps(value,ensure_ascii=False,indent=2))
        save('request.json',body);save('metadata.json',{'endpoint':endpoint,'stage':getattr(self,'current_stage','intake'),'model':self.cfg['model'],'protocol':self.cfg.get('protocol'),'media':media,'effort':effort,'started_at':time.time(),'system_policy':{'version':POLICY_VERSION,'sha256':SYSTEM_SHA256,'present':bool(SYSTEM_PROMPT),'tools_mode':'host_orchestrated_no_native_tools'},'context_policy':{'max_tokens':limit,'reserved_output_tokens':output,'text_utf8_upper_bound':len(text.encode()),'images':len(images),'kept_rounds':len(kept),'archived_earlier_rounds':len(removed),'source_and_current_request_truncated':False,'local_upper_bound_exceeded':upper_bound_exceeded,'token_limit_authority':'model_service; local upper bound only trims redundant history','compression_model_calls':0,'repair_budget_used':0}})
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
                status=response.status;transport['http_status']=status
                # Capture bytes as they arrive, including a body interrupted after
                # HTTP 200. A timeout must retain its elapsed body wait and must
                # never be reported as a complete model response.
                began=time.monotonic();parts=[];transport['response_bytes']=0
                try:
                    while True:
                        chunk=response.read1(65536)
                        if not chunk:
                            if response.length:raise http.client.IncompleteRead(b'',response.length)
                            break
                        parts.append(chunk);transport['response_bytes']+=len(chunk)
                except http.client.IncompleteRead as e:
                    if e.partial:
                        parts.append(e.partial);transport['response_bytes']+=len(e.partial)
                    raise
                finally:
                    transport['response_body_seconds']=time.monotonic()-began
                    raw=b''.join(parts)
                    if capture:(capture/'response.raw').write_bytes(raw)
            if capture:(capture/'response.raw').write_bytes(raw)
            data=json.loads(raw);save('response.json',data)
            if data.get('error'):raise ValueError('Model returned an error object')
            if responses:
                items=data.get('output',[])
                answer=''.join(b.get('text','') for item in items if item.get('type')=='message' and item.get('role')=='assistant' for b in item.get('content',[]) if b.get('type')=='output_text')
                finish=data.get('status');thinking=any(item.get('type')=='reasoning' for item in items)
                complete=finish=='completed' and not data.get('incomplete_details') and all(item.get('status') in (None,'completed') for item in items)
            elif anthropic:
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
            try:failure=json.loads(raw).get('error',{})
            except (ValueError,AttributeError):failure={}
            code=str(failure.get('code','')) if isinstance(failure,dict) else ''
            detail=str(failure.get('message','')) if isinstance(failure,dict) else str(failure)
            import re
            context_error=e.code in (400,413,422) and (code in ('context_length_exceeded','max_context_length_exceeded','context_window_exceeded','input_too_long') or bool(re.search(r'maximum context length|context (?:length|window).*exceed|too many tokens|prompt.*too long',detail,re.I)))
            save('receipt.json',{'complete':False,'http':e.code,'seconds':time.monotonic()-start,'failure_kind':'context_limit' if context_error else 'http_error'})
            if context_error:raise ContextLimitError('模型服务确认上下文超限；必要的当前工程与证据没有截断，上一版已保留。请收窄本轮修改范围或核对模型上下文配置。') from None
            raise RuntimeError(f'Model API HTTP {e.code}') from None
        except Exception as e:
            save('receipt.json',{'complete':False,'seconds':time.monotonic()-start,'error':self.clean(e)})
            raise RuntimeError(self.clean(e)) from None

        finally:
            signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous_alarm)
            save('transport.json',transport)
