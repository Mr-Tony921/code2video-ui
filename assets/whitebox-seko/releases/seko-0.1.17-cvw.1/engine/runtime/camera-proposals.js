import * as THREE from 'three';
import {loadProject} from './project.js';
export function cameraProposals(project,shotIds=null,{budgetMs=15000}={}){
 const view=loadProject(project),begin=performance.now(),scope=shotIds?new Set(shotIds):null;let limited=false;const skippedChecks=[];
const rows=[];
for(const shot of project.shot_plan){
 if(scope&&!scope.has(shot.id))continue;
 if(performance.now()-begin>budgetMs){limited=true;break;}
 const checks=(shot.focus??[]).filter(c=>{
  const valid=Number.isFinite(c.time)&&c.time>=shot.start&&c.time<shot.end&&view.objects[c.entity_id];
  if(!valid)skippedChecks.push({shot_id:shot.id,entity_id:c.entity_id,time:c.time,reason:'Invalid focus declaration; original structural issue remains for model repair'});
  return valid;
 });
 if(!checks.length||shot.camera_plan?.motion!==false)continue;

 // A focus-only solution can remove other declared narrative subjects. Keep
 // visible declared subjects at the same event times; never make a hidden
 // pre-reveal subject appear just to satisfy this optional suggestion.
 for(const time of [...new Set(checks.map(c=>c.time))]){
  const state=view.setTime(time);
  for(const id of shot.camera_plan.subjects??[]){
   if(state.entities[id]?.visible&&!checks.some(c=>c.time===time&&c.entity_id===id))checks.push({entity_id:id,time,supplemental_declared_subject:true});
  }
 }
 const original=checks.map(c=>{view.setTime(c.time);return view.inspectFocus(c);});
 if(original.every(c=>c.pass))continue;
 const points=original.map(c=>new THREE.Vector3(...c.anchor_position));
 const center=points.reduce((sum,v)=>sum.add(v),new THREE.Vector3()).multiplyScalar(1/points.length);
 view.setTime((shot.start+shot.end)/2);
 const basePosition=view.camera.position.clone(),baseFov=view.camera.fov,baseUp=view.camera.up.clone();
 const offset=basePosition.clone().sub(center),baseRadius=offset.length();
 const baseAz=Math.atan2(offset.z,offset.x),baseElev=Math.asin(offset.y/baseRadius);
 const span=Math.max(...points.map(p=>p.distanceTo(center)),.15);
 const fitRadius=span/Math.tan(THREE.MathUtils.degToRad(baseFov/2))+.25;
 const candidates=[];
 let tested=0;
 const test=(position,target)=>{
  const observations=[];
  for(const c of checks){
   view.setTime(c.time);view.camera.position.fromArray(position);view.camera.up.copy(baseUp);view.camera.fov=baseFov;view.camera.lookAt(...target);view.camera.updateProjectionMatrix();view.scene.updateMatrixWorld(true);
   const fact=view.inspectFocus(c);observations.push(fact);
   // Keep a margin around declared points, not only barely inside the image.
   if(!fact.pass||Math.abs(fact.projection[0])>.85||Math.abs(fact.projection[1])>.85)return null;
  }
  return observations;
 };
 for(const az of [0,15,-15,30,-30,60,-60,90,-90,120,-120,180])for(const el of [0,.2,-.2,.4,-.4])for(const scale of [.8,1,1.25,1.5]){
  if(performance.now()-begin>budgetMs){limited=true;break;}
  tested++;const elev=Math.max(-1.1,Math.min(1.1,baseElev+el)),radius=Math.max(baseRadius*scale,fitRadius),a=baseAz+THREE.MathUtils.degToRad(az);
  const pos=new THREE.Vector3(Math.cos(a)*Math.cos(elev),Math.sin(elev),Math.sin(a)*Math.cos(elev)).multiplyScalar(radius).add(center);
  const position=pos.toArray().map(x=>+x.toFixed(5)),target=center.toArray().map(x=>+x.toFixed(5));
  const facts=test(position,target);if(!facts)continue;
  candidates.push({position,target,fov:baseFov,score:pos.distanceTo(basePosition)+Math.abs(scale-1)*baseRadius*.2,checks:facts});
 }
 candidates.sort((a,b)=>a.score-b.score);
 rows.push({shot_id:shot.id,interval:[shot.start,shot.end],original_checks:original,tested,proposals:candidates.slice(0,3),limitations:'Only declared checkpoint geometry/front/visibility constraints and static camera. Not semantic acceptance, all-frame proof, or permission to change user-locked camera. Suggestions are not applied. Model must preserve original shot requirements and actual replay/review remains required.'});
}
view.dispose();
 return {schema:'camera-proposals-v1',seconds:(performance.now()-begin)/1000,limited,skipped_checks:skippedChecks,applied:false,rows};
}
