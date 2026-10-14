import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { once } from 'node:events';
import { ResponsesTransport } from '../src/transport.ts';
import { MAX_BYTES } from '../src/continuation.ts';
import { context, opts, modelFor, reply, server, nextContext, collect, key } from './helpers.mjs';
import { normalizeContext, Type } from '@earendil-works/pi-ai';

function manager(t, now, wait = async () => {}) { const m = new ResponsesTransport(now, wait, { random: () => 0 }); t.after(() => m.clear()); return m; }

for (const mode of ['sse', 'websocket', 'websocket-cached', 'auto']) {
  test(`${mode}: native text parsing, hooks, actual transport, usage and two-turn behavior`, { timeout: 10000 }, async t => {
    const s=await server(t), m=manager(t), model=modelFor(s.baseUrl);
    const seen={payload:0,response:[],events:0};
    const options=opts({transport:mode,onPayload:p=>{seen.payload++;return {...p,metadata:{fixture:true}};},onResponse:r=>seen.response.push(r),onProviderStreamEvent:()=>{seen.events++;}});
    const ctx=context();
    const first=await collect(m.stream(model,ctx,options));
    assert.equal(first.output.stopReason,'stop',first.output.errorMessage);
    assert.equal(first.output.content[0].text,'hello 世界🙂');
    assert.equal(first.output.usage.input,7); assert.equal(first.output.usage.cacheRead,3); assert.equal(first.output.usage.output,4);
    assert.ok(Math.abs(first.output.usage.cost.total-0.0000165)<1e-15);
    assert.equal(first.events.filter(e=>e.type==='start').length,1);
    assert.equal(first.events.filter(e=>e.type==='done').length,1);
    const second=await m.stream(model,nextContext(ctx,first.output),options).result();
    assert.equal(second.stopReason,'stop',second.errorMessage);
    assert.equal(seen.payload,2,'payload-only cache builds must not run caller hooks'); assert.equal(seen.response.length,2); assert.equal(seen.events,10);
    const isWs=mode!=='sse', cached=['websocket-cached','auto'].includes(mode);
    assert.equal(s.handshakes.length,isWs?1:0,'reuse one connection');
    assert.equal(s.requests[1].body.previous_response_id,cached?'resp_1':undefined);
    assert.equal(s.requests[1].body.input.length,cached?1:4);
    assert.equal(s.requests[0].body.metadata.fixture,true);
    assert.equal(s.requests[0].headers.authorization,`Bearer ${key}`);
    assert.equal(seen.response[0].status,isWs?101:200);
    if(isWs){assert.equal(s.handshakes[0].headers['openai-beta'],'responses_websockets=2026-02-06');assert.equal(s.requests[0].body.stream,undefined);assert.equal(s.requests[0].body.type,'response.create');assert.equal(seen.response[1].headers['x-pi-responses-connection-reused'],'true');}
    const status=m.snapshot('fixture-session'); assert.equal(status.actual,isWs?'websocket':'sse');
    if(cached){assert.equal(status.deltaRequests,1);assert.ok(status.lastRequestBytes<status.lastFullBytes);}
  });
}

for(const mode of ['auto','websocket','websocket-cached'])test(`${mode}: ordinary Pi requests satisfy the canonical identity gate`,async t=>{
  const s=await server(t,(_b,r)=>{
    if(r.transport==='sse')return reply(r.n);
    const metadata=r.body.client_metadata;
    if(!metadata?.session_id||!metadata?.thread_id){r.ws.close(1011);return [];}
    assert.equal(metadata.session_id,'fixture-session');assert.equal(metadata.thread_id,'fixture-session');
    assert.equal(r.headers['session-id'],metadata.session_id);assert.equal(r.headers['thread-id'],metadata.thread_id);
    assert.ok(!r.headers['user-agent'].startsWith('codex_cli_rs'));assert.equal(r.headers.originator,undefined);
    return reply(r.n);
  }),m=manager(t);let prepared;
  const options=opts({transport:mode,onPayload:body=>{prepared=body;}});
  const first=await m.stream(modelFor(s.baseUrl),context(),options).result();assert.equal(first.stopReason,'stop',first.errorMessage);
  assert.equal(prepared.client_metadata,undefined,'transport must not mutate caller payloads');
  assert.equal(s.requests.length,1);assert.equal(s.handshakes.length,1);assert.equal(m.snapshot('fixture-session').actual,'websocket');
  const second=await m.stream(modelFor(s.baseUrl),nextContext(context(),first),options).result();assert.equal(second.stopReason,'stop',second.errorMessage);
  assert.equal(s.handshakes.length,1);assert.equal(s.requests[1].body.previous_response_id,mode==='websocket'?undefined:'resp_1');
});

