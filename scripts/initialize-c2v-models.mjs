/** One-time dev migration. Credentials stay in the private model-settings store. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { saveModel, c2vModelSnapshot, enhancementConnection } from '../apps/shared/model-settings.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('python3', [join(root, 'scripts/guard-isolation.py')], { stdio: 'inherit' });
const raw = JSON.parse(readFileSync(join(root, 'config/backend.json'), 'utf8'));
if (raw.environment?.name !== 'dev') throw new Error('Only the isolated dev checkout may be initialized');
for (const line of readFileSync(join(root, 'runtime/.secrets'), 'utf8').split('\n')) {
  const i = line.indexOf('=');
  if (i > 0 && !line.startsWith('#')) process.env[line.slice(0, i)] ??= line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
}
if (!c2vModelSnapshot(raw)) {
  const profile = raw.experimental.models.find(p => p.id === 'tokenhub-deepseek-v41-flash');
  if (!profile) throw new Error('Configure the existing deepseek sfb profile before migration');
  const api_key = process.env[profile.api_key_env ?? ''] ?? profile.api_key;
  const view = saveModel(raw, 'c2v', 'migration', { kind: 'tokenhub', endpoint: profile.endpoint, model: profile.model, api_key });
  console.log('Initialized C2V:', view.model);
}
if (!enhancementConnection(raw)) {
  const am = raw.prompt_enhancement.aux_model;
  const endpoint = process.env[am.base_url_env ?? ''] ?? am.base_url;
  const model = process.env[am.model_env ?? ''] ?? am.model;
  const api_key = process.env[am.api_key_env ?? ''] ?? am.api_key;
  const view = saveModel(raw, 'enhancement', 'migration', { kind: /tokenhub\./.test(endpoint) ? 'tokenhub' : 'intranet', endpoint, model, api_key });
  console.log('Preserved enhancement:', view.model);
}
