import assert from 'node:assert/strict';import {createRequire} from 'node:module';import path from 'node:path';import {fileURLToPath} from 'node:url';
const R=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),E=R+'/assets/whitebox-seko/releases/'+(process.env.SEKO_TEST_RELEASE??'seko-0.1.10-cvw.1')+'/engine';
const THREE=createRequire(E+'/package.json')('three'),{cameraProposals}=await import(E+'/runtime/camera-proposals.js');
function fixture({hidden=false,moving=false,wall=false}={}){
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(45,16/9,.1,100);camera.position.set(5,1,2);camera.lookAt(5,1,0);scene.add(camera);
 const entities=[];for(const [id,x] of [['a',-1],['b',1]]){const o=new THREE.Mesh(new THREE.BoxGeometry(.4,.4,.4),new THREE.MeshBasicMaterial());o.position.set(x,1,0);if(id==='a')o.visible=!hidden;scene.add(o);entities.push({id,uuid:o.uuid});}
 if(wall){const box=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));box.position.set(-1,1,0);scene.add(box);}
 scene.updateMatrixWorld(true);
 return {scene:scene.toJSON(),camera_uuid:camera.uuid,entities,duration:4,animation:{tracks:[]},edits:[],shot_plan:[{id:'s1',start:0,end:4,camera_plan:{motion:moving,subjects:['a','b']},focus:[{entity_id:'a',time:2,front:true}]}]};
}
let p=fixture(),before=JSON.stringify(p),r=cameraProposals(p,['s1']);assert.equal(JSON.stringify(p),before);assert.equal(r.applied,false);assert.equal(r.rows.length,1);assert(r.rows[0].proposals.length);
for(const v of r.rows[0].proposals){assert(v.checks.every(c=>c.pass));assert.deepEqual(new Set(v.checks.map(c=>c.entity_id)),new Set(['a','b']));assert(v.checks.every(c=>Math.abs(c.projection[0])<=.85&&Math.abs(c.projection[1])<=.85));assert.equal(v.fov,45);}
const invalid=fixture();invalid.shot_plan[0].focus.push({entity_id:'unknown',time:2},{entity_id:'a',time:4});const invalidBefore=JSON.stringify(invalid),invalidResult=cameraProposals(invalid);assert.equal(invalidResult.skipped_checks.length,2);assert(invalidResult.rows[0].proposals.length);assert.equal(JSON.stringify(invalid),invalidBefore);
assert.equal(cameraProposals(p,['other']).rows.length,0);
assert.equal(cameraProposals(fixture({moving:true})).rows.length,0);
assert.equal(cameraProposals(fixture({hidden:true})).rows[0].proposals.length,0);
assert.equal(cameraProposals(fixture({wall:true})).rows[0].proposals.length,0);
assert.equal(cameraProposals(p,['s1'],{budgetMs:0}).limited,true);
const successful=structuredClone(p),proposal=r.rows[0].proposals[0],scene=new THREE.ObjectLoader().parse(successful.scene),cam=scene.getObjectByProperty('uuid',successful.camera_uuid);cam.position.fromArray(proposal.position);cam.lookAt(...proposal.target);scene.updateMatrixWorld(true);successful.scene=scene.toJSON();assert.equal(cameraProposals(successful).rows.length,0,'Already valid cameras need no suggestion');
console.log('camera suggestion tests passed: immutable, scope, joint subjects, frame margin, front, hidden, opaque enclosure, moving camera exclusion, bounded tool work');
