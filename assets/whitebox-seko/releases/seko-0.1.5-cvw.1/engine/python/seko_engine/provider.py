"""Portable TokenHub-compatible adapter. Secrets never enter saved request metadata."""
import base64,json,mimetypes,os,re,time,urllib.error,urllib.request
from pathlib import Path
from .io import read

class Provider:
    def __init__(self,config,model):
        all_config=read(config);self.cfg=all_config['models'][model];self.family=self.cfg['family'];self.secrets=[]
        self.credentials=read(all_config['credentials_file']) if all_config.get('credentials_file') else {}
    def key(self,channel):
        key=os.environ.get(self.cfg.get('api_key_env',''),'')
        if not key and channel in self.credentials:key=self.credentials[channel][0]
        if not key:raise ValueError('Missing configured credential for '+channel)
        self.secrets.append(key);return key
    def clean(self,message):
        for values in self.credentials.values():
            for value in values:
                if isinstance(value,str) and value:message=message.replace(value,'[REDACTED]')
        for value in self.secrets:message=message.replace(value,'[REDACTED]')
        return message
    def call(self,prompt,images=(),effort='low',json_mode=False):
        if effort not in ('low','medium','high'):raise ValueError('Invalid reasoning effort')
        family=self.family;content=[{'type':'input_text' if family=='gpt' else 'text','text':prompt}]
        for label,path in images:
            mime=mimetypes.guess_type(str(path))[0] or 'image/jpeg'
            uri='data:'+mime+';base64,'+base64.b64encode(Path(path).read_bytes()).decode()
            content.append({'type':'input_text' if family=='gpt' else 'text','text':'Image evidence: '+label})
            content.append({'type':'input_image','image_url':uri} if family=='gpt' else {'type':'image_url','image_url':{'url':uri}})
        max_tokens=self.cfg.get('max_output_tokens',98304)
        if family=='gpt':settings={'reasoning':{'effort':effort},'max_output_tokens':max_tokens};endpoint='/responses'
        elif family=='deepseek':
            settings={'thinking':{'type':'enabled'},'reasoning_effort':effort,'max_tokens':max_tokens};endpoint='/chat/completions'
            if json_mode:settings['response_format']={'type':'json_object'}
        elif family=='opus':settings={'thinking':{'type':'adaptive'},'output_config':{'effort':effort},'max_tokens':max_tokens};endpoint='/chat/completions'
        else:raise ValueError('Unsupported provider family')
        attempts=[]
        for channel in self.cfg['channels']:
            body={'model':channel,**settings}
            if family=='gpt':body['input']=[{'role':'user','content':content}]
            else:body['messages']=[{'role':'user','content':content}]
            key=self.key(channel);start=time.monotonic()
            try:
                req=urllib.request.Request(self.cfg['base_url'].rstrip('/')+endpoint,json.dumps(body).encode(),{'Authorization':'Bearer '+key,'Content-Type':'application/json'})
                with urllib.request.urlopen(req,timeout=self.cfg.get('http_timeout_seconds',1200)) as response:data=json.load(response)
                if family=='gpt':
                    answer=''.join(c.get('text','') for o in data.get('output',[]) for c in o.get('content',[]) if c.get('type')=='output_text');finish=data.get('status');thinking=any(o.get('type')=='reasoning' for o in data.get('output',[]))
                else:
                    choice=data['choices'][0];m=choice['message'];answer=m.get('content') or '';finish=choice.get('finish_reason');thinking=bool(m.get('reasoning_content') or m.get('reasoning'))
                attempts.append({'channel':channel,'seconds':time.monotonic()-start,'http':200})
                return {'text':answer,'usage':data.get('usage'),'response_model':data.get('model'),'finish_reason':finish,'reasoning_present':thinking,'effort_requested':effort,'effort_effective':'provider mapping unverified','settings':settings,'attempts':attempts,'seconds':sum(x['seconds'] for x in attempts)}
            except urllib.error.HTTPError as e:attempts.append({'channel':channel,'seconds':time.monotonic()-start,'http':e.code,'error':self.clean(e.read().decode(errors='replace')[:1500])})
            except Exception as e:attempts.append({'channel':channel,'seconds':time.monotonic()-start,'error':self.clean(str(e))})
        raise RuntimeError(json.dumps({'transport_failures':attempts},ensure_ascii=False))

def parse_json(text):
    text=text.strip()
    if text.startswith('```'):text=text.split('\n',1)[1].rsplit('```',1)[0]
    return json.loads(text)

def parse_source(text):
    text=text.strip()
    if text.startswith('```'):text=text.split('\n',1)[1].rsplit('```',1)[0].strip()
    if not text.startswith('export') and text.startswith('{'):
        obj=json.loads(text);text=obj.get('source') or obj.get('code') or ''
    # Pure syntax normalization: a single top-level named function can be exported
    # without changing authored geometry/animation. Original response is preserved.
    if re.match(r'^(?:async\s+)?function\s+buildScene\s*\(',text):text='export '+text
    if not re.search(r'export\s+(?:async\s+)?function\s+buildScene\b|export\s*\{[^}]*\bbuildScene\b',text):raise ValueError('Missing exported buildScene module')
    return text+'\n'

def apply_source_patch(source,text):
    patch=parse_json(text)
    if set(patch)=={'source'}:return parse_source(patch['source'])
    edits=patch.get('replacements')
    if not isinstance(edits,list) or not edits:raise ValueError('Expected nonempty replacements array')
    result=source
    for edit in edits:
        if not isinstance(edit,dict) or set(edit)!={'old','new'} or not isinstance(edit['old'],str) or not isinstance(edit['new'],str):raise ValueError('Each replacement needs exactly string old and new; no implicit repair of malformed model JSON')
        before=edit['old'];after=edit['new']
        if not before or result.count(before)!=1:raise ValueError('Patch old text must match exactly once')
        result=result.replace(before,after,1)
    return parse_source(result)
