#!/usr/bin/env python3
"""Resume a dataset through authenticated dev HTTP APIs; never writes queue records directly."""
import argparse, hashlib, http.cookiejar, json, mimetypes, os, time, urllib.request, uuid
from pathlib import Path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def within(root, name):
    path = (root / name).resolve()
    path.relative_to(root.resolve())
    return path


def load_tasks(root):
    groups = [json.loads((root / (group + '-100.json')).read_text())['prompts'] for group in ('seko', 'general')]
    if [len(group) for group in groups] != [100, 100]:
        raise ValueError('Expected 100 Seko and 100 general tasks')
    tasks = []
    for pair in zip(*groups):
        for task in pair:
            assert sha(task['prompt'].encode()) == task['prompt_sha256']
            assert [a['order'] for a in task['attachments']] == list(range(1, len(task['attachments']) + 1))
            for asset in task['attachments']:
                assert sha(within(root, asset['package_path']).read_bytes()) == asset['sha256']
            # Business normalization is supplied by the dataset; prose remains byte-for-byte original.
            prompt = within(root, task['business_input_file']).read_text() if task['group'] == 'seko' else task['prompt']
            tasks.append({**task, 'submitted_prompt': prompt, 'submitted_sha256': sha(prompt.encode())})
    assert len({t['short_id'] for t in tasks}) == 200
    return tasks


