"""Audit preserves results/errors and separates semantic payload from measurements."""
import importlib.util, json, os, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('audit', ROOT / 'apps/worker-bridge/scripts/seko-audit.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

class Provider:
    count = 0
    def call(self, prompt, **kwargs):
        Provider.count += 1
        if prompt == 'fail':
            raise RuntimeError('fixture-private-key')
        return {'text': prompt}

with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as tmp:
    os.environ['CVW_SEKO_API_KEY'] = 'fixture-private-key'
    original = subprocess.run
    a = audit.RoundAudit(tmp, {'prompt':'原始用户指令', 'job_id':'fixture', 'model':'fixture', 'release':'0.1.12'}).install(Provider)
    try:
        assert Provider().call('reply') == {'text':'reply'}
        result = subprocess.run([sys.executable, '-c', 'print("fixture-private-key")'], capture_output=True, text=True)
        assert result.stdout.strip() == 'fixture-private-key'
        try:
            Provider().call('fail')
        except RuntimeError:
            pass
        else:
            raise AssertionError('exception swallowed')
        try:
            subprocess.run([sys.executable, '-c', 'import sys; print("failed"); sys.exit(3)'], capture_output=True, check=True)
        except subprocess.CalledProcessError:
            pass
        else:
            raise AssertionError('tool exception swallowed')
    finally:
        a.close(False)
    assert subprocess.run is original
    trace = [json.loads(x) for x in (Path(tmp)/'trace/events.jsonl').read_text().splitlines()]
    measurements = [json.loads(x) for x in (Path(tmp)/'diagnostics/operations.jsonl').read_text().splitlines()]
    assert [e['seq'] for e in trace] == list(range(1, len(trace)+1))
    assert len([e for e in trace if e['kind']=='model_reply']) == 1
    assert len([e for e in trace if e['kind']=='model_error']) == 1
    assert len([e for e in trace if e['kind']=='tool_result']) == 2
    assert all('seconds' not in e and 'started_at' not in e for e in trace)
    assert len(measurements) == 5 and all(e['seconds'] >= 0 for e in measurements)
    assert 'fixture-private-key' not in '\n'.join(p.read_text() for p in Path(tmp).rglob('*') if p.is_file())
print('seko audit passed')
