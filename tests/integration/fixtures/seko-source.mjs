export async function buildScene({THREE,scene,camera,helpers:h,task}) {
 h.box([8,.1,5],[0,-.05,0],'#aaa');
 const actor=h.person('actor','人物A',[0,0,0]);
 const plan=h.makeShotPlan([[2],[2]]),anim=h.createAnimationRegistry({duration:task.duration});
 h.track(anim,'actor','position',[[0,[0,0,0]],[2,[1,0,0]],[4,[1,0,0]]]);
 h.cameraTimeline(anim,plan.map(s=>({...s,keys:[{time:s.start,position:[2,2,5],target:[0,1,0]},{time:s.end,position:[2,2,5],target:[0,1,0]}]})));
 return {animation:anim.build(),animationRegistry:anim.describe(),shot_plan:plan,reference_usage:[],notes:[]};
}