for(const supplied of ['headers','metadata','partial'])test(`WS preserves and completes caller identity: ${supplied}`,async t=>{
  const s=await server(t),m=manager(t);
  const metadata=supplied==='headers'?{trace:'private-extra'}:{session_id:'private-session',...(supplied==='partial'?{}:{thread_id:'private-thread'}),trace:'private-extra'};
  const headers=supplied==='headers'?{'session-id':'private-session','thread-id':'private-thread'}:{};
  const original=JSON.stringify({metadata,headers});
  const output=await m.stream(modelFor(s.baseUrl),context(),opts({headers,onPayload:body=>({...body,client_metadata:metadata})})).result();
  assert.equal(output.stopReason,'stop',output.errorMessage);assert.equal(JSON.stringify({metadata,headers}),original);
  const r=s.requests[0];assert.equal(r.body.client_metadata.session_id,'private-session');assert.equal(r.body.client_metadata.thread_id,supplied==='partial'?'fixture-session':'private-thread');
  assert.equal(r.body.client_metadata.trace,'private-extra');assert.equal(r.headers['session-id'],r.body.client_metadata.session_id);assert.equal(r.headers['thread-id'],r.body.client_metadata.thread_id);
  assert.ok(!JSON.stringify(m.snapshot('fixture-session')).includes('private-'));
});

test('metadata-only identity changes isolate sockets and continuation',async t=>{
  const s=await server(t),m=manager(t),model=modelFor(s.baseUrl);
  const options=thread=>opts({onPayload:body=>({...body,client_metadata:{session_id:'private-session',thread_id:thread}})});
  const first=await m.stream(model,context(),options('thread-a')).result();assert.equal(first.stopReason,'stop');
  const second=await m.stream(model,nextContext(context(),first),options('thread-b')).result();assert.equal(second.stopReason,'stop',second.errorMessage);
  assert.equal(s.handshakes.length,2);assert.equal(s.requests[1].headers['thread-id'],'thread-b');assert.equal(s.requests[1].body.previous_response_id,undefined);
});

test('missing SDK session uses a transient identity stable only within retry attempts',async t=>{
  const s=await server(t,(_b,r)=>{if(r.n===1){r.ws.close(1011);return [];}return reply(r.n);}),m=manager(t),model=modelFor(s.baseUrl);
  const options=opts({sessionId:undefined});
  assert.equal((await m.stream(model,context(),options).result()).stopReason,'stop');
  assert.equal((await m.stream(model,context(),options).result()).stopReason,'stop');
  const ids=s.requests.map(r=>r.body.client_metadata.session_id);assert.match(ids[0],/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(ids[0],ids[1]);assert.notEqual(ids[1],ids[2]);
  assert.ok(s.requests.every(r=>r.headers['session-id']===r.body.client_metadata.session_id&&r.headers['thread-id']===r.body.client_metadata.thread_id&&!r.body.previous_response_id));
  assert.equal(m.snapshot().activeConnections,0);
});

for(const invalid of [null,[],{session_id:null},{session_id:''},{session_id:'x'.repeat(161)},{session_id:'私有会话'},{thread_id:'private\nidentity'}])test(`invalid canonical metadata is rejected before connecting: ${JSON.stringify(invalid).slice(0,40)}`,async t=>{
  const s=await server(t),m=manager(t);
  const result=await m.stream(modelFor(s.baseUrl),context(),opts({onPayload:body=>({...body,client_metadata:invalid})})).result();
  assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/invalid_session_identity/);assert.ok(!result.errorMessage.includes('private'));
  assert.equal(s.handshakes.length,0);assert.equal(s.requests.length,0);assert.equal(m.snapshot('fixture-session').lastReason,'invalid_session_identity');
});

test('conflicting header and metadata identity is rejected without forwarding either value',async t=>{
  const s=await server(t),m=manager(t);
  const result=await m.stream(modelFor(s.baseUrl),context(),opts({headers:{'session-id':'private-header'},onPayload:body=>({...body,client_metadata:{session_id:'private-body',thread_id:'private-thread'}})})).result();
  assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/session_identity_conflict/);assert.ok(!result.errorMessage.includes('private'));assert.equal(s.handshakes.length,0);assert.equal(s.requests.length,0);
});

for(const mode of ['sse','auto','websocket','websocket-cached'])test(`${mode}: generated canonical identity never changes SSE payload or headers`,async t=>{
  const s=await server(t,(_b,r)=>{if(r.transport==='websocket'){r.ws.close(1011);return [];}return reply(r.n);}),m=manager(t);
  const result=await m.stream(modelFor(s.baseUrl),context(),opts({transport:mode,onPayload:body=>({...body,client_metadata:{trace:'private-extra'}})})).result();
  assert.equal(result.stopReason,'stop',result.errorMessage);const last=s.requests.at(-1);assert.equal(last.transport,'sse');
  assert.deepEqual(last.body.client_metadata,{trace:'private-extra'});assert.equal(last.headers['session-id'],undefined);assert.equal(last.headers['thread-id'],undefined);
  assert.equal(last.headers.authorization,`Bearer ${key}`);
  if(mode!=='sse'){assert.equal(s.handshakes.length,6);assert.ok(s.requests.slice(0,6).every(r=>r.body.client_metadata.session_id==='fixture-session'));}
});

