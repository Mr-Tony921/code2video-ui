"""Stream a faithful session archive; omit replaceable caches/dependencies, never follow links."""
import os, pathlib, sys, zipfile

root = pathlib.Path(sys.argv[1]).resolve()
excluded = {'node_modules', '.tmp', '.cache', '__pycache__'}
allowed = ['workspace', 'rounds', 'jobs', 'skill-revisions', 'references', 'meta.json', 'messages.jsonl']
with zipfile.ZipFile(sys.stdout.buffer, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as out:
    for name in allowed:
        start = root / name
        if not start.exists() or start.is_symlink(): continue
        if start.is_file(): out.write(start, name); continue
        for directory, dirs, files in os.walk(start, followlinks=False):
            d = pathlib.Path(directory)
            dirs[:] = [n for n in dirs if n not in excluded and not (d/n).is_symlink()]
            for name in files:
                p = d/name
                if p.is_symlink() or not p.is_file(): continue
                # Runtime credentials are injected through env; never export older settings files.
                if name in ['settings.json', 'settings.local.json', '.credentials.json', '.env', '.secrets']: continue
                try: out.write(p, str(p.relative_to(root)))
                except FileNotFoundError: pass  # An active job may atomically replace a sidecar.
