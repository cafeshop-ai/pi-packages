import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildChildArgs } from '../../pi-subagent/src/invocation.ts';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { server, reply, key, context, opts } from './helpers.mjs';

const extension=fileURLToPath(new URL('../src/index.ts',import.meta.url));
const routerExtension=fileURLToPath(new URL('../../pi-auto-router/src/index.ts',import.meta.url));

async function setup(t,s,{router=false,tools=[],entry=extension,provider='cafe'}={}) {
  const dir=await mkdtemp(join(tmpdir(),'pi-responses-ws-test-'));
  const oldAgent=process.env.PI_CODING_AGENT_DIR, oldNoProxy=process.env.NO_PROXY;
  process.env.PI_CODING_AGENT_DIR=dir;process.env.NO_PROXY='*';
  t.after(async()=>{if(oldAgent===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldAgent;if(oldNoProxy===undefined)delete process.env.NO_PROXY;else process.env.NO_PROXY=oldNoProxy;await rm(dir,{recursive:true,force:true});});
  const definition={baseUrl:s.baseUrl,api:'openai-responses',apiKey:key,models:[{id:'fixture',reasoning:true,input:['text','image'],contextWindow:32768,maxTokens:128}]};
  const modelsPath=join(dir,'models.json');await writeFile(modelsPath,JSON.stringify({providers:{[provider]:definition,secondary:{...definition,apiKey:'fixture-secondary-key'}}}));
  if(router)await writeFile(join(dir,'pi-auto-router.json'),JSON.stringify({classifier:{provider:'not-configured',model:'none'},routes:Object.fromEntries(['high','medium','low'].map(t=>[t,{provider,model:'fixture',thinkingLevel:'low'}]))}));
  const runtime=await ModelRuntime.create({modelsPath,authPath:join(dir,'auth.json'),allowModelNetwork:false});
  const settings=SettingsManager.inMemory({transport:'websocket-cached',retry:{enabled:false},compaction:{enabled:false,keepRecentTokens:1,reserveTokens:16},cacheWarming:'off',enableInstallTelemetry:false});
  let enabled=true;
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:'Fixture assistant; echo tool when requested.',additionalExtensionPaths:[entry,...(router?[routerExtension]:[])],extensionsOverride:r=>enabled?r:{...r,extensions:[]}});
  await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  const before=JSON.stringify(runtime.getModels().filter(model=>model.provider!=='router'));
  const {session}=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model:runtime.getModel(provider,'fixture'),thinkingLevel:'low',settingsManager:settings,resourceLoader:loader,sessionManager:SessionManager.inMemory(dir),noTools:true,customTools:tools});
  const errors=[];await session.bindExtensions({mode:'json',onError:e=>errors.push(e)});
  t.after(()=>session.dispose());
  assert.deepEqual(errors,[]);assert.equal(JSON.stringify(runtime.getModels().filter(model=>model.provider!=='router')),before);
  return {session,runtime,dir,errors,modelsPath,disable:()=>{enabled=false;}};
}