test('WS identity augmentation still enforces the outgoing request byte limit',async t=>{
  const s=await server(t),m=manager(t);
  const result=await m.stream(modelFor(s.baseUrl),context(),opts({onPayload:()=>({model:'fixture',input:[{role:'user',content:'x'.repeat(MAX_BYTES-100)}],store:false,stream:true})})).result();
  assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/request_too_large/);assert.equal(s.requests.length,0);assert.equal(m.snapshot('fixture-session').activeConnections,0);
});

test('thinking signatures and complete tool/result roundtrip retain Pi IDs in incremental input', {timeout:10000}, async t=>{
  const s=await server(t,(_b,r)=>reply(r.n,{tool:r.n===1,thinking:true})),m=manager(t),model=modelFor(s.baseUrl);
  const ctx=normalizeContext({systemPrompt:'fixture',tools:[{name:'echo',description:'echo',parameters:Type.Object({value:Type.String()})}],messages:[{role:'user',content:'use tool',timestamp:1}]});
  const first=await m.stream(model,ctx,opts()).result();
  assert.equal(first.stopReason,'toolUse',first.errorMessage);
  const tool=first.content.find(p=>p.type==='toolCall');assert.deepEqual(tool.arguments,{value:'你好'});
  assert.ok(first.content.find(p=>p.type==='thinking').thinkingSignature.includes('encrypted_1'));
  const next=normalizeContext({messages:[...ctx.messages,first,{role:'toolResult',toolCallId:tool.id,toolName:'echo',content:[{type:'text',text:'result'},{type:'image',data:'AQID',mimeType:'image/png'}],isError:false,timestamp:2}]});
  const second=await m.stream(model,next,opts()).result();assert.equal(second.stopReason,'stop',second.errorMessage);
  assert.equal(s.requests[1].body.previous_response_id,'resp_1');
  assert.equal(s.requests[1].body.input.length,1); assert.equal(s.requests[1].body.input[0].type,'function_call_output');
  assert.equal(s.requests[1].body.input[0].call_id,'call_1');assert.equal(s.requests[1].body.input[0].output[1].type,'input_image');
});

test('image input, onPayload replacement, raw reasoningEffort/serviceTier/toolChoice stay intact', async t=>{
  const s=await server(t),m=manager(t),model=modelFor(s.baseUrl);
  const ctx=context([{role:'user',content:[{type:'text',text:'look'},{type:'image',data:'AQID',mimeType:'image/png'}],timestamp:1}]);
  const output=await m.stream(model,ctx,opts({reasoningEffort:'high',reasoningSummary:'detailed',serviceTier:'priority',toolChoice:'required',maxTokens:32,onPayload:p=>({...p,temperature:0.25})}),false).result();
  assert.equal(output.stopReason,'stop',output.errorMessage);
  const b=s.requests[0].body;assert.equal(b.reasoning.effort,'high');assert.equal(b.reasoning.summary,'detailed');assert.equal(b.service_tier,'priority');assert.equal(b.tool_choice,'required');assert.equal(b.max_output_tokens,32);assert.equal(b.temperature,0.25);assert.equal(b.input[1].content[1].image_url,'data:image/png;base64,AQID');
});

for(const change of ['branch','system','tools','sampling','empty delta','assistant edit']) test(`cache invalidation: ${change}`,async t=>{
  const s=await server(t),m=manager(t),model=modelFor(s.baseUrl),ctx=context();
  const first=await m.stream(model,ctx,opts()).result();assert.equal(first.stopReason,'stop',first.errorMessage);
  let next=nextContext(ctx,first),extra={};
  if(change==='branch') next=context([{role:'user',content:'different branch',timestamp:1}]);
  if(change==='system') next=normalizeContext({systemPrompt:'changed',messages:next.messages.filter(m=>m.role!=='system')});
  if(change==='tools') next=normalizeContext({systemPrompt:'fixture system',tools:[{name:'echo',description:'echo',parameters:Type.Object({value:Type.String()})}],messages:next.messages.filter(m=>m.role!=='system')});
  if(change==='sampling') extra={temperature:0.7};
  if(change==='empty delta') next=normalizeContext({messages:[...ctx.messages,first]});
  if(change==='assistant edit'){const altered=structuredClone(first);altered.content[0].text='edited';next=nextContext(ctx,altered);}
  const output=await m.stream(model,next,opts(extra)).result();assert.equal(output.stopReason,'stop',output.errorMessage);assert.equal(s.requests[1].body.previous_response_id,undefined);
});

