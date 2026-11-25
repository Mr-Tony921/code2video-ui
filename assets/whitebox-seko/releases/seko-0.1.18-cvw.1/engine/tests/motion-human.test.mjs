import test from 'node:test';import assert from 'node:assert/strict';
import {createHost} from '../runtime/helpers.js';
import {compileProject,loadProject} from '../runtime/project.js';
import {motionAudit} from '../runtime/motion-audit.js';
function fixture(kind='wall'){
 const task={title:'clear passage',duration:4,segments:[{id:'s',start:0,end:4,duration:4,shots:[{id:'a',explicit_duration:4}]}]};
 const host=createHost(task),h=host.helpers,a=h.person('actor','A',[-2,0,0]);
 h.box([12,.1,8],[0,-.05,0],'white');
 if(kind==='door'){h.box([.2,3,2],[0,1.5,-2],'gray');h.box([.2,3,2],[0,1.5,2],'gray');h.box([.2,.5,2],[0,3,0],'gray');}
 else h.box([.2,3,6],[0,1.5,0],'gray');
 const anim=h.createAnimationRegistry({duration:4});
 if(kind==='static')h.track(anim,'actor','position',[[0,[0,0,0]],[4,[0,0,0]]]);
 else if(kind==='step')h.track(anim,'actor','position',[[0,[-2,0,0]],[2,[2,0,0]]],'step');
 else h.moveActor(anim,'actor',[[0,[-2,0,0]],[4,[2,0,0]]]);
 const plan=h.makeShotPlan();h.cameraTimeline(anim,plan.map(s=>({...s,keys:[{time:0,position:[4,3,8],target:[0,1,0]},{time:4,position:[4,3,8],target:[0,1,0]}]})));
 return compileProject(host,{animation:anim.build(),animationRegistry:anim.describe(),shot_plan:plan},task,'fixture');
}
test('default and legacy simple option both create the uniform seven visible primitives',()=>{
 for(const pose of ['stand','sit','crouch']){
  const h=createHost().helpers,a=h.person('p','extra',[0,0,0],{detail:'simple',pose});const meshes=[];a.traverse(o=>{if(o.isMesh)meshes.push(o);});
  assert.equal(meshes.length,7);assert.equal(meshes.filter(m=>m.geometry.type==='CylinderGeometry').length,5);
  assert.equal(meshes.filter(m=>m.geometry.type==='SphereGeometry').length,1);assert.equal(meshes.filter(m=>m.geometry.type==='BoxGeometry').length,1);
  assert.equal(h.registered.get('p_right_hand').object.children.length,0);
  for(const m of meshes)assert.equal(m.scale.y,1);
 }
});
test('travel faces local +Z nose toward world route and seeks deterministically',()=>{
 const v=loadProject(fixture());v.setTime(2);assert.ok(Math.abs(v.objects.actor.rotation.y-Math.PI/2)<1e-8);
 const before=v.setTime(1);v.setTime(4);assert.deepEqual(before,v.setTime(1));v.dispose();
});
test('moving through a solid wall produces an event; real door gap and floor do not',()=>{
 assert.ok(motionAudit(fixture()).findings.some(f=>f.kind==='body_center_enters_box_interior'));
 assert.equal(motionAudit(fixture('door')).findings.length,0);
});
test('static overlap and explicit step scene reset do not count as walking penetration',()=>{
 assert.equal(motionAudit(fixture('static')).findings.length,0);
 assert.equal(motionAudit(fixture('step')).findings.length,0);
});
test('recompiled unchanged obstacles keep their problem identity despite new mesh UUIDs',()=>{
 const a=motionAudit(fixture()).findings,b=motionAudit(fixture()).findings;
 assert.ok(a.length>0);assert.notEqual(a[0].mesh_uuid,b[0].mesh_uuid);
 assert.deepEqual(a.map(x=>x.problem_id),b.map(x=>x.problem_id));
});
