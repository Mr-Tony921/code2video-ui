import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
test('bad source reports the exact line before any browser is launched',()=>{
 const base=resolve('runtime/validation');mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'syntax-preflight-'));
 try{
  const source=join(dir,'source.js'),task=join(dir,'task.json'),out=join(dir,'out');
  writeFileSync(source,'export function buildScene() {\n  const ok = 1;\n  const broken = [1, 2;\n  return {};\n}\n');writeFileSync(task,'{}');
  const release=process.env.SEKO_TEST_RELEASE||'seko-0.1.13-cvw.1';
  const r=spawnSync(process.execPath,[`assets/whitebox-seko/releases/${release}/engine/tools/probe.mjs`,'--source',source,'--task',task,'--out',out],{encoding:'utf8',env:{...process.env,CHROME_PATH:join(dir,'must-not-launch')},timeout:15000});
  assert.equal(r.status,1);assert.match(r.stderr,/syntax preflight failed before rendering/);assert.match(r.stderr,/\[stdin\]:3/);assert.match(r.stderr,/3:   const broken/);
  assert.doesNotMatch(r.stderr,/Browser was not found|Failed to launch/);assert.equal(JSON.parse(readFileSync(join(out,'probe.json'))).ok,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