for(const change of ['provider','model','payload model','key','headers','no session','no cache']) test(`connection identity: ${change}`,async t=>{
  const s=await server(t),m=manager(t),model=modelFor(s.baseUrl),ctx=context();
  const first=await m.stream(model,ctx,opts()).result();let nextModel=model,extra={};
  if(change==='provider') nextModel={...model,provider:'alternate'};
  if(change==='model') nextModel={...model,id:'different'};
  if(change==='payload model') extra={onPayload:body=>({...body,model:'different'})};
  if(change==='key') extra={apiKey:'second-secret'};
  if(change==='headers') extra={headers:{'x-routing':'other'}};
  if(change==='no session') extra={sessionId:undefined};
  if(change==='no cache') extra={cacheRetention:'none'};
  const output=await m.stream(nextModel,nextContext(ctx,first),opts(extra)).result();assert.equal(output.stopReason,'stop',output.errorMessage);assert.equal(s.handshakes.length,2);assert.equal(s.requests[1].body.previous_response_id,undefined);
});

test('concurrent requests do not share active socket or continuation',async t=>{
  const s=await server(t,async (_b,r)=>{await new Promise(resolve=>setTimeout(resolve,20));return reply(r.n);}),m=manager(t),model=modelFor(s.baseUrl);
  const result=await Promise.all([m.stream(model,context(),opts()).result(),m.stream(model,context(),opts()).result()]);
  assert.ok(result.every(o=>o.stopReason==='stop'),JSON.stringify(result));assert.equal(s.handshakes.length,2);assert.ok(s.requests.every(r=>!r.body.previous_response_id));assert.equal(m.snapshot('fixture-session').activeConnections,1);
});

for(const mode of ['auto','websocket','websocket-cached']) test(`${mode}: five retries -> one SSE request -> cooldown -> WS recovery`,async t=>{
  let time=1;const delays=[],s=await server(t),m=manager(t,()=>time,async ms=>delays.push(ms)),model=modelFor(s.baseUrl);s.rejectUpgrade(503);
  let payloads=0;const responses=[],options=opts({transport:mode,onPayload:body=>{payloads++;return {...body,metadata:{fixture:true}};},onResponse:r=>responses.push(r)});
  let ctx=context();const a=await m.stream(model,ctx,options).result();assert.equal(a.stopReason,'stop',a.errorMessage);
  assert.equal(s.handshakes.length,6);assert.deepEqual(delays,[200,400,800,1600,3200]);assert.equal(s.requests.length,1);assert.equal(s.requests[0].transport,'sse');assert.equal(s.requests[0].body.metadata.fixture,true);assert.equal(payloads,1);assert.equal(responses[0].status,200);
  assert.equal(m.snapshot('fixture-session').configured,mode);assert.equal(m.snapshot('fixture-session').lastReason,'connect_failed_sse');assert.equal(m.snapshot('fixture-session').lastHttpStatus,503);assert.equal(m.snapshot('fixture-session').activeConnections,0);
  ctx=nextContext(ctx,a);s.rejectUpgrade(0);
  const b=await m.stream(model,ctx,options).result();assert.equal(b.stopReason,'stop');assert.equal(s.handshakes.length,6);assert.equal(s.requests[1].transport,'sse');
  time+=300001;ctx=nextContext(ctx,b);
  const c=await m.stream(model,ctx,options).result();assert.equal(c.stopReason,'stop',c.errorMessage);assert.equal(s.handshakes.length,7);assert.equal(s.requests[2].body.previous_response_id,undefined);
  ctx=nextContext(ctx,c);const d=await m.stream(model,ctx,options).result();assert.equal(d.stopReason,'stop',d.errorMessage);assert.equal(s.requests[3].body.previous_response_id,mode==='websocket'?undefined:'resp_3');assert.equal(m.snapshot('fixture-session').recovery,'ready');
});

for(const mode of ['auto','websocket','websocket-cached']) for(const status of [400,401,403,429]) test(`${mode}: HTTP ${status} never downgraded/retried`,async t=>{
  const s=await server(t),m=manager(t);s.rejectUpgrade(status);
  const output=await m.stream(modelFor(s.baseUrl),context(),opts({transport:mode,maxRetries:3})).result();assert.equal(output.stopReason,'error');assert.equal(s.requests.length,0);assert.equal(s.handshakes.length,1);assert.match(output.errorMessage,new RegExp(String(status)));assert.equal(m.snapshot('fixture-session').recovery,'ready');
});

test('transient handshake failures recover within the retry budget, reset next request, and keep hooks single-shot',async t=>{
  const s=await server(t),delays=[],m=manager(t,undefined,async ms=>{delays.push(ms);if(delays.length%2===0)s.rejectUpgrade(0);}),model=modelFor(s.baseUrl);
  let payloads=0;const options=opts({cacheRetention:'none',onPayload:()=>{payloads++;}});
  for(let n=0;n<2;n++){
    s.rejectUpgrade(503);const result=await m.stream(model,context(),options).result();assert.equal(result.stopReason,'stop',result.errorMessage);
    assert.equal(s.handshakes.length,(n+1)*3);assert.equal(s.requests.length,n+1);assert.equal(s.requests[n].transport,'websocket');assert.equal(m.snapshot('fixture-session').recovery,'ready');
  }
  assert.deepEqual(delays,[200,400,200,400]);assert.equal(payloads,2);
});

