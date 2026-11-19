import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareWhiteboxHost } from '../../apps/worker-bridge/src/whitebox-host.mjs';
import { whiteboxResponsePatch } from '../../apps/shared/whitebox-response.mjs';

test('natural intake, clarification resume and playable follow-up use distinct skill phases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whitebox-intake-'));
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  try {
    const skill = join(root, '.claude/skills/selected');
    await mkdir(join(skill,'references'),{recursive:true});await mkdir(join(root,'book'));
    await writeFile(join(skill,'SKILL.md'),'1. **Translate the brief into an explicit story contract.** EXACT_INTAKE 2. **Start one shared measured job**');
    for(const ref of ['brief.md','action-scope.md','user-edits.md'])await writeFile(join(skill,'references',ref),'EXACT_'+ref);
    const prepare = (jobId,continued) => prepareWhiteboxHost({repoRoot,ws:root,viewPath:root,bookDir:join(root,'book'),jobId,skill:'selected',continued,modelSelection:{profile_id:'whitebox-deepseek'},prompt:'原始需求'});
    for (const [id,continued] of [['first',false],['clarified',true]]) {
      const host=await prepare(id,continued);
      assert.match(host.contract,/EXACT_INTAKE/);assert.match(host.contract,/EXACT_brief.md/);
      assert.doesNotMatch(host.contract,/EXACT_user-edits.md/);
      const cfg=JSON.parse(await readFile(join(root,'.whitebox',id,'config.json')));
      assert.equal(cfg.continued,false);assert.equal(cfg.require_facts,true);assert.equal(cfg.user_prompt,'原始需求');
      assert.equal(JSON.parse(await readFile(host.mcp_config_path)).mcpServers.whitebox.timeout,1200000);
    }
    await mkdir(join(root,'work/first'),{recursive:true});
    await writeFile(join(root,'work/first/job.json'),'{}');
    await writeFile(join(root,'work/first/brief.json'),'{"original":true}');
    await writeFile(join(root,'work/first/draft.json'),'{"shots":[{"id":"s1"}]}');
    await writeFile(join(root,'.whitebox/first/state.json'),'{"delivered":true,"render_success":true,"quality_pass":true}');
    const host=await prepare('followup',true);
    assert.match(host.contract,/EXACT_user-edits.md/);assert.match(host.contract,/"job":"work\/first"/);
    assert.doesNotMatch(host.contract,/EXACT_brief.md/);
    assert.equal(JSON.parse(await readFile(join(root,'.whitebox/followup/state.json'))).max_repairs,1);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('text completion is limited to explicit whitebox answers and never creates a video',()=>{
  assert.equal(whiteboxResponsePatch('coding_to_video',{kind:'answer',text:'hi'}),null);
  assert.equal(whiteboxResponsePatch('blockout_3d',{kind:'answer',text:''}),null);
  assert.deepEqual(whiteboxResponsePatch('blockout_3d',{kind:'clarification',text:' Where? '}),
    {response:{kind:'clarification',text:'Where?'},result_asset:null,last_assistant_text:'Where?'});
});
