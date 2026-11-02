import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 产物只在【对话真正结束】后才可见 —— 用户的硬要求。
 *
 * 背景：任务跑着时工作区里就可能已经有一版 mp4，agent 后面还会继续改。
 * 提前放出去用户会当成成品（线上 sess_09d06d8f）。
 * 出口有四个，少堵一个就漏：
 *   ① publicJob.result_asset   → 对话区/历史/active-context 都走它
 *   ② /api/admin/gallery       → 管理后台作品集
 *   ③ GET /api/assets/:id      → 产物元数据
 *   ④ serveAsset()             → 真正吐视频流的闸门（猜到 URL 也拉不到）
 */
import { readFileSync } from 'node:fs';
const R=TEST_REPO_ROOT;
const s=readFileSync(`${R}/apps/gateway/src/server.mjs`,'utf8');
let pass=0,fail=0;
const t=(n,c,e='')=>{c?(pass++,console.log('  ✅',n,e)):(fail++,console.log('  ❌',n,e));};

t('① publicJob 只在终态下发 result_asset',
  /result_asset:\s*\(j\.result_asset && store\.isTerminal\(j\.status\)\)/.test(s));
t('② gallery 的 playback_url 判终态',
  /playback_url:\s*\(store\.isTerminal\(j\.status\) && j\.result_asset\?\.state === 'READY'\)/.test(s));
t('③ /api/assets/:id 元数据判终态',
  /同 serveAsset：未结束就不暴露产物元数据与链接[\s\S]{0,120}isTerminal\(j\.status\)/.test(s));
t('④ serveAsset 吐流前判终态（最后闸门）',
  /任务尚未结束，成品还在制作中[\s\S]{0,80}state !== 'READY'/.test(s)
  || /if \(!store\.isTerminal\(j\.status\)\)[\s\S]{0,160}ASSET_NOT_READY[\s\S]{0,200}a\.state !== 'READY'/.test(s));

// 前端也不该在非终态渲染播放器
const jc=readFileSync(`${R}/apps/web/components/JobCard.tsx`,'utf8');
t('JobCard 只在 COMPLETED 且 playable 时渲染 video',
  /job\.status === 'COMPLETED' && job\.result_asset\?\.playable/.test(jc));

console.log(`\n══ 通过 ${pass}，失败 ${fail} ══`);
process.exit(fail?1:0);