class Client:
    def __init__(self, base):
        self.base = base.rstrip('/')
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                                  urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, path, body=None, *, headers=None, retry=False):
        headers = dict(headers or {})
        if isinstance(body, dict):
            body = json.dumps(body, ensure_ascii=False).encode()
            headers['Content-Type'] = 'application/json'
        for attempt in range(3 if retry else 1):
            try:
                with self.opener.open(urllib.request.Request(self.base + path, data=body, headers=headers), timeout=90) as r:
                    return json.load(r)
            except Exception:
                if attempt == (2 if retry else 0):
                    raise
                time.sleep(2)

    def upload(self, sid, filename, data):
        boundary = 'cvw-' + uuid.uuid4().hex
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                f'Content-Type: {mimetypes.guess_type(filename)[0] or "application/octet-stream"}\r\n\r\n').encode()
        body += data + f'\r\n--{boundary}--\r\n'.encode()
        return self.request(f'/api/sessions/{sid}/references', body,
                            headers={'Content-Type': 'multipart/form-data; boundary=' + boundary})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--account', type=Path, required=True)
    parser.add_argument('--models', type=Path, required=True, help='JSON list of {profile_id,model}')
    parser.add_argument('--out', type=Path, required=True, help='Persistent submission ledger; reuse to resume')
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--config', type=Path, default=Path('config/backend.json'))
    parser.add_argument('--limit', type=int, default=0, help='Total submissions including earlier runs; 0 means all')
    parser.add_argument('--release', default='seko-0.1.12-cvw.1')
    args = parser.parse_args()
    tasks = load_tasks(args.dataset)
    models = json.loads(args.models.read_text())
    assert models and len({m['profile_id'] for m in models}) == len(models)
    args.out.mkdir(parents=True, exist_ok=True)
    os.chmod(args.out, 0o700)
    account = json.loads(args.account.read_text())
    os.chmod(args.account, 0o600)
    client = Client(args.base_url)
    user = client.request('/api/auth/login', {'username': account['username'], 'password': account['password']})['user']
    assert user['username'] == account['username'] and user['status'] == 'active'
    settings = client.request('/api/whitebox/settings', retry=True)
    allowed = {m['profile_id']: m for m in settings['models']}
    for m in models:
        assert allowed[m['profile_id']]['model'] == m['model']
        assert allowed[m['profile_id']]['engine_release'] == args.release
    raw = json.loads(args.config.read_text())
    sessions = Path(raw['storage']['sessions_root']) / raw['storage'].get('sessions_subdir', 'sessions')
    contract = {'account': user['username'], 'release': args.release, 'models': models,
                'tasks': [{'id': t['short_id'], 'source_prompt_sha256': t['prompt_sha256'],
                           'submitted_prompt_sha256': t['submitted_sha256'],
                           'references': [{k: a[k] for k in ('order', 'package_path', 'sha256')} for a in t['attachments']]}
                          for t in tasks]}
    manifest = args.out / 'manifest.json'
    if manifest.exists():
        assert json.loads(manifest.read_text()) == contract, 'Batch inputs changed; refusing to mix datasets/models'
    else:
        write(manifest, contract)
    index = args.out / 'submissions.json'
    rows = json.loads(index.read_text()) if index.exists() else {}
    total = sum(bool(row.get('job_id')) for row in rows.values())
    for task in tasks:
        for model in models:
            key = task['short_id'] + ':' + model['profile_id']
            row = rows.setdefault(key, {'task_id': task['short_id'], 'group': task['group'],
                                       'model': model['model'], 'profile_id': model['profile_id'],
                                       'source_prompt_sha256': task['prompt_sha256'],
                                       'submitted_prompt_sha256': task['submitted_sha256']})
            if row.get('job_id'):
                continue
            if args.limit and total >= args.limit:
                print(json.dumps({'submitted': total, 'planned': len(tasks)*len(models), 'limited': True}), flush=True)
                return
            if not row.get('session_id'):
                if row.get('session_create_pending'):
                    raise RuntimeError('Session creation outcome unknown for ' + key + '; reconcile before resuming')
                row['session_create_pending'] = True
                row['session_create_started_at'] = time.time()
                write(index, rows)
                # Session creation has no server idempotency contract: never blindly repeat a lost response.
                created = client.request('/api/sessions', {'mode': 'blockout_3d', 'model_id': model['profile_id']})
                session = created['session']
                assert session['model_selection']['profile_id'] == model['profile_id']
                assert session['model_selection']['engine_release'] == args.release
                row['session_id'] = session['id']
                row['session_create_pending'] = False
                row['model_selection'] = session['model_selection']
                write(index, rows)
            sid = row['session_id']
            remote = client.request(f'/api/sessions/{sid}/references', retry=True)['items']
            assert len(remote) <= len(task['attachments'])
            verified = []
            for i, asset in enumerate(task['attachments']):
                source = within(args.dataset, asset['package_path'])
                filename = f'reference-{i+1:03d}{source.suffix}'
                if i >= len(remote):
                    uploaded = client.upload(sid, filename, source.read_bytes())
                    remote.append(uploaded['item'])
                item = remote[i]
                assert item['original_name'] == filename and item['stored_name'] == filename
                stored = within(sessions / sid / 'references', item['stored_name'])
                assert sha(stored.read_bytes()) == asset['sha256'], 'Uploaded reference mismatch'
                verified.append({'order': i+1, 'stored_name': item['stored_name'], 'sha256': asset['sha256']})
            row['references'] = verified
            write(index, rows)
            idem = 'whitebox:' + sha((str(manifest.resolve()) + ':' + key).encode())
            reply = client.request(f'/api/sessions/{sid}/jobs', {'prompt': task['submitted_prompt'], 'enhance': False},
                                   headers={'Idempotency-Key': idem}, retry=True)
            job = reply['job']
            assert job['model_selection']['profile_id'] == model['profile_id']
            assert job['model_selection']['engine_release'] == args.release
            row.update(job_id=job['id'], idempotency_key=idem, submitted_at=time.time(), status_at_submit=job['status'])
            write(index, rows)
            total += 1
            print(json.dumps({'submitted': total, 'task': task['short_id'], 'model': model['model'],
                              'session_id': sid, 'job_id': job['id'], 'status': job['status']}, ensure_ascii=False), flush=True)
    print(json.dumps({'submitted': total, 'planned': len(tasks)*len(models), 'complete': True}), flush=True)


if __name__ == '__main__':
    main()
