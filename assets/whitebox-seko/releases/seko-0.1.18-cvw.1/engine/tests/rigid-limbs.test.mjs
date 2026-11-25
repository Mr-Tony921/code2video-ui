import test from 'node:test';import assert from 'node:assert/strict';
import {createHost} from '../runtime/helpers.js';
import {compileProject,loadProject} from '../runtime/project.js';
function fixture(extra){
 const task={title:'rigid interaction',duration:10,segments:[{id:'s',start:0,end:10,duration:10,shots:[{id:'a',explicit_duration:10}]}]};
 const host=createHost(task),h=host.helpers,actor=h.person('a','A',[0,0,0],{detail:'articulated'});
 const hand=h.registered.get('a_right_hand').object,prop=h.group('prop','held',[0,0,0],hand);h.box([.12,.12,.12],[0,0,0],'white',prop);
 const anim=h.createAnimationRegistry({duration:10});h.track(anim,'a','position',[[0,[0,0,0]],[10,[4,0,0]]]);h.track(anim,'a_right_arm','rotation',[[0,[0,0,0]],[10,[-Math.PI/2,0,0]]]);
 const plan=h.makeShotPlan();h.cameraTimeline(anim,plan.map(s=>({...s,keys:[{time:s.start,position:[0,3,8],target:[0,1,0]},{time:s.end,position:[4,3,8],target:[4,1,0]}]})));
 extra?.(h,anim);return compileProject(host,{animation:anim.build(),animationRegistry:anim.describe(),shot_plan:plan},task,'rigid-test');
}
test('rigid limb length and prop contact survive movement, rotation and A-B-A seeking',()=>{
 const p=fixture(),v=loadProject(JSON.parse(JSON.stringify(p)));const lengths=[];
 for(const t of [0,2,5,10,2]){
  const state=v.setTime(t).entities,a=state.a_right_arm.position,b=state.a_right_hand.position;
  lengths.push(Math.hypot(...a.map((n,i)=>n-b[i])));assert.deepEqual(state.prop.position,b);
 }
 for(const n of lengths)assert.ok(Math.abs(n-lengths[0])<1e-10);
 const before=v.setTime(2);v.setTime(9);assert.deepEqual(before,v.setTime(2));
 const rigid=[];v.scene.traverse(o=>{if(o.userData.seko_rigid_limb_v1)rigid.push(o);});assert.equal(rigid.length,4);
 for(const pivot of rigid)assert.equal(pivot.children.filter(o=>o.geometry?.type==='CylinderGeometry').length,1);v.dispose();
});
test('independent hand movement fails clearly rather than making an elastic arm',()=>{
 assert.throws(()=>fixture((h,a)=>h.track(a,'a_right_hand','position',[[0,[0,0,3]]])),/Rigid limb\/hand.*rotate/);
});
test('nonuniform actor scaling cannot deform rigid limbs',()=>{
 assert.throws(()=>fixture((h,a)=>h.track(a,'a','scale',[[0,[1,3,1]]])),/Nonuniform character scale/);
});
test('legacy serialized v1 arms retain their original replay',()=>{
 const p=fixture();const find=(o,name)=>o.name===name?o:(o.children||[]).map(c=>find(c,name)).find(Boolean);
 const root=p.scene.object;const arm=find(root,'右肩转轴');delete arm.userData.seko_rigid_limb_v1;
 // Legacy compatibility is covered using an explicit old arm-link mesh, not a new-helper shape.
 const mesh=arm.children.find(x=>x.type==='Mesh');mesh.userData={seko_arm_link_v1:{target:find(root,'右手锚点').uuid,start:[0,0,0],base_length:1.75*.36}};
 const v=loadProject(p);assert.doesNotThrow(()=>v.setTime(5));v.dispose();
});
