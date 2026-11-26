#!/usr/bin/env python3
"""Generate assets with external private provider config; safe resumable video polling."""
import argparse, base64, hashlib, io, json, mimetypes, os, sys, time
import urllib.error, urllib.parse, urllib.request
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    tmp.replace(path)


def data_url(path):
    p = Path(path)
    if p.stat().st_size > 20 * 1024 * 1024:
        raise ValueError('Reference exceeds 20 MiB')
    return 'data:' + (mimetypes.guess_type(p.name)[0] or 'image/png') + ';base64,' + base64.b64encode(p.read_bytes()).decode()


def prepared_reference(path, folder):
    """Preserve originals; upload a bounded, deterministic copy before any POST."""
    from PIL import Image, ImageOps
    source = Path(path)
    if source.stat().st_size > 20 * 1024 * 1024:
        raise ValueError('Reference exceeds 20 MiB')
    raw = source.read_bytes()
    with Image.open(io.BytesIO(raw)) as opened:
        image = ImageOps.exif_transpose(opened).convert('RGBA')
        background = Image.new('RGBA', image.size, (255, 255, 255, 255))
        background.alpha_composite(image)
        image = background.convert('RGB')
    original_size = image.size
    for edge in [1280, 1024, 896, 768]:
        candidate = image.copy()
        candidate.thumbnail((edge, edge), Image.Resampling.LANCZOS)
        for quality in [90, 82, 74]:
            buf = io.BytesIO()
            candidate.save(buf, format='JPEG', quality=quality, optimize=True)
            encoded = buf.getvalue()
            if len(encoded) <= 512 * 1024:
                digest = hashlib.sha256(encoded).hexdigest()
                target = Path(folder) / (digest + '.jpg')
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists():
                    target.write_bytes(encoded)
                return target, {'original_sha256': hashlib.sha256(raw).hexdigest(),
                    'uploaded_sha256': digest, 'original_size': original_size,
                    'uploaded_size': candidate.size, 'original_bytes': len(raw),
                    'uploaded_bytes': len(encoded), 'jpeg_quality': quality}
    raise ValueError('Cannot prepare reference within 512 KiB; no request submitted')


def api(cfg, method, suffix='', payload=None):
    url = cfg['base_url'].rstrip('/') + cfg['path'] + suffix
    if urllib.parse.urlparse(url).scheme != 'https':
        raise ValueError('Provider credential requires HTTPS')
    req = urllib.request.Request(url, method=method,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={'Authorization': 'Bearer ' + cfg['api_key'], 'Content-Type': 'application/json'})
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=180) as res:
            return json.load(res)
    except urllib.error.HTTPError as exc:
        body = exc.read(8192).decode(errors='replace').replace(cfg['api_key'], '[REDACTED]')
        raise RuntimeError('HTTP %s: %s' % (exc.code, body[:1500])) from None


