// Actual installed Claude Code + actual stdio MCP, deterministic local API fixture.
// No external provider, real user storage, service reload or model spending.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, copyFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
const root=await mkdtemp(join(tmpdir(),'cvw-cc-mcp-'));
const repo=fileURLToPath(new URL('../../',import.meta.url));
const host=join(root,'.whitebox/fixture');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW1kAAAAASUVORK5CYII=';
let calls=[],failure,child,stdout='',stderr='';
const server=createServer(async(req,res)=>{
  const chunks=[];for await(const b of req)chunks.push(b);
  let body;try{body=JSON.parse(Buffer.concat(chunks));}catch{res.end('{}');return;}
  if(!req.url.includes('/messages')){res.end('{}');return;}
  try {
    calls.push(body);
    let content,stop;
    if(calls.length===1){
      const names=body.tools.map(t=>t.name);
      assert.ok(names.includes('mcp__whitebox__evidence'),JSON.stringify(names));
      assert.ok(names.includes('mcp__whitebox__submit'));
      assert.ok(!names.includes('Bash')&&!names.includes('Read'));
      content=[{type:'tool_use',id:'tool_fixture',name:'mcp__whitebox__evidence',input:{files:['review/a.png']}}];stop='tool_use';
    }else{
      const results=body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_result');
      const result=results.find(r=>r.tool_use_id==='tool_fixture');
      assert.ok(result&&!result.is_error,JSON.stringify(result));
      assert.ok(result.content.some(b=>b.type==='image'&&b.source?.data),JSON.stringify(result).slice(0,1500));
      content=[{type:'text',text:'fixture complete'}];stop='end_turn';
    }
    const msg={id:'msg_fixture_'+calls.length,type:'message',role:'assistant',model:body.model,content,stop_reason:stop,stop_sequence:null,usage:{input_tokens:100,output_tokens:20}};
    if(!body.stream){res.setHeader('content-type','application/json');res.end(JSON.stringify(msg));return;}
    res.setHeader('content-type','text/event-stream');
    const send=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
    send('message_start',{message:{...msg,content:[],stop_reason:null}});
    for(const [index,b] of content.entries()){
      send('content_block_start',{index,content_block:b.type==='tool_use'?{...b,input:{}}:{type:'text',text:''}});
      send('content_block_delta',{index,delta:b.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(b.input)}:{type:'text_delta',text:b.text}});
      send('content_block_stop',{index});
    }
    send('message_delta',{delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:20}});send('message_stop',{});res.end();
  }catch(e){failure=e;res.statusCode=500;res.end(JSON.stringify({error:{message:e.message}}));}
});
try {
  await mkdir(host,{recursive:true});await mkdir(join(root,'work/fixture/output/review'),{recursive:true});
  for(const [source,target] of [['whitebox-cc-host.py','host.py'],['whitebox-mcp.py','mcp.py'],['whitebox-edit-evidence.py','edit_evidence.py']])await copyFile(join(repo,'apps/worker-bridge/scripts',source),join(host,target));
  await writeFile(join(host,'config.json'),JSON.stringify({workspace:root,job:'work/fixture',inputs:'work/inputs',skill:'.claude/skills/fixture',python:'/usr/bin/python3',continued:false,require_facts:false}));
  await writeFile(join(host,'state.json'),JSON.stringify({started_at:0,repairs:0,max_repairs:2,seen:{},mcp_phase:'review'}));
  await writeFile(join(root,'work/fixture/output/review/a.png'),Buffer.from(png,'base64'));
  const scene='{}';await writeFile(join(root,'work/fixture/scene.json'),scene);
  await writeFile(join(root,'work/fixture/output/review/index.json'),JSON.stringify({scene_sha256:createHash('sha256').update(scene).digest('hex'),pages:[{file:'review/a.png',kind:'overview'}]}));
  const refs=join(root,'.claude/skills/fixture/references');await mkdir(refs,{recursive:true});
  await writeFile(join(refs,'scene.schema.json'),JSON.stringify({properties:{shots:{items:{properties:{camera:{properties:{type:{enum:['static']},framing:{enum:['full']}}}}}}}}));
  const mcp=join(root,'mcp.json');await writeFile(mcp,JSON.stringify({mcpServers:{whitebox:{type:'stdio',command:'/usr/bin/python3',args:[join(host,'mcp.py')],timeout:1200000}}}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const env={...process.env,HOME:root,CLAUDE_CONFIG_DIR:join(root,'.claude-config'),ANTHROPIC_API_KEY:'fixture-only',ANTHROPIC_BASE_URL:'http://127.0.0.1:'+server.address().port,ANTHROPIC_MODEL:'fixture-model',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:'1',CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS:'0',ENABLE_TOOL_SEARCH:'false',MAX_MCP_OUTPUT_TOKENS:'100000'};
  for(const k of ['ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete env[k];
  child=spawn('claude',['-p','--model','fixture-model','--output-format','stream-json','--verbose','--dangerously-skip-permissions','--system-prompt','Use the supplied tool.','--tools','','--strict-mcp-config','--mcp-config',mcp,'--setting-sources','','--disable-slash-commands'],{cwd:root,env,stdio:['pipe','pipe','pipe']});
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.end('Inspect the current evidence page.');
  const timer=setTimeout(()=>child.kill('SIGKILL'),45000);
  const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});clearTimeout(timer);
  if(failure)throw failure;
  assert.equal(code,0,stderr+'\n'+stdout.slice(-4000));assert.equal(calls.length,2);
  assert.match(await readFile(join(host,'events.jsonl'),'utf8'),/image_observation/);
  console.log(JSON.stringify({ok:true,actual_cc:true,api_calls:calls.length,mcp_tools:calls[0].tools.map(t=>t.name),image_delivered:true}));
}finally{child?.kill('SIGTERM');await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
