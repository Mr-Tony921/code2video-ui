/** Per-process test storage; importing a runtime module must never use real user data. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const TEST_REPO_ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
export const TEST_TMP_ROOT = mkdtempSync(join(tmpdir(), 'cvw-codex-test-'));
process.env.CVW_REPO_ROOT = TEST_REPO_ROOT;
process.env.CVW_STORAGE_ROOT = join(TEST_TMP_ROOT, 'store');
process.env.CVW_SESSIONS_ROOT = join(TEST_TMP_ROOT, 'sessions');
process.env.CVW_WORKER_ID ??= JSON.parse(readFileSync(join(TEST_REPO_ROOT, 'config/backend.json')))
  .workers.find(w => w.enabled !== false).worker_id;
process.on('exit', () => rmSync(TEST_TMP_ROOT, {recursive:true, force:true}));
