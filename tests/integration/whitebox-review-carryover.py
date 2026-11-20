"""Regression: an unavailable recheck cannot erase the previous factual finding."""
import contextlib, importlib.util, io, json, tempfile, types, unittest
from pathlib import Path
from unittest.mock import patch

R = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('fixtures', R/'tests/integration/whitebox-provider-failures.py')
f = importlib.util.module_from_spec(spec); spec.loader.exec_module(f)
h = f.harness

class Carryover(unittest.TestCase):
    def scenario(self, failure):
        calls = []
        review = json.loads(f.REVIEW)
        review['shots'][0].update(core='missing', observed='Actor required by source is absent')
        class Provider:
            def __init__(self, *args): pass
            def clean(self, text): return str(text)
            def call(self, prompt, images, effort, json_mode):
                calls.append(prompt)
                if len(calls) == 1: answer = f.SOURCE
                elif len(calls) == 2: answer = json.dumps(review)
                elif len(calls) == 3:
                    answer = json.dumps({'replacements': [{'old': 'return {};', 'new': 'return {repaired:true};'}]})
                elif len(calls) == 4:
                    if failure == 'network': raise BrokenPipeError(32, 'Broken pipe')
                    if failure == 'invalid_json': answer = 'invalid review'
                    else: answer = f.REVIEW
                else: raise AssertionError('Recheck failure must not trigger another correction')
                return {'text': answer, 'seconds': 0}
        def compile(command, **kwargs):
            f.fixture_output(Path(command[command.index('--out')+1]))
            return types.SimpleNamespace(stdout='', stderr='', returncode=0)
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)/'run'
            with patch.object(h, 'Provider', Provider), patch.object(h, 'normalize', lambda *args:f.TASK.copy()), patch.object(h.subprocess, 'run', compile), contextlib.redirect_stdout(io.StringIO()):
                result = h.run('unused', [], {}, 'fixture', out)
            self.assertEqual(len(calls), 4)
            self.assertEqual(result['repairs'], 1)
            artifact = json.loads((out/'artifact.json').read_text())
            self.assertEqual(artifact['source'], 'candidate-01/source.js')
            self.assertIn('repaired:true', (out/artifact['source']).read_text())
            old = json.loads((out/'candidate-00/issues.json').read_text())
            self.assertTrue(old)
            issues = json.loads((out/'candidate-01/issues.json').read_text())
            if failure == 'success':
                self.assertEqual(result['status'], 'self_checked')
                self.assertEqual(issues, [])
            else:
                self.assertEqual(result['status'], 'renderable_with_issues')
                self.assertTrue(any(x.get('shot_id') == 's1' and x.get('recheck_status') == 'unavailable' for x in issues), issues)
                self.assertTrue(any(x.get('code') == ('model_call_unavailable' if failure == 'network' else 'review_contract') for x in issues))
                self.assertFalse((out/'repair-2-request.json').exists())
            self.assertFalse(any('recheck_status' in x for x in old), 'Original evidence must remain immutable')
    def test_network_keeps_unconfirmed_previous_finding(self): self.scenario('network')
    def test_invalid_review_keeps_unconfirmed_previous_finding(self): self.scenario('invalid_json')
    def test_success_clears_resolved_previous_finding(self): self.scenario('success')

if __name__ == '__main__': unittest.main()
