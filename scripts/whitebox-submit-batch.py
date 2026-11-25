#!/usr/bin/env python3
"""Resume a dataset through authenticated dev HTTP APIs; never writes queue records directly."""
import argparse, concurrent.futures, copy, hashlib, http.cookiejar, itertools, json, mimetypes, os, re, threading, time, urllib.request, uuid
from pathlib import Path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def job_idempotency_key(manifest, key, row):
    # Only an explicitly recorded rerun gets a new key. Ordinary resume keeps the
    # original key, including batches started before rerun support was added.
    attempt = row.get('submission_attempt', 0)
    if type(attempt) is not int or attempt < 0:
        raise ValueError('Invalid recorded submission attempt')
    identity = str(manifest.resolve()) + ':' + key
    if attempt:
        identity += ':attempt:' + str(attempt)
    return 'whitebox:' + sha(identity.encode())


def within(root, name):
    path = (root / name).resolve()
    path.relative_to(root.resolve())
    return path


def load_tasks(root):
    root = Path(root)
    groups, versions = [], set()
    for name in ('seko', 'general'):
        candidates = [p for p in root.glob(name + '-*.json') if re.fullmatch(name + r'-\d+\.json', p.name)]
        if len(candidates) != 1:
            raise ValueError('Expected exactly one numbered task file for ' + name)
        path = candidates[0]
        envelope = json.loads(path.read_text())
        group = envelope['prompts']
        if not group or len(group) != int(path.stem.rsplit('-', 1)[1]):
            raise ValueError('Task count does not match ' + path.name)
        if any(t['group'] != name for t in group):
            raise ValueError('Task belongs to the wrong input group')
        if envelope.get('dataset_version'):
            versions.add(envelope['dataset_version'])
        for task in group:
            if task.get('dataset_version'):
                versions.add(task['dataset_version'])
        groups.append(group)
    if len(versions) > 1:
        raise ValueError('Mixed dataset versions')
    # A package input index defines the exact submitted bytes. Legacy packages
    # without one retain their original prose behavior and resume hashes.
    indexed = {}
    index = root / 'tasks.jsonl'
    if index.exists():
        for line in index.read_text().splitlines():
            item = json.loads(line)
            if item['short_id'] in indexed:
                raise ValueError('Duplicate indexed task')
            indexed[item['short_id']] = item
    tasks = []
    for pair in itertools.zip_longest(*groups):
        for task in pair:
            if task is None:
                continue
            if sha(task['prompt'].encode()) != task['prompt_sha256']:
                raise ValueError('Prompt hash mismatch: ' + task['short_id'])
            if [a['order'] for a in task['attachments']] != list(range(1, len(task['attachments']) + 1)):
                raise ValueError('Invalid attachment order: ' + task['short_id'])
            for asset in task['attachments']:
                if sha(within(root, asset['package_path']).read_bytes()) != asset['sha256']:
                    raise ValueError('Reference hash mismatch: ' + task['short_id'])
            prompt = within(root, task['business_input_file']).read_text() if task['group'] == 'seko' else task['prompt']
            if task['group'] == 'seko' and task.get('business_input_sha256') and sha(prompt.encode()) != task['business_input_sha256']:
                raise ValueError('Business input hash mismatch: ' + task['short_id'])
            if indexed:
                item = indexed.get(task['short_id'])
                if not item or item['group'] != task['group'] or item['task_id'] != task['id']:
                    raise ValueError('Input index mismatch: ' + task['short_id'])
                if item.get('dataset_version') != task.get('dataset_version') or item.get('cohort') != task.get('cohort'):
                    raise ValueError('Input provenance mismatch: ' + task['short_id'])
                data = within(root, item['input_file']).read_bytes()
                if sha(data) != item['input_sha256']:
                    raise ValueError('Indexed input hash mismatch: ' + task['short_id'])
                exact = data.decode('utf-8')
                if (exact != prompt if task['group'] == 'seko' else exact.rstrip('\n') != task['prompt']):
                    raise ValueError('Indexed input differs from task: ' + task['short_id'])
                prompt = exact
            tasks.append({**task, 'submitted_prompt': prompt, 'submitted_sha256': sha(prompt.encode())})
    if len({t['short_id'] for t in tasks}) != len(tasks) or len({t['id'] for t in tasks}) != len(tasks):
        raise ValueError('Duplicate task identity')
    if index.exists() and set(indexed) != {t['short_id'] for t in tasks}:
        raise ValueError('Input index does not cover exactly the task set')
    return tasks


