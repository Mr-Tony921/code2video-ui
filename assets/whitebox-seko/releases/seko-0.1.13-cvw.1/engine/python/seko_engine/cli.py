import argparse,json,os,subprocess
from pathlib import Path
from .io import ENGINE,read,write
from .normalize import normalize

def main():
    p=argparse.ArgumentParser();sub=p.add_subparsers(dest='command',required=True)
    n=sub.add_parser('normalize');n.add_argument('--input',required=True);n.add_argument('--references');n.add_argument('--out',required=True)
    c=sub.add_parser('probe');c.add_argument('--source');c.add_argument('--project');c.add_argument('--task',required=True);c.add_argument('--out',required=True);c.add_argument('--legacy',action='store_true')
    g=sub.add_parser('generate');g.add_argument('--input',required=True);g.add_argument('--references',required=True);g.add_argument('--config',required=True);g.add_argument('--model',required=True);g.add_argument('--out',required=True);g.add_argument('--case-id')
    f=sub.add_parser('refine-source');f.add_argument('--run',required=True);f.add_argument('--request-file',required=True);f.add_argument('--config',required=True);f.add_argument('--model',required=True);f.add_argument('--out',required=True)
    w=sub.add_parser('workspace');w.add_argument('--project',required=True);w.add_argument('--task',required=True);w.add_argument('--out',required=True)
    e=sub.add_parser('apply-edits');e.add_argument('--workspace',required=True);e.add_argument('--operations',required=True);e.add_argument('--expected-revision',type=int,required=True)
    r=sub.add_parser('revise');r.add_argument('--workspace',required=True);r.add_argument('--scope',required=True);r.add_argument('--entities',nargs='+',required=True);r.add_argument('--request',required=True);r.add_argument('--config',required=True);r.add_argument('--model',required=True);r.add_argument('--out',required=True)
    q=sub.add_parser('queue');q.add_argument('--db',required=True);q.add_argument('action',choices=['enqueue','list','work','cancel']);q.add_argument('--job');q.add_argument('--id',type=int);q.add_argument('--once',action='store_true')
    args=p.parse_args()
    if args.command=='refine-source':
        from .harness import run
        result=run(None,None,args.config,args.model,args.out,seed_run=args.run,refinement_request=Path(args.request_file).read_text())
        raise SystemExit(0 if result.get('scene_success') else 1)
    if args.command=='workspace':
        from .revisions import create_workspace
        print(json.dumps(create_workspace(args.project,args.task,args.out)));return
    if args.command=='apply-edits':
        from .revisions import manual_edit
        print(json.dumps(manual_edit(args.workspace,read(args.operations),args.expected_revision)));return
    if args.command=='revise':
        from .revisions import revise
        result=revise(args.workspace,args.scope,args.entities,args.request,args.config,args.model,args.out);print(json.dumps(result,ensure_ascii=False));raise SystemExit(0 if result['status']=='self_checked' else 1)
    if args.command=='queue':
        from . import scheduler
        if args.action=='list':print(json.dumps(scheduler.list_jobs(args.db)));return
        if args.action=='enqueue':
            job=read(args.job);print(json.dumps({'id':scheduler.enqueue(args.db,job['kind'],job['args'])}));return
        if args.action=='cancel':print(json.dumps({'cancelled':scheduler.cancel(args.db,args.id)}));return
        scheduler.work(args.db,args.once);return
    if args.command=='normalize':write(args.out,normalize(args.input,args.references));print(json.dumps({'ok':True,'task':args.out}));return
    if args.command=='generate':
        from .harness import run
        result=run(args.input,args.references,args.config,args.model,args.out,args.case_id)
        raise SystemExit(0 if result.get('scene_success') else 1)
    if args.command=='probe':
        command=['node',str(ENGINE/'tools/probe.mjs'),'--task',args.task,'--out',args.out]
        if args.source:command+=['--source',args.source]
        if args.project:command+=['--project',args.project]
        if args.legacy:command+=['--legacy','true']
        raise SystemExit(subprocess.run(command).returncode)
