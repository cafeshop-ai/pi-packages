#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { ExecutionTracker } from '../../dist/extension/execution-tracker.js';

const { values }=parseArgs({options:{report:{type:'string'}},strict:true});
const root=await mkdtemp(join(tmpdir(),'cafe-native-execution-'));
const originalFetch=globalThis.fetch;let networkRequests=0;
globalThis.fetch=async()=>{networkRequests++;throw Error('External network is forbidden in this native fixture');};
const scenarios=[];
try {
 for(const scenario of ['completed','error','retry','aborted','continuation']){
  const dir=join(root,scenario);await mkdir(dir);const events=[],states=[];let n=0,calls=0,continued=false,startedResolve;
  const started=new Promise(resolve=>{startedResolve=resolve;});
  const tracker=new ExecutionTracker(()=>`native-${scenario}-${++n}`);
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,modelsStorePath:join(dir,'models-cache.json'),refreshOnCreate:false,allowModelNetwork:false});
  const streamSimple=(model,_context,options)=>{
   calls++;const attempt=calls,stream=createAssistantMessageEventStream();
   queueMicrotask(async()=>{
    const output={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'pending',timestamp:Date.now()};
    stream.push({type:'start',partial:output});startedResolve();
    if(scenario==='aborted')await new Promise(done=>{if(options?.signal?.aborted)done();else options?.signal?.addEventListener('abort',()=>done(),{once:true});});
    if(scenario==='aborted'||scenario==='error'||scenario==='retry'&&attempt===1){
      output.stopReason=scenario==='aborted'?'aborted':'error';output.errorMessage=scenario==='retry'?'503 service temporarily unavailable':'synthetic non-retryable failure';
      stream.push({type:'error',reason:output.stopReason,error:output});
    }else{output.content=[{type:'text',text:'Synthetic native run. No tools or remote model executed.'}];output.stopReason='stop';stream.push({type:'done',reason:'stop',message:output});}
    stream.end();
   });return stream;
  };
  runtime.registerProvider('cafe-synthetic',{api:'cafe-synthetic-api',apiKey:'synthetic-key-not-a-credential',baseUrl:'http://127.0.0.1:1',models:[{id:'fixture',name:'Isolated execution fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}],streamSimple});
  const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:scenario==='retry',maxRetries:2,baseDelayMs:10}});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:'Isolated native lifecycle test.',extensionFactories:[pi=>{
   const save=()=>states.push(tracker.snapshot());
   pi.on('agent_start',()=>{events.push('extension:agent_start');tracker.begin();save();});
   pi.on('message_start',event=>{if(event.message.role==='assistant'){tracker.assistantStarted();save();}});
   pi.on('message_end',event=>{if(event.message.role==='assistant')tracker.assistantEnded(event.message.stopReason);});
   pi.on('agent_before_settle',event=>{events.push('extension:before:'+event.outcome);tracker.beforeSettle(event.outcome);save();if(scenario==='continuation'&&!continued){continued=true;return{continue:true,entries:[{type:'custom_message',customType:'execution-fixture',content:'Perform one further synthetic response.',display:false}]};}});
   pi.on('agent_settled',event=>{events.push('extension:settled:'+event.aborted);tracker.settled(event.aborted);save();});
  }]});
  await loader.reload();assert.equal(loader.getExtensions().errors.length,0);
  const {session}=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model:runtime.getModel('cafe-synthetic','fixture'),resourceLoader:loader,settingsManager:settings,sessionManager:SessionManager.inMemory(dir),noTools:'all',tools:[],thinkingLevel:'off'});
  try{
   await session.bindExtensions({});
   session.subscribe(event=>{if(['agent_start','agent_end','agent_settled','auto_retry_start','auto_retry_end','compaction_start','compaction_end'].includes(event.type))events.push('sdk:'+event.type);});
   const prompt=session.prompt('Synthetic fixture '+scenario);
   if(scenario==='aborted'){await started;await session.abort();}
   await prompt;
   const expected=scenario==='error'?'error':scenario==='aborted'?'aborted':'completed';
   assert.equal(tracker.snapshot().outcome,expected,JSON.stringify({scenario,events,states}));
   assert.equal(events.filter(e=>e.startsWith('extension:settled:')).length,1);
   if(scenario==='retry'){assert.equal(calls,2);assert(events.includes('sdk:auto_retry_start'));assert.equal(new Set(states.map(s=>s.runId).filter(Boolean)).size,1);}
   if(scenario==='continuation'){assert.equal(calls,2);assert.equal(new Set(states.map(s=>s.runId).filter(Boolean)).size,1);}
   assert(states.slice(0,-1).every(s=>s.outcome==='none'),'intermediate states must not claim a final result');
   scenarios.push({scenario,calls,outcome:tracker.snapshot().outcome,events,oneRunIdAcrossContinuation:new Set(states.map(s=>s.runId).filter(Boolean)).size===1});
  }finally{session.dispose();}
 }
 assert.equal(networkRequests,0);
 const pkg=JSON.parse(await readFile(new URL('../../../../node_modules/@earendil-works/pi-coding-agent/package.json',import.meta.url),'utf8'));
 const result={passed:true,nativePiVersion:pkg.version,scenarios,networkRequests,realModelRequests:0,toolsExecuted:0,usesOSC:false,scope:'Actual installed Pi SDK AgentSession and extension events with an in-memory model provider, not a real upstream model'};
 if(values.report){await mkdir(values.report,{recursive:true});await writeFile(resolve(values.report,'result.json'),JSON.stringify(result,null,2));}
 console.log(JSON.stringify(result,null,2));
}finally{globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