test('terminal handshake error after a transient failure stops the retry loop',async t=>{
  const s=await server(t),m=manager(t,undefined,async()=>s.rejectUpgrade(401));s.rejectUpgrade(503);
  const result=await m.stream(modelFor(s.baseUrl),context(),opts()).result();assert.equal(result.stopReason,'error');assert.match(result.errorMessage,/401/);assert.equal(s.handshakes.length,2);assert.equal(s.requests.length,0);assert.equal(m.snapshot('fixture-session').recovery,'ready');
});

test('abort during real retry backoff cancels without another handshake or SSE request',async t=>{
  const s=await server(t),controller=new AbortController();s.rejectUpgrade(503);
  const m=manager(t,undefined,(ms,signal)=>{setTimeout(()=>controller.abort(),10);return sleep(ms,undefined,{signal});});
  const result=await m.stream(modelFor(s.baseUrl),context(),opts({signal:controller.signal})).result();assert.equal(result.stopReason,'aborted',result.errorMessage);assert.equal(s.handshakes.length,1);assert.equal(s.requests.length,0);assert.equal(m.snapshot('fixture-session').activeConnections,0);assert.equal(m.snapshot('fixture-session').lastReason,'aborted');
});

test('clear during retry backoff cancels the active request without reopening a connection',async t=>{
  const s=await server(t);s.rejectUpgrade(503);
  const m=manager(t,undefined,(ms,signal)=>{m.clear('fixture-session');return sleep(ms,undefined,{signal});});
  const result=await m.stream(modelFor(s.baseUrl),context(),opts()).result();assert.equal(result.stopReason,'aborted',result.errorMessage);assert.equal(s.handshakes.length,1);assert.equal(s.requests.length,0);assert.equal(m.snapshot('fixture-session').activeConnections,0);
});

test('SSE cooldown is isolated by connection identity and clear resets the retry budget',async t=>{
  const s=await server(t),m=manager(t),model=modelFor(s.baseUrl);s.rejectUpgrade(503);
  assert.equal((await m.stream(model,context(),opts()).result()).stopReason,'stop');assert.equal(s.handshakes.length,6);
  s.rejectUpgrade(0);const other=await m.stream(model,context(),opts({apiKey:'different-fixture-key'})).result();assert.equal(other.stopReason,'stop');assert.equal(s.requests[1].transport,'websocket');assert.equal(s.handshakes.length,7);
  m.clear('fixture-session');s.rejectUpgrade(503);assert.equal((await m.stream(model,context(),opts()).result()).stopReason,'stop');assert.equal(s.handshakes.length,13);assert.equal(s.requests[2].transport,'sse');
});

for(const mode of ['auto','websocket','websocket-cached']) for(const partial of [false,true]) test(`${mode}: disconnected response (partial=${partial}) retries five times then succeeds over SSE`,async t=>{
  const s=await server(t,async(_b,r)=>{
    if(r.transport==='sse')return reply(r.n);
    if(partial){for(const event of reply(r.n,{text:'discarded partial'}).slice(0,3))r.ws.send(JSON.stringify(event));await sleep(5);}
    r.ws.terminate();return [];
  }),m=manager(t);
  const result=await collect(m.stream(modelFor(s.baseUrl),context(),opts({transport:mode,maxRetries:3})));
  assert.equal(result.output.stopReason,'stop',result.output.errorMessage);assert.equal(s.handshakes.length,6);assert.equal(s.requests.length,7);assert.ok(s.requests.slice(0,6).every(r=>r.transport==='websocket'));assert.equal(s.requests[6].transport,'sse');
  assert.equal(result.events.filter(e=>e.type==='start').length,1);assert.equal(result.events.filter(e=>e.type==='done').length,1);assert.equal(result.events.filter(e=>e.type==='error').length,0);assert.equal(result.output.content[0].text,'hello 世界🙂');
  assert.equal(m.snapshot('fixture-session').activeConnections,0);assert.equal(m.snapshot('fixture-session').lastReason,'ws_failed_sse');
});

test('sent-request disconnects can recover over WS without SSE and establish a fresh delta baseline',async t=>{
  const s=await server(t,(_b,r)=>{if(r.n<=2){r.ws.terminate();return [];}return reply(r.n);}),delays=[],m=manager(t,undefined,async ms=>delays.push(ms)),model=modelFor(s.baseUrl),ctx=context();
  const first=await m.stream(model,ctx,opts()).result();assert.equal(first.stopReason,'stop',first.errorMessage);assert.deepEqual(delays,[200,400]);assert.equal(s.handshakes.length,3);assert.equal(s.requests.length,3);assert.ok(s.requests.every(r=>r.transport==='websocket'&&!r.body.previous_response_id));
  const next=await m.stream(model,nextContext(ctx,first),opts()).result();assert.equal(next.stopReason,'stop');assert.equal(s.requests[3].body.previous_response_id,'resp_3');
});

