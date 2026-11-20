import path from 'node:path';import {fileURLToPath} from 'node:url';import {createRequire} from 'node:module';import assert from 'node:assert/strict';
const R=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),E=R+'/assets/whitebox-seko/releases/'+(process.env.SEKO_TEST_RELEASE??'seko-0.1.10-cvw.1')+'/engine',THREE=createRequire(E+'/package.json')('three'),{loadProject}=await import(E+'/runtime/project.js');
function check(tracks,expected,start=0,end=4){const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(45,1,.1,100),parent=new THREE.Group(),actor=new THREE.Group(),limb=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial());actor.add(limb);parent.add(actor);scene.add(parent,camera);scene.updateMatrixWorld(true);const p={scene:scene.toJSON(),camera_uuid:camera.uuid,entities:[{id:'parent',uuid:parent.uuid},{id:'actor',uuid:actor.uuid,character:true},{id:'limb',uuid:limb.uuid}],duration:4,animation:{tracks},edits:[]};const view=loadProject(p);try{view.setTime(start);assert.equal(view.inspectGeometryRelations(['actor'],start,end).bounds[0].world_root_transform_constant,expected);}finally{view.dispose();}}
const track=(target,keys)=>({target,property:'position',keys:keys.map(([time,value])=>({time,value,interpolation:'linear'}))});
check([],true);check([track('actor',[[0,[0,0,0]],[4,[0,0,0]]])],true);
check([track('actor',[[0,[0,0,0]],[1,[2,0,0]],[2,[0,0,0]],[4,[0,0,0]]])],false);
check([track('parent',[[0,[0,0,0]],[4,[2,0,0]]])],false);
check([track('limb',[[0,[0,0,0]],[4,[2,0,0]]])],true);
check([{target:'actor',property:'position',keys:[{time:0,value:[0,0,0],interpolation:'step'},{time:4,value:[2,0,0]}]}],true);
check([{target:'actor',property:'position',keys:[{time:0,value:[0,0,0],interpolation:'unsupported'},{time:4,value:[2,0,0]}]}],null);
console.log('7 root-motion cases passed: full interval, interior excursion, ancestor movement, child-only motion, boundary step and unknown interpolation');
