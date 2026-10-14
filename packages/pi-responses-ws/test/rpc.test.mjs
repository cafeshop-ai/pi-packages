import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { server, reply, key } from './helpers.mjs';

const extension=fileURLToPath(new URL('..',import.meta.url));
const defaultCli=fileURLToPath(new URL('./bundle/cli.js',import.meta.resolve('@earendil-works/pi-coding-agent')));
const hosts=[['workspace',defaultCli],...(process.env.PI_WS_HOST_CLI?[['installed host',process.env.PI_WS_HOST_CLI]]:[])];

for(const [name,cli] of hosts)for(const fallback of [false,true])test(`${name}: RPC status and ${fallback?'five WS retries then SSE fallback':'WS continuation'}`,{timeout:30000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pi-ws-rpc-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const s=await server(t,(_b,r)=>{
    if(fallback&&r.transport==='websocket'){for(const event of reply(r.n,{text:'discarded partial'}).slice(0,3))r.ws.send(JSON.stringify(event));r.ws.close(1011,'fixture disconnect');return [];}
    return reply(r.n);
  });
  await writeFile(join(dir,'models.json'),JSON.stringify({providers:{alternate:{baseUrl:s.baseUrl,api:'openai-responses',apiKey:key,models:[{id:'fixture',reasoning:false,input:['text'],contextWindow:32768,maxTokens:128}]}}}));
  await writeFile(join(dir,'settings.json'),JSON.stringify({transport:fallback?'websocket':'websocket-cached',retry:{enabled:false},compaction:{enabled:false},cacheWarming:'off',enableInstallTelemetry:false}));
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,HOME:dir,USERPROFILE:dir,PI_CODING_AGENT_DIR:dir,NO_PROXY:'*',PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1'};
  const child=spawn(process.execPath,[cli,'--mode','rpc','--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-themes','--no-tools','--no-approve','-e',extension,'--model','alternate/fixture'],{cwd:dir,env,stdio:['pipe','pipe','pipe']});
  t.after(()=>child.kill());let buffer='',stderr='';const records=[],waiters=new Set();
  child.stderr.setEncoding('utf8');child.stderr.on('data',part=>stderr+=part);
  const fail=error=>{for(const waiter of waiters)waiter.reject(error);};
  child.on('error',fail);child.on('close',code=>fail(new Error(`RPC closed (${code}): ${stderr}`)));
  child.stdout.setEncoding('utf8');child.stdout.on('data',part=>{
    buffer+=part;let end;
    while((end=buffer.indexOf('\n'))!==-1){
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
      try{const record=JSON.parse(line);records.push(record);for(const waiter of waiters)if(waiter.predicate(record))waiter.resolve(record);}catch(error){fail(error);}
    }
  });
  const receive=predicate=>{
    const existing=records.find(predicate);if(existing)return Promise.resolve(existing);
    return new Promise((resolve,reject)=>{
      const remove=()=>{clearTimeout(timer);waiters.delete(waiter);};
      const waiter={predicate,resolve:record=>{remove();resolve(record);},reject:error=>{remove();reject(error);}};
      const timer=setTimeout(()=>waiter.reject(new Error(`RPC deadline: ${stderr}`)),15000);waiters.add(waiter);
    });
  };
  const command=async(id,type,extra={})=>{const result=receive(r=>r.type==='response'&&r.id===id);child.stdin.write(JSON.stringify({id,type,...extra})+'\n');return result;};
  const commands=await command('commands','get_commands');assert.equal(commands.success,true,stderr);
  assert.ok(commands.data.commands.some(c=>c.name==='responses-ws'&&c.source==='extension'),`Command missing: ${stderr}`);
  const before=receive(r=>r.type==='extension_ui_request'&&r.method==='notify');
  const handled=await command('before','prompt',{message:'/responses-ws'});assert.equal(handled.data.disposition,'handled');
  assert.equal(JSON.parse((await before).message).actual,'not connected');assert.equal(s.requests.length,0);
  const settled=receive(r=>r.type==='agent_settled');await command('generate','prompt',{message:'Reply hello.'});await settled;
  assert.equal(s.requests.length,fallback?7:1);assert.equal(s.requests.at(-1).transport,fallback?'sse':'websocket');assert.equal(s.handshakes.length,fallback?6:1);
  const firstEnd=records.length;const secondEnd=receive(r=>r.type==='agent_settled'&&records.indexOf(r)>=firstEnd);
  await command('next','prompt',{message:'Reply again.'});await secondEnd;
  assert.equal(s.requests.length,fallback?8:2);assert.equal(s.requests.at(-1).transport,fallback?'sse':'websocket');assert.equal(s.requests.at(-1).body.previous_response_id,fallback?undefined:'resp_1');assert.equal(s.handshakes.length,fallback?6:1);if(!fallback)assert.equal(s.requests[1].body.input.length,1);
  const after=receive(r=>r.type==='extension_ui_request'&&r.method==='notify'&&r.message.includes('"websocket"'));
  await command('after','prompt',{message:'/responses-ws'});const status=JSON.parse((await after).message);assert.equal(status.actual,fallback?'sse':'websocket');assert.equal(status.fullRequests,fallback?6:1);assert.equal(status.deltaRequests,fallback?0:1);assert.equal(status.warmupRequests,1);assert.equal(status.warmupsCompleted,1);assert.equal(status.lastWarmup,'completed');if(fallback){assert.equal(status.connectionsCreated,6);assert.equal(status.recovery,'sse cooldown');assert.equal(status.lastReason,'sse_cooldown');}
  assert.equal(s.requests.length,fallback?8:2,'status command must not generate');assert.ok(s.requests.every(r=>!JSON.stringify(r.body).includes('discarded partial')));
  const exited=new Promise(resolve=>child.once('close',resolve));child.stdin.end();assert.equal(await exited,0,stderr);
});