test('handshake and sent-request failures share one retry budget',async t=>{
  const s=await server(t,(_b,r)=>{if(r.transport==='websocket'){r.ws.terminate();return [];}return reply(r.n);}),delays=[],m=manager(t,undefined,async ms=>{delays.push(ms);s.rejectUpgrade(0);});s.rejectUpgrade(503);
  const result=await m.stream(modelFor(s.baseUrl),context(),opts()).result();assert.equal(result.stopReason,'stop',result.errorMessage);assert.equal(s.handshakes.length,6);assert.equal(s.requests.length,6);assert.equal(s.requests[5].transport,'sse');assert.deepEqual(delays,[200,400,800,1600,3200]);
});

test('abort while backing off a sent-request failure prevents all further generation',async t=>{
  const s=await server(t,(_b,r)=>{r.ws.terminate();return [];}),controller=new AbortController();
  const m=manager(t,undefined,(ms,signal)=>{controller.abort();return sleep(ms,undefined,{signal});});
  const result=await m.stream(modelFor(s.baseUrl),context(),opts({signal:controller.signal})).result();assert.equal(result.stopReason,'aborted',result.errorMessage);assert.equal(s.requests.length,1);assert.equal(s.handshakes.length,1);assert.equal(m.snapshot('fixture-session').activeConnections,0);
});

for(const stage of ['pre-aborted','idle','abort']) test(`bounded cancellation: ${stage}`,async t=>{
  const s=await server(t,()=>[]),m=manager(t),controller=new AbortController();
  if(stage==='pre-aborted') controller.abort();
  const stream=m.stream(modelFor(s.baseUrl),context(),opts({signal:controller.signal,timeoutMs:40}));
  const timer=stage==='abort'?setTimeout(()=>controller.abort(),20):undefined;
  const output=await stream.result();clearTimeout(timer);
  assert.equal(output.stopReason,stage==='idle'?'error':'aborted',output.errorMessage);assert.equal(s.requests.length,stage==='pre-aborted'?0:1);assert.equal(m.snapshot('fixture-session').activeConnections,0);
});

for(const mode of ['auto','websocket','websocket-cached'])test(`${mode}: unsupported_value is a terminal business error, never retried or downgraded`,async t=>{
  const s=await server(t,()=>[{type:'error',status:400,error:{type:'invalid_request_error',code:'unsupported_value',message:'secret-prompt sk-dangerous'}}]),m=manager(t);
  const output=await m.stream(modelFor(s.baseUrl),context(),opts({transport:mode})).result();
  assert.equal(output.stopReason,'error');assert.match(output.errorMessage,/unsupported_value/);assert.ok(!output.errorMessage.includes('sk-dangerous'));
  assert.equal(s.handshakes.length,1);assert.equal(s.requests.length,1);assert.equal(s.requests[0].transport,'websocket');
  const status=m.snapshot('fixture-session');assert.equal(status.lastReason,'provider_error');assert.equal(status.lastWs.providerCode,'unsupported_value');assert.equal(status.activeConnections,0);
});

test('malformed JSON and provider error close safely, preserve overflow classification, redact text',async t=>{
  for(const bad of ['{', {type:'error',code:'context_length_exceeded',message:'secret-prompt sk-dangerous'}]){
    const s=await server(t,()=>[bad]),m=manager(t);
    const output=await m.stream(modelFor(s.baseUrl),context(),opts()).result();assert.equal(output.stopReason,'error');assert.ok(!output.errorMessage.includes('sk-dangerous'));if(typeof bad!=='string')assert.match(output.errorMessage,/context_length_exceeded/);assert.equal(m.snapshot('fixture-session').activeConnections,0);
  }
});

test('101 followed by Aether canonical-identity rejection is diagnosed without exposing server text or identity values',async t=>{
  const s=await server(t,(_b,r)=>{
    assert.equal(r.transport,'websocket');assert.equal(r.body.client_metadata.session_id,'fixture-session');assert.equal(r.headers['session-id'],'fixture-session');assert.equal(r.headers['thread-id'],'fixture-session');
    return [{type:'error',status:400,error:{type:'invalid_request_error',code:'aether_codex_ws_protocol_error',message:'canonical Codex session_id and thread_id metadata are required'}}];
  }),m=manager(t);
  const output=await m.stream(modelFor(s.baseUrl),context(),opts()).result();assert.equal(output.stopReason,'error');assert.match(output.errorMessage,/aether_codex_ws_protocol_error.*canonical_identity_required/);assert.equal(s.requests.length,1,'a protocol rejection must not be treated as a dropped connection');
  const status=m.snapshot('fixture-session');assert.equal(status.lastWs.handshakeStatus,101);assert.equal(status.lastWs.requestSent,true);assert.equal(status.lastWs.framesReceived,1);assert.equal(status.lastWs.eventsReceived,1);assert.equal(status.lastWs.lastEvent,'error');assert.equal(status.lastWs.providerCode,'aether_codex_ws_protocol_error');assert.equal(status.lastWs.providerReason,'canonical_identity_required');
  assert.deepEqual(status.lastWs.identity,{sessionHeader:true,threadHeader:true,sessionMetadata:true,threadMetadata:true});assert.ok(!JSON.stringify(status).includes('fixture-session'));assert.ok(!JSON.stringify(status).includes(key));
  status.lastWs.identity.sessionMetadata=false;assert.equal(m.snapshot('fixture-session').lastWs.identity.sessionMetadata,true,'snapshots must not mutate transport diagnostics');
});

