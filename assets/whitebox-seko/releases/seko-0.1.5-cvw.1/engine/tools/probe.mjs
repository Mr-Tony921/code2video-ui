import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';import puppeteer from 'puppeteer-core';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const THREE_DIR=path.dirname(require.resolve('three'));
const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
if(!args.out||!args.task||(!args.source&&!args.project))throw Error('Need --out --task and --source or --project');
const out=path.resolve(args.out);fs.mkdirSync(out,{recursive:true});
const task=JSON.parse(fs.readFileSync(args.task)),width=+(args.width||640),height=+(args.height||360),errors=[],started=performance.now();
let browser,server,profile,timer;
const save=(name,v)=>fs.writeFileSync(path.join(out,name),JSON.stringify(v,null,2));
async function cleanup(){clearTimeout(timer);if(browser)await browser.close().catch(()=>{});if(server)server.close();if(profile)fs.rmSync(profile,{recursive:true,force:true});}
process.on('SIGTERM',()=>cleanup().finally(()=>process.exit(124)));
try{
 timer=setTimeout(()=>{console.error('Probe timeout');cleanup().finally(()=>process.exit(124));},1000*+(args.timeout||180));
 const allowed={'/':ROOT+'/runtime/probe.html','/runtime/helpers.js':ROOT+'/runtime/helpers.js','/runtime/project.js':ROOT+'/runtime/project.js','/vendor/three.module.js':THREE_DIR+'/three.module.js','/vendor/three.core.js':THREE_DIR+'/three.core.js','/source.js':args.source?path.resolve(args.source):null};
 server=http.createServer((req,res)=>{const f=allowed[req.url];if(!f){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':'text/html');fs.createReadStream(f).pipe(res);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 profile=fs.mkdtempSync(path.join(out,'.browser-'));
 const chromeArgs=['--no-sandbox','--disable-dev-shm-usage','--ignore-gpu-blocklist','--use-gl=angle','--use-angle=gl','--enable-webgl','--disable-background-timer-throttling'];
 if(args.software!=='false')chromeArgs.splice(chromeArgs.indexOf('--use-angle=gl'),1,'--use-angle=swiftshader','--enable-unsafe-swiftshader');
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',userDataDir:profile,headless:true,args:chromeArgs,protocolTimeout:180000});
 const page=await browser.newPage();await page.setViewport({width,height,deviceScaleFactor:1});page.on('pageerror',e=>errors.push(e.message));
 await page.setRequestInterception(true);page.on('request',r=>{const url=r.url();if(url.startsWith(origin+'/')||url.startsWith('data:')||url.startsWith('blob:'))r.continue();else r.abort();});
 await page.goto(origin);await page.waitForFunction('window.ready===true');
 let project,checks;
 if(args.source){
   const hash=crypto.createHash('sha256').update(fs.readFileSync(args.source)).digest('hex');
   ({project,checks}=await page.evaluate(o=>window.build(o),{task,hash,legacy:args.legacy==='true',width,height}));
   save('project.json',project);save('checks.json',checks);
 } else {project=JSON.parse(fs.readFileSync(args.project));await page.evaluate(o=>window.load(o),{project,width,height});}
 const hardware=await page.evaluate(()=>window.hardware());hardware.puppeteer=JSON.parse(fs.readFileSync(require.resolve('puppeteer-core/package.json'))).version;hardware.node=process.version;
 const focus=[];
 for(const s of project.shot_plan)for(const c of s.focus||[]){const result=await page.evaluate(c=>window.checkFocus(c),c);focus.push({shot_id:s.id,...result});}
 save('focus.json',focus);
 save('focus-checks.json',{pass:focus.every(c=>c.pass),scope:'Only declared focus checkpoints',errors:focus.filter(c=>!c.pass).map(c=>({code:'required_focus',message:JSON.stringify(c)}))});
 const evidence=[],samples=[];fs.mkdirSync(path.join(out,'frames'),{recursive:true});
 const selectedShots=project.shot_plan.filter(s=>!args.scope||s.id===args.scope||s.segment_id===args.scope);
 if(!selectedShots.length)throw Error('No shots in requested scope');
 const snapshots=selectedShots.flatMap((s,i)=>['start','middle','end'].map((label,j)=>({time:j===0?s.start+Math.min(.001,(s.end-s.start)/10):j===1?(s.start+s.end)/2:s.end-.001,shot:s.id,segment_id:s.segment_id,label,file:`frames/${String(i+1).padStart(3,'0')}-${label}.jpg`})));
 // One bounded extra sample per shot near a non-camera state change catches short prop/action events.
 if(args.events!=='false')for(const [i,s] of selectedShots.entries()){
   const fixed=snapshots.filter(p=>p.shot===s.id).map(p=>p.time),candidates=[];
   for(const tr of project.animation.tracks.filter(t=>t.target!=='__camera'&&['visible','position','rotation'].includes(t.property)))for(let j=1;j<tr.keys.length;j++){
     const k=tr.keys[j],prev=tr.keys[j-1];if(JSON.stringify(k.value)===JSON.stringify(prev.value))continue;
     const t=Math.min(k.time+.01,s.end-.001),distance=Math.min(...fixed.map(f=>Math.abs(t-f)));
     if(t>s.start+.1&&t<s.end-.1&&distance>.15)candidates.push({time:t,priority:(tr.property==='visible'?100:0)+distance});
   }
   candidates.sort((a,b)=>b.priority-a.priority);if(candidates.length)snapshots.push({time:candidates[0].time,shot:s.id,segment_id:s.segment_id,label:'event',file:`frames/${String(i+1).padStart(3,'0')}-event.jpg`});
 }
 snapshots.sort((a,b)=>a.time-b.time);
 for(const point of snapshots){
   const result=await page.evaluate(({t,capture})=>window.frame(t,capture),{t:point.time,capture:args.capture!=='false'});
   if(result.jpeg)fs.writeFileSync(path.join(out,point.file),Buffer.from(result.jpeg,'base64'));
   else point.file=null;
   evidence.push(point);samples.push({...point,state:result.state});
 }
 const determinism=[];
 for(const seg of project.segments){
   const t=seg.start+.371*(seg.end-seg.start);
   const a=await page.evaluate(t=>window.frame(t),t);await page.evaluate(t=>window.frame(t),project.duration*.73);
   const b=await page.evaluate(t=>window.frame(t),t);determinism.push({segment_id:seg.id,time:t,equal:JSON.stringify(a.state)===JSON.stringify(b.state)});
 }
 save('evidence.json',evidence);save('states.json',samples);save('determinism.json',determinism);
 if(args.scope){const boundaries=[];for(const t of [...new Set(selectedShots.flatMap(s=>[s.start,s.end]))])boundaries.push({time:t,...await page.evaluate(t=>window.frame(t),t)});save('edit-boundaries.json',boundaries);}
 if(determinism.some(x=>!x.equal))errors.push('A-B-A state mismatch');
 // Independently sample all segment boundaries; no sequential playback prerequisite.
 for(const s of project.segments)for(const t of [s.start,s.end])await page.evaluate(t=>window.frame(t),t);
 const runtimeFiles=['helpers.js','project.js','probe.html'];
 save('probe.json',{ok:!errors.length,errors,seconds:(performance.now()-started)/1000,hardware,sampled_frames:evidence.length,runtime_sha256:Object.fromEntries(runtimeFiles.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(ROOT+'/runtime/'+f)).digest('hex')])),scope:'All shots start/middle/end; all segment boundaries; A-B-A per segment. Not exhaustive every-frame semantic proof.'});
 console.log(JSON.stringify({ok:!errors.length,checks,seconds:(performance.now()-started)/1000,frames:evidence.length,entities:project.entities.length,hardware}));
 await cleanup();if(errors.length)process.exitCode=1;
}catch(e){save('probe.json',{ok:false,errors:[e.stack,...errors],seconds:(performance.now()-started)/1000});console.error(e.stack);await cleanup();process.exitCode=1;}
