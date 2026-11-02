import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 侧栏显示的会话 ID 必须是【当前在看的那个对话】的。
 *
 * 用户报障时靠这个 ID 让我们查轨迹。原来一直显示 boot.session.id
 * （只有新建对话才变），用户切到别的对话后复制到的还是旧 ID，
 * 报上来的 ID 和他描述的现象对不上，等于无法定位。
 */
import { readFileSync } from 'node:fs';
const R=TEST_REPO_ROOT;
const sb=readFileSync(`${R}/apps/web/components/Sidebar.tsx`,'utf8');
const ws=readFileSync(`${R}/apps/web/app/_workspace.tsx`,'utf8');
let pass=0,fail=0;
const t=(n,c,e='')=>{c?(pass++,console.log('  ✅',n,e)):(fail++,console.log('  ❌',n,e));};

t('Sidebar 接收 focusedSessionId', /focusedSessionId\?: string \| null;/.test(sb));
t('★ 显示用 focusedSessionId（不是写死 session.id）',
  /\{focusedSessionId \?\? session\.id\}/.test(sb));
t('★ 复制也用 focusedSessionId', /copyText\(focusedSessionId \?\? session\.id\)/.test(sb));
t('跨会话时有明确标注（避免 ID 与 mode 错配造成困惑）',
  /focusedSessionId !== session\.id[\s\S]{0,160}正在查看另一个对话/.test(sb));
t('_workspace 传入当前聚焦任务的 session_id',
  /focusedSessionId=\{job\?\.session_id \?\? boot\.session\?\.id \?\? null\}/.test(ws));

// Job 必须带 session_id，否则上面取不到
const ty=readFileSync(`${R}/apps/web/lib/types.ts`,'utf8');
t('Job 类型里有 session_id', /session_id: string;/.test(ty));
const srv=readFileSync(`${R}/apps/gateway/src/server.mjs`,'utf8');
t('publicJob 下发 session_id', /id: j\.id, session_id: j\.session_id/.test(srv));

console.log(`\n══ 通过 ${pass}，失败 ${fail} ══`);
process.exit(fail?1:0);
