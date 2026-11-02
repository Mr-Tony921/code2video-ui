"""Behavioral lifecycle checks using disposable Node processes, never a deployed service."""
import importlib.util
import io
import json
import hashlib
import copy
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('lifecycle', ROOT / 'scripts/service.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)

class LifecycleTests(unittest.TestCase):
    def test_inherited_endpoint_overrides_cannot_redirect_service(self):
        with tempfile.TemporaryDirectory(prefix='cvw-codex-env-') as tmp:
            root=Path(tmp); (root/'runtime').mkdir()
            (root/'runtime/.secrets').write_text('CVW_INTERNAL_TOKEN=test-only\n')
            cfg={'deployment':{'gateway':{'host':'127.0.0.1','port':9996}},
                 'storage':{'root':str(root/'runtime'),'sessions_root':str(root/'runtime/sessions')},
                 'workers':[{'worker_id':'test-worker','bridge':{'host':'127.0.0.1','port':18082}}]}
            with patch.object(service,'ROOT',root), patch.dict(os.environ,{
                'CVW_GATEWAY_PORT':'9998','CVW_GATEWAY_HOST':'foreign','CVW_BRIDGE_HOST':'foreign','CVW_BRIDGE_PORT':'18080'}):
                env=service.environment(cfg,'/usr/local/bin/node','bridge','test-worker')
            self.assertEqual(env['CVW_GATEWAY_PORT'],'9996')
            self.assertEqual(env['CVW_GATEWAY_HOST'],'0.0.0.0')
            self.assertEqual(env['CVW_BRIDGE_HOST'],'127.0.0.1')
            self.assertEqual(env['CVW_BRIDGE_PORT'],'18082')

    def test_health_contracts(self):
        def response(body, status=200):
            value=io.BytesIO(body)
            value.status=status
            return value
        self.assertTrue(service.health_ready(response(b'ok'), 'web'))
        self.assertFalse(service.health_ready(response(b'error', 503), 'web'))
        self.assertTrue(service.health_ready(response(b'{"ok":true}'), 'gateway'))
        self.assertTrue(service.health_ready(response(b'{"registered":true,"worker_id":"w"}'), 'bridge', 'w'))
        self.assertFalse(service.health_ready(response(b'{"registered":false,"worker_id":"w"}'), 'bridge', 'w'))
        self.assertFalse(service.health_ready(response(b'{"registered":true,"worker_id":"other"}'), 'bridge', 'w'))

    def test_explicit_old_node_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix='cvw-codex-node-') as tmp:
            binary=Path(tmp)/'node'
            binary.write_text('#!/bin/sh\necho v16.20.2\n')
            binary.chmod(0o700)
            with patch.dict(os.environ, {'CVW_NODE_BIN':tmp}):
                with self.assertRaisesRegex(RuntimeError,'Node >=22'):
                    service.node_binary()

    def test_stop_only_exact_cwd_and_role(self):
        with tempfile.TemporaryDirectory(prefix='cvw-codex-lifecycle-') as tmp:
            own, unrelated = Path(tmp)/'own', Path(tmp)/'unrelated'
            own.mkdir(); unrelated.mkdir()
            for root in [own, unrelated]:
                for name in ['server.mjs','task.mjs']:
                    (root/name).write_text('setInterval(()=>{},1000);')
            processes = [subprocess.Popen([service.node_binary(), entry],cwd=cwd)
                         for cwd,entry in [(own,'server.mjs'),(unrelated,'server.mjs'),(own,'task.mjs')]]
            try:
                time.sleep(.5)
                selected=service.owned_processes(own,'server.mjs',False)
                self.assertEqual(list(selected),[processes[0].pid])
                self.assertTrue(selected[processes[0].pid].isdigit())
                service.stop(own,'server.mjs',False)
                self.assertEqual(processes[0].wait(timeout=5), -15)
                self.assertIsNone(processes[1].poll())
                self.assertIsNone(processes[2].poll())
            finally:
                for process in processes:
                    if process.poll() is None: process.terminate()
                    process.wait(timeout=5)

