import * as THREE from 'three';

export const SCHEMA_VERSION='0.1.0';
// Object3D in userData is a metadata reference, not extra scene geometry.
// Convert it before CDP transport, which otherwise returns undefined for cycles.
function metadataJSON(value, seen=new Set()) {
  if(value?.isObject3D)return {$three_object_uuid:value.uuid};
  if(value===null||['string','boolean','number'].includes(typeof value))return value;
  if(typeof value!=='object')throw Error('Non-JSON userData value');
  if(seen.has(value))throw Error('Cyclic userData without an Object3D reference');
  seen.add(value);
  const result=Array.isArray(value)?value.map(v=>metadataJSON(v,seen)):Object.fromEntries(Object.entries(value).map(([k,v])=>[k,metadataJSON(v,seen)]));
  seen.delete(value);return result;
}

export function compileProject(host,result,task,sourceHash,{legacy=false}={}) {
  host.scene.traverse(o=>{
    if([...o.position.toArray(),...o.quaternion.toArray(),...o.scale.toArray()].some(x=>!Number.isFinite(x)))throw Error('Nonfinite transform '+o.name);
    const p=o.geometry?.attributes?.position?.array;if(p&&p.some(x=>!Number.isFinite(x)))throw Error('Nonfinite geometry '+o.name);
  });
  const entries=new Map();
  for(const e of [...host.helpers.registered.values(),...(result.entities||[])]){
    if(!e.id||!e.object?.isObject3D)throw Error('Invalid registered entity');
    if(entries.has(e.id)&&entries.get(e.id).object!==e.object)throw Error('Duplicate entity '+e.id);
    entries.set(e.id,e);e.object.userData.technicalId=e.id;
  }
  let animation=result.animation;
  if(!animation?.tracks)throw Error('Missing compiled animation tracks');
  const duration=task.duration;
  const shotPlan=result.shot_plan||result.shotPlan;
  if(!shotPlan&&!legacy)throw Error('Missing shot_plan with business shot IDs and segment_id');
  let shots=shotPlan;
  const cameras=result.animationRegistry?.data?.camera_shots||[];
  if(legacy){
    // Sidecar attribution is a benchmark adapter decision, never silently used for new generation.
    shots=[];let ordinal=0;
    for(const segment of task.segments){
      const intervals=cameras.filter(c=>c.start>=segment.start-1e-6 && c.end<=segment.end+1e-6);
      let t=segment.start;
      for(let i=0;i<segment.shots.length;i++){
        const s=segment.shots[i];const end=s.explicit_duration!=null?t+s.explicit_duration:(intervals.length===segment.shots.length?intervals[i].end:segment.start+(i+1)*segment.duration/segment.shots.length);
        shots.push({id:s.id,segment_id:segment.id,start:t,end,source_number:s.source_number,sidecar:true});t=end;ordinal++;
      }
    }
  }
  for(const tr of animation.tracks){if(tr.target!=='__camera'&&!entries.has(tr.target))throw Error('Track target missing: '+tr.target);}
  host.scene.traverse(o=>{o.userData=metadataJSON(o.userData);});
  host.scene.updateMatrixWorld(true);
  const entities=[...entries.values()].map(e=>({id:e.id,name:e.name||e.object.name,uuid:e.object.uuid,parent:e.object.parent?.uuid,character:!!e.object.userData.characterName}));
  const project={schema_version:SCHEMA_VERSION,engine_version:'0.1.5-cvw.1',source_sha256:sourceHash,revision:0,title:task.title,duration,segments:task.segments.map(({prompt,shots,...s})=>({...s,shot_ids:shots.map(x=>x.id)})),shot_plan:shots,scene:host.scene.toJSON(),camera_uuid:host.camera.uuid,entities,actors:host.helpers.actors,animation,authored_camera_cuts:cameras.map(s=>({id:s.id,start:s.start,end:s.end})),edits:[],provenance:{legacy,metadata:legacy?'Sidecar from original input; camera subdivisions remain separate':'Authored shot_plan',helper_contract:'Observed subset; no official business runtime supplied'},notes:result.notes||[],reference_usage:result.reference_usage||[]};
  return project;
}