test('actual Pi loader, agent tool execution, incremental continuation, reload/unload and raw SDK options', {timeout:30000}, async t=>{
  const s=await server(t,(_b,r)=>reply(r.n,{tool:r.n===1}));let toolCalls=0;
  const f=await setup(t,s,{tools:[{name:'echo',label:'Echo',description:'Echo a value',parameters:Type.Object({value:Type.String()}),execute:async(_id,args)=>{toolCalls++;return{content:[{type:'text',text:args.value}],details:undefined};}}]});
  const originalConfig=await readFile(f.modelsPath,'utf8');
  await f.session.prompt('/responses-ws');assert.equal(s.requests.length,0,'status command performs no generation');assert.equal(s.warmups.length,0,'no speculative startup requests');
  await f.session.prompt('Use echo once.');
  const piSessionId=f.session.sessionManager.getSessionId();
  assert.equal(s.warmups.length,1);assert.equal(s.warmups[0].body.generate,false);assert.deepEqual(s.warmups[0].body.input,[]);assert.equal(s.warmups[0].body.reasoning.effort,'low');assert.equal(s.warmups[0].ws,s.requests[0].ws);
  assert.equal(s.requests[0].body.client_metadata.session_id,piSessionId);assert.equal(s.requests[0].body.client_metadata.thread_id,piSessionId);assert.equal(s.requests[0].headers['session-id'],piSessionId);assert.equal(s.requests[0].headers['thread-id'],piSessionId);
  assert.equal(f.session.getLastAssistantText(),'hello 世界🙂');assert.equal(toolCalls,1);assert.equal(s.requests.length,2);assert.equal(s.requests[1].body.previous_response_id,'resp_1');assert.equal(s.requests[1].body.input[0].type,'function_call_output');
  const raw=await f.runtime.complete(f.runtime.getModel('cafe','fixture'),context(),opts({sessionId:'raw',reasoningEffort:'high',serviceTier:'priority',toolChoice:'required'}));
  assert.equal(raw.stopReason,'stop',raw.errorMessage);assert.equal(s.requests[2].body.reasoning.effort,'high');assert.equal(s.requests[2].body.service_tier,'priority');assert.equal(s.requests[2].body.tool_choice,'required');
  const other=await f.runtime.completeSimple(f.runtime.getModel('secondary','fixture'),context(),opts({sessionId:'other'}));assert.equal(other.stopReason,'stop');assert.equal(s.requests[3].transport,'websocket');
  await f.session.reload();assert.deepEqual(f.errors,[]);await f.session.prompt('After reload.');assert.equal(s.requests.at(-1).transport,'websocket');assert.equal(s.requests.at(-1).body.previous_response_id,undefined);
  const beforeCompact=s.requests.length;await f.session.compact('Keep a short summary.');assert.ok(s.requests.length>beforeCompact);assert.equal(s.requests.at(-1).transport,'websocket');assert.equal(s.requests.at(-1).body.previous_response_id,undefined);
  await f.session.prompt('After compaction.');assert.equal(s.requests.at(-1).body.previous_response_id,undefined);
  f.disable();await f.session.reload();assert.equal(f.runtime.getRegisteredNativeProvider('cafe'),undefined);assert.equal(f.runtime.getRegisteredNativeProvider('secondary'),undefined);await f.session.prompt('After disable.');assert.equal(s.requests.at(-1).transport,'sse');assert.equal(await readFile(f.modelsPath,'utf8'),originalConfig);
  f.session.dispose();await new Promise(r=>setTimeout(r,10));assert.equal(s.sockets.size,0);
});

test('no Cafe provider: arbitrary providers keep separate auth, sockets and continuation through reload/unload', {timeout:30000},async t=>{
  const s=await server(t),f=await setup(t,s,{provider:'personal'}),config=await readFile(f.modelsPath,'utf8');
  assert.equal(f.runtime.getModel('cafe','fixture'),undefined);
  await f.session.prompt('First personal turn.');assert.equal(s.requests[0].transport,'websocket');assert.equal(s.requests[0].headers.authorization,`Bearer ${key}`);
  await f.session.setModel(f.runtime.getModel('secondary','fixture'));await f.session.prompt('Secondary turn.');
  assert.equal(s.requests[1].transport,'websocket');assert.equal(s.requests[1].headers.authorization,'Bearer fixture-secondary-key');assert.equal(s.requests[1].body.previous_response_id,undefined);assert.equal(s.handshakes.length,2);
  await f.session.setModel(f.runtime.getModel('personal','fixture'));await f.session.prompt('Personal again.');assert.equal(s.requests.at(-1).headers.authorization,`Bearer ${key}`);assert.equal(s.handshakes.length,2);
  await f.session.reload();await f.session.prompt('After reload.');assert.equal(s.requests.at(-1).transport,'websocket');assert.equal(s.requests.at(-1).body.previous_response_id,undefined);
  f.disable();await f.session.reload();assert.equal(f.runtime.getRegisteredNativeProvider('personal'),undefined);assert.equal(f.runtime.getRegisteredNativeProvider('secondary'),undefined);
  await f.session.prompt('Native after unload.');assert.equal(s.requests.at(-1).transport,'sse');assert.equal(await readFile(f.modelsPath,'utf8'),config);assert.deepEqual(f.errors,[]);
});

