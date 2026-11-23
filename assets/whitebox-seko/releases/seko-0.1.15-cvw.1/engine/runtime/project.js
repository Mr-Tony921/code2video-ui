import * as THREE from 'three';

export const SCHEMA_VERSION='0.1.0';

// Only new helper-created, explicitly marked arm meshes participate. Old
// projects without this metadata keep their original replay behavior.
function collectArmLinks(scene){
  const result=[];
  scene.traverse(mesh=>{
    const spec=mesh.userData?.seko_arm_link_v1;if(spec==null)return;
    const target=typeof spec.target==='string'?scene.getObjectByProperty('uuid',spec.target):null;
    if(!mesh.isMesh||mesh.isSkinnedMesh||mesh.isInstancedMesh||!mesh.parent||mesh.matrixAutoUpdate===false||!target||!Array.isArray(spec.start)||spec.start.length!==3||spec.start.some(v=>!Number.isFinite(v))||!Number.isFinite(spec.base_length)||spec.base_length<=0)throw Error('Invalid seko_arm_link_v1');
    result.push({mesh,target,start:new THREE.Vector3(...spec.start),baseLength:spec.base_length});
  });
  const driven=new Set(result.map(r=>r.mesh));
  for(const link of result)for(let p=link.target;p;p=p.parent)if(driven.has(p))throw Error('Cyclic/mesh-driven arm link is unsupported');
  return result;
}
function updateArmLinks(links){
  for(const {mesh,target,start,baseLength} of links){
    const end=mesh.parent.worldToLocal(target.getWorldPosition(new THREE.Vector3()));
    const delta=end.clone().sub(start),length=delta.length();
    mesh.position.copy(start).add(end).multiplyScalar(.5);
    mesh.scale.y=length/baseLength;
    if(length>1e-12)mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.multiplyScalar(1/length));
    else mesh.quaternion.identity();
    mesh.updateMatrixWorld(true);
  }
}
function armDependencies(links,entries){
  const ids=new Map([...entries.values()].map(e=>[e.object,e.id])),result=[];
  for(const {mesh,target} of links){
    const containing=new Set();for(let p=mesh;p;p=p.parent)containing.add(p);
    for(let p=target;p;p=p.parent)if(ids.has(p)&&!containing.has(p))result.push({driver:ids.get(p),mesh_uuid:mesh.uuid,kind:'arm_endpoint'});
  }
  return result;
}

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
  if(!result||typeof result!=='object')throw Error('buildScene must return its result object with animation, animationRegistry, shot_plan and reference_usage; received '+String(result));
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
  // Enforce the fixed cheap human contract for newly authored scenes only.
  // Serialized old projects are replayed by loadProject without reinterpretation.
  if(!legacy)for(const [id,actor] of Object.entries(host.helpers.actors)){
    const root=host.scene.getObjectByProperty('uuid',actor.root);
    if(root?.userData.nonhuman===true)continue;
    if(!root?.userData.seko_human_v2)throw Error('Human '+id+' must use helpers.person: sphere head, box nose, cylinder torso and four rigid cylinder limbs.');
    for(let o=root;o&&o!==host.scene;o=o.parent)if(Math.abs(o.scale.x-o.scale.y)>1e-6||Math.abs(o.scale.y-o.scale.z)>1e-6)throw Error('Nonuniform human ancestor scale: '+id);
  }
  // New rigid helpers use pivot rotation and a fixed hand offset. Old v1
  // projects retain their original replay; never reinterpret a frozen output.
  const protectedTransforms=new Map();
  host.scene.traverse(o=>{
    const rigid=o.userData?.seko_rigid_limb_v1;if(!rigid)return;
    if(!Number.isFinite(rigid.length)||rigid.length<=0)throw Error('Invalid rigid limb '+o.name);
    protectedTransforms.set(o,new Set(['position','scale']));
    if(o.scale.toArray().some(x=>Math.abs(x-1)>1e-6))throw Error('Rigid limb cannot be scaled: '+o.name);
    if(rigid.anchor){
      const hand=host.scene.getObjectByProperty('uuid',rigid.anchor);
      if(!hand||hand.parent!==o||hand.position.distanceTo(new THREE.Vector3(0,-rigid.length,0))>1e-6)throw Error('Rigid hand must stay at its fixed arm endpoint: '+o.name);
      protectedTransforms.set(hand,new Set(['position','scale']));
    }
  });
  for(const tr of animation.tracks){
    const object=entries.get(tr.target)?.object;
    if(protectedTransforms.get(object)?.has(tr.property))throw Error('Rigid limb/hand '+tr.target+' cannot animate '+tr.property+'; rotate the registered shoulder/hip pivot or move the whole actor.');
    if(tr.property==='scale'&&object){
      let containsRigid=false;object.traverse(o=>{if(o.userData?.seko_rigid_limb_v1)containsRigid=true;});
      if(containsRigid&&tr.keys.some(k=>!Array.isArray(k.value)||k.value.some(x=>Math.abs(x-k.value[0])>1e-6)))throw Error('Nonuniform character scale deforms rigid limbs: '+tr.target);
    }
  }
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
  const armLinks=collectArmLinks(host.scene);host.scene.updateMatrixWorld(true);updateArmLinks(armLinks);host.scene.updateMatrixWorld(true);
  const entities=[...entries.values()].map(e=>({id:e.id,name:e.name||e.object.name,uuid:e.object.uuid,parent:e.object.parent?.uuid,character:!!e.object.userData.characterName}));
  const project={schema_version:SCHEMA_VERSION,engine_version:'0.1.15-cvw.1',source_sha256:sourceHash,revision:0,title:task.title,duration,segments:task.segments.map(({prompt,shots,...s})=>({...s,shot_ids:shots.map(x=>x.id)})),shot_plan:shots,scene:host.scene.toJSON(),camera_uuid:host.camera.uuid,entities,actors:host.helpers.actors,dynamic_dependencies:armDependencies(armLinks,entries),animation,authored_camera_cuts:cameras.map(s=>({id:s.id,start:s.start,end:s.end})),edits:[],provenance:{legacy,metadata:legacy?'Sidecar from original input; camera subdivisions remain separate':'Authored shot_plan',helper_contract:'Observed subset; no official business runtime supplied'},notes:result.notes||[],reference_usage:result.reference_usage||[]};
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
  const armLinks=collectArmLinks(scene);
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
    scene.updateMatrixWorld(true);updateArmLinks(armLinks);
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
    // An object's root may sit on the floor, outside its visible geometry.
    // Preserve explicit Mesh/empty-anchor checks; composite Groups use the
    // visible geometry's world-space center, never hidden descendants.
    // Opacity below .5 can be plainly visible (glass/glow). It is not an
    // opaque blocker, but must not be discarded as target geometry. Actual
    // point evidence and visual review remain required; alpha=0 stays hidden.
    const contributes=m=>m&&m.visible!==false&&m.colorWrite!==false&&(!m.transparent||m.opacity>0)&&(!m.alphaTest||m.opacity>=m.alphaTest);
    const ownObject=object=>{for(let a=object;a;a=a.parent)if(a===o)return true;return false;};
    const relevantHit=h=>{let visible=true;for(let a=h.object;a;a=a.parent)visible&&=a.visible;const m=Array.isArray(h.object.material)?h.object.material[h.face?.materialIndex??0]:h.object.material;return visible&&(ownObject(h.object)?contributes(m):(!m||(m.visible!==false&&(!m.transparent||m.opacity>=.5))));};
    const p=o.getWorldPosition(new THREE.Vector3());let anchor='object_origin',geometryHidden=false;
    if(o.isGroup){
      const box=new THREE.Box3();let hasGeometry=false;
      o.traverse(child=>{
        if(!child.isMesh||!child.geometry)return;hasGeometry=true;
        let visible=true;for(let n=child;n;n=n.parent)visible&&=n.visible;
        const mats=Array.isArray(child.material)?child.material:[child.material];
        if(!visible||!mats.some(contributes))return;
        child.geometry.computeBoundingBox();box.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld));
      });
      if(!box.isEmpty()){box.getCenter(p);anchor='visible_geometry_center';}else geometryHidden=hasGeometry;
    }
    const screen=p.clone().project(camera),cam=camera.getWorldPosition(new THREE.Vector3());
    let shown=!geometryHidden;for(let a=o;a;a=a.parent)shown&&=a.visible;
    const direction=p.clone().sub(cam),distance=direction.length(),ray=new THREE.Raycaster(cam,direction.normalize(),camera.near,distance+.01);
    const hit=ray.intersectObjects(scene.children,true).find(relevantHit);
    let own=false;if(hit)for(let a=hit.object;a;a=a.parent)if(a===o)own=true;
    const face=new THREE.Vector3(0,0,1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion())).dot(cam.clone().sub(p).normalize());
    const inFrame=shown&&Math.abs(screen.x)<.98&&Math.abs(screen.y)<.98&&screen.z>-1&&screen.z<1;
    const centerOccluder=hit&&!own?hit.object.name||hit.object.parent?.name||hit.object.type:null;
    // A composite's empty center is not a surface: a visible ring/arch may
    // surround another object. Only for a blocked, in-frame Group center,
    // check bounded real triangle surfaces. Empty space never counts as proof.
    // This is point visibility, not proof of semantic readability; visual
    // review still sees the complete unchanged frame and these observations.
    const surface={tested:0,visible:0,points:[]};
    if(o.isGroup&&inFrame&&hit&&!own){
      const meshes=[];o.traverse(m=>{
        let visible=true;for(let a=m;a;a=a.parent)visible&&=a.visible;
        if(m.isMesh&&!m.isSkinnedMesh&&!m.isInstancedMesh&&visible&&m.geometry?.attributes?.position)meshes.push(m);
      });
      // Oversized/composite assets get evenly distributed observations.
      for(let k=0;k<Math.min(24,meshes.length);k++){
        const m=meshes[Math.floor(k*meshes.length/Math.min(24,meshes.length))],g=m.geometry,pos=g.attributes.position,idx=g.index;
        const start=Math.max(0,g.drawRange.start||0),end=Math.min(idx?idx.count:pos.count,start+g.drawRange.count),triangles=Math.floor((end-start)/3);
        for(let j=0;j<Math.min(12,triangles);j++){
          const offset=start+3*Math.floor(j*triangles/Math.min(12,triangles)),group=g.groups.find(x=>offset>=x.start&&offset<x.start+x.count),mat=Array.isArray(m.material)?m.material[group?.materialIndex??0]:m.material;
          if(!contributes(mat))continue;
          const point=new THREE.Vector3();for(let a=0;a<3;a++)point.add(new THREE.Vector3().fromBufferAttribute(pos,idx?idx.getX(offset+a):offset+a));point.multiplyScalar(1/3).applyMatrix4(m.matrixWorld);
          const projection=point.clone().project(camera);surface.tested++;
          if(Math.abs(projection.x)>=.98||Math.abs(projection.y)>=.98||projection.z<=-1||projection.z>=1)continue;
          const d=point.clone().sub(cam),length=d.length(),r=new THREE.Raycaster(cam,d.normalize(),camera.near,length+1e-4);
          const first=r.intersectObjects(scene.children,true).find(relevantHit);
          let belongs=false;if(first)for(let a=first.object;a;a=a.parent)if(a===o)belongs=true;
          if(belongs){surface.visible++;if(surface.points.length<8)surface.points.push({position:point.toArray(),projection:projection.toArray()});}
        }
      }
    }
    const unoccluded=!hit||own||surface.visible>=2;
    return {entity_id:check.entity_id,time:current,anchor,anchor_position:p.toArray(),in_frame:inFrame,unoccluded,front_dot:face,pass:inFrame&&unoccluded&&(!check.front||face>.15),projection:screen.toArray(),occluder:unoccluded?null:centerOccluder,center_occluder:centerOccluder,surface_observations:surface};
  }
  function constantWorldTransform(object,start,end){
    const chain=new Set();for(let a=object;a;a=a.parent)chain.add(a);
    const ids=new Set(Object.entries(objects).filter(([id,o])=>chain.has(o)).map(([id])=>id));
    if((project.edits||[]).some(e=>ids.has(e.entity_id)&&e.start<end&&e.end>start&&['translate','freeze_position','rotation'].includes(e.kind)))return false;
    const last=Math.max(start,end-1e-9),properties=new Set(['position','scale','rotation','quaternion','lookAt','roll']);
    for(const track of project.animation.tracks){
      if(!ids.has(track.target)||!properties.has(track.property))continue;
      if(track.keys.some(k=>k.interpolation&&!['linear','smooth','step'].includes(k.interpolation)))return null;
      const times=[start,last,...track.keys.filter(k=>k.time>start&&k.time<end).map(k=>k.time)];
      const values=times.map(t=>JSON.stringify(sample(track.keys,t)));if(values.some(v=>v!==values[0]))return false;
    }
    return true;
  }
  function inspectGeometryRelations(ids,start=current,end=current){
    const entries=new Map(project.entities.map(e=>[e.uuid,e])),targets=new Map();
    for(const id of ids){
      let object=objects[id],resolved=id;if(!object)continue;
      // Declared head/hand anchors may belong to a registered character.
      // Use the proven hierarchy, never infer actor identity from an ID name.
      for(let a=object;a;a=a.parent)if(entries.get(a.uuid)?.character){object=a;resolved=entries.get(a.uuid).id;break;}
      targets.set(resolved,object);
    }
    const bounds=[];
    for(const [id,object] of targets){
      const box=new THREE.Box3();let unsupported=false;
      object.traverse(child=>{
        let shown=true;for(let a=child;a;a=a.parent)shown&&=a.visible;
        if(!shown||!child.isMesh||!child.geometry)return;
        if(child.isSkinnedMesh||child.isInstancedMesh){unsupported=true;return;}
        const mats=Array.isArray(child.material)?child.material:[child.material];
        if(!mats.some(m=>m&&m.visible!==false&&m.colorWrite!==false&&(!m.transparent||m.opacity>=.5)&&(!m.alphaTest||m.opacity>=m.alphaTest)))return;
        child.geometry.computeBoundingBox();box.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld));
      });
      bounds.push({id,world_root_transform_constant:constantWorldTransform(object,start,end),box:unsupported||box.isEmpty()?null:[box.min.toArray(),box.max.toArray()],unknown_reason:unsupported?'unsupported_deformed_geometry':box.isEmpty()?'no_visible_opaque_geometry':null});
    }
    const pairs=[];
    for(let i=0;i<bounds.length;i++)for(let j=i+1;j<bounds.length;j++){
      const a=bounds[i],b=bounds[j];if(!a.box||!b.box){pairs.push({a:a.id,b:b.id,gap:null});continue;}
      const axes=[0,1,2].map(k=>Math.max(0,a.box[0][k]-b.box[1][k],b.box[0][k]-a.box[1][k]));pairs.push({a:a.id,b:b.id,gap:Math.hypot(...axes),axis_gaps:axes});
    }
    return {policy:'Visible opaque geometry AABB lower-bound gap, in scene units. Positive gap proves these opaque surfaces are disjoint. Zero does NOT prove actual contact. Translucent effects omitted; missing/unsupported bounds are unknown. Character roots resolved from registered hierarchy.',bounds,pairs};
  }
  function dispose(){scene.traverse(o=>{o.geometry?.dispose();for(const m of o.material?(Array.isArray(o.material)?o.material:[o.material]):[])m.dispose();});}
  return {project,scene,camera,objects,setTime,inspectState,inspectFocus,inspectGeometryRelations,dispose,listEntities:()=>project.entities};
}

