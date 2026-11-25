// Regression: changing a suite must not relabel/re-evaluate historical videos.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'bench/web/app.js'), 'utf8');
const ctx = vm.createContext({document: {addEventListener() {}}, assert});
vm.runInContext(source.slice(0, source.lastIndexOf('(async () => {')), ctx);
ctx.suiteOld = JSON.parse(fs.readFileSync(path.join(root, 'dataset/v0.1.0/suite.json')));
ctx.suiteNew = JSON.parse(fs.readFileSync(path.join(root, 'dataset/v0.1.1/suite.json')));
vm.runInContext(`
  boot = {suite:suiteNew,user:{username:'test'}};
  const oldCase = suiteOld.cases.find(c=>c.id==='08-microwave');
  const newCase = suiteNew.cases.find(c=>c.id===oldCase.id);
  const fixture = (version,c) => ({id:'test-'+version,suite_version:version,
    suite_sha256:version,cohort:'fixture',case:c,created_at:'2026-11-25',
    job_id:'fixture-job',job:{status:'COMPLETED',result_asset:{playable:true}},
    model_requested:{model:'deepseek-c2v-v1',revision:'fixture'},state:'COMPLETED',
    local_original_available:true,probe:{duration_seconds:90,width:1920,height:1080},
    evaluation:{execution_seconds:100,has_video:true,render_verified:true,quality:'unreviewed'},reviews:[]});
  runs=[fixture('0.1.0',oldCase), fixture('0.1.1',newCase)]; runsLoaded=true;
  current=newCase;
  assert.equal(resultRuns().length,1);
  assert.equal(reviewCases()[0].prompt_original,newCase.prompt_original);
  assert.match(renderResults(),/0.1.1/);
  assert.match(renderResults(),/制作时长 00小时01分钟40秒/);
  assert.equal(elapsed(3599.6),'01小时00分钟00秒');
  assert.equal(elapsed(3723.25),'01小时02分钟03秒');
  assert.equal(elapsed(null),'未记录');
  resultVersion='0.1.0';
  assert.equal(resultRuns().length,1);
  assert.equal(reviewCases()[0].prompt_original,oldCase.prompt_original);
  assert.equal(reviewCases()[0].requirements.style_prompt,undefined);
  assert.doesNotThrow(()=>renderResults());
  assert.doesNotThrow(()=>renderReview());
  assert.equal(current.prompt_original,oldCase.prompt_original);
  assert.match(renderCases(), /风格化三维动画/);
  assert.equal(current.prompt_original,newCase.prompt_original);
  runs=[fixture('0.1.0',oldCase)]; resultVersion='0.1.1';
  assert.equal(resultRuns().length,0);
  assert.match(renderReview(),/历史版本/);
  assert.match(durationLabel(suiteNew.cases.find(c=>c.id==='04b-paper-yeti')),/约 26 秒/);
`, ctx);
console.log('version isolation, frozen review, empty current suite, approximate duration: PASS');
