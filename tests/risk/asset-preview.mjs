import { TEST_REPO_ROOT, TEST_TMP_ROOT } from '../fixtures.mjs';
/**
 * 网页播放降采样预览片的回归（1.4.4）。
 *
 * 需求：网页里播的视频要降采样（给**绝对上限**，不按百分比一刀切），
 * 保证在受限网络下能快速起播；「下载原片」是单独的显式交互；
 * 视频插件自带的下载按钮拿到的仍是压缩片。
 *
 * ★ 本测试重点守三条**用户点名的风险**：
 *
 * 1. **多轮续跑不能串片。** agent 的工作区 `sessions/<sid>/workspace/` 各轮共用，
 *    `output/final.mp4` 第 2 轮就被覆盖；能按轮回放靠的是每轮钉住的
 *    `rounds/<jid>/final.mp4`。所以预览片必须按 **job_id** 落在
 *    **会话目录之外**（`runtime/gateway/asset-previews/`）——
 *    落在原片旁边或从工作区路径派生，都会让第 2 轮覆盖第 1 轮。
 *    实测线上 130 个产物路径、被多个 job 共用的 0 个，job_id 本身就是每轮唯一。
 * 2. **不能影响视频生成逻辑。** 只读原片、只写 Gateway 自己的目录，
 *    不碰会话目录、不碰 agent 工作区，完成钩子必须 fire-and-forget。
 * 3. **白模同理。** 白模 previs 本来就是低码率（实测 640x360 / 59kbps），
 *    同时按码率与分辨率触发就意味着它**一个字节都不会被动**，不会白掉一次画质。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const R = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let pass = 0, fail = 0;
const t = (n, c, e = '') => { c ? (pass++, console.log('  ✅', n, e)) : (fail++, console.log('  ❌', n, e)); };
// ★ 顺序很重要：**先去整行注释，再去块注释**。
//   反过来的话，注释里出现 `/api/*` 这种字样会被当成块注释开头，
//   一路吞到下一个 */ —— route.ts 第 92 行就有一条这样的整行注释，
//   导致它后面约 20 行（含 headers 构造与 accept-encoding 设置）在断言里凭空消失。
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

process.env.CVW_REPO_ROOT ??= R;
process.env.CVW_INTERNAL_TOKEN ??= 'x'.repeat(32);
process.env.CVW_MODEL_API_KEY ??= 'sk-test';

const cfg = JSON.parse(readFileSync(join(R, 'config/backend.json'), 'utf8'));

/* ───── 1. 上限是绝对值且可配置 ───── */
t('config 里有 preview 段', !!cfg.preview);
t('max_height 是绝对上限', Number(cfg.preview?.max_height) > 0, `=${cfg.preview?.max_height}`);
t('max_kbps 是绝对上限', Number(cfg.preview?.max_kbps) > 0, `=${cfg.preview?.max_kbps}`);
t('生成有超时上限（不能无限等）', Number(cfg.preview?.generate_timeout_ms) > 0);

