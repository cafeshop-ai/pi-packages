#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { applyThinkingLevel, thinkingCapability } from '../../dist/extension/thinking-capability.js';
const {values}=parseArgs({options:{'pi-root':{type:'string'},report:{type:'string'}},strict:true});
assert(values['pi-root']&&isAbsolute(values['pi-root']));
const root=values['pi-root'],pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
const {AgentSession}=await import(pathToFileURL(resolve(root,'dist/core/agent-session.js')).href);
const {getSupportedThinkingLevels}=await import(pathToFileURL(resolve(root,'node_modules/@earendil-works/pi-ai/dist/compat.js')).href);
const cases=[];
for(const reasoning of [false,true]){
 const model={provider:'cafeshop',id:'gemini-3.8-flash',api:'openai-responses',reasoning};const emitted=[];
 const session={model,agent:{state:{thinkingLevel:'off'}},sessionManager:{appendThinkingLevelChange(){}},_extensionRunner:{emit:async e=>emitted.push(e.type)},_emit:e=>emitted.push(e.type),getAvailableThinkingLevels:AgentSession.prototype.getAvailableThinkingLevels,_clampThinkingLevel:AgentSession.prototype._clampThinkingLevel};
 const api={getThinkingLevel:()=>session.agent.state.thinkingLevel,setThinkingLevel:level=>AgentSession.prototype.setThinkingLevel.call(session,level)};
 assert.deepEqual(thinkingCapability(model).thinkingLevels,getSupportedThinkingLevels(model));
 const result=applyThinkingLevel(api,model,'high');
 assert.equal(result.actual,reasoning?'high':'off');assert.equal(result.code,reasoning?null:'THINKING_UNSUPPORTED');
 if(reasoning){assert(emitted.includes('thinking_level_select'));assert.equal(applyThinkingLevel(api,model,'low').actual,'low');}
 else assert.equal(emitted.length,0);
 cases.push({reasoning,supported:getSupportedThinkingLevels(model),requested:'high',result,events:emitted});
}
// The legacy/unknown metadata path must also detect Pi's real silent clamping.
const m={reasoning:false};let current='off';const native={model:m,agent:{state:{thinkingLevel:current}},sessionManager:{appendThinkingLevelChange(){}},_extensionRunner:{emit:async()=>{}},_emit(){},getAvailableThinkingLevels:AgentSession.prototype.getAvailableThinkingLevels,_clampThinkingLevel:AgentSession.prototype._clampThinkingLevel};
const clamped=applyThinkingLevel({getThinkingLevel:()=>native.agent.state.thinkingLevel,setThinkingLevel:level=>AgentSession.prototype.setThinkingLevel.call(native,level)},undefined,'high');assert.equal(clamped.code,'THINKING_NOT_APPLIED');
const {streamSimple}=await import(pathToFileURL(resolve(root,'node_modules/@earendil-works/pi-ai/dist/compat.js')).href);
let payload=null,networkRequests=0;const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{networkRequests++;throw Error('Network disabled');};
try{await streamSimple({id:'gemini-3.8-flash',name:'synthetic serialization check',provider:'cafeshop',api:'openai-responses',baseUrl:'http://127.0.0.1:1/v1',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:4096,maxTokens:64},{messages:[{role:'user',content:'synthetic local check',timestamp:0}]},{apiKey:'synthetic-test-only',reasoning:'high',maxTokens:16,onPayload:value=>{payload=value;throw Error('Stop after serialization');}}).result();}finally{globalThis.fetch=originalFetch;}
assert.equal(payload?.reasoning?.effort,'high');assert.equal(networkRequests,0);
const report={passed:true,actualResponsesEffort:payload.reasoning.effort,networkRequests,nativePackage:pkg.name,nativeVersion:pkg.version,cases,legacySilentClampRejected:true,providerRequests:0,scope:'Actual installed AgentSession setter and capability helper, isolated in-memory state; not an upstream model API test'};
if(values.report){await mkdir(values.report,{recursive:true});await writeFile(resolve(values.report,'result.json'),JSON.stringify(report,null,2));}console.log(JSON.stringify(report,null,2));
