#!/usr/bin/env node
// Fast deterministic Node Canvas capture. One render; no creative correction loop.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve,dirname} from 'node:path';
import {mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
const started=Date.now(), args=process.argv.slice(2), entry=args.shift();
function option(name,fallback){const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];}
if(!entry)throw new Error('Usage: render.mjs src/film.mjs --dur 30 --out output/final.mp4');
const width=Number(option('width',1280)),height=Number(option('height',720)),fps=Number(option('fps',24)),duration=Number(option('dur',30));
if(![width,height,fps,duration].every(x=>Number.isFinite(x)&&x>0)||width%2||height%2)throw new Error('Invalid video dimensions/timing');
const out=resolve(option('out','output/final.mp4')),work=resolve('work');mkdirSync(dirname(out),{recursive:true});mkdirSync(work,{recursive:true});
const require=createRequire(resolve('package.json')),{createCanvas}=require('@napi-rs/canvas');
const config={width,height,fps,duration}, film=await import(pathToFileURL(resolve(entry)));
if(typeof film.render!=='function')throw new Error('Export render(ctx,t,config)');
await film.init?.(config);
const c=createCanvas(width,height),ctx=c.getContext('2d'),total=Math.round(duration*fps);
const sheet=createCanvas(960,360),sctx=sheet.getContext('2d');
for(let k=0;k<6;k++){ctx.resetTransform();ctx.clearRect(0,0,width,height);await film.render(ctx,Math.min(duration-1/fps,k*duration/6),config);sctx.drawImage(c,(k%3)*320,Math.floor(k/3)*180,320,180);}
writeFileSync(resolve(work,'fast-contact.png'),sheet.toBuffer('image/png'));
const previewAt=Date.now(),tmp=out+'.encoding.mp4';
const ff=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgba','-s',`${width}x${height}`,'-r',String(fps),'-i','-','-an','-c:v','libx264','-preset','veryfast','-crf','22','-pix_fmt','yuv420p','-movflags','+faststart',tmp],{stdio:['pipe','ignore','pipe']});
let err='';ff.stderr.on('data',d=>err+=d);const complete=once(ff,'close');
try{
 for(let i=0;i<total;i++){
  ctx.resetTransform();ctx.clearRect(0,0,width,height);await film.render(ctx,i/fps,config);
  if(!ff.stdin.write(ctx.getImageData(0,0,width,height).data))await once(ff.stdin,'drain');
 }
 ff.stdin.end();const [code]=await complete;if(code!==0)throw new Error('ffmpeg: '+err.slice(-1500));
}catch(e){ff.stdin.destroy();ff.kill('SIGTERM');throw e;}
const encodedAt=Date.now(),probe=spawnSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',tmp],{encoding:'utf8'});
if(probe.status!==0)throw new Error('ffprobe failed');const data=JSON.parse(probe.stdout),v=data.streams.find(s=>s.codec_type==='video');
if(!v||v.width!==width||v.height!==height||Math.abs(Number(data.format.duration)-duration)>Math.max(0.05,1/fps))throw new Error('Output metadata mismatch');
const dec=spawnSync('ffmpeg',['-v','error','-i',tmp,'-f','null','-'],{encoding:'utf8'});if(dec.status!==0||dec.stderr.trim())throw new Error('Decode check failed '+dec.stderr);
renameSync(tmp,out);
const result={output:out,...config,frames:total,render_attempts:1,preview_seconds:(previewAt-started)/1000,encode_seconds:(encodedAt-previewAt)/1000,check_seconds:(Date.now()-encodedAt)/1000,total_tool_seconds:(Date.now()-started)/1000,codec:v.codec_name,pixel_format:v.pix_fmt,verified_decode:true};
writeFileSync(resolve(work,'render-metrics.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
