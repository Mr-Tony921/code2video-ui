#!/usr/bin/env python3
"""One lifecycle implementation for web, gateway and worker services in this checkout."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def guard():
    spec = importlib.util.spec_from_file_location('isolation_guard', ROOT / 'scripts/guard-isolation.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.check()


def node_binary():
    pin = os.environ.get('CVW_NODE_BIN') or os.environ.get('CVW_NODE22_BIN')
    candidates = [str(Path(pin) / 'node')] if pin else [
        '/usr/local/bin/node', '/mnt/afs_toolcall/codevideo/.nvm/versions/node/v22.23.4/bin/node',
        shutil.which('node')]
    for candidate in candidates:
        if not candidate or not os.access(candidate, os.X_OK):
            continue
        version = subprocess.check_output([candidate, '--version'], text=True).strip()
        if int(version[1:].split('.')[0]) >= 22:
            return candidate
    raise RuntimeError('Node >=22 required; set CVW_NODE_BIN to its bin directory')


def service_info(config, kind, worker):
    if kind == 'bridge':
        w = next(w for w in config['workers'] if w['worker_id'] == worker and w.get('enabled', True))
        return 'bridge-' + worker, w['bridge'], ROOT, 'apps/worker-bridge/src/server.mjs', '/health'
    if kind == 'gateway':
        return kind, config['deployment']['gateway'], ROOT, 'apps/gateway/src/server.mjs', '/healthz'
    return 'web-local', config['deployment']['web'], ROOT / 'apps/web', 'node_modules/next/dist/bin/next', '/health'


def owned_processes(cwd, entry, web):
    """Identify by exact cwd + executable role; capture start time to guard PID reuse."""
    found = {}
    for proc in Path('/proc').glob('[0-9]*'):
        try:
            if proc.joinpath('cwd').resolve() != cwd:
                continue
            comm = proc.joinpath('comm').read_text().strip()
            argv = proc.joinpath('cmdline').read_bytes().split(b'\0')
            if web:
                match = comm.startswith('next-server') or entry.encode() in argv
            else:
                match = comm == 'node' and entry.encode() in argv
            if match:
                fields = proc.joinpath('stat').read_text().rsplit(')', 1)[1].split()
                if fields[0] != 'Z':
                    found[int(proc.name)] = fields[19]
        except (OSError, ValueError):
            continue
    return found


def stop(cwd, entry, web):
    original = owned_processes(cwd, entry, web)
    for pid, ticks in original.items():
        if owned_processes(cwd, entry, web).get(pid) == ticks:
            os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        current = owned_processes(cwd, entry, web)
        if not any(current.get(pid) == ticks for pid, ticks in original.items()):
            return
        time.sleep(.25)
    # Only the exact service processes originally selected, never their task groups.
    for pid, ticks in original.items():
        if owned_processes(cwd, entry, web).get(pid) == ticks:
            os.kill(pid, signal.SIGKILL)
    time.sleep(.25)


def environment(config, node, kind, worker):
    env = dict(os.environ)
    for line in (ROOT / 'runtime/.secrets').read_text().splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            env[k] = v
    gateway = config['deployment']['gateway']
    env.update(CVW_REPO_ROOT=str(ROOT), CVW_STORAGE_ROOT=config['storage']['root'],
               CVW_GATEWAY_PORT=str(gateway['port']), CVW_GATEWAY_HOST=gateway.get('bind', '0.0.0.0'),
               CVW_SESSIONS_ROOT=config['storage']['sessions_root'],
               CVW_GATEWAY_BASE_URL=f"http://{gateway['host']}:{gateway['port']}",
               PATH=str(Path(node).parent) + ':' + env.get('PATH', ''), NEXT_TELEMETRY_DISABLED='1')
    env['NO_PROXY'] = env['no_proxy'] = 'localhost,127.0.0.1,.svc.cluster.local,10.120.0.0/16'
    if kind == 'bridge':
        w = next(w for w in config['workers'] if w['worker_id'] == worker)
        env.update(CVW_WORKER_ID=worker, CVW_BRIDGE_PORT=str(w['bridge']['port']), CVW_BRIDGE_HOST=w['bridge']['host'])
    return env


def health_ready(response, kind, worker=None):
    if response.status != 200:
        return False
    if kind == 'web':
        return response.read().strip() == b'ok'
    data = json.load(response)
    return kind != 'bridge' or (data.get('registered') and data.get('worker_id') == worker)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=['web', 'gateway', 'bridge'])
    parser.add_argument('action', choices=['start', 'stop', 'restart', 'status', 'build', 'logs'])
    parser.add_argument('worker', nargs='?')
    args = parser.parse_args()
    guard()
    cfg = json.loads(Path(os.environ.get('CVW_BACKEND_CONFIG', ROOT / 'config/backend.json')).read_text())
    name, address, cwd, entry, health = service_info(cfg, args.kind, args.worker)
    local = socket.gethostbyname_ex(socket.gethostname())[2] + ['127.0.0.1', 'localhost']
    if address['host'] not in local:
        raise RuntimeError(f"Run {name} on {address['host']}, not this host")
    log = ROOT / 'runtime/logs' / (name + '.log')
    web = args.kind == 'web'
    if args.action == 'logs':
        os.execvp('tail', ['tail', '-n', '40', '-F', str(log)])
    if args.action == 'status':
        pids = owned_processes(cwd, entry, web)
        print(name, 'pids=' + ','.join(map(str, pids)), f"http://{address['host']}:{address['port']}")
        return 0 if len(pids) == 1 else 1
    for d in ['logs', 'pids']:
        (ROOT / 'runtime' / d).mkdir(parents=True, exist_ok=True)
    # Mutating lifecycle operations serialize; the lock is scoped to this checkout.
    with (ROOT / 'runtime/pids' / (name + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action in ['stop', 'restart']:
            stop(cwd, entry, web)
            (ROOT / 'runtime/pids' / (name + '.pid')).unlink(missing_ok=True)
            if args.action == 'stop':
                return 0
        node = node_binary()
        env = environment(cfg, node, args.kind, args.worker)
        base_path = cfg['deployment']['web'].get('base_path') or ''
        if args.action == 'build':
            if not web:
                raise RuntimeError('Only web has a build step')
            if owned_processes(cwd, entry, True):
                raise RuntimeError('Stop this checkout web before replacing its build')
            env['NEXT_PUBLIC_BASE_PATH'] = base_path
            return subprocess.call([node, entry, 'build'], cwd=cwd, env=env)
        if owned_processes(cwd, entry, web):
            raise RuntimeError(f'{name} already running; use status or restart')
        # A different checkout may own the desired port: never stop it or reuse its health.
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind((address.get('bind', '0.0.0.0'), address['port']))
        command = [node, entry]
        if web:
            for f in ['BUILD_ID', 'prerender-manifest.json', 'build-manifest.json', 'routes-manifest.json']:
                if not (cwd / '.next' / f).exists():
                    raise RuntimeError('Incomplete web build: ' + f)
            manifest = json.loads((cwd / '.next/routes-manifest.json').read_text())
            if manifest.get('basePath', '') != base_path:
                raise RuntimeError('Build basePath differs from config; rebuild with start-frontend.sh build')
            env['NEXT_PUBLIC_BASE_PATH'] = base_path if os.environ.get('CVW_KONG_STRIPS_PATH', '1') == '0' else ''
            command += ['start', '-H', address.get('bind', '0.0.0.0'), '-p', str(address['port'])]
        with log.open('ab', buffering=0) as output:
            process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                       stdout=output, stderr=output, start_new_session=True)
        (ROOT / 'runtime/pids' / (name + '.pid')).write_text(str(process.pid) + '\n')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f'{name} exited; see {log}')
            try:
                with opener.open(f'http://127.0.0.1:{address["port"]}{health}', timeout=2) as response:
                    ready = health_ready(response, args.kind, args.worker)
                if ready:
                    print(f'{name} ready pid={process.pid} port={address["port"]}')
                    return 0
            except (OSError, ValueError):
                pass
            time.sleep(.5)
        raise RuntimeError(f'{name} did not become ready; see {log}')


if __name__ == '__main__':
    raise SystemExit(main())
