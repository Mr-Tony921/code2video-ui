import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * prompt 绝不能进 cc 的命令行。
 *
 * 事故（线上 job_dc9fd3ab「鹈鹕骑车」）：prompt 里含 "chrome-linux64/chrome"，
 * agent 清理残留浏览器时执行 pgrep -f "chrome-linux64" | kill -9，
 * 把【自己】匹配上了 → SIGKILL 自杀 → 前端报「制作引擎异常退出 code=null signal=SIGKILL」。
 * 根治：prompt 走 stdin，命令行里不出现它。
 */
import { readFileSync } from 'node:fs';
const R = TEST_REPO_ROOT;
const src = readFileSync(`${R}/apps/worker-bridge/src/job-runner.mjs`, 'utf8');
let pass = 0, fail = 0;
const t = (n, c, e = '') => { c ? (pass++, console.log('  ✅', n, e)) : (fail++, console.log('  ❌', n, e)); };

t('不再用 __PROMPT__ 占位符塞 argv', !src.includes('__PROMPT__'));
t('spawn 的 stdin 是管道（用于送 prompt）', /stdio:\s*\['pipe'/.test(src));
t('确实往 stdin 写了 prompt', /child\.stdin\.end\(fullPrompt/.test(src));
t('stdin 的 error 被接住（避免 EPIPE 崩溃）', /child\.stdin\.on\('error'/.test(src));

/**
 * 剥掉注释再断言。
 * ★ 必须剥：buildCommand 与 kill-leftovers 的注释里【故意】写着当年那条
 *   `pgrep -f "chrome-linux64"` 的事故说明 —— 那是文档，不是代码。
 *   不剥注释的话这些断言会把说明文字当成违规，红得毫无意义。
 */
// ★ 先去行注释再去块注释：反过来的话，注释里的 `/api/*` 这类字样会被当成
//   块注释开头、一路吞到下一个 */（route.ts 第 92 行就有一条）。
const strip = (x) => x.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 按花括号配平精确截出函数体。
 *
 * ★ 起点必须跳过【参数解构】的花括号。
 *   第一版从 indexOf('{') 开始数，结果参数里的 `({ jobWs, ... })` 就让计数归零，
 *   只截到了函数签名 —— 于是「argv 里没有 prompt / 没有 chrome」这些断言
 *   变成空洞通过（签名里当然没有）。这比红掉更危险：测试在骗人。
 *   所以从参数表闭合后的 `) {` 开始数。
 */
function fnBody(text, name) {
  const i = text.indexOf(`function ${name}`);
  if (i < 0) return '';
  // 跳过参数表：从函数名后的第一个 '(' 配平到它的 ')'
  let k = text.indexOf('(', i), pd = 0;
  for (; k < text.length; k++) {
    if (text[k] === '(') pd++;
    else if (text[k] === ')') { pd--; if (pd === 0) { k++; break; } }
  }
  const open = text.indexOf('{', k);
  if (open < 0) return '';
  let d = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '{') d++;
    else if (text[j] === '}') { d--; if (d === 0) return text.slice(open, j + 1); }
  }
  return text.slice(open);
}
const bc = strip(fnBody(src, 'buildCommand'));
// 自检：截出来的必须是真的函数体，不能是空壳 —— 否则下面的断言全是空洞通过
t('【自检】截出的 buildCommand 函数体非空且含 claudeArgs',
  bc.length > 400 && /claudeArgs/.test(bc), `${bc.length} 字符`);
t('buildCommand 的 -p 后面不再跟 prompt 文本', !/'-p',\s*'__PROMPT__'/.test(bc));

// ── 1.4.0：新增了 --session-id / --resume，argv 里多了东西，这几条必须守住 ──
t('argv 里没有 prompt 变量', !/\bfullPrompt\b|\bp\.prompt\b/.test(bc));
t('argv 里不拼工作区路径', !/jobWs\s*\+|\$\{jobWs\}|ws\.ws\s*\+/.test(bc));
t('argv 里不出现 chrome 字样（当年 pgrep -f 自杀的根因）', !/chrome/i.test(bc));

// --session-id / --resume 的值必须只能是 uuid，不能是任意字符串
t('resume/session-id 用的是 ccSessionId（由 uuid 推导）',
  /'--resume',\s*ccSessionId/.test(bc) && /'--session-id',\s*ccSessionId/.test(bc));
t('两者互斥，不会同时出现', /resume\s*\?\s*\['--resume'/.test(bc));
t('ccSessionId 为空时两个都不加', /ccSessionId\s*\?\s*\(/.test(bc));

// ccSessionIdFor 必须只接受合法 uuid —— 否则非法值会进 argv
const paths = readFileSync(`${R}/apps/worker-bridge/src/job-paths.mjs`, 'utf8');
t('ccSessionIdFor 用严格 uuid 正则校验',
  /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}/.test(paths));
t('形状不符返回 null（调用方据此不加参数）', /return m \? m\[1\]\.toLowerCase\(\) : null/.test(paths));

// resume 前必须先确认会话文件存在，否则 cc 启动即失败、整轮白丢
t('resume 前查会话文件是否存在', /export function findCcSessionFile/.test(paths));
// 断言【语义】而不是某个字面写法：resume 与否必须由「会话文件是否真的存在」决定。
// 第一版写死了 findCcSessionFile(ws, ccSessionId) 这个形态，
// 后来为兼容 1.3.x 老会话改了变量名就误报 —— 断言该盯行为，不该盯拼写。
{
  const jw = readFileSync(`${R}/apps/worker-bridge/src/job-workspace.mjs`, 'utf8');
  t('job-workspace 查过会话文件才决定续跑',
    /findCcSessionFile\(/.test(jw) && /isContinuation\s*=\s*!!ccFile/.test(jw));
  t('老会话迁移后会回退到它记录的 cc id（否则老对话记忆白搬）',
    /recordedCcSessionId/.test(jw) && /migratedCcId/.test(jw));
}

// 清残留：token 变了之后必须把 token 单独传给脚本，否则匹配不上、静默失效
const kl = readFileSync(`${R}/apps/worker-bridge/scripts/kill-leftovers.sh`, 'utf8');
t('kill-leftovers 接收 token 参数', /TOKEN=\$\{2:-\}/.test(kl));
t('kill-leftovers 按 token 精确匹配', /grep -qxF "CVW_JOB_TOKEN=\$TOKEN"/.test(kl));
// shell 的注释是 #，不能用 JS 的 strip
const stripSh = (x) => x.replace(/(^|[^$])#.*$/gm, '$1');
t('kill-leftovers 仍不按进程名/模式匹配', !/pgrep|pkill|killall/.test(stripSh(kl)));
t('runner 把 token 传给了清残留脚本', /script, st\.agentWs \?\? st\.jobDir, st\.jobToken/.test(src));

// skill 必须警告「不要按名字/模式杀进程」
for (const f of ['assets/skillsets/coding_to_video/code-video-core/SKILL.md',
                 'assets/skillsets/blockout_3d/code-video-core/SKILL.md']) {
  const s = readFileSync(`${R}/${f}`, 'utf8');
  t(`${f.split('/').slice(-2)[0]} 警告了按模式杀进程`, /Never kill by name or pattern/.test(s));
}
console.log(`\n══ 通过 ${pass}，失败 ${fail} ══`);
process.exit(fail ? 1 : 0);
