import fs from 'node:fs';import crypto from 'node:crypto';import {cameraProposals} from '../runtime/camera-proposals.js';
const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
if(!args.project||!args.out||!args.scope)throw Error('Need project, scope and out');
const bytes=fs.readFileSync(args.project),project=JSON.parse(bytes),result=cameraProposals(project,args.scope.split(','));
result.project_sha256=crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(args.out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({seconds:result.seconds,shots:result.rows.length,limited:result.limited,applied:false}));
