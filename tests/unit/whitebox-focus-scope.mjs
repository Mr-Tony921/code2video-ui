import assert from 'node:assert/strict';import path from 'node:path';import {fileURLToPath} from 'node:url';
const R=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),E=R+'/assets/whitebox-seko/releases/'+(process.env.SEKO_TEST_RELEASE??'seko-0.1.10-cvw.1')+'/engine';const {structuralChecks}=await import(E+'/runtime/project.js');
const task={duration:4,references:[],segments:[{id:'seg',start:0,end:4,shots:[{id:'s1',explicit_duration:2},{id:'s2',explicit_duration:2}]}]};
const project={duration:4,shot_plan:[{id:'s1',segment_id:'seg',start:0,end:2,focus:[{entity_id:'missing',time:1}]},{id:'s2',segment_id:'seg',start:2,end:4,focus:[{entity_id:'actor',time:4}]}],entities:[{id:'actor'}],authored_camera_cuts:[{start:0,end:2},{start:2,end:4}],animation:{tracks:[{target:'__camera'}]},reference_usage:[],provenance:{legacy:false}};
const original=JSON.stringify(project),r=structuralChecks(project,task);assert.equal(r.pass,false);assert.deepEqual(r.errors.map(e=>[e.code,e.shot_id]),[['focus_contract','s1'],['focus_contract','s2']]);assert.equal(JSON.stringify(project),original);
const global=structuralChecks({...project,duration:301},task);assert(global.errors.some(e=>e.code==='duration'&&!e.shot_id));
project.shot_plan[0].focus[0].entity_id='actor';project.shot_plan[1].focus[0].time=3;assert(structuralChecks(project,task).pass);
console.log('Focus structural scope: exact IDs retained, invalid declarations still fail, unknown global failure not localized, successful checks unchanged, input immutable');
