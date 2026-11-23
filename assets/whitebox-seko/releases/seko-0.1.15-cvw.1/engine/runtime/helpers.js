import * as THREE from 'three';

const clone = value => JSON.parse(JSON.stringify(value));
const PROPERTIES = new Set(['position','rotation','quaternion','scale','visible','fov','lookAt','roll','opacity']);

/** Observed business helper contract; animation callbacks compile into absolute tracks. */
export function createHelpers(scene, camera, task=null) {
  const registered = new Map(), actors = {}, warnings=[];
  const material = c => c?.isMaterial ? c : new THREE.MeshStandardMaterial({color:c ?? '#bfc4c7',roughness:.9});
  function mesh(geometry, at, color, parent=scene) {
    const object=new THREE.Mesh(geometry,material(color));
    object.position.fromArray(at);parent.add(object);return object;
  }
  function register(id,name,object) {
    if(registered.has(id) && registered.get(id).object!==object)throw Error('Duplicate entity '+id);
    object.userData.technicalId=id;object.name=name;
    // Backward-compatible adapter for models that confuse a registered entry with its Group.
    if(!Object.hasOwn(object,'object'))Object.defineProperty(object,'object',{get:()=>object,enumerable:false});
    registered.set(id,{id,name,object});return object;
  }
  const h={
    warnings,registered,actors,material,
    worldPosition:(id,offset=[0,0,0])=>{const entry=registered.get(id);if(!entry)throw Error('Unknown entity '+id);entry.object.updateWorldMatrix(true,false);return entry.object.localToWorld(new THREE.Vector3(...offset)).toArray();},
    box:(size,at,color,parent)=>mesh(new THREE.BoxGeometry(...size),at,color,parent),
    sphere:(r,at,color,parent)=>mesh(new THREE.SphereGeometry(r,12,8),at,color,parent),
    cylinder:(r,height,at,color,parent)=>mesh(new THREE.CylinderGeometry(r,r,height,12),at,color,parent),
    bar:(a,b,r,color,parent)=>{
      const u=new THREE.Vector3(...a),v=new THREE.Vector3(...b),delta=v.clone().sub(u);
      const m=mesh(new THREE.CylinderGeometry(r,r,delta.length(),8),u.clone().add(v).multiplyScalar(.5).toArray(),color,parent);
      if(delta.length())m.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());return m;
    },
    group:(id,name,at=[0,0,0],parent=scene)=>{const g=register(id,name,new THREE.Group());g.position.fromArray(at);parent.add(g);return g;},
    registerActor:(id,root,anchors={})=>{actors[id]={root:root.uuid,anchors:Object.fromEntries(Object.entries(anchors).map(([k,v])=>[k,v.uuid]))};root.userData.characterName ||= root.name;},
    planScene:spec=>{
      const world=clone(spec);
      world.landmark=id=>{const p=spec.landmarks?.find(x=>x.id===id);if(!p)throw Error('Unknown landmark '+id);return {...p,position:new THREE.Vector3(...p.position)};};
      world.band=id=>({geometry:()=>{
        const band=spec.bands?.find(x=>x.id===id),corridor=spec.corridors?.find(x=>x.id===band?.corridor);
        if(!band||!corridor)throw Error('Unknown band '+id);
        const points=corridor.points.map(p=>new THREE.Vector3(...p)),vertices=[],indices=[];
        points.forEach((p,i)=>{
          const delta=points[Math.min(i+1,points.length-1)].clone().sub(points[Math.max(0,i-1)]);
          const right=new THREE.Vector3(delta.z,0,-delta.x).normalize();
          for(const side of [band.from??-.5,band.to??.5]){const v=p.clone().addScaledVector(right,side*corridor.width);v.y+=band.height||0;vertices.push(...v.toArray());}
          if(i){const a=(i-1)*2;indices.push(a,a+2,a+1,a+1,a+2,a+3);}
        });
        const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));g.setIndex(indices);g.computeVertexNormals();return g;
      }});
      return world;
    },
    shot:(position,target,fov=50)=>{camera.position.fromArray(position);camera.lookAt(...target);camera.fov=fov;camera.updateProjectionMatrix();},
  };
  h.person=(id,name,at,options={})=>{
    const {height=1.75,color='#b7bec4',yaw=0}=options;
    const pose=options.pose==='sit'?'sit':'stand';
    if(options.pose&&!['stand','sit'].includes(options.pose))warnings.push(id+': optional pose simplified to safe stand');
    const g=h.group(id,name,at);g.rotation.y=yaw;g.userData.characterName=name;
    g.userData.seko_human_v2={height,pose,front:'+Z',parts:7};
    const hip=height*(pose==='sit'?.30:.50)+.025,shoulder=hip+height*.30;
    const body=h.group(id+'_body','躯干',[0,0,0],g),head=h.group(id+'_head','头部',[0,hip+height*.40,0],g);
    h.sphere(height*.10,[0,0,0],color,head);
    h.box([height*.04,height*.04,height*.06],[0,0,height*.10],'#59636c',head);
    h.cylinder(height*.10,height*.30,[0,(hip+shoulder)/2,0],color,body);
    const anchors={Head:head,Hips:body};
    for(const sign of [-1,1]){
      const side=sign<0?'left':'right',armLength=height*.36,legLength=height*.50;
      const arm=h.group(id+'_'+side+'_arm',sign<0?'左肩转轴':'右肩转轴',[sign*height*.16,shoulder,0],body);
      h.cylinder(height*.035,armLength,[0,-armLength/2,0],color,arm);
      const hand=h.group(id+'_'+side+'_hand',sign<0?'左手锚点':'右手锚点',[0,-armLength,0],arm);
      arm.userData.seko_rigid_limb_v1={kind:'arm',length:armLength,anchor:hand.uuid};
      const leg=h.group(id+'_'+side+'_leg',sign<0?'左髋转轴':'右髋转轴',[sign*height*.09,hip,0],body);
      h.cylinder(height*.045,legLength,[0,-legLength/2,0],color,leg);
      leg.rotation.x=pose==='sit'?-Math.acos(Math.min(1,(hip-.025)/legLength)):0;
      leg.userData.seko_rigid_limb_v1={kind:'leg',length:legLength};
      anchors[sign<0?'LeftHand':'RightHand']=hand;
    }
    h.registerActor(id,g,anchors);return g;
  };
  h.yawTo=(from,to)=>Math.atan2(to[0]-from[0],to[2]-from[2]);
  // Points are authored in the actor parent's local space. Waypoints must route
  // through real openings; this helper aligns facing, it is not a path finder.
  h.moveActor=(anim,id,keys,{faceTravel=true}={})=>{
    const actor=registered.get(id)?.object;if(!actor)throw Error('Unknown actor '+id);
    if(!Array.isArray(keys)||keys.length<2)throw Error('moveActor needs timed waypoints');
    h.track(anim,id,'position',keys);
    if(faceTravel){
      let yaw=actor.rotation.y;
      for(let i=0;i<keys.length-1;i++){
        const [t,p]=keys[i],q=keys[i+1][1];if(Math.hypot(q[0]-p[0],q[2]-p[2])<1e-6)continue;
        let next=h.yawTo(p,q);while(next-yaw>Math.PI)next-=2*Math.PI;while(next-yaw<-Math.PI)next+=2*Math.PI;yaw=next;
        anim.key(id,'rotation',t,[0,yaw,0],'step');
      }
      anim.key(id,'rotation',keys.at(-1)[0],[0,yaw,0],'step');
    }
  };
  h.makeShotPlan=(durations)=>{
    if(!task)throw Error('Task needed for shot plan');const result=[];
    task.segments.forEach((seg,i)=>{let cursor=seg.start;
      if(durations?.[i] && durations[i].length!==seg.shots.length)throw Error('Duration count differs in segment '+seg.id);
      seg.shots.forEach((shot,j)=>{
        const duration=durations?.[i]?.[j]??shot.explicit_duration;
        if(!Number.isFinite(duration)||duration<=0)throw Error('Choose a positive duration for '+shot.id);
        if(shot.explicit_duration!=null&&Math.abs(shot.explicit_duration-duration)>.001)throw Error('Changed explicit shot duration '+shot.id);
        result.push({id:shot.id,segment_id:seg.id,source_number:shot.source_number,start:cursor,end:cursor+duration});cursor+=duration;
      });
      if(Math.abs(cursor-seg.end)>.001)throw Error('Shot durations do not fill segment '+seg.id);
    });Object.defineProperty(result,'shots',{get:()=>result,enumerable:false});return result;
  };
  h.track=(anim,id,property,keys,interpolation='linear')=>{for(const [t,v] of keys)anim.key(id,property,t,v,interpolation);};
  h.cameraTimeline=(anim,shots)=>{
    anim.data('camera_shots',shots);
    shots.forEach((s,i)=>{
      if(!s.keys?.length)throw Error('Missing camera keys '+s.id);
      const keys=s.keys.map(k=>({...k,target:k.target||k.lookAt}));
      for(const k of keys)if(k.time<s.start-.001||k.time>s.end+.001)throw Error('Camera key crosses cut '+s.id);
      const end=i===shots.length-1?s.end:s.end-.0001;
      function add(k){
        anim.key('__camera','position',k.time,k.position);
        if(k.target)anim.key('__camera','lookAt',k.time,k.target);
        else if(k.rotation)anim.key('__camera','rotation',k.time,k.rotation);
        else throw Error('Camera key needs target or rotation');
        anim.key('__camera','fov',k.time,k.fov??50);anim.key('__camera','roll',k.time,k.roll??0);
      }
      for(const k of keys)if(k.time<=end)add(k);
      let a=keys[0],b=a;for(const k of keys){if(k.time<=end)a=k;else{b=k;break;}b=a;}
      const u=b.time>a.time?(end-a.time)/(b.time-a.time):0,final={time:end};
      for(const field of ['position','target','rotation'])if(a[field])final[field]=a[field].map((v,j)=>v+((b[field]||a[field])[j]-v)*u);
      final.fov=(a.fov??50)+((b.fov??50)-(a.fov??50))*u;final.roll=(a.roll??0)+((b.roll??0)-(a.roll??0))*u;add(final);
    });
  };
  h.createAnimationRegistry=({entities=[],duration,world={}}={})=>{
    const data={},programs=new Map(),bindings=[],tracks=new Map();let compiled=false;
    const add=(id,property,time,value,interpolation='linear')=>{
      if(!PROPERTIES.has(property))throw Error('Unsupported track property '+property);
      if(!Number.isFinite(time)||time<0||time>duration+1e-6)throw Error('Key time outside story: '+id+' '+time);
      if(!['linear','step','smooth'].includes(interpolation))throw Error('Unknown interpolation '+interpolation);
      if(property==='visible' && typeof value!=='boolean')throw Error('Visibility must be boolean');
      const nums=Array.isArray(value)?value:[value];if(property!=='visible'&&nums.some(v=>!Number.isFinite(v)))throw Error('Nonfinite key '+id);
      const key=id+'\0'+property;if(!tracks.has(key))tracks.set(key,{target:id,property,keys:[]});
      tracks.get(key).keys.push({time,value:clone(value),interpolation});
    };
    const api={
      data:(id,value)=>{if(compiled)throw Error('Registry already compiled');data[id]=clone(value);return api;},
      program:(id,fn)=>{programs.set(id,fn);return api;},
      bind:(target,program,params={},options={})=>{bindings.push({target,program,params:clone(params),options:clone(options)});return api;},
      key:(target,property,time,value,interpolation='linear')=>{add(target,property,time,value,interpolation);return api;},
      build:()=>{
        if(!compiled){
          for(const b of bindings){
            const fn=programs.get(b.program);if(!fn)throw Error('Missing animation program '+b.program);
            const m={key:add,input:name=>{const input=b.options.inputs?.[name];if(!input)throw Error('Missing input '+name);if(!Object.hasOwn(data,input.data))throw Error('Missing data '+input.data);return clone(data[input.data]);}};
            fn(m,{...clone(b.params),id:b.target});
          }
          for(const tr of tracks.values()){
            const unique=new Map();for(const k of tr.keys)unique.set(k.time,k);
            tr.keys=[...unique.values()].sort((a,b)=>a.time-b.time);
          }
          compiled=true;
        }
        return {duration,tracks:clone([...tracks.values()])};
      },
      describe:()=>({version:1,duration,data:clone(data),bindings:clone(bindings),world:clone(world)}),
    };return api;
  };
  return h;
}

export function createHost(task=null) {
  const scene=new THREE.Scene();scene.background=new THREE.Color('#b9c2c7');
  scene.add(new THREE.HemisphereLight('#ffffff','#5f6872',2));
  const light=new THREE.DirectionalLight('#fff6e5',2.5);light.position.set(-12,24,18);scene.add(light);
  const camera=new THREE.PerspectiveCamera(50,16/9,.02,3000);camera.name='剧情相机';scene.add(camera);
  return {scene,camera,helpers:createHelpers(scene,camera,task)};
}
