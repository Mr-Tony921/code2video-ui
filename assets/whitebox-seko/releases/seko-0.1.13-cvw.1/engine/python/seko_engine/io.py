import hashlib,json,os,tempfile
from pathlib import Path

ENGINE=Path(__file__).resolve().parents[2]

def read(path):return json.loads(Path(path).read_text())
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def write(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    # Atomic replace, confined to destination directory, safe for scheduler readers.
    with tempfile.NamedTemporaryFile('w',dir=path.parent,delete=False,encoding='utf8') as f:
        json.dump(value,f,ensure_ascii=False,indent=2);f.write('\n');tmp=f.name
    os.replace(tmp,path)
def confined(root,value):
    root=Path(root).resolve();p=(root/value).resolve()
    if not p.is_relative_to(root):raise ValueError('Path outside permitted root')
    return p