class PersistenceTests(unittest.TestCase):
    def test_supervisor_restarts_exited_service(self):
        with tempfile.TemporaryDirectory(prefix='cvw-codex-restart-') as tmp:
            root=Path(tmp); counter=root/'starts.json'
            script=root/'probe.mjs'
            script.write_text("import fs from 'node:fs';const f='starts.json';let n=0;try{n=JSON.parse(fs.readFileSync(f))}catch{};fs.writeFileSync(f,JSON.stringify(n+1));setTimeout(()=>process.exit(1),100);")
            def complete():
                return counter.exists() and json.loads(counter.read_text()) >= 2
            service.supervise_process([service.node_binary(),str(script)],root,dict(os.environ),root/'service.log',complete,.1)
            self.assertEqual(json.loads(counter.read_text()),2)
            self.assertEqual((root/'service.log').read_text().count('service exited 1'),2)

    def test_tmux_service_survives_controller_exit(self):
        with tempfile.TemporaryDirectory(prefix='cvw-codex-tmux-') as tmp:
            root=Path(tmp); script=root/'probe.mjs'
            script.write_text('setInterval(()=>{},1000);')
            socket='cvw-codex-test-'+str(os.getpid())
            controller="import subprocess,sys;subprocess.run(['tmux','-L',sys.argv[1],'new-session','-d','-s','probe','-c',sys.argv[2],sys.argv[3],sys.argv[4]],check=True)"
            try:
                subprocess.run([os.sys.executable,'-c',controller,socket,str(root),service.node_binary(),str(script)],check=True)
                time.sleep(.3)
                first=service.owned_processes(root,str(script),False)
                self.assertEqual(len(first),1)
                time.sleep(.3)
                self.assertEqual(service.owned_processes(root,str(script),False),first)
            finally:
                subprocess.run(['tmux','-L',socket,'kill-server'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                service.stop(root,str(script),False)


class HandoverGuardTests(unittest.TestCase):
    def test_dev_reuse_requires_matching_record_and_never_allows_production(self):
        spec=importlib.util.spec_from_file_location('handover_guard',ROOT/'scripts/guard-isolation.py')
        guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
        original=json.loads((ROOT/'config/backend.example.json').read_text())
        with tempfile.TemporaryDirectory(prefix='cvw-codex-guard-') as tmp:
            root=Path(tmp);(root/'config').mkdir();(root/'runtime/deployment').mkdir(parents=True)
            cfg=json.loads(json.dumps(original).replace(str(ROOT),str(root)))
            cfg['deployment']['web']['port']=8000;cfg['deployment']['gateway']['port']=9998
            for worker in cfg['workers']:worker['bridge']['port']=18080
            configs={}
            for base in ['/mnt/afs_if','/mnt/afs_toolcall']:
                p=Path(base)/'codevideo/workspace/code2video-dev/config/backend.json'
                if p.exists():configs[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
            def endpoints():
                return [[cfg['deployment'][k]['host'],cfg['deployment'][k]['port']] for k in ['web','gateway']]+[[w['bridge']['host'],w['bridge']['port']] for w in cfg['workers']]
            def save(): (root/'config/backend.json').write_text(json.dumps(cfg))
            marker=root/'runtime/deployment/dev-takeover.json'
            record={'scope':'retire-cc-dev-processes-only','source_configs':configs,'adopted_endpoints':endpoints()}
            save()
            with patch.object(guard,'ROOT',root),patch.object(guard,'EXPECTED',root):
                with self.assertRaises(FileNotFoundError):guard.check()
                marker.write_text(json.dumps(record));guard.check()
                damaged=copy.deepcopy(record);damaged['source_configs']={k:'wrong' for k in configs}
                marker.write_text(json.dumps(damaged))
                with self.assertRaisesRegex(AssertionError,'changed since handover'):guard.check()
                cfg['deployment']['gateway']['host']='10.120.7.0';save()
                record['adopted_endpoints']=endpoints();marker.write_text(json.dumps(record))
                with self.assertRaises(AssertionError):guard.check()


if __name__ == '__main__':
    unittest.main()
