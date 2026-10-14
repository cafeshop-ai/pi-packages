import test from 'node:test';
import assert from 'node:assert/strict';
import extension, { wrapProvider } from '../src/index.ts';
import { ResponsesTransport } from '../src/transport.ts';
import { cleanupSessionResources } from '@earendil-works/pi-ai';
import { isContextOverflow, isRetryableAssistantError } from '@earendil-works/pi-ai/compat';
import { context, modelFor, opts, server } from './helpers.mjs';

function fixture(bases=[],models=bases.map(base=>({provider:base.id,api:'openai-responses'})),existing=[]) {
  const events=new Map(),commands=new Map(),registrations=new Map(existing.map(base=>[base.id,base]));
  const registry={getAll:()=>models,getRegisteredProviderIds:()=>[...registrations.keys()],getProvider:name=>registrations.get(name)??bases.find(base=>base.id===name),getRegisteredNativeProvider:name=>registrations.get(name),unregisterProvider:name=>registrations.delete(name)};
  const pi={on:(name,handler)=>events.set(name,handler),registerCommand:(name,command)=>commands.set(name,command),registerProvider:provider=>registrations.set(provider.id,provider),unregisterProvider:registry.unregisterProvider};
  const notices=[];let id='owner';
  const ctx={modelRegistry:registry,sessionManager:{getSessionId:()=>id},ui:{notify:message=>notices.push(message)}};
  extension(pi);events.get('session_start')({},ctx);
  return {events,commands,ctx,notices,registry,registrations,registered:(name=bases[0]?.id)=>registrations.get(name),setSession:value=>{id=value;}};
}

test('non-Responses API remains delegated for both raw and simple stream',()=>{
  const calls=[],base={id:'cafe',stream:(...args)=>{calls.push(['raw',...args]);return 'raw';},streamSimple:(...args)=>{calls.push(['simple',...args]);return 'simple';}};
  const wrapped=wrapProvider(base,new ResponsesTransport()),model={api:'anthropic-messages'},ctx={},options={};
  assert.equal(wrapped.stream(model,ctx,options),'raw');assert.equal(wrapped.streamSimple(model,ctx,options),'simple');
  assert.deepEqual(calls,[['raw',model,ctx,options],['simple',model,ctx,options]]);
});

test('no Responses models: no registration, no discovery or generation',async t=>{
  const f=fixture([{id:'other'}],[{provider:'other',api:'anthropic-messages'}]);t.after(()=>f.events.get('session_shutdown')({},f.ctx));
  assert.equal(f.registrations.size,0);await f.commands.get('responses-ws').handler('',f.ctx);
  const status=JSON.parse(f.notices[0]);assert.deepEqual(status.enabledProviders,[]);assert.deepEqual(status.skippedProviders,[]);assert.equal(status.actual,'not connected');
});

test('arbitrary Responses provider names are discovered once, including after model selection',t=>{
  const bases=[{id:'alpha'},{id:'beta'},{id:'other'}],models=[{provider:'alpha',api:'openai-responses'},{provider:'alpha',api:'openai-responses'},{provider:'other',api:'openai-completions'}];
  const f=fixture(bases,models);t.after(()=>f.events.get('session_shutdown')({},f.ctx));
  const first=f.registered('alpha');assert.ok(first);assert.equal(f.registrations.size,1);
  models.push({provider:'beta',api:'openai-responses'});f.events.get('model_select')({},f.ctx);
  assert.equal(f.registered('alpha'),first);assert.ok(f.registered('beta'));assert.equal(f.registered('other'),undefined);assert.equal(f.registrations.size,2);
});

test('conflicting provider extension is skipped without blocking other Responses providers',async t=>{
  const custom={id:'custom',stream:()=> 'custom'},normal={id:'normal'};
  const f=fixture([custom,normal],undefined,[custom]);t.after(()=>f.events.get('session_shutdown')({},f.ctx));
  assert.equal(f.registered('custom'),custom);assert.notEqual(f.registered('normal'),normal);
  await f.commands.get('responses-ws').handler('',f.ctx);const status=JSON.parse(f.notices[0]);assert.deepEqual(status.enabledProviders,['normal']);assert.deepEqual(status.skippedProviders,['custom']);
  f.registry.unregisterProvider('custom');f.events.get('model_select')({},f.ctx);assert.notEqual(f.registered('custom'),custom);
  await f.commands.get('responses-ws').handler('',f.ctx);assert.deepEqual(JSON.parse(f.notices[1]).skippedProviders,[]);
});

for(const event of ['session_shutdown','resource_cleanup'])test(`${event}: releases only owned providers, preserving a later replacement`,async t=>{
  const f=fixture([{id:'alpha'},{id:'beta'}]);t.after(()=>f.events.get('session_shutdown')({},f.ctx));
  const replacement={id:'alpha'};f.registrations.set('alpha',replacement);f.events.get('model_select')({},f.ctx);
  await f.commands.get('responses-ws').handler('',f.ctx);assert.deepEqual(JSON.parse(f.notices[0]).skippedProviders,['alpha']);
  if(event==='session_shutdown')f.events.get(event)({},f.ctx);else cleanupSessionResources('owner');
  assert.equal(f.registered('alpha'),replacement);assert.equal(f.registered('beta'),undefined);
});

test('session dispose closes all owned sockets including raw SDK and a switched session; status is safe',async t=>{
  const s=await server(t);const api=(await import('@earendil-works/pi-ai/compat')).openAIResponsesApi();
  const base={id:'cafe',stream:api.stream,streamSimple:api.streamSimple},second={...base,id:'another'},f=fixture([base,second]);t.after(()=>f.events.get('session_shutdown')({},f.ctx));
  const provider=f.registered(),model=modelFor(s.baseUrl);
  await provider.streamSimple(model,context(),opts({sessionId:'owner'})).result();
  await f.registered('another').streamSimple({...model,provider:'another'},context(),opts({sessionId:'raw-sdk'})).result();
  await f.commands.get('responses-ws').handler('',f.ctx);
  const status=JSON.parse(f.notices[0]);assert.equal(status.actual,'websocket');assert.equal(status.provider,'cafe');assert.deepEqual(status.enabledProviders,['another','cafe']);assert.equal(status.connectionsCreated,1);assert.equal(status.fullRequests,1);
  assert.ok(!f.notices[0].includes('fixture-not-a-secret'));assert.ok(!f.notices[0].includes('resp_'));assert.ok(!f.notices[0].includes('127.0.0.1'));
  f.setSession('switched');await provider.streamSimple(model,context(),opts({sessionId:'switched'})).result();
  cleanupSessionResources('switched');assert.equal(f.registrations.size,0);await new Promise(r=>setTimeout(r,10));assert.equal(s.sockets.size,0);
  cleanupSessionResources('switched');
});

for(const code of ['context_length_exceeded','rate_limit_exceeded','insufficient_quota','invalid_api_key','previous_response_not_found'])test('Pi retry/overflow classification: '+code,async t=>{
  const s=await server(t,()=>[{type:'error',code,message:code}]),m=new ResponsesTransport();t.after(()=>m.clear());
  const output=await m.stream(modelFor(s.baseUrl),context(),opts()).result();assert.equal(output.stopReason,'error');
  assert.equal(isRetryableAssistantError(output),code==='rate_limit_exceeded');
  if(code==='context_length_exceeded')assert.equal(isContextOverflow(output),true);
});
