import test from 'node:test';import assert from 'node:assert/strict';
import {createHost} from '../runtime/helpers.js';import {compileProject,loadProject,structuralChecks} from '../runtime/project.js';
function fixture(){
 const task={title:'generic',duration:10,segments:[{id:'s',start:0,end:10,duration:10,shots:[{id:'a',explicit_duration:4},{id:'b',explicit_duration:6}]}]};
 const host=createHost(task),h=host.helpers,root=h.group('actor','甲'),prop=h.group('held','携带物',[.4,1,0],root);h.box([.2,.2,.2],[0,0,0],'white',prop);
 const anim=h.createAnimationRegistry({duration:10});h.track(anim,'actor','position',[[0,[0,0,0]],[10,[10,0,0]]]);
 const shots=h.makeShotPlan([[4,6]]);h.cameraTimeline(anim,shots.map(s=>({...s,keys:[{time:s.start,position:[0,3,8],target:[1,1,0]},{time:s.end,position:[2,3,8],target:[2,1,0]}]})));
 const project=compileProject(host,{animation:anim.build(),animationRegistry:anim.describe(),shot_plan:shots,reference_usage:[{observed:'generic'}]},task,'test');return {project,task};
}
test('absolute seeking preserves held object and A-B-A state',()=>{
 const {project}=fixture(),view=loadProject(project);const a=view.setTime(2);view.setTime(9);assert.deepEqual(view.setTime(2),a);
 const p=view.setTime(8).entities;assert.equal(p.held.position[0]-p.actor.position[0],.40000000000000036);view.dispose();
});
test('scoped freeze keeps child attached and changes nothing outside interval',()=>{
 const {project}=fixture(),before=loadProject(project);project.edits.push({entity_id:'actor',kind:'freeze_position',start:4,end:8,position:[4,0,0]});const after=loadProject(project);
 for(const t of [0,3.999,8,9,10])assert.deepEqual(before.setTime(t),after.setTime(t));
 assert.equal(after.setTime(6).entities.actor.position[0],4);assert.equal(after.inspectState().entities.held.position[0],4.4);before.dispose();after.dispose();
});
test('shot timing and camera coverage fail independently',()=>{
 const {project,task}=fixture();assert.equal(structuralChecks(project,task).pass,true);project.authored_camera_cuts[0].end=5;assert.equal(structuralChecks(project,task).pass,false);
});
test('focus checks use real anchors and reject offscreen targets',()=>{
 const {project}=fixture(),view=loadProject(project);view.setTime(0);
 assert.equal(view.inspectFocus({entity_id:'held',front:true}).pass,true);
 view.objects.held.position.x=100;view.scene.updateMatrixWorld(true);assert.equal(view.inspectFocus({entity_id:'held'}).in_frame,false);view.dispose();
});
test('model compatibility aliases preserve objects without changing serialization',()=>{
 const {task}=fixture(),host=createHost(task),actor=host.helpers.person('p','甲',[0,0,0]);assert.equal(actor.object,actor);
 const plan=host.helpers.makeShotPlan([[4,6]]);assert.equal(plan.shots,plan);assert.equal(JSON.parse(JSON.stringify(plan)).length,2);assert.doesNotThrow(()=>JSON.stringify(host.scene.toJSON()));
});

test('no references need no invented mapping; supplied references still require evidence',()=>{
 const {project,task}=fixture(); project.reference_usage=[];
 assert.equal(structuralChecks(project,{...task,references:[]}).pass,true);
 assert.equal(structuralChecks(project,{...task,references:[{id:'reference_1'}]}).pass,false);
});

test('Object3D metadata references cross JSON/CDP boundary without changing scene geometry',()=>{
 const {task}=fixture(),host=createHost(task),h=host.helpers,actor=h.person('actor','A',[0,0,0]);
 const head=h.registered.get('actor_head').object;actor.userData.head=head;
 const anim=h.createAnimationRegistry({duration:10});h.track(anim,'actor','position',[[0,[0,0,0]],[10,[1,0,0]]]);
 const plan=h.makeShotPlan([[4,6]]);h.cameraTimeline(anim,plan.map(s=>({...s,keys:[{time:s.start,position:[0,3,8],target:[0,1,0]},{time:s.end,position:[0,3,8],target:[0,1,0]}]})));
 const count=[];host.scene.traverse(o=>count.push(o.uuid));
 const project=compileProject(host,{animation:anim.build(),animationRegistry:anim.describe(),shot_plan:plan},task,'fixture');
 assert.deepEqual(actor.userData.head,{$three_object_uuid:head.uuid});assert.doesNotThrow(()=>structuredClone(project));
 const after=[];host.scene.traverse(o=>after.push(o.uuid));assert.deepEqual(after,count);
 const view=loadProject(JSON.parse(JSON.stringify(project)));assert.equal(view.setTime(10).entities.actor.position[0],1);view.dispose();
});