function sample(keys,t){
  if(!keys.length)return null;if(t<=keys[0].time)return keys[0].value;
  let lo=0,hi=keys.length-1;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(keys[mid].time<=t)lo=mid;else hi=mid-1;}
  const a=keys[lo],b=keys[lo+1];if(!b||a.interpolation==='step'||typeof a.value==='boolean')return a.value;
  let u=(t-a.time)/(b.time-a.time);if(a.interpolation==='smooth')u=u*u*(3-2*u);
  return Array.isArray(a.value)?a.value.map((v,i)=>v+(b.value[i]-v)*u):a.value+(b.value-a.value)*u;
}
export function loadProject(project) {
  const scene=new THREE.ObjectLoader().parse(project.scene),camera=scene.getObjectByProperty('uuid',project.camera_uuid);
  if(!camera?.isCamera)throw Error('Missing camera');
  const objects={__camera:camera},base=new Map();
  scene.traverse(o=>{base.set(o.uuid,{p:o.position.clone(),q:o.quaternion.clone(),s:o.scale.clone(),visible:o.visible,fov:o.fov,up:o.up.clone()});});
  for(const e of project.entities){const o=scene.getObjectByProperty('uuid',e.uuid);if(!o)throw Error('Missing entity '+e.id);objects[e.id]=o;}
  let current=0;
  function applyTrack(tr,t){
    const o=objects[tr.target];if(!o)throw Error('Missing track target '+tr.target);const value=sample(tr.keys,t);if(value==null)return;
    if(['position','scale','quaternion'].includes(tr.property)){o[tr.property].fromArray(value);if(tr.property==='quaternion')o.quaternion.normalize();}
    else if(tr.property==='rotation')o.rotation.set(...value);
    else if(tr.property==='lookAt')o.lookAt(...value);
    else if(tr.property==='visible')o.visible=value;
    else if(tr.property==='fov')o.fov=value;
    else if(tr.property==='roll')o.rotateZ(value);
    else if(tr.property==='opacity')o.traverse(m=>{if(m.isMesh){for(const mat of Array.isArray(m.material)?m.material:[m.material]){mat.transparent=value<1;mat.opacity=value;}}});
  }
  function setTime(t){
    if(!Number.isFinite(t))throw Error('Invalid time');current=Math.max(0,Math.min(project.duration,t));
    scene.traverse(o=>{const b=base.get(o.uuid);if(b){o.position.copy(b.p);o.quaternion.copy(b.q);o.scale.copy(b.s);o.visible=b.visible;o.up.copy(b.up);if(b.fov!=null)o.fov=b.fov;}});
    for(const tr of project.animation.tracks)if(!['lookAt','roll'].includes(tr.property))applyTrack(tr,current);
    scene.updateMatrixWorld(true);
    for(const tr of project.animation.tracks)if(tr.property==='lookAt')applyTrack(tr,current);
    for(const tr of project.animation.tracks)if(tr.property==='roll')applyTrack(tr,current);
    for(const edit of project.edits||[]){
      if(current<edit.start||current>=edit.end && !(current===project.duration&&edit.end===project.duration))continue;
      const o=objects[edit.entity_id];if(!o)continue;
      if(edit.kind==='translate')o.position.add(new THREE.Vector3(...edit.delta));
      if(edit.kind==='freeze_position')o.position.fromArray(edit.position);
      if(edit.kind==='rotation')o.rotation.set(...edit.rotation);
      if(edit.kind==='visible')o.visible=edit.visible;
    }
    camera.updateProjectionMatrix();scene.updateMatrixWorld(true);return inspectState();
  }
  function inspectState(){
    const states={};for(const [id,o] of Object.entries(objects)){
      const pos=new THREE.Vector3(),q=new THREE.Quaternion();o.getWorldPosition(pos);o.getWorldQuaternion(q);
      let visible=true;for(let n=o;n;n=n.parent)visible&&=n.visible;
      states[id]={position:pos.toArray(),local_position:o.position.toArray(),quaternion:q.toArray(),visible};
    }
    return {time:current,entities:states,camera:{position:camera.position.toArray(),quaternion:camera.quaternion.toArray(),fov:camera.fov}};
  }
  function inspectFocus(check){
    const o=objects[check.entity_id];if(!o)throw Error('Unknown focus entity '+check.entity_id);
    const p=o.getWorldPosition(new THREE.Vector3()),screen=p.clone().project(camera),cam=camera.getWorldPosition(new THREE.Vector3());
    let shown=true;for(let a=o;a;a=a.parent)shown&&=a.visible;
    const direction=p.clone().sub(cam),distance=direction.length(),ray=new THREE.Raycaster(cam,direction.normalize(),camera.near,distance+.01);
    const hit=ray.intersectObjects(scene.children,true).find(h=>{let visible=true;for(let a=h.object;a;a=a.parent)visible&&=a.visible;const m=h.object.material;return visible&&(!m||Array.isArray(m)||!m.transparent||m.opacity>=.5);});
    let own=false;if(hit)for(let a=hit.object;a;a=a.parent)if(a===o)own=true;
    const face=new THREE.Vector3(0,0,1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion())).dot(cam.clone().sub(p).normalize());
    const inFrame=shown&&Math.abs(screen.x)<.98&&Math.abs(screen.y)<.98&&screen.z>-1&&screen.z<1;
    return {entity_id:check.entity_id,time:current,in_frame:inFrame,unoccluded:!hit||own,front_dot:face,pass:inFrame&&(!hit||own)&&(!check.front||face>.15),projection:screen.toArray(),occluder:hit&&!own?hit.object.name||hit.object.parent?.name||hit.object.type:null};
  }
  function dispose(){scene.traverse(o=>{o.geometry?.dispose();for(const m of o.material?(Array.isArray(o.material)?o.material:[o.material]):[])m.dispose();});}
  return {project,scene,camera,objects,setTime,inspectState,inspectFocus,dispose,listEntities:()=>project.entities};
}

