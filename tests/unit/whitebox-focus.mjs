import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
const L=path.dirname(fileURLToPath(import.meta.url)),R=path.resolve(L,'../..');const E=R+'/assets/whitebox-seko/releases/'+(process.env.SEKO_TEST_RELEASE??'seko-0.1.10-cvw.1')+'/engine';const require=createRequire(E+'/package.json'),THREE=require('three');const {loadProject}=await import(E+'/runtime/project.js');
const results=[];
function check(name,mutate,expected){
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(45,16/9,.1,100);camera.position.set(0,3,8);camera.lookAt(0,1,0);scene.add(camera);
 const group=new THREE.Group();group.name='car';const body=new THREE.Mesh(new THREE.BoxGeometry(2,1,2),new THREE.MeshBasicMaterial());body.position.y=1;group.add(body);scene.add(group);
 const floor=new THREE.Mesh(new THREE.BoxGeometry(20,.2,20),new THREE.MeshBasicMaterial());floor.position.y=-.1;floor.name='street';scene.add(floor);mutate({scene,camera,group,body});scene.updateMatrixWorld(true);
 const p={scene:scene.toJSON(),camera_uuid:camera.uuid,entities:[{id:'car',uuid:group.uuid}],duration:10,animation:{tracks:[]},edits:[]};const v=loadProject(p);v.setTime(1);const r=v.inspectFocus({entity_id:'car',time:1});assert.equal(r.pass,expected,name+JSON.stringify(r));results.push({name,...r});v.dispose();
}
check('floor-origin group uses visible geometry',()=>{},true);
check('opaque wall remains blocker',({scene})=>{const w=new THREE.Mesh(new THREE.BoxGeometry(20,20,.2),new THREE.MeshBasicMaterial());w.position.z=3;scene.add(w);},false);
check('offscreen remains blocker',({group})=>{group.position.x=50;},false);
check('hidden parent remains blocker',({group})=>{group.visible=false;},false);
check('hidden children cannot count as visible',({body})=>{body.visible=false;},false);
check('visible center follows translation and scale',({group})=>{group.position.x=1;group.scale.setScalar(.8);},true);

function arch({scene,camera,group,body}){
 group.remove(body);camera.position.set(0,1,8);camera.lookAt(0,1,0);
 for(const [x,y,w,h] of [[-1,1,.3,2],[1,1,.3,2],[0,2,2,.3]]){const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,.3),new THREE.MeshBasicMaterial());b.position.set(x,y,0);group.add(b);}
 const head=new THREE.Mesh(new THREE.SphereGeometry(.7,12,8),new THREE.MeshBasicMaterial());head.position.set(0,1,1);head.name='head';scene.add(head);
}
check('visible arch around head is not blocked by empty center',arch,true);
assert(results.at(-1).surface_observations.visible>=2);assert.equal(results.at(-1).center_occluder,'head');
check('arch surfaces behind complete opaque wall still fail',ctx=>{arch(ctx);const wall=new THREE.Mesh(new THREE.BoxGeometry(20,20,.3),new THREE.MeshBasicMaterial());wall.position.set(0,1,3);ctx.scene.add(wall);},false);
check('hidden arch surface cannot rescue center',ctx=>{arch(ctx);ctx.group.children.forEach(x=>x.visible=false);},false);
check('transparent hidden arch surface cannot rescue center',ctx=>{arch(ctx);ctx.group.children.forEach(x=>{x.material.transparent=true;x.material.opacity=0;});},false);
check('partly transparent target still contributes visible pixels',({body})=>{body.material.transparent=true;body.material.opacity=.25;},true);
check('visible transparent arch around head has real surface evidence',ctx=>{arch(ctx);ctx.group.children.forEach(x=>{x.material.transparent=true;x.material.opacity=.25;});},true);
assert(results.at(-1).surface_observations.visible>=2);
check('transparent target behind opaque wall still fails',ctx=>{arch(ctx);ctx.group.children.forEach(x=>{x.material.transparent=true;x.material.opacity=.25;});const wall=new THREE.Mesh(new THREE.BoxGeometry(20,20,.3),new THREE.MeshBasicMaterial());wall.position.set(0,1,3);ctx.scene.add(wall);},false);
check('alpha-tested discarded geometry cannot count as visible',({body})=>{body.material.transparent=true;body.material.opacity=.25;body.material.alphaTest=.5;},false);
console.log('focus cases passed',results.length);
