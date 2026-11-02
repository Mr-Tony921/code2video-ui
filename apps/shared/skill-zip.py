"""Validate/extract a skill ZIP into a fresh staging directory; no external packages."""
import pathlib, re, shutil, stat, sys, zipfile

stage = pathlib.Path(sys.argv[1])
unpacked = stage / 'unpacked'
unpacked.mkdir()
with zipfile.ZipFile(stage / 'uploaded.zip') as z:
    entries = z.infolist()
    if len(entries) > 2000 or sum(e.file_size for e in entries) > 64 * 1024 * 1024:
        raise ValueError('skill ZIP 解压后不能超过 64 MiB / 2000 个文件')
    seen = set()
    for e in entries:
        p = pathlib.PurePosixPath(e.filename)
        mode = e.external_attr >> 16
        if (not e.filename or '\\' in e.filename or '\x00' in e.filename or p.is_absolute()
                or '..' in p.parts or any(':' in s for s in p.parts)
                or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))):
            raise ValueError('skill ZIP 包含非法路径或链接')
        if str(p) in seen: raise ValueError('skill ZIP 包含重复路径')
        seen.add(str(p))
        dest = unpacked.joinpath(*p.parts)
        if e.is_dir(): dest.mkdir(parents=True, exist_ok=True)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            with z.open(e) as src, dest.open('wb') as dst: shutil.copyfileobj(src, dst)
            dest.chmod(0o755 if mode & 0o111 else 0o644)

roots = [p.parent for p in unpacked.rglob('SKILL.md')]
if not roots: raise ValueError('skill ZIP 必须包含至少一个 SKILL.md')
for skill in roots:
    if any(parent in roots for parent in skill.parents): raise ValueError('不支持嵌套 skill')
    name = skill.name if skill != unpacked else 'uploaded-skill'
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}', name): raise ValueError('skill 目录名称无效')
    dest = stage / 'skills' / name
    if dest.exists(): raise ValueError('skill 名称重复')
    shutil.copytree(skill, dest)
shutil.rmtree(unpacked)
