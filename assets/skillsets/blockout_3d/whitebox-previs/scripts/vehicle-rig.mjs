// Read-only inspection registry: observe actual nodes without replacing generated animation.
const auditRigs=[];
export function auditVehicleRigs() {
  const axis=(node,v)=>v.clone().transformDirection(node.matrixWorld).toArray();
  return auditRigs.map(r=>{
    r.root.updateWorldMatrix(true,true);
    let ancestor=r.root,attached=false,visible=true;
    while(ancestor){if(ancestor.isScene)attached=true;visible=visible&&ancestor.visible;ancestor=ancestor.parent;}
    const common={kind:r.kind,uuid:r.root.uuid,attached,visible};
    if(r.kind==='wheel')return {...common,radius:r.radius,distance:r.distance,
      steer:r.root.rotation.y,spin:r.rolling.rotation.x,otherSpinAxes:[r.rolling.rotation.y,r.rolling.rotation.z],
      geometryAxisWorld:axis(r.mesh,new r.THREE.Vector3(1,0,0)),spinAxisWorld:axis(r.rolling,new r.THREE.Vector3(1,0,0))};
    return {...common,angle:r.rotor.rotation.z,otherSpinAxes:[r.rotor.rotation.x,r.rotor.rotation.y],
      ringNormalWorld:axis(r.mesh,new r.THREE.Vector3(0,0,1)),shaftAxisWorld:axis(r.root,new r.THREE.Vector3(0,0,1)),
      gripQueries:r.gripQueries};
  });
}
if(typeof window!=='undefined')window.previsVehicleAudit=auditVehicleRigs;

// Vehicle local coordinates: +Z forward, +Y up, +X right. No dependency on a specific THREE build.
export function createWheelRig(THREE, {radius=0.33, width=0.24, side=1, material, markerMaterial}={}) {
  if (!(radius>0 && width>0) || ![1,-1].includes(side)) throw Error('Invalid wheel dimensions/side');
  const steering = new THREE.Group(), rolling = new THREE.Group();
  steering.add(rolling);
  const rubber = material || new THREE.MeshLambertMaterial({color:0x25282c});
  const paint = markerMaterial || new THREE.MeshLambertMaterial({color:0xbac1ca});
  const geometry = new THREE.CylinderGeometry(radius,radius,width,16);
  geometry.rotateZ(-Math.PI/2); // bake default Y cylinder axis into X; keep rolling node uncorrected.
  const mesh=new THREE.Mesh(geometry,rubber);rolling.add(mesh);
  const audit={kind:'wheel',THREE,root:steering,rolling,mesh,radius,distance:0};auditRigs.push(audit);
  const marker = new THREE.Mesh(new THREE.BoxGeometry(0.018,radius*0.7,0.04),paint);
  marker.position.set(side*(width/2+0.012),radius*0.45,0);
  rolling.add(marker);
  return {root:steering, steering, rolling, radius,
    setState(signedDistance, steerAngle=0) {
      if (!Number.isFinite(signedDistance) || !Number.isFinite(steerAngle)) throw Error('Non-finite wheel state');
      audit.distance=signedDistance;
      steering.rotation.y=steerAngle;
      rolling.rotation.x=signedDistance/radius; // +Z travel: +X angular velocity gives rearward contact velocity.
    }};
}

export function createSteeringRig(THREE, {radius=0.23, axis=new THREE.Vector3(0,0,1), material}={}) {
  if (!(radius>0) || !(axis.lengthSq()>0)) throw Error('Invalid steering radius/axis');
  const mount = new THREE.Group(), rotor = new THREE.Group();
  mount.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),axis.clone().normalize());
  mount.add(rotor);
  const mat=material || new THREE.MeshLambertMaterial({color:0x89929d});
  // TorusGeometry lies in XY with normal Z; rotor Z is therefore its physical shaft axis.
  const mesh=new THREE.Mesh(new THREE.TorusGeometry(radius,0.03,8,24),mat);rotor.add(mesh);
  const audit={kind:'steering',THREE,root:mount,rotor,mesh,gripQueries:0};auditRigs.push(audit);
  for(let i=0;i<3;i++) {
    const spokeRoot=new THREE.Group();spokeRoot.rotation.z=i*2*Math.PI/3;
    const spoke=new THREE.Mesh(new THREE.BoxGeometry(0.025,radius,0.025),mat);
    spoke.position.y=radius/2;spokeRoot.add(spoke);rotor.add(spokeRoot);
  }
  const shaftGeometry=new THREE.CylinderGeometry(0.018,0.018,0.35,8);
  shaftGeometry.rotateX(Math.PI/2);
  const shaft=new THREE.Mesh(shaftGeometry,mat);shaft.position.z=0.175;mount.add(shaft);
  return {root:mount, rotor,
    setAngle(angle) {
      if (!Number.isFinite(angle)) throw Error('Non-finite steering angle');
      rotor.rotation.z=angle;
    },
    gripWorld(angleOnRing, target=new THREE.Vector3()) {
      audit.gripQueries++;
      mount.updateWorldMatrix(true,true);
      target.set(radius*Math.cos(angleOnRing),radius*Math.sin(angleOnRing),0);
      return rotor.localToWorld(target);
    }};
}

// Bake signed speed once. Subsequent calls seek by t, including backwards/random access.
export function bakeTravelDistance(speedAt, duration, steps=Math.max(240,Math.ceil(duration*240))) {
  if (!(duration>0) || !Number.isInteger(steps) || steps<1) throw Error('Invalid travel interval');
  const dt=duration/steps, distances=new Float64Array(steps+1);
  let previous=speedAt(0);
  if (!Number.isFinite(previous)) throw Error('Non-finite speed');
  for(let i=1;i<=steps;i++) {
    const speed=speedAt(i*dt);
    if (!Number.isFinite(speed)) throw Error('Non-finite speed');
    distances[i]=distances[i-1]+(previous+speed)*dt/2;previous=speed;
  }
  return t=> {
    if (!Number.isFinite(t)) throw Error('Non-finite time');
    const u=Math.max(0,Math.min(duration,t))/dt, i=Math.min(steps-1,Math.floor(u));
    return distances[i]+(distances[i+1]-distances[i])*(u-i);
  };
}
