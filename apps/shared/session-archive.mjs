import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function streamSessionArchive(root, subdir, sid, req, res) {
  if (!/^sess_[a-f0-9-]{36}$/.test(sid)) throw Object.assign(new Error('非法会话 ID'), { status: 400 });
  const dir = join(root, subdir, sid);
  await stat(dir);
  const child = spawn('python3', [fileURLToPath(new URL('./session-archive.py', import.meta.url)), dir],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let error = '';
  child.stderr.on('data', b => { error += b.toString().slice(0, 1000); });
  child.once('error', e => res.destroy(e));
  child.once('close', code => { if (code) res.destroy(new Error(error || '会话导出失败')); });
  const stop = () => { if (child.exitCode == null) child.kill('SIGTERM'); };
  res.once('close', stop);
  res.writeHead(200, {
    'content-type': 'application/zip', 'cache-control': 'no-store',
    'content-disposition': `attachment; filename="${sid}.zip"`,
  });
  child.stdout.pipe(res);
}