test('diagnostic identity flags preserve valid caller-supplied identity without exposing its values',async t=>{
  const s=await server(t),m=manager(t);
  const output=await m.stream(modelFor(s.baseUrl),context(),opts({headers:{'session-id':'private-session','thread-id':'private-thread'},onPayload:body=>({...body,client_metadata:{session_id:'private-session',thread_id:'private-thread'}})})).result();assert.equal(output.stopReason,'stop',output.errorMessage);
  const status=m.snapshot('fixture-session');assert.deepEqual(status.lastWs.identity,{sessionHeader:true,threadHeader:true,sessionMetadata:true,threadMetadata:true});assert.equal(status.lastWs.lastEvent,'response.completed');assert.ok(!JSON.stringify(status).includes('private-'));
});

for(const kind of ['binary','non-json','peer-close','unknown-event','unknown-error'])test(`101 diagnostic distinguishes ${kind} without leaking wire data`,async t=>{
  const s=await server(t,(_b,r)=>{
    if(r.transport==='sse')return reply(r.n);
    if(kind==='binary')r.ws.send(Buffer.from(JSON.stringify(reply()[0])),{binary:true});
    if(kind==='non-json')r.ws.send('private-prompt sk-dangerous');
    if(kind==='peer-close')r.ws.close(1011,'private-close-reason sk-dangerous');
    if(kind==='unknown-event'){r.ws.send(JSON.stringify({type:'response.private-secret',value:'private-prompt'}));r.ws.close(1011,'private-close-reason');}
    if(kind==='unknown-error')return[{type:'response.private-secret',value:'private-prompt'},{type:'error',error:{code:'sk-dangerous',message:'private-prompt'}}];
    return [];
  }),m=manager(t);
  const output=await m.stream(modelFor(s.baseUrl),context(),opts()).result();assert.equal(output.stopReason,kind==='unknown-error'?'error':'stop',output.errorMessage);
  const status=m.snapshot('fixture-session');assert.equal(status.lastWs.handshakeStatus,101);assert.equal(status.lastWs.requestSent,true);
  if(kind==='binary'){assert.equal(status.lastWs.clientFailure,'binary_frame');assert.equal(status.lastWs.lastFrame,'binary');assert.equal(status.lastWs.eventsReceived,0);}
  if(kind==='non-json'){assert.equal(status.lastWs.clientFailure,'non_json_frame');assert.equal(status.lastWs.lastFrame,'text');assert.equal(status.lastWs.eventsReceived,0);}
  if(kind==='peer-close'){assert.equal(status.lastWs.closeCode,1011);assert.equal(status.lastWs.framesReceived,0);assert.equal(status.lastWs.clientFailure,undefined);}
  if(kind==='unknown-event'){assert.equal(status.lastWs.lastEvent,'other');assert.equal(status.lastWs.eventsReceived,1);}
  if(kind==='unknown-error'){assert.equal(status.lastWs.eventsReceived,2);assert.equal(status.lastWs.providerCode,undefined);assert.equal(status.lastWs.providerReason,undefined);assert.equal(s.requests.length,1);}
  const printed=JSON.stringify({status,error:output.errorMessage});assert.ok(!printed.includes('sk-dangerous'));assert.ok(!printed.includes('private-'));
});

test('custom fetch: auto honors caller policy, explicit WS rejects instead of bypassing',async t=>{
  const s=await server(t),m=manager(t);let calls=0;
  const fetch=async(...args)=>{calls++;return globalThis.fetch(...args);};
  const auto=await m.stream(modelFor(s.baseUrl),context(),opts({transport:'auto',fetch})).result();assert.equal(auto.stopReason,'stop');assert.equal(calls,1);assert.equal(s.handshakes.length,0);
  const ws=await m.stream(modelFor(s.baseUrl),context(),opts({fetch})).result();assert.equal(ws.stopReason,'error');assert.match(ws.errorMessage,/custom_fetch/);assert.equal(calls,1);
});

