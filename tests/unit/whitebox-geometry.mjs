import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createRequire} from 'node:module';import assert from 'node:assert/strict';
const R=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),E=R+'/assets/whitebox-seko/releases/'+(process.env.SEKO_TEST_RELEASE??'seko-0.1.10-cvw.1')+'/engine',THREE=createRequire(E+'/package.json')('three'),{loadProject,subjectObservations}=await import(E+'/runtime/project.js');
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(45,16/9,.1,100);camera.position.set(0,2,8);camera.lookAt(0,1,0);scene.add(camera);
const actor=new THREE.Group(),body=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial()),head=new THREE.Group();body.position.y=.5;actor.add(body);head.position.y=.8;head.add(new THREE.Mesh(new THREE.BoxGeometry(.2,.2,.2),new THREE.MeshBasicMaterial()));actor.add(head);
const glow=new THREE.Mesh(new THREE.BoxGeometry(3,3,3),new THREE.MeshBasicMaterial({transparent:true,opacity:.2}));actor.add(glow);scene.add(actor);
const rock=new THREE.Group();rock.position.y=2;rock.add(new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial()));scene.add(rock);scene.updateMatrixWorld(true);
const project={scene:scene.toJSON(),camera_uuid:camera.uuid,entities:[{id:'person-opaque',uuid:actor.uuid,character:true},{id:'arbitrary-anchor',uuid:head.uuid},{id:'load',uuid:rock.uuid}],duration:10,animation:{tracks:[{target:'load',property:'position',keys:[{time:0,value:[0,2,0]},{time:10,value:[0,1.5,0]}]}]},edits:[],shot_plan:[{id:'s1',start:0,end:10,camera_plan:{subjects:['arbitrary-anchor','load']}}]};const before=JSON.stringify(project),v=loadProject(project);
try{
 v.setTime(0);let r=v.inspectGeometryRelations(['arbitrary-anchor','load']);assert.equal(r.pairs[0].a,'person-opaque');assert(Math.abs(r.pairs[0].gap-.5)<1e-6);assert.equal(r.bounds.length,2);assert(r.policy.includes('Zero does NOT prove'));
 v.setTime(10);r=v.inspectGeometryRelations(['arbitrary-anchor','load']);assert.equal(r.pairs[0].gap,0);
 v.objects.load.visible=false;r=v.inspectGeometryRelations(['arbitrary-anchor','load']);assert.equal(r.pairs[0].gap,null);
 v.objects.load.visible=true;v.objects.load.children[0].material.opacity=0;v.objects.load.children[0].material.transparent=true;r=v.inspectGeometryRelations(['arbitrary-anchor','load']);assert.equal(r.pairs[0].gap,null);
}finally{v.dispose();}
const observations=subjectObservations(project);assert(observations.shots[0].samples[0].geometry_relations.pairs[0].gap>0);assert(observations.shots[0].samples[2].geometry_relations.pairs[0].gap<.0001);assert.equal(JSON.stringify(project),before);
console.log('geometry facts: hierarchy, opacity, hidden/unknown, current-time tracks, zero-not-contact and immutable source passed');
