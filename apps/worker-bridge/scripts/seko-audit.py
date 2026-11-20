"""Append-only semantic trace with separate diagnostic measurements for one round."""
import hashlib, json, os, subprocess, time
from pathlib import Path


class RoundAudit:
    def __init__(self, work, args):
        self.work = Path(work)
        self.trace = self.work / 'trace'
        self.diagnostics = self.work / 'diagnostics'
        self.trace.mkdir(exist_ok=True)
        self.diagnostics.mkdir(exist_ok=True)
        self.sequence = 0
        self.tool_sequence = 0
        self.secret = os.environ.get('CVW_SEKO_API_KEY', '')
        self.started = time.monotonic()
        self.event('user', prompt_file='../prompt.md', prompt_sha256=hashlib.sha256(args['prompt'].encode()).hexdigest(),
                   job_id=args['job_id'], model=args['model'], release=args['release'])

    def clean(self, value):
        text = value.decode(errors='replace') if isinstance(value, bytes) else str(value)
        return text.replace(self.secret, '[REDACTED]') if self.secret else text

    def append(self, path, data):
        with path.open('a', encoding='utf-8') as f:
            f.write(self.clean(json.dumps(data, ensure_ascii=False, default=str)) + '\n')
            f.flush()
            os.fsync(f.fileno())

    def event(self, kind, **data):
        self.sequence += 1
        self.append(self.trace / 'events.jsonl', {'seq': self.sequence, 'kind': kind, **data})

    def measure(self, operation_id, began, started_at, **data):
        self.append(self.diagnostics / 'operations.jsonl', {
            'operation_id': operation_id, 'started_at': started_at,
            'seconds': time.monotonic() - began, **data})

    def install(self, provider):
        self.provider = provider
        self.original_call = provider.call
        self.original_run = subprocess.run
        audit = self

        def call(instance, *args, **kwargs):
            number = provider.count + 1
            operation_id = 'model-%04d' % number
            capture = 'capture/%04d' % number
            stage = getattr(instance, 'current_stage', 'intake')
            audit.event('model_call', operation_id=operation_id, stage=stage,
                        request_file=capture + '/request.json', media_file=capture + '/metadata.json')
            began, at = time.monotonic(), time.time()
            try:
                result = audit.original_call(instance, *args, **kwargs)
                audit.event('model_reply', operation_id=operation_id, response_file=capture + '/response.json')
                audit.measure(operation_id, began, at, stage=stage, complete=True,
                              transport_file=capture + '/transport.json')
                return result
            except BaseException as e:
                audit.event('model_error', operation_id=operation_id, error=audit.clean(e),
                            response_file=capture + '/response.raw')
                audit.measure(operation_id, began, at, stage=stage, complete=False,
                              transport_file=capture + '/transport.json')
                raise

        def run(*args, **kwargs):
            audit.tool_sequence += 1
            operation_id = 'tool-%04d' % audit.tool_sequence
            folder = audit.trace / operation_id
            folder.mkdir()
            command = args[0] if args else kwargs.get('args')
            audit.event('tool_call', operation_id=operation_id, argv=command,
                        cwd=str(kwargs.get('cwd', Path.cwd())), shell=kwargs.get('shell', False))
            began, at = time.monotonic(), time.time()
            def record(output, error, returncode, failure=None):
                for name, value in [('stdout.txt', output), ('stderr.txt', error)]:
                    (folder / name).write_text(audit.clean(value or ''), encoding='utf-8')
                audit.event('tool_result', operation_id=operation_id, returncode=returncode,
                            stdout_file=str((folder / 'stdout.txt').relative_to(audit.work)),
                            stderr_file=str((folder / 'stderr.txt').relative_to(audit.work)), error=failure)
                audit.measure(operation_id, began, at, returncode=returncode, complete=failure is None)
            try:
                result = audit.original_run(*args, **kwargs)
                record(result.stdout, result.stderr, result.returncode)
                return result
            except BaseException as e:
                record(getattr(e, 'stdout', None), getattr(e, 'stderr', None),
                       getattr(e, 'returncode', None), audit.clean(e))
                raise
        provider.call = call
        subprocess.run = run
        return self

    def close(self, complete):
        self.provider.call = self.original_call
        subprocess.run = self.original_run
        self.event('round_end', complete=complete, result_file='result.json')
        self.measure('round', self.started, None, complete=complete)
