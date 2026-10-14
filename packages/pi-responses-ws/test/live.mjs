// Opt-in only. Prints diagnostic correlation IDs, never endpoints, credentials, complete headers or content.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { normalizeContext } from '@earendil-works/pi-ai';
import { wrapProvider } from '../src/index.ts';
import { ResponsesTransport } from '../src/transport.ts';

const diagnosticOnly=process.argv.includes('--diagnose');
const withSessionIdentity=process.argv.includes('--with-session-identity');
assert.ok(!withSessionIdentity||diagnosticOnly,'Session-identity comparison requires --diagnose');
const requestBudget=diagnosticOnly?1:5,tokenBudget=diagnosticOnly?16:128;
assert.equal(process.argv[2],'--allow-live',`Requires explicit --allow-live consent (${requestBudget} requests, max_output_tokens requested: ${tokenBudget}; upstream may normalize this field).`);
const target=process.argv[3]??'',separator=target.indexOf('/');
assert.ok(separator>0&&separator<target.length-1,'Pass an existing provider/model ID.');
const provider=target.slice(0,separator),modelId=target.slice(separator+1);
const reasoningEfforts=['minimal','low','medium','high','xhigh'];
const effortIndex=process.argv.indexOf('--reasoning-effort'),reasoningEffort=process.argv[effortIndex+1];
assert.ok(effortIndex>3&&reasoningEfforts.includes(reasoningEffort),'Specify --reasoning-effort with a model-supported minimal/low/medium/high/xhigh; none is disabled for this diagnostic.');
const dir=await mkdtemp(join(tmpdir(),'pi-responses-ws-live-'));
const controller=new AbortController();
// A diagnostic never retries or falls back, even if the first WS attempt disconnects.
const transport=new ResponsesTransport(undefined,undefined,{prewarm:false,recover:!diagnosticOnly});
let attempts=0;
try {
  const agentDir=getAgentDir();
  const runtime=await ModelRuntime.create({modelsPath:join(agentDir,'models.json'),authPath:join(agentDir,'auth.json'),modelsStorePath:join(dir,'models.db'),allowModelNetwork:false,refreshOnCreate:false});
  const model=runtime.getModel(provider,modelId);assert.ok(model?.api==='openai-responses','Select an existing openai-responses model.');
  runtime.registerNativeProvider(wrapProvider(runtime.getProvider(provider),transport));
  const sessionId=randomUUID();
  let context=normalizeContext({systemPrompt:'Respond with exactly OK. No explanation.',messages:[{role:'user',content:'Reply OK.',timestamp:Date.now()}]});
  for(let step=1;step<=requestBudget;step++) {
    if(step===4)transport.clear(sessionId);
    let responseStatus,payloadPreparedAt=null,payloadReasoningEffort=null,responseObservedAt=null,serverRequestId=null,serverRequestIdState='not_observed';
    const started=performance.now();
    const correlation=diagnosticOnly?{startedAt:new Date().toISOString(),provider,model:modelId,sessionId,threadId:sessionId,clientRequestId:sessionId,requestedReasoningEffort:reasoningEffort}:undefined;
    if(diagnosticOnly)console.log(JSON.stringify({diagnosticRequest:correlation}));
    const output=await runtime.complete(model,context,{
      transport:step===1?'websocket':'websocket-cached',sessionId,cacheRetention:'short',signal:controller.signal,maxTokens:tokenBudget,reasoningEffort,maxRetries:0,timeoutMs:60000,websocketConnectTimeoutMs:15000,
      ...(process.argv.includes('--direct')?{env:{NO_PROXY:'*',no_proxy:'*'}}:{}),
      ...(diagnosticOnly?{headers:{'x-client-request-id':sessionId,...(withSessionIdentity?{'session-id':sessionId,'thread-id':sessionId}:{})}}:{}),
      onPayload:payload=>{
        payloadPreparedAt=new Date().toISOString();
        const effort=payload.reasoning?.effort;
        payloadReasoningEffort=effort==null?null:(reasoningEfforts.includes(effort)||effort==='none')?effort:'other';
        assert.ok(effort==null?!model.reasoning:reasoningEfforts.includes(effort),'Generated reasoning is absent/unsupported; refusing to send this diagnostic.');
        assert.ok(++attempts<=requestBudget,'Request budget exceeded');assert.ok(payload.max_output_tokens<=tokenBudget,'Output budget exceeded');assert.equal(payload.store,false,'Storage policy changed');
        if(withSessionIdentity)return {...payload,client_metadata:{session_id:sessionId,thread_id:sessionId}};
      },
      onResponse:response=>{
        responseStatus=response.status;responseObservedAt=new Date().toISOString();
        if(!diagnosticOnly)return;
        const id=response.headers['x-request-id'];
        // Only recognized opaque ID shapes; never print arbitrary server header values.
        if(typeof id==='string'&&/^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|(?:req_)?[0-9a-f]{32}|[0-9a-hjkmnp-tv-z]{26})$/i.test(id))serverRequestId=id;
        serverRequestIdState=id==null?'absent':serverRequestId?'recorded':'redacted';
      },
    });
    const status=transport.snapshot(sessionId);
    console.log(JSON.stringify({step,stopReason:output.stopReason,handshakeStatus:status.lastWs?.handshakeStatus??responseStatus,status,correlation:diagnosticOnly?{...correlation,payloadPreparedAt,payloadReasoningEffort,responseObservedAt,finishedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-started),serverRequestId,serverRequestIdState}:undefined,usage:{input:output.usage.input,output:output.usage.output,cacheRead:output.usage.cacheRead}}));
    if(diagnosticOnly)break;
    assert.equal(output.stopReason,'stop','Live request failed; raw provider details intentionally omitted.');
    assert.equal(responseStatus,101);assert.equal(status.actual,'websocket');assert.ok(output.responseId,'No response ID');
    if(step===3||step===5){assert.equal(status.deltaRequests,1,'Server continuation was not used');assert.ok(status.lastRequestBytes<status.lastFullBytes);}
    if(step===4){assert.equal(status.connectionsCreated,1);assert.equal(status.fullRequests,1);assert.equal(status.deltaRequests,0);}
    context=normalizeContext({messages:[...context.messages,output,{role:'user',content:'Reply OK again.',timestamp:Date.now()}]});
  }
  console.log(JSON.stringify(diagnosticOnly?{diagnosticOnly:true,requests:attempts,requestedMaxOutputTokens:tokenBudget}:{verified:true,requests:attempts,requestedMaxOutputTokens:tokenBudget}));
} finally {
  transport.clear();await rm(dir,{recursive:true,force:true});
}