/* ───── 2. ★ 落点必须在会话目录之外、按 job_id ───── */
const { previewPathFor, previewIsFresh, previewCaps, previewUrlFor } = await import(join(R, 'apps/gateway/src/asset-preview.mjs'));
const p1 = previewPathFor('job_aaa');
const p2 = previewPathFor('job_bbb');
t('★ 预览片按 job_id 命名（多轮各自独立）', p1 !== p2 && p1.includes('job_aaa'));
t('★ 预览片不落在会话目录里', !/\/sessions?\//.test(p1), p1);
// 注意不能简单匹配 "workspace/" —— 仓库根本身就在 .../codevideo/workspace/ 下面。
// 要守的是【agent 的工作区】，即 sessions/<sid>/workspace/。
t('★ 预览片不落在 agent 工作区里（sessions/<sid>/workspace/）',
  !/sessions[/\\][^/\\]+[/\\]workspace/.test(p1), p1);
t('预览片在 Gateway 自己的目录下', /gateway[/\\]asset-previews/.test(p1), p1);

/* ───── 3. 陈旧判定（纯函数，直接测行为）───── */
const fp = { source_size: 100, source_mtime_ms: 5 };
// 指纹里含【当前上限】—— 配置改了也要重做，所以 fixture 必须带上当前的 caps
const caps = previewCaps();
const rec = { ...fp, caps, mode: 'none' };
t('指纹一致 ⇒ 新鲜', previewIsFresh(rec, fp) === true);
t('★ 原片大小变了 ⇒ 判定过期（否则会把旧内容当本轮成片播）',
  previewIsFresh({ ...rec, source_size: 101 }, fp) === false);
t('★ 原片 mtime 变了 ⇒ 判定过期', previewIsFresh({ ...rec, source_mtime_ms: 6 }, fp) === false);
t('★ 上限改了 ⇒ 判定过期（否则调 config.preview 等于没用）',
  previewIsFresh({ ...rec, caps: '123x45' }, fp) === false);
t('★ 旧记录没有 caps 字段 ⇒ 判定过期（本版之前写入的记录要重做）',
  previewIsFresh({ ...fp, mode: 'none' }, fp) === false);
t('没有记录 ⇒ 不新鲜', previewIsFresh(null, fp) === false);
t('读不到原片指纹 ⇒ 不新鲜（不能瞎用旧预览片）', previewIsFresh(rec, null) === false);

/* ───── 4. 同时按码率与分辨率触发（白模与小片子不受影响）───── */
const ap = strip(readFileSync(join(R, 'apps/gateway/src/asset-preview.mjs'), 'utf8'));
t('分辨率超限也触发重编码', /meta\.height[^;]+> maxHeight/.test(ap));
t('480P 是当前预览上限', cfg.preview.max_height === 480);
t('旧缓存策略失效', !previewIsFresh({ ...fp, caps: '480x600', mode: 'none' }, fp));
t('播放 URL 含预览策略版本，避开旧浏览器缓存', previewUrlFor('job_aaa').includes('v=v2%3A480x'));
t('达标时返回 mode:none 且不产生第二份文件', /mode:\s*'none',\s*path:\s*null/.test(ap));
t('缩放只缩不放', /min\(\$\{maxHeight\},ih\)/.test(ap));
t('产物先校验再 rename（别让半截文件被播到）',
  /probeVideo\(tmp\)[\s\S]{0,300}await rename\(tmp, dst\)/.test(ap));
t('失败清临时文件并返回 null（退化成播原片）',
  /catch[\s\S]{0,200}unlink\(tmp\)[\s\S]{0,200}return null/.test(ap));
t('同一 job 并发只生成一次', /inflight/.test(ap));
t('达标时清掉旧预览片', /unlink\(previewPathFor\(jobId\)\)/.test(ap));

/* ───── 5. 路由分工：播放=预览片，下载=原片 ───── */
const gw = strip(readFileSync(join(R, 'apps/gateway/src/server.mjs'), 'utf8'));
t("★ playback 路由用 variant:'preview'",
  /playback':[\s\S]{0,200}variant:\s*'preview'/.test(gw));
t("★ download 路由用 variant:'original'（下载必须给原片）",
  /download':[\s\S]{0,200}variant:\s*'original'/.test(gw));
t('下发用 servePath（不是写死 storage_path）',
  /createReadStream\(servePath/.test(gw) && !/createReadStream\(a\.storage_path/.test(gw));
t('只有 preview 分支才会改 servePath',
  /variant === 'preview'/.test(gw));

/* ───── 6. ★ 不影响生成逻辑：完成钩子必须 fire-and-forget ───── */
t('★ 完成钩子是 void 异步（绝不阻塞 /complete）',
  /void \(async \(\) => \{[\s\S]{0,400}ensurePreview\(id, asset\.storage_path/.test(gw));
t('★ 钩子内部有 catch（失败不影响任务完成）',
  /ensurePreview\(id, asset\.storage_path[\s\S]{0,400}catch[\s\S]{0,120}不影响任务/.test(gw));
t('钩子在状态迁移成功之后才跑', gw.indexOf("无法迁移到 COMPLETED") < gw.indexOf('void (async () =>'));

/* ───── 7. 前端：必须说明播的不是原片，且下载标注慢 ───── */
const jc = readFileSync(join(R, 'apps/web/components/JobCard.tsx'), 'utf8');
t('★ 下载按钮明确写「原片」', /下载原片/.test(jc));
t('★ 标注受网络策略限制、速度慢、请耐心等待',
  /速度较慢/.test(jc) && /耐心等待/.test(jc));
t('★ 告知网页播放已降采样（否则用户以为成片就这个画质）', /最高 480P 预览/.test(jc));
t('mode:none 时不乱说"已压缩"', /preview\?\.mode === 'reencode'/.test(jc));
t('video 的 src 仍是 playback_url（插件下载因此拿到压缩片）',
  /<video[\s\S]{0,450}src=\{withBase\(job\.result_asset\.playback_url\)\}/.test(jc));
const ty = readFileSync(join(R, 'apps/web/lib/types.ts'), 'utf8');
t('Asset 类型带 preview 字段', /preview:\s*\{[\s\S]{0,200}mode:\s*'reencode'\s*\|\s*'none'/.test(ty));

console.log(`\n  预览片降采样: 通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
