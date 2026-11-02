"""Behavioral lifecycle checks using disposable Node processes, never a deployed service."""
import importlib.util
import io
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

if __name__ == '__main__':
    unittest.main()