export function structuralChecks(project,task){
  const errors=[],warnings=[];const fail=(code,message,shot_id)=>errors.push({code,message,...(shot_id?{shot_id}:{})});
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
    if(!project.entities.some(e=>e.id===check.entity_id)||!Number.isFinite(check.time)||check.time<shot.start||check.time>=shot.end)fail('focus_contract','Invalid focus target/time in '+shot.id,shot.id);
  }
  return {pass:errors.length===0,errors,warnings};
}

// Bounded advisory facts for visual review. These never independently mark a
// scene good/bad: a deliberate insert/POV can crop a registered root or head.
export function subjectObservations(project) {
  const view=loadProject(project),rows=[];
  try {
    for(const shot of project.shot_plan){
      const subjects=[...new Set(shot.camera_plan?.subjects||[])],samples=[];
      for(const time of [shot.start+Math.min(.001,(shot.end-shot.start)/10),(shot.start+shot.end)/2,shot.end-.001]){
        view.setTime(time);samples.push({time,geometry_relations:view.inspectGeometryRelations(subjects,shot.start,shot.end),subjects:subjects.map(id=>{
          if(!view.objects[id])return {id,missing_entity:true};
          const c=view.inspectFocus({entity_id:id});
          return {id,position:c.anchor_position,in_frame:c.in_frame,point_visible:c.unoccluded,occluder:c.occluder,
            head:view.objects[id+'_head']?(()=>{const h=view.inspectFocus({entity_id:id+'_head'});return {in_frame:h.in_frame,point_visible:h.unoccluded,occluder:h.occluder};})():null};
        })});
      }
      rows.push({shot_id:shot.id,samples});
    }
  }finally{view.dispose();}
  return {scope:'Declared camera subjects at start/middle/end; finite points, not silhouette/semantic certification. Use actual screenshots and original required event. Intentional insert/POV crops can be correct.',shots:rows};
}
