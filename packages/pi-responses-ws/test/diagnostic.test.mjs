import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { key, reply, server } from './helpers.mjs';

for(const identity of [false,true])for(const kind of ['success','disconnect','protocol rejection','handshake rejection','nonreasoning','missing effort','none effort','mapped none'])test(`single-attempt diagnostic: ${kind}, explicit identity=${identity}`,{timeout:30000},async t=>{
  const modelId=identity?'org/fixture':'fixture';
  const s=await server(t,(_b,r)=>{
    assert.equal(r.transport,'websocket','diagnostic must not fall back to SSE');
    assert.equal(r.body.max_output_tokens,16);assert.equal(r.body.store,false);assert.equal(r.body.reasoning?.effort,kind==='nonreasoning'?undefined:'xhigh');
    assert.ok(r.body.client_metadata);
    assert.equal(r.body.client_metadata.session_id,r.headers['session-id']);assert.equal(r.body.client_metadata.thread_id,r.headers['thread-id']);assert.equal(r.headers['thread-id'],r.headers['x-client-request-id']);
    assert.ok(!r.headers['user-agent'].startsWith('codex_cli_rs'));assert.equal(r.headers.originator,undefined);
    if(kind==='disconnect'){r.ws.terminate();return [];}
    if(kind==='protocol rejection')return [{type:'error',status:400,error:{type:identity?'invalid_request_error':key,code:'aether_codex_ws_protocol_error',message:'canonical Codex session_id and thread_id metadata are required'}}];
    return reply(r.n);
  });
  const serverRequestId='req_0123456789abcdef0123456789abcdef';
  s.wss.on('headers',headers=>{headers.push(`X-Request-ID: ${identity?serverRequestId:key}`);headers.push(`Set-Cookie: ${key}`);headers.push(`Authorization: Bearer ${key}`);});
  if(kind==='handshake rejection')s.rejectUpgrade(426);
  const dir=await mkdtemp(join(tmpdir(),'pi-ws-diagnostic-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'models.json'),JSON.stringify({providers:{alternate:{baseUrl:s.baseUrl,api:'openai-responses',apiKey:key,models:[{id:modelId,reasoning:kind!=='nonreasoning',input:['text'],contextWindow:32768,maxTokens:128,...(kind==='mapped none'?{thinkingLevelMap:{xhigh:'none'}}:{})}]}}}));
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,HOME:dir,USERPROFILE:dir,PI_CODING_AGENT_DIR:dir,NO_PROXY:'*',PI_OFFLINE:'1'};
  const script=fileURLToPath(new URL('./live.mjs',import.meta.url));
  const effortArgs=kind==='missing effort'?[]:['--reasoning-effort',kind==='none effort'?'none':'xhigh'];
  const child=spawn(process.execPath,['--experimental-strip-types',script,'--allow-live',`alternate/${modelId}`,'--diagnose',...effortArgs,...(identity?['--with-session-identity']:[])],{cwd:dir,env,stdio:['ignore','pipe','pipe']});t.after(()=>child.kill());
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  if(['missing effort','none effort'].includes(kind)){assert.notEqual(code,0);assert.equal(stdout,'');assert.equal(s.handshakes.length,0);assert.equal(s.requests.length,0);assert.match(stderr,/Specify --reasoning-effort/);return;}
  if(kind==='mapped none'){
    assert.equal(code,0,stderr+'\n'+stdout);assert.equal(s.handshakes.length,0);assert.equal(s.requests.length,0);
    const [request,result,budget]=stdout.trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(request.diagnosticRequest.requestedReasoningEffort,'xhigh');assert.equal(result.correlation.payloadReasoningEffort,'none');assert.equal(result.stopReason,'error');assert.equal(budget.requests,0);return;
  }
  assert.equal(code,0,stderr+'\n'+stdout);assert.equal(s.handshakes.length,1);assert.equal(s.requests.length,kind==='handshake rejection'?0:1);assert.equal(s.warmups.length,0,'diagnostics never prewarm');
  const [request,result,budget]=stdout.trim().split('\n').map(line=>JSON.parse(line));
  const correlation=result.correlation;assert.ok(request.diagnosticRequest);
  assert.match(correlation.sessionId,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(correlation.clientRequestId,s.handshakes[0].headers['x-client-request-id']);assert.equal(correlation.sessionId,correlation.clientRequestId);
  assert.equal(correlation.threadId,correlation.sessionId);assert.equal(correlation.provider,'alternate');assert.equal(correlation.model,modelId);
  assert.deepEqual(request.diagnosticRequest,Object.fromEntries(Object.entries(correlation).filter(([name])=>['startedAt','provider','model','sessionId','threadId','clientRequestId','requestedReasoningEffort'].includes(name))));
  for(const stamp of [correlation.startedAt,correlation.payloadPreparedAt,correlation.finishedAt]){assert.ok(stamp.endsWith('Z'));assert.ok(Number.isFinite(Date.parse(stamp)));}
  assert.ok(Date.parse(correlation.startedAt)<=Date.parse(correlation.payloadPreparedAt));assert.ok(Date.parse(correlation.payloadPreparedAt)<=Date.parse(correlation.finishedAt));assert.ok(correlation.durationMs>=0);
  assert.equal(correlation.requestedReasoningEffort,'xhigh');assert.equal(correlation.payloadReasoningEffort,kind==='nonreasoning'?null:'xhigh');
  const observed=['success','protocol rejection','nonreasoning'].includes(kind);
  assert.equal(correlation.serverRequestId,observed&&identity?serverRequestId:null);assert.equal(correlation.serverRequestIdState,observed?(identity?'recorded':'redacted'):'not_observed');
  assert.equal(correlation.responseObservedAt!==null,observed);
  assert.equal(s.handshakes[0].headers['session-id'],correlation.sessionId);
  assert.equal(budget.diagnosticOnly,true);assert.equal(budget.requests,1);assert.equal(budget.requestedMaxOutputTokens,16);assert.equal(result.status.lastWs.handshakeStatus,kind==='handshake rejection'?426:101);
  if(kind==='protocol rejection')assert.equal(result.status.lastWs.providerReason,'canonical_identity_required');
  assert.deepEqual(result.status.lastWs.identity,{sessionHeader:true,threadHeader:true,sessionMetadata:true,threadMetadata:true});
  assert.ok(!stdout.includes(key));assert.ok(!stdout.includes('hello 世界'));assert.ok(!stdout.includes('fixture system'));assert.ok(!stdout.includes(s.baseUrl));
});
