#!/usr/bin/env node
/** Dev-only integration smoke, ordinary accounts; --continue never submits a second task. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('python3', [join(root, 'scripts/guard-isolation.py')]);
const cfg = JSON.parse(await readFile(join(root, 'config/backend.json'))); assert.equal(cfg.environment.name, 'dev');
const out = join(root, 'runtime/validation/anatomy-2026-11-04'); await mkdir(out, { recursive: true });
const base = cfg.deployment.web.public_url, continuing = process.argv.includes('--continue');
const report = continuing ? JSON.parse(await readFile(join(out, 'live.json'))) : { started_at: new Date().toISOString(), base, checks: [] };
const save = () => writeFile(join(out, 'live.json'), JSON.stringify(report, null, 2) + '\n');
let cookie, peerCookie;
async function req(path, body, expected = 200, peer = false) {
  const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: (peer ? peerCookie : cookie) ?? '', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const d = await r.json(); assert.equal(r.status, expected, path + ': ' + JSON.stringify(d).slice(0, 400)); return { d, headers: r.headers };
}
async function login(name) { return (await req('/api/auth/login', JSON.parse(await readFile(join(root, 'runtime', name))))).headers.get('set-cookie').split(';')[0]; }
// The tiny renderer exercises actual Anatomy geometry and platform frame capture, not a long quality experiment.
const renderer = `import {mkdir,writeFile,readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {slabOf,cylinder,solidSvg,ISO_CSS} from '../.claude/skills/anatomy/kit/iso-kit.mjs';
const require=createRequire(import.meta.url),puppeteer=require('puppeteer');
if (!process.env.CHROME_PATH || process.env.CHROME_PATH!==process.env.CHROME_BIN) throw Error('Chrome aliases differ');
const assets=await readdir('assets'); if(!assets.length) throw Error('Missing reference');
await mkdir('work/frames',{recursive:true}); await mkdir('output',{recursive:true});
const p={origin:[160,112],scale:4},base=solidSvg(slabOf({x:-15,y:-10,w:30,d:20,r:2},0,3,p));
const stem=solidSvg(cylinder(0,0,4,3,7,p)),cap=solidSvg(cylinder(0,0,7,10,3,p));
const html='<!doctype html><style>'+ISO_CSS+'body{margin:0;background:#10151c}svg{display:block}</style><svg width="320" height="180" viewBox="0 0 320 180">'+base+stem+'<g id="cap">'+cap+'</g></svg><script>window.DUR=2;window.seek=t=>{document.getElementById("cap").setAttribute("transform","translate(0 "+(Math.sin(t*Math.PI)*5)+")")};window.seek(0);window.READY=true;</script>';
await writeFile('src/anatomy-smoke.html',html);
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
try{const page=await browser.newPage();await page.setViewport({width:320,height:180,deviceScaleFactor:1});await page.goto(pathToFileURL(process.cwd()+'/src/anatomy-smoke.html').href);await page.waitForFunction(()=>window.READY===true);for(let i=0;i<20;i++){await page.evaluate(t=>window.seek(t),i/10);await page.screenshot({path:'work/frames/'+String(i).padStart(3,'0')+'.png'});}}finally{await browser.close();}
execFileSync('ffmpeg',['-y','-framerate','10','-i','work/frames/%03d.png','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','output/final.mp4'],{stdio:'ignore'});
await writeFile('work/anatomy-smoke.json',JSON.stringify({anatomy_imported:true,chrome_aliases_equal:true,assets,frames:20,duration:2}));
`;
try {
  cookie = await login('test-account.json'); peerCookie = await login('test-peer-account.json');
  const me = (await req('/api/auth/me')).d.user; assert.equal(me.role, 'user'); assert.equal(me.can_use_experimental, true);
  await req('/api/experimental/skills', undefined, 403, true);
  const catalog = (await req('/api/experimental/skills')).d.skills, anatomy = catalog.find(s => s.id === 'anatomy'); assert.ok(anatomy);
  assert.equal(anatomy.version, '1482e8469b0a9e0d8cc18ea2740a01423d29ae80'); assert.equal(anatomy.archive, undefined);
  report.checks.push('dev catalog visible to authorized ordinary test only, with pinned version and no filesystem paths');
  if (!continuing) {
    const models = (await req('/api/experimental/models')).d.models;
    const model = models.find(m => m.profile_id === (process.env.CVW_TEST_MODEL_ID ?? 'intranet-default')); assert.ok(model);
    const session = (await req('/api/sessions', { mode: 'experimental', model_id: model.profile_id, builtin_skills: 'coding_to_video' }, 201)).d.session;
    report.session = session.id; await save();
    const ref = await readFile(process.env.CVW_ANATOMY_REFERENCE ?? '/mnt/afs_toolcall/codevideo/workspace/code2video-dev-codex/research/anatomy-2026-11-04/reference-images/button-lamp-reference.png');
    const form = new FormData(); form.append('file', new Blob([ref], { type: 'image/png' }), 'anatomy-reference.png');
    const upload = await fetch(base + `/api/sessions/${session.id}/references`, { method: 'POST', headers: { cookie }, body: form, signal: AbortSignal.timeout(30000) });
    assert.equal(upload.status, 201); const uploaded = await upload.json(); report.reference = uploaded.item.stored_name; await save();
    await req(`/api/sessions/${session.id}/jobs`, { prompt: 'conflict validation only', idempotency_key: randomUUID(),
      experimental_skills: { configured: [anatomy], text: '---\nname: anatomy\n---\nDuplicate.' } }, 400);
    report.checks.push('same-name pasted skill rejected before generation');
    const prompt = `This is a tiny integration smoke, not a full Anatomy Figure. First invoke the Skill tool for code-video-core and anatomy. Read the reference image at assets/${report.reference}; use it only to confirm button shape, never paste it into the video. Then write the following exact renderer to src/anatomy-smoke.mjs and run node src/anatomy-smoke.mjs. It uses the real Anatomy kit, deterministic seek/READY/DUR and local Chromium to render 20 small frames. Do not expand this smoke into a large composition, install dependencies, browse the web or modify any skill source. Deliver output/final.mp4 and finish.\n\n${renderer}`;
    const result = (await req(`/api/sessions/${session.id}/jobs`, { prompt, enhance: false, idempotency_key: randomUUID(), max_runtime_seconds: 900,
      experimental_skills: { builtin: 'coding_to_video', configured: [anatomy] } }, 202)).d;
    report.job = result.job.id; await save();
  }
  let final, previous;
  for (let i = 0; i < 450; i++) {
    const j = (await req(`/api/jobs/${report.job}`)).d.job;
    if (j.status !== previous) { console.log(j.id, j.status); previous = j.status; }
    if (['COMPLETED','FAILED','CANCELLED','OUT_OF_SCOPE'].includes(j.status)) { final = j; break; }
    await req(`/api/sessions/${report.session}/presence`, { tab_id: 'anatomy-smoke' });
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.equal(final?.status, 'COMPLETED', JSON.stringify(final?.failure));
  const dir = join(cfg.storage.sessions_root, cfg.storage.sessions_subdir, report.session);
  const meta = JSON.parse(await readFile(join(dir, 'rounds', report.job, '_meta.json')));
  assert.ok(meta.skills.includes('anatomy') && meta.skills.includes('code-video-core')); assert.equal(meta.experimental_skills.configured[0].version, anatomy.version);
  const smoke = JSON.parse(await readFile(join(dir, 'workspace/work/anatomy-smoke.json'))); assert.ok(smoke.anatomy_imported && smoke.chrome_aliases_equal); assert.ok(smoke.assets.includes(report.reference));
  const mounted = join(dir,'workspace/.claude/skills/anatomy/SKILL.md'), pinned = join(dir,'skill-revisions',meta.experimental_skills.revision,'skills/anatomy/SKILL.md');
  assert.deepEqual(await readFile(mounted),await readFile(pinned));
  const calls = (await readFile(join(dir, 'workspace/claude.jsonl'),'utf8')).split('\n').flatMap(line => {
    try { const row=JSON.parse(line); return row.type === 'assistant' ? (row.message?.content ?? []).filter(c=>c.type==='tool_use'&&c.name==='Skill').map(c=>c.input?.skill) : []; } catch { return []; }
  });
  assert.ok(calls.includes('anatomy') && calls.includes('code-video-core'), JSON.stringify(calls)); report.skill_calls = calls;
  report.checks.push('real Skill invocations, core plus Anatomy mounted, reference found, Anatomy kit imported, Chrome aliases aligned, deterministic frame renderer completed');
  const video = await fetch(base + final.result_asset.playback_url, { headers: {cookie,range:'bytes=0-1023'},signal:AbortSignal.timeout(30000) });
  assert.equal(video.status,206);assert.equal((await video.arrayBuffer()).byteLength,1024);
  const archive = await fetch(base + `/api/sessions/${report.session}/archive`, {headers:{cookie},signal:AbortSignal.timeout(120000)}); assert.equal(archive.status,200);
  const bytes=Buffer.from(await archive.arrayBuffer());
  const summary=JSON.parse(execFileSync('python3',['-c',"import io,json,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); names=z.namelist(); print(json.dumps({'files':len(names),'configured_package':any('/configured-packages/anatomy/uploaded.zip' in n for n in names),'native_session':any('/projects/' in n and n.endswith('.jsonl') for n in names),'round_meta':any(n.endswith('/_meta.json') for n in names)}))"],{input:bytes,encoding:'utf8'}));
  assert.ok(summary.configured_package&&summary.native_session&&summary.round_meta);report.archive=summary;
  report.checks.push('authenticated Range playback and full export retain configured package, round metadata and native session');
  report.passed=true;delete report.error;report.checks=[...new Set(report.checks)];report.finished_at=new Date().toISOString();await save();console.log('PASS Anatomy real integration smoke');
} catch(e) { report.passed=false;report.error=e.message;await save();throw e; }