def batch_contract(tasks, models, account, release, version=2):
    result = {'account': account, 'release': release, 'models': models,
              'tasks': [{'id': t['short_id'], 'source_prompt_sha256': t['prompt_sha256'],
                         'submitted_prompt_sha256': t['submitted_sha256'],
                         'references': [{k: a[k] for k in ('order', 'package_path', 'sha256')} for a in t['attachments']]}
                        for t in tasks]}
    if version == 2:
        result['manifest_version'] = 2
        for item, task in zip(result['tasks'], tasks):
            item.update({k: task[k] for k in ('group', 'dataset_version', 'cohort') if k in task})
    elif version != 1:
        raise ValueError('Unsupported batch manifest version')
    return result


class Client:
    def __init__(self, base):
        self.base = base.rstrip('/')
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                                  urllib.request.HTTPCookieProcessor(self.cookies))

    def fork(self):
        # Reuse one ordinary authenticated session, but keep per-thread HTTP
        # handlers/cookie state independent. Avoid simultaneous password logins.
        client = Client(self.base)
        for cookie in self.cookies:
            client.cookies.set_cookie(copy.copy(cookie))
        return client

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
    parser.add_argument('--group', action='append', choices=['seko', 'general'], help='Submit selected input group(s), sharing the same full batch ledger')
    parser.add_argument('--task', action='append', help='Submit selected short IDs first, sharing the full batch ledger; omit when resuming all')
    parser.add_argument('--limit', type=int, default=0, help='Total submissions including earlier runs; 0 means all')
    parser.add_argument('--workers', type=int, default=1, choices=range(1, 9), help='Bounded HTTP submission concurrency; does not change generation slots')
    parser.add_argument('--release', default='seko-0.1.18-cvw.1')
    args = parser.parse_args()
    tasks = load_tasks(args.dataset)
    if args.task and set(args.task) - {t['short_id'] for t in tasks}:
        parser.error('Unknown selected task ID')
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
    manifest = args.out / 'manifest.json'
    previous = json.loads(manifest.read_text()) if manifest.exists() else None
    contract = batch_contract(tasks, models, user['username'], args.release,
                              previous.get('manifest_version', 1) if previous else 2)
    if manifest.exists():
        assert previous == contract, 'Batch inputs changed; refusing to mix datasets/models'
    else:
        write(manifest, contract)
    index = args.out / 'submissions.json'
    rows = json.loads(index.read_text()) if index.exists() else {}
    total = sum(bool(row.get('job_id')) for row in rows.values())
    pending = []
    for task in tasks:
        if args.group and task['group'] not in args.group:
            continue
        if args.task and task['short_id'] not in args.task:
            continue
        for model in models:
            key = task['short_id'] + ':' + model['profile_id']
            if not rows.get(key, {}).get('job_id'):
                pending.append((task, model))
    if args.limit:
        pending = pending[:max(0, args.limit - total)]
    for task, model in pending:
        key = task['short_id'] + ':' + model['profile_id']
        row = rows.get(key, {})
        if row.get('session_create_pending') and not row.get('session_id'):
            raise RuntimeError('Session creation outcome unknown for ' + key + '; reconcile before resuming')
    lock, clients = threading.Lock(), threading.local()
    if args.workers == 1:
        clients.client = client

    def submit_one(pair):
        nonlocal total
        task, model = pair
        key = task['short_id'] + ':' + model['profile_id']
        with lock:
            row = copy.deepcopy(rows.get(key) or {'task_id': task['short_id'], 'group': task['group'],
                                       'model': model['model'], 'profile_id': model['profile_id'],
                                       'source_prompt_sha256': task['prompt_sha256'],
                                       'submitted_prompt_sha256': task['submitted_sha256'],
                                       **{k: task[k] for k in ('dataset_version', 'cohort') if k in task}})
        def persist():
            # Each worker owns its row. All durable ledger writes merge snapshots
            # under one lock; no thread can overwrite another task's receipt.
            with lock:
                rows[key] = copy.deepcopy(row)
                write(index, rows)
        if not hasattr(clients, 'client'):
            clients.client = client.fork()
        active_client = clients.client
        if not row.get('session_id'):
            if row.get('session_create_pending'):
                raise RuntimeError('Session creation outcome unknown for ' + key + '; reconcile before resuming')
            row['session_create_pending'] = True
            row['session_create_started_at'] = time.time()
            persist()
            # Session creation has no server idempotency contract: never blindly repeat a lost response.
            created = active_client.request('/api/sessions', {'mode': 'blockout_3d', 'model_id': model['profile_id']})
            session = created['session']
            assert session['model_selection']['profile_id'] == model['profile_id']
            assert session['model_selection']['engine_release'] == args.release
            row['session_id'] = session['id']
            row['session_create_pending'] = False
            row['model_selection'] = session['model_selection']
            persist()
        sid = row['session_id']
        remote = active_client.request(f'/api/sessions/{sid}/references', retry=True)['items']
        assert len(remote) <= len(task['attachments'])
        verified = []
        for i, asset in enumerate(task['attachments']):
            source = within(args.dataset, asset['package_path'])
            filename = f'reference-{i+1:03d}{source.suffix}'
            if i >= len(remote):
                uploaded = active_client.upload(sid, filename, source.read_bytes())
                remote.append(uploaded['item'])
            item = remote[i]
            assert item['original_name'] == filename and item['stored_name'] == filename
            stored = within(sessions / sid / 'references', item['stored_name'])
            assert sha(stored.read_bytes()) == asset['sha256'], 'Uploaded reference mismatch'
            verified.append({'order': i+1, 'stored_name': item['stored_name'], 'sha256': asset['sha256']})
        row['references'] = verified
        persist()
        idem = job_idempotency_key(manifest, key, row)
        reply = active_client.request(f'/api/sessions/{sid}/jobs', {'prompt': task['submitted_prompt'], 'enhance': False},
                                      headers={'Idempotency-Key': idem}, retry=True)
        job = reply['job']
        assert job['model_selection']['profile_id'] == model['profile_id']
        assert job['model_selection']['engine_release'] == args.release
        row.update(job_id=job['id'], idempotency_key=idem, submitted_at=time.time(), status_at_submit=job['status'])
        with lock:
            rows[key] = copy.deepcopy(row)
            write(index, rows)
            total += 1
            print(json.dumps({'submitted': total, 'task': task['short_id'], 'model': model['model'],
                              'session_id': sid, 'job_id': job['id'], 'status': job['status']}, ensure_ascii=False), flush=True)
    if args.workers == 1:
        for pair in pending:
            submit_one(pair)
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(submit_one, pair) for pair in pending]
            try:
                for future in concurrent.futures.as_completed(futures):
                    future.result()
            except BaseException:
                for future in futures:
                    future.cancel()
                raise
    print(json.dumps({'submitted': total, 'planned': len(tasks)*len(models), 'selected_groups': args.group or ['seko', 'general'], 'selected_groups_submitted': True, 'complete': total == len(tasks)*len(models)}), flush=True)


if __name__ == '__main__':
    main()