def download(url, out):
    if urllib.parse.urlparse(url).scheme != 'https':
        raise ValueError('Asset URL must use HTTPS')
    # Provider Authorization is deliberately never forwarded to asset hosts.
    tmp = out.with_suffix(out.suffix + '.part')
    with urllib.request.urlopen(url, timeout=180) as res, tmp.open('wb') as f:
        total = 0
        while True:
            chunk = res.read(1024 * 1024)
            if not chunk: break
            total += len(chunk)
            if total > 512 * 1024 * 1024: raise ValueError('Asset exceeds 512 MiB')
            f.write(chunk)
    if not tmp.stat().st_size: raise ValueError('Empty asset')
    tmp.replace(out)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('kind', choices=['image', 'video'])
    p.add_argument('--config', default=os.environ.get('C2V_MEDIA_CONFIG', str(Path.home()/'.config/c2v-media/.secrets')))
    p.add_argument('--prompt-file', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--reference', action='append', default=[])
    p.add_argument('--seconds', type=int, default=8)
    p.add_argument('--resolution', choices=['480p','720p','1080p'], default='720p')
    p.add_argument('--ratio', default='16:9')
    p.add_argument('--audio', action='store_true')
    p.add_argument('--wait', type=int, default=900)
    a = p.parse_args()
    cfg = json.loads(Path(a.config).read_text())[a.kind]
    out = Path(a.out).resolve(); out.parent.mkdir(parents=True, exist_ok=True)
    receipt = out.with_suffix(out.suffix+'.receipt.json')
    prompt = Path(a.prompt_file).read_text()
    prepared = [prepared_reference(x, out.parent/'.transport') for x in a.reference]
    refs = [data_url(x[0]) for x in prepared]
    if a.kind == 'image':
        payload = {'model':cfg['model'], 'prompt':prompt, 'size':'2K', 'output_format':'png', 'response_format':'url', 'watermark':False}
        if refs: payload['image'] = refs[0] if len(refs)==1 else refs
    else:
        if not 4 <= a.seconds <= 30: raise ValueError('Video seconds must be 4..30')
        content = [{'type':'text','text':prompt}]
        content += [{'type':'image_url','image_url':{'url':u}, 'role':'first_frame' if len(refs)==1 else 'reference_image'} for u in refs]
        payload = {'model':cfg['model'],'content':content,'resolution':a.resolution,'duration':a.seconds,'ratio':a.ratio,'generate_audio':a.audio,'watermark':False}
        # First-frame video inherits its image ratio; specifying ratio is rejected.
        if len(refs)==1: payload.pop('ratio')
    fingerprint = hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest()
    if receipt.exists():
        r = json.loads(receipt.read_text())
        if r['request_sha256'] != fingerprint: raise ValueError('Output already reserved for another request; use a distinct output path')
        if r.get('status')=='downloaded' and out.exists():
            print(json.dumps({k:v for k,v in r.items() if k!='asset_url'},ensure_ascii=False)); return
        if not r.get('task_id') and not r.get('asset_url'):
            raise RuntimeError('Previous POST not confirmed; inspect provider task history before resubmission. No automatic duplicate POST.')
    else:
        r = {'kind':a.kind,'provider_model':cfg['model'],'request_sha256':fingerprint,'started_at':time.time(),'status':'submitting','output':str(out),
             'reference_transport': [x[1] for x in prepared]}
        # Exclusive durable reservation prevents duplicate paid requests.
        with receipt.open('x') as f: json.dump(r,f)
        try:
            result = api(cfg,'POST',payload=payload)
            r['accepted_at']=time.time()
            r['submit_seconds']=r['accepted_at']-r['started_at']
            if a.kind=='video':
                if not result.get('id'): raise ValueError('No task id in create response')
                r.update(task_id=result['id'],status='accepted')
            else:
                row=result['data'][0]
                if row.get('url'): r['asset_url']=row['url']
                elif row.get('b64_json'): out.write_bytes(base64.b64decode(row['b64_json']))
                else: raise ValueError('Image response has no asset')
                r['status']='generated'
            save(receipt,r)
        except Exception as exc:
            r.update(status='submission_unconfirmed',error=str(exc).replace(cfg['api_key'],'[REDACTED]'))
            save(receipt,r); raise
    if a.kind=='video' and not r.get('asset_url'):
        deadline=time.monotonic()+a.wait
        print(json.dumps({'task_id':r['task_id'],'status':r['status']},ensure_ascii=False),flush=True)
        while time.monotonic()<deadline:
            try:
                result=api(cfg,'GET','/'+urllib.parse.quote(r['task_id'],safe=''))
            except Exception as exc:
                r['last_poll_error']=str(exc);save(receipt,r);time.sleep(15);continue
            r['status']=result.get('status','unknown');r['checked_at']=time.time()
            if r['status']=='succeeded':
                r['asset_url']=result['content']['video_url'];r['usage']=result.get('usage');save(receipt,r);break
            if r['status'] in ['failed','cancelled','expired']:
                r['error']=result.get('error');save(receipt,r);raise RuntimeError('Video task '+r['status']+': '+str(r['error']))
            save(receipt,r);time.sleep(15)
        if not r.get('asset_url'):
            raise RuntimeError('Polling budget reached; rerun SAME command to query saved task, never recreate it')
    if r.get('asset_url'): download(r['asset_url'],out)
    r.update(status='downloaded',finished_at=time.time(),bytes=out.stat().st_size,asset_sha256=hashlib.sha256(out.read_bytes()).hexdigest())
    r['elapsed_seconds']=r['finished_at']-r['started_at'];save(receipt,r)
    # Receipts retain signed URLs locally for recovery; stdout omits them.
    print(json.dumps({k:v for k,v in r.items() if k!='asset_url'},ensure_ascii=False))


if __name__=='__main__':
    try: main()
    except Exception as exc:
        print(type(exc).__name__+': '+str(exc),file=sys.stderr);sys.exit(1)
