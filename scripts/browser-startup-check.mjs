/** Live dev browser regression: startup, explicit history, refresh, pinned skill. */
import puppeteer from '../runtime/previs-deps/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const cfg = JSON.parse(await readFile(join(root, 'config/backend.json'), 'utf8'));
assert.equal(cfg.environment.name, 'dev');
const base = 'http://' + cfg.deployment.web.host + ':' + cfg.deployment.web.port;
const baseline = process.argv.includes('--baseline');
const out = resolve(root, process.env.CVW_BROWSER_CHECK_OUT ?? `runtime/validation/browser-startup-${Date.now()}`);
assert(out.startsWith(resolve(root, 'runtime') + sep), 'browser evidence must stay inside runtime');
await mkdir(out, {recursive:true});
const credentials = JSON.parse(await readFile(join(root, 'runtime/test-account.json'), 'utf8'));
const browser = await puppeteer.launch({executablePath:cfg.runtime_binaries.chrome_bin_host,headless:true,
 args:['--no-sandbox','--disable-dev-shm-usage'],userDataDir:join(out,'profile')});
const report={baseline,base,checks:[],phases:[],errors:[]};
let phase, held=[],holdStatus=false,holdHistory=false,holdExamples=false,failHistory=false;
try {
 const context=await browser.createBrowserContext(),page=await context.newPage();
 await page.setViewport({width:1440,height:1000});
 page.on('pageerror',e=>report.errors.push(e.message));
 page.on('request',r=>{
  const u=new URL(r.url());if(phase&&u.pathname.startsWith('/api/'))
   phase.requests.push({method:r.method(),path:u.pathname+u.search});
 });
 page.on('response',async r=>{
  const target=phase,u=new URL(r.url());
  if(!target||!u.pathname.startsWith('/api/')||u.pathname.includes('/events')||u.pathname.includes('/playback'))return;
  try {const bytes=(await r.buffer()).length;target.responses.push({path:u.pathname+u.search,status:r.status(),bytes});}catch{}
 });
 await page.setRequestInterception(true);
 page.on('request',r=>{
  const path=new URL(r.url()).pathname;
  if(failHistory&&path==='/api/me/history'){
   failHistory=false;void r.respond({status:503,contentType:'application/json',body:JSON.stringify({error:'test history unavailable'})});
  } else if((holdStatus&&path==='/api/me/active-context')||(holdHistory&&path==='/api/me/history')||(holdExamples&&path==='/api/examples'))held.push(r);
  else void r.continue();
 });
 const start=name=>{phase={name,requests:[],responses:[]};report.phases.push(phase);return performance.now();};
 const ready=async start=>{
  await page.waitForSelector('textarea',{timeout:30000});
  phase.workspace_ms=Math.round(performance.now()-start);
  await page.waitForNetworkIdle({idleTime:200,timeout:10000}).catch(()=>{});
 };
 const assertLight=p=>{
  const paths=p.requests.map(r=>r.path);
  assert(!paths.some(p=>p==='/api/me/active-context'),'full history must not load at startup');
  assert(!paths.some(p=>/^\/api\/sessions\/[^/]+$/.test(p)),'no automatic old session');
  assert(!paths.some(p=>p.includes('/events')),'no event replay at startup');
 };
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await page.waitForSelector('input[autocomplete=username]');
 await page.type('input[autocomplete=username]',credentials.username);
 await page.type('input[type=password]',credentials.password);
 const loginStart=start('login');
 await page.click('button.btn.primary.full');
 await ready(loginStart);
 if(!baseline){
  assertLight(phase);
  assert(await page.$('h2::-p-text(开始新对话)'));
  await page.waitForSelector('.sidebar [data-history-job]',{timeout:60000});
  assert.equal(phase.requests.filter(r=>r.path==='/api/me/history').length,1);
  assert.equal(phase.requests.filter(r=>r.path==='/api/examples').length,1);
  report.checks.push('login opens new conversation and automatically restores sidebar history/examples');
 }
 const welcome=await page.$('dialog[open] button');if(welcome)await welcome.click();
 // Seed a real existing conversation in localStorage, as returning users have.
 phase=null;
 const history=await page.evaluate(async()=>{const r=await fetch('/api/me/history');return r.json();});
 const old=history.completed.find(j=>j.result_asset?.playable)??history.completed[0];
 assert(old?.session_id,'ordinary test account needs an existing completed task');
 await page.evaluate(({username,sid,mode,jid})=>{
  let h=0;for(let i=0;i<username.length;i++)h=(h*31+username.charCodeAt(i))|0;
  const scope=Math.abs(h).toString(36);
  localStorage.setItem('cvw:ctx:'+scope,JSON.stringify({v:1,userScope:scope,sessionId:sid,mode,jobId:jid,lastSeenAt:new Date().toISOString()}));
  localStorage.setItem('cvw:welcomed','1');
 },{username:credentials.username,sid:old.session_id,mode:old.mode,jid:old.id});
 const refreshStart=start('refresh-with-saved-conversation');
 await page.reload({waitUntil:'domcontentloaded'});
 await ready(refreshStart);
 if(!baseline){
  assertLight(phase);
  assert(await page.$('h2::-p-text(开始新对话)'));
  await page.waitForSelector('.sidebar [data-history-job]',{timeout:60000});
  report.checks.push('refresh starts empty while retaining the automatically loaded history list');
  // A slow status endpoint cannot block the workspace or change its selection.
  holdStatus=true;
  const slowStart=start('delayed-background-status');
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForSelector('h2::-p-text(开始新对话)',{timeout:10000});
  phase.workspace_ms=Math.round(performance.now()-slowStart);
  await page.waitForFunction(()=>document.querySelector('textarea')!==null);
  assertLight(phase);assert(held.length>0);
  holdStatus=false;for(const r of held)await r.continue();held=[];
  await page.waitForNetworkIdle({idleTime:200,timeout:10000}).catch(()=>{});
  assert(await page.$('h2::-p-text(开始新对话)'));
  report.checks.push('delayed background status does not block or restore a conversation');
  // Hold history/examples before they reach the server: the workspace must
  // already be visible, and releasing them must restore the original sidebar.
  holdHistory=true;holdExamples=true;
  const pendingBackground=Promise.all(['/api/me/history','/api/examples'].map(path=>
   page.waitForRequest(r=>new URL(r.url()).pathname===path,{timeout:10000})));
  const backgroundStart=start('delayed-history-and-examples');
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForSelector('h2::-p-text(开始新对话)',{timeout:10000});
  phase.workspace_ms=Math.round(performance.now()-backgroundStart);
  await pendingBackground;
  assert(await page.$('.sidebar ::-p-text(正在加载历史对话)'));
  assert(await page.$('.sidebar ::-p-text(正在加载示例)'));
  assert.equal((await page.$$('.sidebar [data-history-job]')).length,0);
  assertLight(phase);
  await page.screenshot({path:join(out,'background-loading.png')});
  holdHistory=false;holdExamples=false;for(const r of held)await r.continue();held=[];
  await page.waitForSelector('.sidebar [data-history-job]',{timeout:60000});
  phase.history_visible_ms=Math.round(performance.now()-backgroundStart);
  await page.waitForFunction(()=>!document.querySelector('.sidebar')?.textContent?.includes('正在加载示例'),{timeout:30000});
  assert(await page.$('h2::-p-text(开始新对话)'));
  assert.equal((await page.$$('.sidebar [data-history-job]')).length,Math.min(200,history.completed.length));
  await page.screenshot({path:join(out,'history-restored.png')});
  report.checks.push('slow history/examples show loading states, then populate automatically without selecting a session');

  failHistory=true;
  const retryStart=start('history-failure-and-retry');
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForSelector('h2::-p-text(开始新对话)',{timeout:10000});
  phase.workspace_ms=Math.round(performance.now()-retryStart);
  await page.waitForSelector('button::-p-text(重新加载历史)');
  assert(await page.$('h2::-p-text(开始新对话)'));
  await (await page.$('button::-p-text(重新加载历史)')).click();
  await page.waitForSelector('.sidebar [data-history-job]',{timeout:60000});
  assert.equal(phase.requests.filter(r=>r.path==='/api/me/history').length,2);
  report.checks.push('history failure stays local and one retry restores the list');

  start('sidebar-history-selection');
  const card=await page.$('.sidebar [data-history-job]');
  const cardId=await card.evaluate(el=>el.getAttribute('data-history-job'));
  const sidebarResponse=page.waitForResponse(r=>/^\/api\/sessions\/[^/]+$/.test(new URL(r.url()).pathname));
  await card.click();
  const sidebarSelected=await (await sidebarResponse).json();
  assert(sidebarSelected.jobs.some(j=>j.id===cardId));
  await page.waitForFunction(id=>document.querySelector('a[href$="/archive"]')?.getAttribute('href')?.includes(id),{},sidebarSelected.session.id);
  assert.equal(phase.requests.filter(r=>/^\/api\/sessions\/[^/]+$/.test(r.path)).length,1);
  report.checks.push('sidebar history opens the correct existing conversation with one session request');
  phase=null;await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForSelector('.sidebar [data-history-job]',{timeout:60000});
  start('explicit-history-selection');
  await (await page.$('button::-p-text(创作历史)')).click();
  await page.waitForSelector('.admin-panel .card button');
  const sessionResponse=page.waitForResponse(r=>/^\/api\/sessions\/[^/]+$/.test(new URL(r.url()).pathname));
  await (await page.$('button::-p-text(回到该任务)')).click();
  const selected=await (await sessionResponse).json();
  await page.waitForFunction(id=>document.querySelector('a[href$="/archive"]')?.getAttribute('href')?.includes(id),{},selected.session.id);
  await page.waitForNetworkIdle({idleTime:200,timeout:10000}).catch(()=>{});
  assert.equal(phase.requests.filter(r=>/^\/api\/sessions\/[^/]+$/.test(r.path)).length,1);
  assert(!phase.requests.some(r=>r.path==='/api/me/active-context'));
  report.checks.push('explicit history selection loads one ownership-checked session snapshot');
  if(selected.jobs.some(j=>j.result_asset?.playable)){
   await page.waitForSelector('video');
   await page.evaluate(()=>{const v=document.querySelector('video');v.muted=true;v.load();return v.play().catch(()=>{});});
   await page.waitForFunction(()=>[...document.querySelectorAll('video')].some(v=>v.videoWidth>0),{timeout:30000});
   report.checks.push('existing video still decodes after explicit history selection');
  }
  // Return to default start, open the actual whitebox dialog, create no model job.
  phase=null;await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForSelector('h2::-p-text(开始新对话)');
  await page.click('button[data-mode="blockout_3d"]');
  await page.waitForFunction(()=>document.querySelector('dialog[open]')?.textContent?.includes('0.1.16'));
  const createdPromise=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/sessions'&&r.request().method()==='POST');
  await page.click('dialog[open] button.btn.primary');
  const created=await (await createdPromise).json();
  assert.equal(created.session.model_selection.engine_release,'seko-0.1.16-cvw.1');
  assert.equal(created.session.model_selection.skill_version,'0.1.16');
  assert.match(created.session.model_selection.model,/gpt-6\.1-sol/);
  report.new_session={id:created.session.id,model_selection:created.session.model_selection};
  report.checks.push('new whitebox session uses 0.1.16 and GPT; no generation job submitted');
  await page.waitForFunction(id=>document.querySelector('a[href$="/archive"]')?.getAttribute('href')?.includes(id),{},created.session.id);
  await page.screenshot({path:join(out,'whitebox-new-session.png')});
  phase=null;await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForSelector('h2::-p-text(开始新对话)');
  await page.screenshot({path:join(out,'new-conversation.png')});
 }
 assert.equal(report.errors.length,0,report.errors.join('\n'));
 report.finished_at=new Date().toISOString();
} catch(e) {
 report.failure=e.message;throw e;
} finally {
 holdStatus=false;holdHistory=false;holdExamples=false;for(const r of held)await r.continue().catch(()=>{});
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({path:out,checks:report.checks,phases:report.phases.map(p=>({name:p.name,workspace_ms:p.workspace_ms,history_visible_ms:p.history_visible_ms,api_requests:p.requests.length,response_bytes:p.responses.reduce((s,r)=>s+r.bytes,0)})),failure:report.failure,errors:report.errors},null,2));
 await browser.close();
}