for(const kind of ['missing id','empty output','incomplete','previous response missing'])test('cache recovery: '+kind,async t=>{
  const s=await server(t,(_b,r)=>{
    const events=reply(r.n,{empty:kind==='empty output'&&r.n===1});
    if(kind==='missing id'&&r.n===1){delete events[0].response.id;delete events.at(-1).response.id;}
    if(kind==='incomplete'&&r.n===1){events.at(-1).type='response.incomplete';events.at(-1).response.status='incomplete';events.at(-1).response.incomplete_details={reason:'max_output_tokens'};}
    if(kind==='previous response missing'&&r.n===2)return[{type:'error',code:'previous_response_not_found',message:'previous_response_not_found'}];
    return events;
  }),m=manager(t),model=modelFor(s.baseUrl),ctx=context();
  const first=await m.stream(model,ctx,opts()).result();
  const next=nextContext(ctx,first),second=await m.stream(model,next,opts()).result();
  if(kind==='previous response missing'){
    assert.equal(second.stopReason,'stop',second.errorMessage);assert.equal(s.requests.length,3,'one full replay after losing the local continuation');
    assert.equal(s.requests[1].body.previous_response_id,'resp_1');assert.equal(s.requests[2].body.previous_response_id,undefined);assert.equal(s.handshakes.length,2);
    assert.ok(s.requests[2].body.input.length>s.requests[1].body.input.length);
  }else{assert.equal(second.stopReason,'stop',second.errorMessage);assert.equal(s.requests[1].body.previous_response_id,undefined);}
});

test('absent Authorization is not replaced with SDK dummy credentials',async t=>{
  const s=await server(t),m=manager(t);
  const result=await m.stream(modelFor(s.baseUrl),context(),opts({headers:{Authorization:null,'x-api-key':'fixture-header'}})).result();
  assert.equal(result.stopReason,'stop',result.errorMessage);assert.equal(s.requests[0].headers.authorization,undefined);assert.equal(s.requests[0].headers['x-api-key'],'fixture-header');
});

test('connection age and capacity bound retained sessions',async t=>{
  let now=0;const s=await server(t),m=manager(t,()=>now),model=modelFor(s.baseUrl),ctx=context();
  const first=await m.stream(model,ctx,opts()).result();now=56*60000;
  await m.stream(model,nextContext(ctx,first),opts()).result();assert.equal(s.handshakes.length,2);assert.equal(s.requests[1].body.previous_response_id,undefined);
  for(let i=0;i<16;i++)assert.equal((await m.stream(model,ctx,opts({sessionId:'capacity-'+i})).result()).stopReason,'stop');
  assert.equal(m.snapshot('fixture-session').activeConnections,0);
  assert.equal(Array.from({length:16},(_,i)=>m.snapshot('capacity-'+i).activeConnections).reduce((a,b)=>a+b),16);
});

for(const limit of ['request','frame','queue'])test('size/backpressure limit: '+limit,{timeout:10000},async t=>{
  const s=await server(t,(_b,r)=>r.transport==='sse'?reply(r.n):limit==='frame'?['x'.repeat(MAX_BYTES+1)]:Array.from({length:1100},()=>({type:'response.created',response:{id:'resp_1',status:'in_progress'}}))),m=manager(t);
  const ctx=limit==='request'?context([{role:'user',content:'x'.repeat(MAX_BYTES+1),timestamp:1}]):context();
  const result=await m.stream(modelFor(s.baseUrl),ctx,opts({timeoutMs:1000,onProviderStreamEvent:limit==='queue'?async()=>new Promise(r=>setTimeout(r,50)):undefined})).result();assert.equal(result.stopReason,limit==='request'?'error':'stop',result.errorMessage);assert.equal(s.requests.length,limit==='request'?0:7);assert.equal(m.snapshot('fixture-session').activeConnections,0);
});

test('stalled handshake has a bounded connect timeout and releases the socket',async t=>{
  let handshakes=0,requests=0;const sockets=new Set(),http=createServer(async(req,res)=>{
    for await(const _ of req){}requests++;res.writeHead(200,{'content-type':'text/event-stream'});res.end(reply().map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''));
  });
  http.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});});http.on('upgrade',()=>{handshakes++;});
  http.listen(0,'127.0.0.1');await once(http,'listening');t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(r=>http.close(r));});
  const m=manager(t),output=await m.stream(modelFor(`http://127.0.0.1:${http.address().port}/v1`),context(),opts({websocketConnectTimeoutMs:40,timeoutMs:1500})).result();
  assert.equal(output.stopReason,'stop',output.errorMessage);assert.equal(handshakes,6);assert.equal(requests,1);assert.equal(m.snapshot('fixture-session').actual,'sse');assert.equal(m.snapshot('fixture-session').activeConnections,0);
});

test('clear closes session resources without clearing another session',async t=>{
  const s=await server(t),m=manager(t),model=modelFor(s.baseUrl);
  await m.stream(model,context(),opts()).result();await m.stream(model,context(),opts({sessionId:'other'})).result();
  m.clear('fixture-session');assert.equal(m.snapshot('fixture-session').activeConnections,0);assert.equal(m.snapshot('other').activeConnections,1);m.clear();assert.equal(m.snapshot('other').activeConnections,0);
});
