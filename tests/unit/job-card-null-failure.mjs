import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const web = fileURLToPath(new URL('../../apps/web/', import.meta.url));
const requireWeb=createRequire(resolve(web,'package.json'));
const ts=requireWeb('typescript'), React=requireWeb('react');
const {renderToStaticMarkup}=requireWeb('react-dom/server');
const cache=new Map();
function load(file) {
  file=resolve(file);
  if(!existsSync(file))file+=existsSync(file+'.tsx')?'.tsx':'.ts';
  if(cache.has(file))return cache.get(file).exports;
  const module={exports:{}};cache.set(file,module);
  const output=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{
    module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,
    esModuleInterop:true
  }}).outputText;
  function requireOne(id) {
    if(id.startsWith('@/'))return load(resolve(web,id.slice(2)));
    if(id.startsWith('.'))return load(resolve(dirname(file),id));
    return requireWeb(id);
  }
  new Function('require','module','exports',output)(requireOne,module,module.exports);
  return module.exports;
}
const {JobCard}=load(resolve(web,'components/JobCard.tsx'));
const base={id:'fixture',mode:'blockout_3d',status:'FAILED',failure:null,
 cancellation:{requested_at:null},health:{assessment:'CONFIRMED_FAILED'},
 elapsed:{running_ms:1000,queued_ms:null,current_phase_ms:null},result_asset:null};
test('failed SSE snapshot without failure detail remains renderable',()=>{
 const html=renderToStaticMarkup(React.createElement(JobCard,{job:base}));
 assert.match(html,/生成失败/);assert.match(html,/错误详情暂未返回/);
});
test('failure detail and actionable complexity explanation still render',()=>{
 for(const [code,message] of [['E_WHITEBOX_EXECUTION','模型连接断开'],['E_TASK_TOO_COMPLEX','内容过于复杂']]){
  const html=renderToStaticMarkup(React.createElement(JobCard,{job:{...base,failure:{code,message}}}));
  assert.ok(html.includes(message));assert.ok(!html.includes('错误详情暂未返回'));
 }
});
