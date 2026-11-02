import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 上下文长度与压缩率必须由配置决定，且真的传到 cc。
 *
 * 两个坑：
 *  ① auto_detect_context 开启会用 /v1/models 覆盖配置值 ⇒ 实际值不可控
 *  ② ${model.xxx} 占位符是白名单式的，漏登记会被替换成空串并被丢掉 ——
 *    配置看着改了却静默无效，没有任何报错
 */
import { readFileSync } from 'node:fs';
const R=TEST_REPO_ROOT;
const cfg=JSON.parse(readFileSync(`${R}/config/backend.json`,'utf8'));
const jr=readFileSync(`${R}/apps/worker-bridge/src/job-runner.mjs`,'utf8');
const cm=readFileSync(`${R}/apps/worker-bridge/src/config.mjs`,'utf8');
let pass=0,fail=0;
const t=(n,c,e='')=>{c?(pass++,console.log('  ✅',n,e)):(fail++,console.log('  ❌',n,e));};

const m=cfg.model, env=cfg.claude_cli.env;
t('上下文固定 512K', m.max_context_tokens===524288, String(m.max_context_tokens));
t('★ 自动探测已关闭（否则会覆盖配置值）', m.auto_detect_context===false, String(m.auto_detect_context));
t('压缩率可配置且为 80', m.autocompact_pct===80, String(m.autocompact_pct));
t('env 用占位符引用上下文（不写死）',
  env.CLAUDE_CODE_MAX_CONTEXT_TOKENS==='${model.max_context_tokens}');
t('env 用占位符引用压缩率（不写死）',
  env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE==='${model.autocompact_pct}');
t('★ 占位符已在白名单登记（漏了会静默失效）',
  /'model\.autocompact_pct':\s*config\.model\.autocompactPct/.test(jr));
t('config.mjs 读出 autocompactPct', /autocompactPct:\s*Number\(/.test(cm));
t('两种 mode 共用同一套 env（白模也生效）',
  !/mode\s*===\s*'blockout_3d'[\s\S]{0,200}resolveClaudeEnv/.test(jr));

console.log(`\n══ 通过 ${pass}，失败 ${fail} ══`);
process.exit(fail?1:0);
