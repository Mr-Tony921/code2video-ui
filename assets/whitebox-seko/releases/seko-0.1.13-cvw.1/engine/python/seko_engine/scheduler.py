"""Small durable local queue. Interrupted model calls are not silently repeated."""
import json,sqlite3,subprocess,sys,datetime
from pathlib import Path
from .io import ENGINE

def connect(path):
    Path(path).parent.mkdir(parents=True,exist_ok=True);db=sqlite3.connect(path,timeout=30);db.row_factory=sqlite3.Row
    db.execute('CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, args TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL, result TEXT)');return db
def enqueue(path,kind,args):
    if kind not in ('generate','revise','refine-source'):raise ValueError('Only generate/revise/refine-source jobs supported')
    if not isinstance(args,list) or any(not isinstance(x,str) for x in args):raise ValueError('args must be a string array; no shell command')
    with connect(path) as db:
        c=db.execute('INSERT INTO jobs(kind,args,status,created) VALUES(?,?,?,?)',(kind,json.dumps(args),'queued',datetime.datetime.now(datetime.timezone.utc).isoformat()));return c.lastrowid
def list_jobs(path):
    with connect(path) as db:return [dict(x) for x in db.execute('SELECT * FROM jobs ORDER BY id')]
def cancel(path,job_id):
    with connect(path) as db:
        c=db.execute("UPDATE jobs SET status='cancelled' WHERE id=? AND status='queued'",(job_id,));return bool(c.rowcount)
def work(path,once=False):
    while True:
        with connect(path) as db:
            db.execute('BEGIN IMMEDIATE');row=db.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").fetchone()
            if row is None:return
            db.execute("UPDATE jobs SET status='running' WHERE id=?",(row['id'],))
        log=Path(path).parent/f'job-{row["id"]:06d}.log'
        try:
            with log.open('w') as f:proc=subprocess.run([sys.executable,str(ENGINE/'cli.py'),row['kind'],*json.loads(row['args'])],stdout=f,stderr=subprocess.STDOUT)
            state='completed' if proc.returncode==0 else 'failed';result={'exit_code':proc.returncode,'log':str(log)}
        except BaseException as e:
            with connect(path) as db:db.execute("UPDATE jobs SET status='interrupted',result=? WHERE id=?",(json.dumps({'error':str(e),'note':'Inspect original output; do not retry automatically'}),row['id']))
            raise
        with connect(path) as db:db.execute('UPDATE jobs SET status=?,result=? WHERE id=?',(state,json.dumps(result),row['id']))
        if once:return
