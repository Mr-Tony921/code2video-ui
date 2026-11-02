// Shared loopback runtime: one project, an OS-assigned port, and a stable Three import.
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {dependencyRequire} from './dependencies.mjs';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,realpath,stat,open} from 'node:fs/promises';

const [action,...argv]=process.argv.slice(2), opts={};
for(let i=0;i<argv.length;i++){
  const key=argv[i];
  if(key==='--init')opts.init=true;
  else if(key==='--project'&&argv[i+1])opts.project=argv[++i];
  else throw Error(`Unknown option ${key}`);
}
if(!['start','serve','status','stop'].includes(action)||!opts.project)throw Error('runtime.mjs start|status|stop --project DIR [--init]');
await mkdir(path.resolve(opts.project),{recursive:true});
const project=await realpath(path.resolve(opts.project));
const stateFile=path.join(project,'render-runtime.json');
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
const state=async()=>{try{return JSON.parse(await readFile(stateFile,'utf8'));}catch{return null;}};
async function request(s,method='GET'){
  if(s?.project!==project||!s.url||!s.token)throw Error('No runtime for this project');
  const u=new URL(s.url);
  if(u.hostname!=='127.0.0.1'||u.protocol!=='http:')throw Error('Runtime must be loopback');
  const r=await fetch(new URL(method==='POST'?'/__previs/stop':'/__previs/status',u),
    {method,headers:{'x-previs-control':s.token},signal:AbortSignal.timeout(1500)});
  if(!r.ok)throw Error(`Runtime HTTP ${r.status}`);
  const data=await r.json();
  if(data.project!==project||data.pid!==s.pid)throw Error('Runtime identity mismatch');
  return data;
}
if(action==='status'){
  const s=await state();await request(s);console.log(JSON.stringify({url:s.url,pid:s.pid,project}));
}else if(action==='stop'){
  const s=await state();await request(s,'POST');console.log(JSON.stringify({stopped:true,pid:s.pid}));
}else if(action==='start'){
  const old=await state();let reuse=false;
  if(old){try{
    await request(old);
    if(old.owner_pid&&!alive(old.owner_pid)){await request(old,'POST');}
    else{
      if(old.owner_pid&&old.owner_pid!==Number(process.env.PREVIS_OWNER_PID||0))throw Error('Another live owner is using this project');
      reuse=true;
    }
  }catch(e){if(e.message==='Another live owner is using this project')throw e;}}
  if(opts.init){
    const html='<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}canvas{display:block}</style><script type="importmap">{"imports":{"three":"/@three/three.module.js"}}</script></head><body><script type="module" src="./main.js"></script></body></html>\n';
    const js=`import * as THREE from 'three';
// Replace the sample objects and evaluateWorld/evaluateCamera with this film's scene.
const scene=new THREE.Scene();scene.background=new THREE.Color(0xdce1e5);
const camera=new THREE.PerspectiveCamera(45,16/9,.1,200);
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});document.body.appendChild(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xffffff,0x8b9298,2));
const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(4,8,5);scene.add(light);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(40,40),new THREE.MeshStandardMaterial({color:0xb7bdc2}));floor.rotation.x=-Math.PI/2;scene.add(floor);
const sample=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial({color:0xe8eaec}));sample.position.y=.5;scene.add(sample);
function evaluateWorld(t){sample.position.x=2*Math.sin(t);sample.rotation.y=.3*t;}
function evaluateCamera(t){camera.position.set(5,3,7);camera.lookAt(0,.7,0);}
window.renderFrame=async(t,width,height)=>{renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();evaluateWorld(t);evaluateCamera(t);renderer.render(scene,camera);};
window.previsReady=true;
`;
    for(const [name,content] of [['index.html',html],['main.js',js]]){
      try{await writeFile(path.join(project,name),content,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
    }
  }
  if(!reuse){
    const log=await open(path.join(project,'runtime-server.log'),'a');
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'serve','--project',project],
      {detached:true,stdio:['ignore',log.fd,log.fd],env:process.env});
    child.unref();await log.close();
    for(let i=0;i<100;i++){
      const s=await state();
      if(s?.pid===child.pid){try{await request(s);reuse=true;break;}catch{}}
      if(!alive(child.pid))throw Error('Runtime exited; see runtime-server.log');
      await new Promise(r=>setTimeout(r,100));
    }
    if(!reuse)throw Error('Runtime not ready; see runtime-server.log');
  }
  const s=await state();console.log(JSON.stringify({url:s.url,pid:s.pid,project,state_file:stateFile}));
}else{
  const requireDependency=dependencyRequire(project);
  const threeRoot=await realpath(path.resolve(path.dirname(requireDependency.resolve('three')),'..')); 
  const token=randomBytes(24).toString('hex');
  const owner=Number(process.env.PREVIS_OWNER_PID||0);
  const within=(root,p)=>p===root||p.startsWith(root+path.sep);
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.gltf':'model/gltf+json','.wasm':'application/wasm'};
  const server=http.createServer(async(req,res)=>{
    try{
      const pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
      if(pathname.startsWith('/__previs/')){
        if(req.headers['x-previs-control']!==token){res.writeHead(403);res.end();return;}
        const stop=pathname==='/__previs/stop'&&req.method==='POST';
        if(!stop&&!(pathname==='/__previs/status'&&req.method==='GET')){res.writeHead(405);res.end();return;}
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({project,pid:process.pid}));
        if(stop)server.close(()=>process.exit(0));return;
      }
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
      const shared=pathname.startsWith('/@three/');
      const rel=shared?pathname.slice('/@three/'.length):pathname.replace(/^\//,'')||'index.html';
      if(rel.split('/').some(s=>s.startsWith('.'))||rel==='render-runtime.json'){res.writeHead(403);res.end();return;}
      const base=shared?path.join(threeRoot,'build'):project;
      const file=await realpath(path.resolve(base,rel));
      if(!within(base,file)&&!(within(project,path.resolve(base,rel))&&within(threeRoot,file))){res.writeHead(403);res.end();return;}
      if(!(await stat(file)).isFile()){res.writeHead(404);res.end();return;}
      const data=await readFile(file);res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','content-length':data.length,'cache-control':'no-store'});
      res.end(req.method==='HEAD'?undefined:data);
    }catch(e){res.writeHead(e.code==='ENOENT'?404:400);res.end('Project resource unavailable');}
  });
  server.listen(0,'127.0.0.1',async()=>{
    await writeFile(stateFile,JSON.stringify({url:`http://127.0.0.1:${server.address().port}/index.html`,pid:process.pid,project,token,owner_pid:owner,started_at:Date.now()},null,2),{mode:0o600});
  });
  if(owner)setInterval(()=>{if(!alive(owner))server.close(()=>process.exit(0));},3000).unref();
}