export function structuralChecks(project,task){
  const errors=[],warnings=[];const fail=(code,message)=>errors.push({code,message});
  const expected=task.segments.flatMap(s=>s.shots.map(x=>({...x,segment_id:s.id}))),byId=new Map(project.shot_plan.map(s=>[s.id,s]));
  if(project.shot_plan.length!==expected.length||byId.size!==expected.length)fail('shot_count','Missing/duplicate business shots');
  let cursor=0;
  for(let i=0;i<expected.length;i++){
    const e=expected[i],s=project.shot_plan[i],seg=task.segments.find(x=>x.id===e.segment_id);
    if(!s||s.id!==e.id){fail('shot_order','Expected '+e.id);continue;}
    if(s.segment_id!==e.segment_id)fail('segment_id',s.id);
    if(!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.end<=s.start)fail('shot_time',s.id);
    if(Math.abs(s.start-cursor)>.001)fail('timeline_gap',s.id);
    if(s.start<seg.start-.001||s.end>seg.end+.001)fail('segment_boundary',s.id);
    if(e.explicit_duration!=null&&Math.abs(s.end-s.start-e.explicit_duration)>.001)fail('explicit_duration',s.id);
    cursor=s.end;
  }
  if(Math.abs(cursor-task.duration)>.001)fail('total_duration','Incorrect story end');
  let cutCursor=0;
  for(const c of project.authored_camera_cuts){
    if(!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.end<=c.start||Math.abs(c.start-cutCursor)>.001)fail('camera_coverage','Camera cut gap/overlap');
    if(!project.shot_plan.some(s=>c.start>=s.start-.001&&c.end<=s.end+.001))fail('camera_cut_boundary','Camera cut crosses original business shot');
    cutCursor=c.end;
  }
  if(Math.abs(cutCursor-task.duration)>.001)fail('camera_coverage','Camera intervals must cover the entire story');
  if(project.duration>300||Math.abs(project.duration-task.duration)>.001)fail('duration','Incorrect project duration');
  if(!project.animation.tracks.some(x=>x.target==='__camera'))warnings.push({code:'static_camera',message:'No camera animation; check original requested motion'});
  if(!project.provenance.legacy && task.references?.length && !project.reference_usage.length)fail('reference_usage','Reference mapping/evidence missing');
  for(const shot of project.shot_plan)for(const check of shot.focus||[]){
    if(!project.entities.some(e=>e.id===check.entity_id)||!Number.isFinite(check.time)||check.time<shot.start||check.time>=shot.end)fail('focus_contract','Invalid focus target/time in '+shot.id);
  }
  return {pass:errors.length===0,errors,warnings};
}
