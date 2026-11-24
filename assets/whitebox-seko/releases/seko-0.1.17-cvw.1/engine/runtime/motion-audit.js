import * as THREE from 'three';
import {loadProject} from './project.js';

const visible=o=>{for(let p=o;p;p=p.parent)if(!p.visible)return false;return true;};
const inside=(o,root)=>{for(let p=o;p;p=p.parent)if(p===root)return true;return false;};
function clip(a,b,box){
 let lo=0,hi=1;
 for(const k of ['x','y','z']){
  const d=b[k]-a[k];
  if(Math.abs(d)<1e-10){if(a[k]<box.min[k]||a[k]>box.max[k])return null;continue;}
  const u=(box.min[k]-a[k])/d,v=(box.max[k]-a[k])/d;
  lo=Math.max(lo,Math.min(u,v));hi=Math.min(hi,Math.max(u,v));if(hi<lo)return null;
 }
 return [lo,hi];
}

/** Conservative body-centre crossing evidence, not a physics/visibility oracle.
 * Exact local box interiors; cylinder bounding boxes are warnings. No AABB of
 * a whole wall/group (which would incorrectly fill real door openings).
 */
export function motionAudit(project,{maxSamples=1800}={}){
 const v=loadProject(project),findings=[],actors=project.entities.filter(e=>e.character&&v.objects[e.id]);
 const roots=actors.map(e=>v.objects[e.id]),meshes=[];
 v.scene.traverse(o=>{
  if(!o.isMesh||roots.some(r=>inside(o,r)))return;
  const mats=Array.isArray(o.material)?o.material:[o.material];
  if(mats.every(m=>m.visible===false||(m.transparent&&m.opacity<.5)))return;
  if(!['BoxGeometry','CylinderGeometry'].includes(o.geometry?.type))return;
  o.geometry.computeBoundingBox();meshes.push(o);
 });
 const times=new Set([0,project.duration]);
 for(const s of project.shot_plan)for(const t of [s.start,s.start+.001,s.end-.001,s.end])times.add(t);
 for(const tr of project.animation.tracks)if(tr.target!=='__camera')for(const k of tr.keys)times.add(k.time);
 for(let t=0;t<project.duration;t+=.5)times.add(t);
 let sample=[...times].filter(t=>t>=0&&t<=project.duration).sort((a,b)=>a-b);
 const exhaustive=sample.length<=maxSamples;if(!exhaustive)sample=sample.filter((_,i)=>i%Math.ceil(sample.length/maxSamples)===0);
 let prev=null;const seen=new Set();
 for(const t of sample){
  v.setTime(t);
  const current=actors.map(e=>{const o=v.objects[e.id];return {id:e.id,p:o.getWorldPosition(new THREE.Vector3()),visible:visible(o),height:o.userData.seko_human_v2?.height||1.75};});
  if(prev)for(const [i,a] of current.entries()){
   const p=prev.actors[i],distance=Math.hypot(a.p.x-p.p.x,a.p.z-p.p.z);
   // Tiny stationary overlaps and explicit cuts/step resets are not walking.
   if(!a.visible||!p.visible||distance<.04||t-prev.time<.002)continue;
   const shot=project.shot_plan.find(s=>prev.time>=s.start-1e-7&&t<=s.end+1e-7);if(!shot)continue;
   const root=v.objects[a.id];let stepped=false;
   for(let parent=root;parent;parent=parent.parent){
    const id=parent.userData.technicalId;
    for(const tr of project.animation.tracks)if(tr.target===id&&tr.property==='position')for(let k=1;k<tr.keys.length;k++)if(tr.keys[k-1].interpolation==='step'&&tr.keys[k].time>prev.time&&tr.keys[k].time<=t)stepped=true;
   }
   if(stepped)continue;
   for(const m of meshes){
    if(!visible(m))continue;
    const inverse=new THREE.Matrix4().copy(m.matrixWorld).invert(),previousInverse=prev.meshes.get(m.uuid)?.clone().invert()||inverse,box=m.geometry.boundingBox.clone();
    const scale=m.getWorldScale(new THREE.Vector3());
    for(const k of ['x','y','z']){const margin=.015/Math.max(Math.abs(scale[k]),1e-6);box.min[k]+=margin;box.max[k]-=margin;}
    if(box.isEmpty())continue;
    for(const level of [.32,.64]){
     const start=p.p.clone().add(new THREE.Vector3(0,a.height*level,0)).applyMatrix4(previousInverse);
     const end=a.p.clone().add(new THREE.Vector3(0,a.height*level,0)).applyMatrix4(inverse);
     if(start.distanceTo(end)*Math.min(scale.x,scale.y,scale.z)<.04)continue; // carried/co-moving contact
     const interval=clip(start,end,box);if(!interval||(interval[1]-interval[0])*distance<.025)continue;
     let container=m;while(container.parent&&!container.userData.technicalId)container=container.parent;
     // UUIDs change on every compilation; they must not make an unchanged
     // unregistered wall look like a new regression after source repair.
     const worldBounds=new THREE.Box3().setFromObject(m),center=worldBounds.getCenter(new THREE.Vector3()),size=worldBounds.getSize(new THREE.Vector3());
     const fallback='mesh:'+m.geometry.type+':'+[...center.toArray(),...size.toArray()].map(n=>n.toFixed(3)).join(',');
     const obstacle=container.userData.technicalId||m.name||fallback;
     const key=[shot.id,a.id,m.uuid].join('/');if(seen.has(key))continue;seen.add(key);
     const exact=m.geometry.type==='BoxGeometry';
     findings.push({code:'motion_crossing',shot_id:shot.id,actor:a.id,obstacle,mesh_uuid:m.uuid,
      time:prev.time+(t-prev.time)*(interval[0]+interval[1])/2,interval:[prev.time,t],
      kind:exact?'body_center_enters_box_interior':'possible_cylinder_bounds_crossing',
      severity:exact?'review_required':'uncertain',repairable:exact,
      problem_id:`motion:${shot.id}:${a.id}:${obstacle}`,entity_ids:[a.id,obstacle].sort(),
      message:'Moving body centre crosses solid mesh interior. Inspect event frame; preserve required barriers and route through an actual opening. Static overlap is excluded.'});
     break;
    }
   }
  }
  prev={time:t,actors:current,meshes:new Map(meshes.map(m=>[m.uuid,m.matrixWorld.clone()]))};
 }
 v.dispose();
 return {policy:'motion-crossing-v2',samples:sample.length,full_key_coverage:exhaustive,actors:actors.length,obstacle_meshes:meshes.length,findings,
  limitation:'Finite intervals and body-centre probes; relative endpoints exclude co-moving contact; interval interpolation and rotating obstacles remain approximate. Static contact/grazing is permitted; findings require event context. Exact box penetration is geometric evidence, not all-frame semantic certification. Cylinders are conservative warnings; step scene resets and stationary overlap are excluded.'};
}
