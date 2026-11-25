"""Original, resumable local media archive. No transcoding or generation calls."""
import concurrent.futures
import collections
import threading
import fcntl
import json
import re
import subprocess
import time
from pathlib import Path
from core import digest_file, now, lock_file


def original_path(root, run):
    model = (run.get('job') or {}).get('model_selection') or run['model_requested']
    def slug(value):
        return re.sub(r'[^A-Za-z0-9_.-]+', '-', str(value)).strip('.-')[:100] or 'unknown'
    rid = run['id']
    import uuid
    uuid.UUID(rid[4:])
    if not rid.startswith('run_'):
        raise ValueError('Invalid run id')
    base = (Path(root) / 'runtime/originals').resolve()
    base.relative_to(Path(root).resolve())
    path = base / slug(model.get('model')) / slug(run['case']['id']) / (rid + '.mp4')
    path.resolve().relative_to(base)
    return path


def cached_original(root, run):
    meta = run.get('local_original') or {}
    path = original_path(root, run)
    expected = ((run.get('job') or {}).get('result_asset') or {}).get('size_bytes')
    if (meta.get('job_id') == run.get('job_id') and meta.get('sha256')
            and meta.get('path') == str(path.relative_to(Path(root).resolve()))
            and path.is_file() and path.stat().st_size == meta.get('bytes')
            and (not expected or expected == meta['bytes'])):
        return path
    return None


def _range_download(remote, job_id, part, expected, block_size, workers):
    """Bounded memory/connections; append only contiguous, verified original ranges."""
    offset = part.stat().st_size if part.exists() else 0
    if offset > expected:
        part.unlink()
        offset = 0
    local = threading.local()
    def fetch(start):
        if not hasattr(local, 'remote'):
            local.remote = remote.fork() if hasattr(remote, 'fork') else remote
        end = min(expected, start + block_size) - 1
        for attempt in range(3):
            try:
                with local.remote.open('GET', '/api/assets/' + job_id + '/download',
                        headers={'Range': 'bytes=%d-%d' % (start, end)}, timeout=30) as response:
                    if response.status != 206 or response.headers.get('Content-Range') != 'bytes %d-%d/%d' % (start, end, expected):
                        raise ValueError('原片分段 Range 不一致')
                    data = response.read(end - start + 1)
                    if len(data) != end - start + 1:
                        raise ValueError('原片分段不完整')
                    return data
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(1)
    starts = iter(range(offset, expected, block_size))
    pending = collections.deque()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool, part.open('ab') as f:
        for start in [next(starts, None) for _ in range(workers * 2)]:
            if start is not None:
                pending.append(pool.submit(fetch, start))
        while pending:
            f.write(pending.popleft().result())
            f.flush()
            start = next(starts, None)
            if start is not None:
                pending.append(pool.submit(fetch, start))


def download_original(root, store, rid, owner, remote, attempts=3, range_bytes=None, range_workers=4):
    if range_bytes is not None and (not 65536 <= range_bytes <= 8 * 1024**2 or not 1 <= range_workers <= 32):
        raise ValueError('Invalid range download limits')
    run = store.get(rid, owner)
    asset = (run.get('job') or {}).get('result_asset') or {}
    if not run.get('job_id') or not asset.get('playable'):
        raise ValueError('没有可下载的最终成片')
    expected = asset.get('size_bytes')
    if not isinstance(expected, int) or not 0 < expected <= 4 * 1024**3:
        raise ValueError('原片大小缺失或超过 4 GiB')
    dest = original_path(root, run)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.with_suffix('.lock').open('a') as lock:
        lock_file(lock)
        run = store.get(rid, owner)
        cached = cached_original(root, run)
        if cached and digest_file(cached) == run['local_original']['sha256']:
            return cached
        part = dest.with_suffix('.part')
        if dest.exists():
            # A completed rename with a lost metadata receipt can be reconciled.
            if not run.get('local_original') and dest.stat().st_size == expected:
                part = dest
            else:
                dest.replace(part)
                part.unlink()  # known corrupt cache, never append to it
        for attempt in range(attempts):
            try:
                offset = part.stat().st_size if part.exists() else 0
                if offset > expected:
                    part.unlink()
                    offset = 0
                if offset < expected and range_bytes:
                    _range_download(remote, run['job_id'], part, expected, range_bytes, range_workers)
                    offset = expected
                if offset < expected:
                    headers = {'Range': 'bytes=%d-' % offset} if offset else {}
                    with remote.open('GET', '/api/assets/' + run['job_id'] + '/download', headers=headers, timeout=120) as response:
                        if response.status == 206:
                            cr = response.headers.get('Content-Range', '')
                            if cr != 'bytes %d-%d/%d' % (offset, expected - 1, expected):
                                raise ValueError('原片 Range 与预期大小不一致')
                        elif response.status == 200:
                            offset = 0  # server ignored Range: restart instead of appending
                        else:
                            raise ValueError('Unexpected download status')
                        with part.open('ab' if offset else 'wb') as f:
                            count = offset
                            while True:
                                chunk = response.read(1024 * 1024)
                                if not chunk:
                                    break
                                count += len(chunk)
                                if count > expected:
                                    raise ValueError('原片超过任务记录大小')
                                f.write(chunk)
                if part.stat().st_size != expected:
                    raise ValueError('原片下载不完整')
                with part.open('rb') as f:
                    if b'ftyp' not in f.read(64):
                        part.unlink()
                        raise ValueError('原片不是 MP4')
                sha = digest_file(part)
                if part != dest:
                    part.replace(dest)
                store.update(rid, owner, local_original={
                    'path': str(dest.relative_to(Path(root).resolve())),
                    'bytes': expected, 'sha256': sha, 'job_id': run['job_id'],
                    'downloaded_at': now(), 'source': 'dev_original_download',
                    'transcoded': False,
                })
                store.event(rid, owner, 'original_downloaded', bytes=expected, sha256=sha)
                return dest
            except Exception:
                if attempt + 1 == attempts:
                    raise
                time.sleep(1 + attempt)


def probe_original(path):
    try:
        meta = json.loads(subprocess.check_output([
            'ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)
        ], timeout=90, stderr=subprocess.PIPE))
        v = next(s for s in meta['streams'] if s['codec_type'] == 'video')
        num, den = map(float, v['avg_frame_rate'].split('/'))
    except (subprocess.CalledProcessError, ValueError, KeyError, StopIteration):
        return {'checked_at': now(), 'source': 'downloaded_original',
                'sha256': digest_file(path), 'bytes': path.stat().st_size,
                'decode_ok': False, 'decode_error': 'Invalid video metadata'}
    test = subprocess.run([
        'ffmpeg', '-v', 'error', '-xerror', '-threads', '2', '-i', str(path),
        '-threads', '2', '-f', 'null', '-'
    ], capture_output=True, timeout=900)
    return {
        'checked_at': now(), 'source': 'downloaded_original',
        'sha256': digest_file(path), 'bytes': path.stat().st_size,
        'duration_seconds': float(meta['format']['duration']),
        'width': v['width'], 'height': v['height'], 'fps': num / den if den else None,
        'has_audio': any(s['codec_type'] == 'audio' for s in meta['streams']),
        'decode_ok': test.returncode == 0,
        'decode_error': test.stderr.decode(errors='replace')[-2000:] or None,
    }
