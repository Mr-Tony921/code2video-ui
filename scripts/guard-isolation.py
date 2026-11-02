#!/usr/bin/env python3
"""Fail closed before operations on this independent checkout."""
import json
import hashlib
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = Path('/mnt/afs_if/codevideo/workspace/code2video-dev-codex')


def inside(value):
    p = Path(value).resolve()
    return p.is_relative_to(ROOT / 'runtime')


def validate_data_scope(c):
    paths = [c['storage']['root'], c['storage']['sessions_root'], c['session_store']['root'], c['session_store']['index_file']]
    reused = not all(inside(p) for p in paths)
    if reused:
        source = Path('/mnt/afs_if/codevideo/workspace/code2video-dev/config/backend.json')
        old = json.loads(source.read_text())
        marker = json.loads((ROOT / 'runtime/deployment/dev-data-reuse.json').read_text())
        assert marker['scope'] == 'reuse-cc-dev-data-only', 'Invalid data reuse scope'
        assert old['environment']['name'] == 'dev', 'Source data is not dev'
        assert marker['source_config_sha256'] == hashlib.sha256(source.read_bytes()).hexdigest(), 'Source configuration changed'
        expected = ['/mnt/afs_if/codevideo/workspace/code2video-dev/runtime',
                    '/mnt/afs_if/codevideo/workspace/session-dev',
                    '/mnt/afs_if/codevideo/workspace/session-dev/sessions',
                    '/mnt/afs_if/codevideo/workspace/session-dev/session-index.jsonl']
        assert [str(Path(p).resolve()) for p in paths] == expected, 'Only original dev data paths may be reused'
        original = [old['storage']['root'], old['storage']['sessions_root'], old['session_store']['root'], old['session_store']['index_file']]
        assert paths == original, 'Data configuration differs from original dev'
        assert {w['worker_id'] for w in c['workers']} == {w['worker_id'] for w in old['workers']}, 'Shared data requires original dev worker identities'
    else:
        assert all(w['worker_id'].startswith('cvw-codex-') for w in c['workers']), 'Foreign worker ID'
    overrides = [os.environ[k] for k in ('CVW_STORAGE_ROOT', 'CVW_SESSIONS_ROOT') if k in os.environ]
    assert all(inside(p) or (reused and p in paths[:2]) for p in overrides), 'Foreign storage override'
    return reused


def check():
    assert ROOT == EXPECTED, f'Unexpected checkout: {ROOT}'
    assert Path(os.environ.get('CVW_REPO_ROOT', ROOT)).resolve() == ROOT, 'Foreign CVW_REPO_ROOT'
    cfg = Path(os.environ.get('CVW_BACKEND_CONFIG', ROOT / 'config/backend.json')).resolve()
    assert cfg.is_relative_to(ROOT / 'config'), 'Foreign backend configuration'
    c = json.loads(cfg.read_text())
    assert c['environment']['name'] == 'dev', 'Not a development environment'
    validate_data_scope(c)
    dependencies = [c['runtime_binaries']['chrome_bin_host'], c['runtime_binaries']['previs_dependency_root_host']]
    dependencies += [b['src'] for b in c['isolation']['bind_paths']]
    assert all(inside(p) for p in dependencies), 'Dependency or bind path escapes this checkout'
    assert c['isolation']['enabled'] and not c['isolation']['fallback_to_soft'], 'Mount isolation must be required'
    assert c['auth']['session_cookie_name'] == 'cvw_codex_session', 'Cookie must be isolated'
    endpoints = {(c['deployment'][k]['host'], c['deployment'][k]['port']) for k in ('web', 'gateway')}
    endpoints |= {(w['bridge']['host'], w['bridge']['port']) for w in c['workers']}
    assert len(endpoints) == 2 + len(c['workers']), 'Duplicate endpoints'
    # Read configuration only; never contact or mutate these installations.
    for base in ('/mnt/afs_if', '/mnt/afs_toolcall'):
        for name in ('coding-video-web', 'codeing-video-web', 'code2video-dev'):
            p = Path(base) / 'codevideo/workspace' / name / 'config/backend.json'
            if not p.exists():
                continue
            other = json.loads(p.read_text())
            used = {(other['deployment'][k]['host'], other['deployment'][k]['port']) for k in ('web', 'gateway')}
            used |= {(w['bridge']['host'], w['bridge']['port']) for w in other['workers']}
            if endpoints & used:
                assert name == 'code2video-dev', f'Endpoint collision with {name}'
                marker = ROOT / 'runtime/deployment/dev-takeover.json'
                handover = json.loads(marker.read_text())
                assert handover['scope'] == 'retire-cc-dev-processes-only', 'Invalid handover scope'
                assert handover['source_configs'].get(str(p)) == hashlib.sha256(p.read_bytes()).hexdigest(), 'CC dev config changed since handover'
                adopted = {tuple(e) for e in handover['adopted_endpoints']}
                assert endpoints == adopted and endpoints & used <= adopted, 'Unapproved dev endpoint reuse'
            if name != 'code2video-dev':
                hosts = {host for host, _ in used}
                assert not ({host for host, _ in endpoints} & hosts), 'Production host selected'
    print('PASS: checkout, storage, dependencies, namespaces, worker IDs, cookies and endpoints isolated')


if __name__ == '__main__':
    check()
