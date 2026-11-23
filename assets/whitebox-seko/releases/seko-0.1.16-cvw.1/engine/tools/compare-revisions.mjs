import fs from 'node:fs';import {loadProject} from '../runtime/project.js';
const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
const base=JSON.parse(fs.readFileSync(args.base)),edited=JSON.parse(fs.readFileSync(args.edited)),allowed=new Set(args.entities.split(','));
const scope=[...base.segments,...base.shot_plan].find(s=>s.id===args.scope);if(!scope)throw Error('Unknown scope');
const a=loadProject(base),b=loadProject(edited),errors=[];
for(const f of ['scene','animation','segments','shot_plan','entities','camera_uuid'])if(JSON.stringify(base[f])!==JSON.stringify(edited[f]))errors.push('Unapproved base structure change: '+f);
if(JSON.stringify(edited.edits.slice(0,base.edits.length))!==JSON.stringify(base.edits))errors.push('Existing manual edits were lost');
const additions=edited.edits.slice(base.edits.length);
for(const op of additions)if(!allowed.has(op.entity_id)||op.start<scope.start||op.end>scope.end)errors.push('Edit outside authorized scope');
const dependent=new Set();for(const [id,o] of Object.entries(b.objects))for(let n=o;n;n=n.parent)if(allowed.has(n.userData.technicalId))dependent.add(id);
const points=[...new Set([...base.shot_plan.flatMap(s=>[s.start,(s.start+s.end)/2,s.end-.001]),scope.start,scope.end])].sort((x,y)=>x-y);
const same=(x,y)=>JSON.stringify(x)===JSON.stringify(y),frozen=additions.filter(o=>o.kind==='freeze_position');
for(const t of points){const before=a.setTime(t),after=b.setTime(t),inside=t>=scope.start&&t<scope.end;
 for(const id of Object.keys(before.entities))if((!inside||!dependent.has(id))&&!same(before.entities[id],after.entities[id]))errors.push(`Unexpected state change ${id} at ${t}`);
 if(!allowed.has('__camera')&&!same(before.camera,after.camera))errors.push('Camera changed at '+t);
 for(const op of frozen)if(t>=op.start&&t<op.end&&after.entities[op.entity_id].local_position.some((v,i)=>Math.abs(v-op.position[i])>1e-8))errors.push('Freeze did not hold at '+t);
}
const report={pass:!errors.length,errors,scope:args.scope,authorized_entities:[...allowed],dependent_entities:[...dependent],sampled_times:points.length,checks:['original scene/tracks/timing unchanged','earlier manual edits preserved','new overlays stay in authorized scope','sampled outside scope and unrelated objects unchanged','frozen local position holds','camera unchanged unless authorized'],limitations:['Finite temporal sampling; dependency geometry/visual quality still needs scoped review']};
if(args.out)fs.writeFileSync(args.out,JSON.stringify(report,null,2));console.log(JSON.stringify(report));a.dispose();b.dispose();if(errors.length)process.exitCode=1;