test('actual agent retries partial WS tool responses, falls back once, and executes only the successful tool call',{timeout:15000},async t=>{
  const s=await server(t,async(_b,r)=>{
    if(r.transport==='sse')return reply(r.n,{tool:r.n===7});
    for(const event of reply(r.n,{tool:true}).slice(0,-1))r.ws.send(JSON.stringify(event));
    await new Promise(resolve=>setTimeout(resolve,5));r.ws.terminate();return [];
  });let toolCalls=0;
  const f=await setup(t,s,{tools:[{name:'echo',label:'Echo',description:'Echo a value',parameters:Type.Object({value:Type.String()}),execute:async()=>{toolCalls++;return{content:[{type:'text',text:'result'}],details:undefined};}}]});
  await f.session.prompt('Use echo once.');assert.equal(f.session.getLastAssistantText(),'hello 世界🙂');assert.equal(toolCalls,1);assert.equal(s.handshakes.length,6);assert.equal(s.requests.length,8);assert.ok(s.requests.slice(0,6).every(r=>r.transport==='websocket'));assert.ok(s.requests.slice(6).every(r=>r.transport==='sse'));
  const messages=f.session.messages;assert.equal(messages.filter(m=>m.role==='assistant').length,2);assert.equal(messages.filter(m=>m.role==='toolResult').length,1);assert.equal(messages.find(m=>m.role==='toolResult').toolCallId.split('|')[0],'call_7');assert.deepEqual(f.errors,[]);
});

test('auxiliary fixture also loads the actual extension imports through Pi',async t=>{
  const s=await server(t),f=await setup(t,s,{entry:fileURLToPath(new URL('./fixtures/imports.ts',import.meta.url))});
  await f.session.prompt('Fixture import.');assert.equal(s.requests[0].transport,'websocket');assert.deepEqual(f.errors,[]);
});

test('actual pi-auto-router physical model dispatch reaches the WS wrapper', {timeout:30000}, async t=>{
  const s=await server(t),f=await setup(t,s,{router:true});
  const virtual=f.runtime.getModel('router','auto');assert.ok(virtual);await f.session.setModel(virtual);await f.session.prompt('Route fixture.');
  assert.equal(f.session.getLastAssistantText(),'hello 世界🙂');assert.equal(s.requests[0].transport,'websocket');assert.equal(s.requests[0].body.model,'fixture');assert.deepEqual(f.errors,[]);
  f.session.dispose();await new Promise(r=>setTimeout(r,10));assert.equal(s.sockets.size,0);assert.equal(f.runtime.getRegisteredNativeProvider('cafe'),undefined);
});

const childHosts=[['workspace',fileURLToPath(new URL('./bundle/cli.js',import.meta.resolve('@earendil-works/pi-coding-agent')))],...(process.env.PI_WS_HOST_CLI?[['installed host',process.env.PI_WS_HOST_CLI]]:[])];
for(const [host,cli] of childHosts)for(const enabled of [true,false])test(`${host}: real bundled CLI with pi-subagent arguments, explicit extension=${enabled}`,{timeout:30000},async t=>{
  const s=await server(t),f=await setup(t,s,{provider:'alternate'});f.session.dispose();
  await writeFile(join(f.dir,'settings.json'),JSON.stringify({transport:'websocket-cached',extensions:[extension],retry:{enabled:false},cacheWarming:'off',enableInstallTelemetry:false}));
  const args=buildChildArgs({task:'Say hello.',tools:'',model:'alternate/fixture'});
  if(enabled)args.unshift('-e',fileURLToPath(new URL('..',import.meta.url)));
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,HOME:f.dir,USERPROFILE:f.dir,PI_CODING_AGENT_DIR:f.dir,NO_PROXY:'*',PI_SKIP_VERSION_CHECK:'1'};
  const child=spawn(process.execPath,[cli,...args],{cwd:f.dir,env,stdio:['ignore','pipe','pipe']});t.after(()=>child.kill());
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,0,stderr+'\n'+stdout);assert.ok(stdout.includes('hello 世界🙂'),stdout);assert.equal(s.requests.length,1);assert.equal(s.requests[0].transport,enabled?'websocket':'sse');assert.equal(s.handshakes.length,enabled?1:0);assert.equal(s.warmups.length,enabled?1:0);assert.equal(s.sockets.size,0);
});
