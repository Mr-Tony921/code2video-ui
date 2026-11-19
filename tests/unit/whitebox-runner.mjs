import '../fixtures.mjs';
import { TEST_TMP_ROOT } from '../fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
process.env.CVW_INTERNAL_TOKEN = 'whitebox-runner-fixture-token';
process.env.CVW_GATEWAY_BASE_URL = 'http://127.0.0.1:1';
const { config } = await import('../../apps/worker-bridge/src/config.mjs');
const { whiteboxModels, prepareWhiteboxSkills, defaultWhiteboxSkills } = await import('../../apps/shared/whitebox.mjs');
const runner = await import('../../apps/worker-bridge/src/job-runner.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
test('custom whitebox child disables other CC skills, uses job-local authentication and retains the selected workflow', async () => {
  config.raw.whitebox.models = [{ id: 'whitebox-fixture', name: 'Fixture', channels: [
    { model: 'fixture-model', endpoint: 'https://model.test', api_key: 'fixture-upstream-key' } ] }];
  config.isolation = { enabled: false };
  const bin = join(TEST_TMP_ROOT, 'fake-whitebox-cli');
  await writeFile(bin, `#!/usr/bin/env python3
import json,os,pathlib,sys,time
p=pathlib.Path.cwd()
(p/'argv-env.json').write_text(json.dumps({'argv':sys.argv,'key':os.getenv('ANTHROPIC_API_KEY'),'base':os.getenv('ANTHROPIC_BASE_URL'),'secret':os.getenv('CVW_INTERNAL_TOKEN'),'api_timeout':os.getenv('API_TIMEOUT_MS')}))
(p/'received.md').write_text(sys.stdin.read())
time.sleep(30)
`);
  await chmod(bin, 0o755);config.claudeCli.bin=bin;
  const sid='sess_'+randomUUID(),jid='job_'+randomUUID();
  const skills=await prepareWhiteboxSkills(join(config.storage.sessionsRoot,config.storage.sessionsSubdir),sid,defaultWhiteboxSkills(config.raw),null,{raw:config.raw,repoRoot:config.repoRoot});
  const ws=join(config.storage.sessionsRoot,config.storage.sessionsSubdir,sid,'workspace');let settle;let cancelled=false;const done=new Promise(r=>settle=r);
  try {
    await runner.startJob({sessionId:sid,jobId:jid,mode:'blockout_3d',prompt:'Render a grey cube.',experimentalSkills:skills,modelSelection:whiteboxModels(config.raw)[0],leaseToken:'fixture',maxRuntimeSeconds:0,hooks:{onCancelled:()=>{cancelled=true;settle();},onLeaseLostExit:settle,onFail:settle}});
    let observed;
    for(let i=0;i<100;i++){try{observed=JSON.parse(await readFile(join(ws,'argv-env.json')));break;}catch{await sleep(30);}}
    assert.ok(observed.argv.includes('--disable-slash-commands'));
    assert.equal(observed.argv[observed.argv.indexOf('--tools')+1], '');
    assert.match(observed.argv[observed.argv.indexOf('--mcp-config')+1], /mcp.json$/);
    assert.ok(observed.argv.includes('--settings'));
    assert.equal(observed.api_timeout,'1200000');
    assert.ok(observed.argv.includes('--system-prompt-snapshot'));
    assert.notEqual(observed.key,'fixture-upstream-key');assert.equal(observed.secret,null);
    assert.ok(observed.base.endsWith('/whitebox-model/'+jid));
    assert.match(await readFile(join(ws,'received.md'),'utf8'),/Selected skill: current phase only/);
  } finally {runner.getJob(jid).leaseValid=false;await runner.cancelJob(jid,'fixture finished',0.01);await Promise.race([done,sleep(5000)]);assert.equal(cancelled,true,'Explicit cancellation wins over its own revoked lease');}
});

test('an explicit clarification completes without publishing a prior video', async () => {
  config.isolation = { enabled: false };
  const bin=join(TEST_TMP_ROOT,'fake-whitebox-clarify');
  await writeFile(bin,`#!/usr/bin/env python3
import json,pathlib,sys
p=pathlib.Path.cwd();sys.stdin.read()
state=next((p/'.whitebox').glob('*/state.json'));s=json.loads(state.read_text())
s.update(mcp_phase='waiting_user',clarification='故事发生在哪里？');state.write_text(json.dumps(s))
# Even a fresh-looking unrelated old MP4 must not be relabelled as this answer.
(p/'output/final.mp4').write_bytes(b'previous movie, not a new artifact')
print(json.dumps({'type':'result','subtype':'success','is_error':False,'result':'故事发生在哪里？'}),flush=True)
`);await chmod(bin,0o755);config.claudeCli.bin=bin;
  const sid='sess_'+randomUUID(),jid='job_'+randomUUID();
  const skills=await prepareWhiteboxSkills(join(config.storage.sessionsRoot,config.storage.sessionsSubdir),sid,defaultWhiteboxSkills(config.raw),null,{raw:config.raw,repoRoot:config.repoRoot});
  let resolve;const done=new Promise(r=>resolve=r);
  await runner.startJob({sessionId:sid,jobId:jid,mode:'blockout_3d',prompt:'Make a scene',experimentalSkills:skills,modelSelection:whiteboxModels(config.raw)[0],leaseToken:'fixture',maxRuntimeSeconds:0,hooks:{onComplete:meta=>resolve({meta}),onFail:failure=>resolve({failure})}});
  const result=await Promise.race([done,sleep(10000).then(()=>({timeout:true}))]);
  assert.ok(result.meta,JSON.stringify(result));assert.equal(result.meta.storage_path,undefined);
  assert.deepEqual(result.meta.response,{kind:'clarification',text:'故事发生在哪里？'});
});
