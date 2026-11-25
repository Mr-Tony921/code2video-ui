/** Deterministic camera render of the delivered project; never executes source.js. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import puppeteer from 'puppeteer-core';
const require = createRequire(import.meta.url), ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {}; for (let i=2; i<process.argv.length; i+=2) args[process.argv[i].replace(/^--/,'')] = process.argv[i+1];
const project = JSON.parse(fs.readFileSync(args.project));
const width = +(args.width || 1280), height = +(args.height || 720), fps = +(args.fps || 24);
if (!(project.duration>0 && project.duration<=300)) throw Error('Invalid project duration');
const THREE_DIR = path.dirname(require.resolve('three'));
let browser, server, encoder, profile;
const tmp = args.out + '.partial.mp4';
async function cleanup() { if (encoder?.exitCode == null) encoder?.kill('SIGTERM'); await browser?.close().catch(()=>{}); server?.close(); if(profile) fs.rmSync(profile,{recursive:true,force:true}); }
process.on('SIGTERM',()=>cleanup().finally(()=>process.exit(143)));
try {
  const allowed = {'/':ROOT+'/runtime/probe.html','/runtime/helpers.js':ROOT+'/runtime/helpers.js','/runtime/project.js':ROOT+'/runtime/project.js','/vendor/three.module.js':THREE_DIR+'/three.module.js','/vendor/three.core.js':THREE_DIR+'/three.core.js'};
  server=http.createServer((req,res)=>{ const f=allowed[req.url]; if(!f){res.writeHead(404);res.end();return;} res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':'text/html');fs.createReadStream(f).pipe(res); });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  profile=fs.mkdtempSync(path.join(path.dirname(args.out),'.video-browser-'));
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,userDataDir:profile,headless:true,protocolTimeout:180000,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-webgl','--disable-background-networking']});
  const page=await browser.newPage();await page.setViewport({width,height,deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(origin+'/')?r.continue():r.abort());
  await page.goto(origin);await page.waitForFunction('window.ready===true');await page.evaluate(o=>window.load(o),{project,width,height});
  encoder=spawn(process.env.FFMPEG_BIN||'ffmpeg',['-v','error','-y','-f','image2pipe','-vcodec','mjpeg','-framerate',String(fps),'-i','pipe:0','-an','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-threads','2','-movflags','+faststart',tmp],{stdio:['pipe','ignore','pipe']});
  let encodingError='';encoder.stderr.on('data',s=>encodingError+=s);encoder.stdin.on('error',()=>{});
  const exit = new Promise((resolve,reject)=>{encoder.once('error',reject);encoder.once('close',code=>resolve(code));});
  const frames=Math.ceil(project.duration*fps),started=performance.now();
  for(let i=0;i<frames;i++) {
    const jpeg=await page.evaluate(t=>window.frame(t,true).jpeg,Math.min(i/fps,project.duration-.00001));
    if(!jpeg||errors.length)throw Error('Video frame failed: '+errors.join(';'));
    if(!encoder.stdin.write(Buffer.from(jpeg,'base64')))await once(encoder.stdin,'drain');
    if(i%240===0)console.log(JSON.stringify({event:'render_progress',frame:i,total:frames}));
  }
  encoder.stdin.end();const code=await exit;if(code!==0)throw Error('ffmpeg: '+encodingError);
  fs.renameSync(tmp,args.out);console.log(JSON.stringify({ok:true,frames,fps,width,height,seconds:(performance.now()-started)/1000}));
} finally { await cleanup(); }
