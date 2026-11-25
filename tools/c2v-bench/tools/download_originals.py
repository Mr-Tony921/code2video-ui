#!/usr/bin/env python3
"""Download selected cohorts using their owner's ordinary dev account; never submit jobs."""
import argparse
import concurrent.futures
import getpass
import json
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bench'))
from core import Store, now, atomic
from local_media import download_original, probe_original
from remote import Remote


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data-root', type=Path, default=ROOT)
    p.add_argument('--dev-url', default='http://10.210.9.14:20211')
    p.add_argument('--cohort', action='append', required=True)
    p.add_argument('--credentials-stdin', action='store_true', help='Read username/password JSON from stdin; never saved')
    p.add_argument('--workers', type=int, choices=range(1, 5), default=3)
    p.add_argument('--range-bytes', type=int, help='Optional bounded Range blocks for slow proxy links, e.g. 131072')
    p.add_argument('--range-workers', type=int, choices=range(1, 9), default=4)
    p.add_argument('--large-range-workers', type=int, choices=range(1, 33), help='Separate concurrency for originals >=256 MiB')
    p.add_argument('--probe', action='store_true', help='Fully decode originals with ffmpeg')
    args = p.parse_args()
    root = args.data_root.resolve()
    creds = json.load(sys.stdin) if args.credentials_stdin else {'username': input('Username: '), 'password': getpass.getpass()}
    remote = Remote(args.dev_url)
    user = remote.login(creds['username'], creds['password'])
    del creds
    owner = args.dev_url.rstrip('/') + '|' + str(user['id'])
    store = Store(root / 'runtime/runs')
    runs = [r for r in store.list(owner) if r['cohort'] in args.cohort]
    runs.sort(key=lambda r: -r['job']['result_asset']['size_bytes'])
    if not runs:
        p.error('No matching runs for authenticated owner')
    def work(r):
        try:
            dest = download_original(root, store, r['id'], owner, remote, range_bytes=args.range_bytes, range_workers=(args.large_range_workers if args.large_range_workers and r['job']['result_asset']['size_bytes'] >= 256 * 1024**2 else args.range_workers))
            if args.probe:
                latest = store.get(r['id'], owner)
                probe = latest.get('probe') or {}
                if probe.get('sha256') != latest['local_original']['sha256'] or not probe.get('decode_ok'):
                    probe = probe_original(dest)
                    store.update(r['id'], owner, probe=probe)
                    store.event(r['id'], owner, 'original_probed', decode_ok=probe['decode_ok'])
            print(json.dumps({'case': r['case']['id'], 'model': r['model_requested']['model'], 'downloaded': True, 'decode_ok': (store.get(r['id'], owner).get('probe') or {}).get('decode_ok')}, ensure_ascii=False), flush=True)
            return {'run_id': r['id'], 'ok': True}
        except Exception as e:
            print(json.dumps({'case': r['case']['id'], 'error': str(e)[:300]}, ensure_ascii=False), flush=True)
            return {'run_id': r['id'], 'ok': False, 'error': str(e)[:300]}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        items = list(pool.map(work, runs))
    atomic(root / 'runtime/download-status.json', {'at': now(), 'cohorts': args.cohort, 'items': items})
    from export_review import export
    print(json.dumps(export(root, owner, args.cohort), ensure_ascii=False), flush=True)
    if not all(x['ok'] for x in items):
        raise SystemExit(1)

if __name__ == '__main__':
    main()
