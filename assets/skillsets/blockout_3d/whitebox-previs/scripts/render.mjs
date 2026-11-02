// Deterministic capture with one or two bounded chunks; no per-frame AFS writes.
import {spawn, spawnSync} from 'node:child_process';
import {dependencyRequire} from './dependencies.mjs';
import {createWriteStream} from 'node:fs';
import {mkdir, mkdtemp, readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import path from 'node:path';

const args = process.argv.slice(2), opts = {};
const flags = new Set(['check-seek', 'help']);
const known = new Set(['url','project','out','duration','width','height','fps','start','frames','workers','crf',...flags]);
for (let i=0; i<args.length; i++) {
  const key = args[i].replace(/^--/, '');
  if (!args[i].startsWith('--') || !known.has(key)) throw Error(`Unknown argument: ${args[i]}`);
  if (flags.has(key)) opts[key] = true;
  else {
    if (!args[i+1] || args[i+1].startsWith('--')) throw Error(`Missing value: --${key}`);
    opts[key] = args[++i];
  }
}
if (opts.help) {
  console.log('node render.mjs --url URL --project DIR --out FILE --duration SEC [--width 640 --height 360 --fps 24 --start 0 --frames N --workers 1 --crf 20 --check-seek]');
  process.exit(0);
}
const number = (key, fallback, integer=false) => {
  const value = Number(opts[key] ?? fallback);
  if (!Number.isFinite(value) || value < (key==='start' ? 0 : 1) || integer && !Number.isInteger(value)) throw Error(`Invalid --${key}`);
  return value;
};
if (!opts.url || !opts.project || !opts.out) throw Error('--url, --project and --out are required');
const url = new URL(opts.url), project = path.resolve(opts.project), output = path.resolve(opts.out);
if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw Error('Serve the task on loopback before capture');
const duration = number('duration', 0), fps = number('fps', 24), width = number('width', 640, true), height = number('height', 360, true);
if (width%2 || height%2) throw Error('Dimensions must be even');
const total = Math.round(duration*fps), start = number('start', 0, true), count = number('frames', total-start, true);
if (Math.abs(total-duration*fps)>1e-6 || start+count>total) throw Error('Frame range must fit the exact duration');
const workers = number('workers', 1, true), cap = Number(process.env.PREVIS_RENDER_WORKERS || 1);
const crf = Number(opts.crf ?? 20);
if(!Number.isInteger(crf) || crf<0 || crf>40) throw Error('crf must be an integer in [0,40]');
if (![1,2].includes(cap) || ![1,2].includes(workers) || workers>cap) throw Error('workers must be 1 or 2 and fit PREVIS_RENDER_WORKERS (default 1)');
const puppeteer = dependencyRequire(project)('puppeteer-core');
const executablePath = process.env.CHROME_BIN;
if (!executablePath) throw Error('Set CHROME_BIN to the sandbox Chromium executable; see references/runtime.md');
const entry = path.join(project, path.basename(url.pathname) || 'index.html');
const expectedHtml = await readFile(entry, 'utf8');
const htmlHash = createHash('sha256').update(expectedHtml).digest('hex');
await mkdir(path.dirname(output),{recursive:true});
const work = await mkdtemp(path.join(path.dirname(output),'.capture-'));
const abort = new AbortController(), begun = Date.now();
let firstFailure;

function run(command, argv) {
  const result = spawnSync(command,argv,{encoding:'utf8',maxBuffer:8*1024*1024});
  if (result.error || result.status!==0) throw Error(`${command} failed: ${result.error?.message || result.stderr?.slice(-1200) || result.status}`);
  return result.stdout;
}
function verify(file, expected) {
  const data = JSON.parse(run('ffprobe',['-v','error','-count_frames','-show_streams','-of','json',file]));
  const videos = data.streams.filter(s=>s.codec_type==='video');
  if (videos.length!==1 || data.streams.some(s=>s.codec_type==='audio')) throw Error('Expected exactly one silent video stream');
  const s=videos[0], [num,den]=s.avg_frame_rate.split('/').map(Number);
  if (s.width!==width || s.height!==height || s.codec_name!=='h264' || s.pix_fmt!=='yuv420p' || Number(s.nb_read_frames)!==expected || Math.abs(num/den-fps)>1e-6 || Math.abs(Number(s.duration)-expected/fps)>1/fps) throw Error('Encoded chunk/output specification mismatch');
  return {frames:Number(s.nb_read_frames),duration:Number(s.duration),width,height,fps};
}

async function capture(index, first, frames) {
  let browser, ff, failure;
  const file=path.join(work,`part-${String(index).padStart(3,'0')}.mp4`), log=file+'.log';
  const t0=Date.now();
  const cancel=()=>{ff?.kill('SIGTERM'); browser?.close().catch(()=>{});};
  abort.signal.addEventListener('abort',cancel);
  try {
    if (abort.signal.aborted) throw Error('Capture cancelled');
    browser=await puppeteer.launch({executablePath,headless:true,protocolTimeout:60000,args:[...(process.env.PREVIS_CHROME_NO_SANDBOX==='1'?['--no-sandbox']:[]),'--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    const page=await browser.newPage();
    await page.setViewport({width,height,deviceScaleFactor:1});
    let failPage;
    const pageFailure=new Promise((_,reject)=>{failPage=reject;});
    pageFailure.catch(()=>{});
    page.on('pageerror', e=>{failure=e; failPage(e);});
    const response=await Promise.race([page.goto(url.href,{waitUntil:'networkidle0',timeout:60000}),pageFailure]);
    if (!response?.ok() || await response.text()!==expectedHtml) throw Error('Served HTML differs from this project or returned HTTP error');
    await Promise.race([page.waitForFunction(()=>
      window.previsReady===true && typeof window.renderFrame==='function' || window.READY===true && typeof window.seek==='function',
      {timeout:60000}),pageFailure]);
    async function draw(frame) {
      await Promise.race([page.evaluate(async ({t,width,height})=>{
        const render=window.previsReady===true && typeof window.renderFrame==='function'
          ? ()=>window.renderFrame(t,width,height) : ()=>window.seek(t);
        let timer;
        try { await Promise.race([render(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('renderFrame timed out')),30000);})]); }
        finally { clearTimeout(timer); }
      },{t:frame/fps,width,height}),pageFailure]);
      if (failure || abort.signal.aborted) throw failure || Error('Capture cancelled');
      return page.screenshot({type:'png'});
    }
    let seekCheck;
    if (opts['check-seek']) {
      const a=await draw(first);
      await draw(first+Math.floor((frames-1)/2));
      const b=await draw(first);
      const hash=buf=>createHash('sha256').update(buf).digest('hex');
      if (hash(a)!==hash(b)) throw Error('Repeated seek produced different pixels');
      seekCheck={frame:first,sha256:hash(a)};
    }
    ff=spawn('ffmpeg',['-v','error','-y','-f','image2pipe','-framerate',String(fps),'-i','-',
      '-frames:v',String(frames),'-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-crf',String(crf),'-preset','fast','-an','-movflags','+faststart',file],{stdio:['pipe','ignore','pipe']});
    ff.stderr.pipe(createWriteStream(log));
    const finished=new Promise((resolve,reject)=>{
      ff.once('error',reject);
      ff.once('close',(code,signal)=>code===0 ? resolve() : reject(Error(`ffmpeg exit ${code ?? signal}; see ${log}`)));
    });
    finished.catch(()=>{});
    let inputError;
    ff.stdin.on('error',e=>{inputError=e;});
    for (let i=0;i<frames;i++) {
      const bytes=await draw(first+i);
      if (inputError || ff.stdin.destroyed) throw inputError || Error('ffmpeg stdin closed');
      if (!ff.stdin.write(bytes)) await Promise.race([once(ff.stdin,'drain'),finished.then(()=>{throw Error('ffmpeg closed before capture ended');})]);
      if (i%Math.ceil(fps)===0) console.log(`chunk=${index} frames=${i+1}/${frames}`);
    }
    ff.stdin.end();
    await finished;
    return {index,start:first,frames,file,log,elapsed_ms:Date.now()-t0,seek_check:seekCheck,verification:verify(file,frames)};
  } catch(e) {firstFailure ??= e;abort.abort();throw e;}
  finally {abort.signal.removeEventListener('abort',cancel);ff?.kill('SIGTERM');await browser?.close();}
}

try {
  const ranges=[], chunkSize=Math.ceil(count/workers);
  for(let i=0;i<workers;i++) {
    const first=start+i*chunkSize, frames=Math.min(chunkSize,start+count-first);
    if(frames>0) ranges.push({index:i,first,frames});
  }
  const outcomes=await Promise.allSettled(ranges.map(r=>capture(r.index,r.first,r.frames)));
  const bad=outcomes.find(r=>r.status==='rejected');
  if(bad) throw firstFailure || bad.reason;
  const chunks=outcomes.map(r=>r.value);
  let encoded=chunks[0].file;
  if(chunks.length>1) {
    const manifest=path.join(work,'chunks.txt');
    await writeFile(manifest,chunks.map(c=>`file '${path.basename(c.file)}'`).join('\n')+'\n');
    encoded=path.join(work,'joined.mp4');
    run('ffmpeg',['-v','error','-y','-f','concat','-safe','0','-i',manifest,'-map','0:v:0','-c','copy','-an','-movflags','+faststart',encoded]);
  }
  const verification=verify(encoded,count);
  const report={status:'complete',url:url.href,entry,html_sha256:htmlHash,start,frames:count,workers:chunks.length,
    elapsed_ms:Date.now()-begun,verification,chunks};
  const reportPath=output+'.render.json';
  await writeFile(reportPath+'.tmp',JSON.stringify(report,null,2));
  // Publishing happens only after all worker exits and output checks succeed.
  await rename(encoded,output);
  await rename(reportPath+'.tmp',reportPath);
  for(const c of chunks) if(c.file!==encoded) await unlink(c.file);
  console.log(JSON.stringify({output,report:reportPath,frames:count,workers:chunks.length,elapsed_ms:report.elapsed_ms}));
} catch(e) {
  await writeFile(path.join(work,'failure.json'),JSON.stringify({status:'failed',error:String(e),elapsed_ms:Date.now()-begun},null,2));
  console.error(`Capture failed; diagnostics: ${work}\n${e.message}`);
  process.exitCode=1;
}
