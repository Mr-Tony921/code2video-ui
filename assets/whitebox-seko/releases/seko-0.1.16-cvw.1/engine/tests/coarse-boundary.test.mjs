import test from 'node:test';
import assert from 'node:assert/strict';
import {createHost} from '../runtime/helpers.js';
import {compileProject,loadProject} from '../runtime/project.js';
import {motionAudit} from '../runtime/motion-audit.js';

function scene(kind){
 const task={title:'coarse route',duration:6,segments:[{id:'s',start:0,end:6,duration:6,shots:[{id:'one',explicit_duration:6}]}]};
 const host=createHost(task),h=host.helpers;
 h.person('a','A',[-3,0,0]);
 const object=h.group('object','obstacle',[0,0,0]);
 h.box(kind==='carried'?[.5,.4,.5]:[.3,3,2],[0,kind==='carried'?.8:1.5,0],'gray',object);
 const anim=h.createAnimationRegistry({duration:6});
 if(kind==='cut')h.actorTimeline(anim,'a',[{start:0,end:3,points:[[-3,0,0]]},{start:3,end:6,points:[[3,0,0]]}]);
 else h.actorTimeline(anim,'a',[{start:0,end:6,points:kind==='around'?[[-3,0,0],[-3,0,2],[3,0,2],[3,0,0]]:[[-3,0,0],[3,0,0]]}]);
 if(kind==='carried')h.track(anim,'object','position',[[0,[-3,0,0]],[6-.0001,[3,0,0]]]);
 if(kind==='attached')h.attachProp('object','a_right_hand');
 const plan=h.makeShotPlan();h.cameraTimeline(anim,plan.map(s=>({...s,keys:[{time:0,position:[8,5,8],target:[0,1,0]}]})));
 return compileProject(host,{animation:anim.build(),animationRegistry:anim.describe(),shot_plan:plan},task,'fixture');
}
test('coarse avoidance accepts a few waypoints but still detects a direct wall crossing',()=>{
 assert.ok(motionAudit(scene('wall')).findings.length>0);
 assert.equal(motionAudit(scene('around')).findings.length,0);
});
test('step clip boundary holds old scene position until the cut, including arbitrary seek',()=>{
 const v=loadProject(scene('cut'));
 for(const t of [2,2.99999,.2]){v.setTime(t);assert.equal(v.objects.a.position.x,-3);}
 v.setTime(3);assert.equal(v.objects.a.position.x,3);
 const at=v.setTime(1);v.setTime(5);assert.deepEqual(v.setTime(1),at);v.dispose();
 assert.equal(motionAudit(scene('cut')).findings.length,0);
});
test('separately tracked co-moving carried object is not a stationary route obstacle',()=>{
 assert.equal(motionAudit(scene('carried')).findings.length,0);
});
test('explicit attachment resets a distant world placement to a stable local hand offset',()=>{
 const h=createHost().helpers;h.person('a','A',[8,0,-5]);
 const p=h.group('cup','cup',[50,8,30]);h.cylinder(.07,.15,[0,0,0],'white',p);
 h.attachProp('cup','a_right_hand',[0,-.05,0]);
 assert.equal(p.parent,h.registered.get('a_right_hand').object);
 assert.deepEqual(p.position.toArray(),[0,-.05,0]);
 const local=p.position.clone();h.registered.get('a_right_arm').object.rotation.x=1.2;
 assert.deepEqual(p.position,local);assert.throws(()=>h.attachProp('a','cup'),/Cyclic/);
});
