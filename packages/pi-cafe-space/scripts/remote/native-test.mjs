#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';

const {values}=parseArgs({strict:true,options:{binary:{type:'string'},'pi-root':{type:'string'},candidate:{type:'string'},report:{type:'string'},'allow-provider':{type:'boolean'}}});
for(const key of ['binary','pi-root','candidate'])assert(values[key]&&isAbsolute(values[key]),`--${key} requires an absolute path`);
let credential;
if(values['allow-provider']){
  let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>16384)throw Error('Private test input exceeds limit');}
  credential=JSON.parse(input);input='';
  assert(typeof credential.apiKey==='string'&&credential.apiKey.length>=16&&typeof credential.baseUrl==='string'&&new URL(credential.baseUrl).protocol==='https:'&&typeof credential.model==='string','Invalid explicit provider test input');
}
const binary=await realpath(values.binary),piRoot=await realpath(values['pi-root']),candidate=await realpath(values.candidate);
const pkg=JSON.parse(await readFile(join(piRoot,'package.json'),'utf8'));assert.equal(pkg.version,'0.99.1','This acceptance script was checked against native Pi 0.99.1');
const cli=await realpath(join(piRoot,'dist/bundle/cli.js'));
const {applyEvent}=await import(pathToFileURL(join(candidate,'dist/protocol/index.js')).href);
const report=values.report?resolve(values.report):null;if(report)await mkdir(report,{recursive:true});
const root=await realpath(await mkdtemp(join(tmpdir(),'cafe-native-remote-')));
const secret=()=>randomBytes(32).toString('base64url');const digest=value=>createHash('sha256').update(value).digest('hex');
const children=[];const sockets=[];let proxy;
let providerRequests=0,providerStatus=null,providerCompleted=false;
const checks=[];let stage='setup';
async function port(){const server=netServer();await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res)});const value=server.address().port;await new Promise(res=>server.close(res));return value;}
async function until(fn,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await delay(50);}throw Error(label+' timed out');}
async function json(name,value){const path=join(root,name);await writeFile(path,JSON.stringify(value),{mode:0o600,flag:'wx'});return path;}
function osEnvironment(){const env={};for(const key of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','LANG','LC_ALL'])if(process.env[key])env[key]=process.env[key];Object.assign(env,{HOME:join(root,'home'),USERPROFILE:join(root,'home'),APPDATA:join(root,'home'),LOCALAPPDATA:join(root,'home'),TMPDIR:root,TEMP:root,TMP:root});return env;}
function start(config,listen,hostToken,clientToken,managed){
  const env={...osEnvironment(),PI_COLLAB_HOST:'127.0.0.1',PI_COLLAB_PORT:String(listen),PI_COLLAB_HOST_TOKEN:hostToken,PI_COLLAB_CLIENT_TOKEN:clientToken,PI_CAFE_REMOTE_CONFIG:config,...managed?{PI_COLLAB_MANAGED_CONFIG:managed}:{}};
  const child=spawn(binary,[],{cwd:root,env,stdio:['ignore','ignore','pipe']});children.push(child);
  let diagnostics='';child.stderr.on('data',b=>{diagnostics=(diagnostics+b.toString()).slice(-4096);});
  child.on('error',()=>{});
  return{child,diagnostics:()=>diagnostics};
}
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;const finished=new Promise(res=>child.once('exit',res));child.kill('SIGTERM');await Promise.race([finished,delay(12000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await finished;}}
class RemoteClient{
  constructor(ws){this.ws=ws;this.id='';this.frames=[];this.snapshots=new Map();this.errors=[];ws.on('message',raw=>{try{const f=JSON.parse(raw.toString());if(f.type==='opened')this.id=f.id;this.frames.push(f);if(this.frames.length>1024)this.frames.shift();if(f.type==='data'){const m=JSON.parse(Buffer.from(f.payload,'base64').toString());if(m.type==='snapshot')this.snapshots.set(m.hostId,m.snapshot);if(m.type==='event'){const previous=this.snapshots.get(m.hostId);if(previous)this.snapshots.set(m.hostId,applyEvent(previous,m));}}}catch{this.errors.push('invalid native projection');}});}
  send(v){assert.equal(this.ws.readyState,1,'Remote connection closed');this.ws.send(JSON.stringify(v));}
  async wait(test,timeout=15000){return await until(()=>{const i=this.frames.findIndex(test);if(i<0)return null;return this.frames.splice(i,1)[0];},'remote response',timeout);}
  data(v){this.send({type:'data',id:this.id,payload:Buffer.from(JSON.stringify(v)).toString('base64')});}
  async result(v,type='remote.result',timeout=15000){const id=v.requestId??randomUUID();this.data({...v,requestId:id});const f=await this.wait(frame=>{if(frame.type!=='data')return false;const m=JSON.parse(Buffer.from(frame.payload,'base64').toString());return m.type===type&&m.requestId===id;},timeout);return JSON.parse(Buffer.from(f.payload,'base64').toString());}
  async workspace(operation,fields={}){const r=await this.result({type:'remote.workspace',request:{room:'main',operation,...fields}});assert.equal(r.ok,true,r.code??'management rejected');return r.data;}
  async command(host,payload){const s=this.snapshots.get(host);assert(s,'Missing authoritative native snapshot');return await this.result({type:'command',targetHostId:host,expectedStreamId:s.streamId,expectedSessionId:s.sessionId,expectedCwd:s.cwd,payload},'command_result');}
}
try{
  for(const dir of ['home','agent','state','project'])await mkdir(join(root,dir),{mode:0o700});
  const cloudPort=await port(),devicePort=await port();const origin=`http://127.0.0.1:${cloudPort}`;
  const deviceToken=secret(),userToken=secret(),hostToken=secret(),clientToken=secret();
  const cloudPath=await json('cloud.json',{mode:'cloud',publicOrigin:origin,enableWebRTC:true,devices:[{id:'office',name:'Native test office',tokenHash:digest(deviceToken)}],users:[{id:'owner',name:'Owner',tokenHash:digest(userToken),grants:[{deviceId:'office',room:'main',role:'admin'}]}]});
  const devicePath=await json('device.json',{mode:'device',deviceId:'office',deviceToken,cloudUrl:`ws://127.0.0.1:${cloudPort}/remote/agent`,rooms:['main'],maxRole:'admin',enableWebRTC:true});
  const settings={defaultThinkingLevel:'off',defaultTools:[],defaultProjectTrust:'never',enableInstallTelemetry:false,enableAnalytics:false,cacheWarming:'off',transport:'sse',compaction:{enabled:false},retry:{enabled:false,maxRetries:0,provider:{maxRetries:0,timeoutMs:50000}},httpIdleTimeoutMs:50000,extensions:[],skills:[],prompts:[],themes:[]};
  if(credential){
    const proxyKey=secret();
    proxy=createServer(async(req,res)=>{
      let timeout;
      try{
        if(req.method!=='POST'||req.url!=='/v1/responses'||req.headers.authorization!=='Bearer '+proxyKey){res.writeHead(403);res.end();return;}
        providerRequests++;if(providerRequests!==1){res.writeHead(429);res.end('Test permits exactly one provider request');return;}
        let body='';for await(const chunk of req){body+=chunk;if(body.length>2*1024*1024)throw Error('Request exceeds test limit');}
        const payload=JSON.parse(body);assert.equal(payload.model,credential.model);payload.max_output_tokens=512;payload.tools=[];
        const abort=new AbortController();timeout=setTimeout(()=>abort.abort(),50000);
        const response=await fetch(credential.baseUrl.replace(/\/$/,'')+'/responses',{method:'POST',headers:{Authorization:'Bearer '+credential.apiKey,'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify(payload),signal:abort.signal});
        providerStatus=response.status;res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')??'application/json'});
        if(response.body)for await(const chunk of response.body){if(res.destroyed)break;if(!res.write(chunk))await new Promise(resolve=>res.once('drain',resolve));}
        res.end();
      }catch{if(!res.headersSent)res.writeHead(502);res.end('Bounded provider test failed');}finally{clearTimeout(timeout);}
    });
    await new Promise((res,rej)=>{proxy.once('error',rej);proxy.listen(0,'127.0.0.1',res)});
    settings.defaultProvider='remote-acceptance';settings.defaultModel=credential.model;
    await writeFile(join(root,'agent/models.json'),JSON.stringify({providers:{'remote-acceptance':{api:'openai-responses',baseUrl:`http://127.0.0.1:${proxy.address().port}/v1`,apiKey:proxyKey,models:[{id:credential.model,name:'Explicit native acceptance',reasoning:true,input:['text'],contextWindow:274000,maxTokens:512,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}),{mode:0o600});
  }
  await writeFile(join(root,'agent/settings.json'),JSON.stringify(settings),{mode:0o600});
  const managedPath=await json('managed.json',{node:process.execPath,cli,extension:join(candidate,'dist/extension/index.js'),agentDir:join(root,'agent'),stateDir:join(root,'state'),env:osEnvironment(),projects:[{id:'fixture',name:'Isolated native project',room:'main',cwd:join(root,'project')}]});
  stage='service startup';const cloudProcess=start(cloudPath,cloudPort,secret(),secret());const deviceProcess=start(devicePath,devicePort,hostToken,clientToken,managedPath);
  await until(async()=>{assert(cloudProcess.child.exitCode===null&&deviceProcess.child.exitCode===null,'Owned candidate failed to start');try{return(await fetch(origin+'/healthz')).ok&&(await fetch(`http://127.0.0.1:${devicePort}/healthz`)).ok;}catch{return false;}},'native services');
  await until(async()=>{const r=await fetch(origin+'/api/remote/devices',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+userToken,'Content-Type':'application/json'},body:'{}'});return(await r.json()).devices?.[0]?.online;},'office device online');
  const ws=new WebSocket(`ws://127.0.0.1:${cloudPort}/remote/connect`,{headers:{Origin:origin}});sockets.push(ws);const remote=new RemoteClient(ws);
  await new Promise((res,rej)=>{ws.once('open',res);ws.once('error',rej)});remote.send({type:'connect',token:userToken,deviceId:'office',room:'main',mode:'relay'});await remote.wait(f=>f.type==='opened');remote.send({type:'select',id:remote.id,mode:'relay'});await remote.wait(f=>f.type==='selected');
  remote.data({type:'hello',protocolVersion:1,peerRole:'client',roomId:'main',peerId:'native-acceptance',token:'remote-session'});
  await remote.wait(f=>f.type==='data'&&JSON.parse(Buffer.from(f.payload,'base64').toString()).type==='welcome');
  stage='native creation';const first=randomUUID(),second=randomUUID();
  for(const[id,name]of [[first,'First native'],[second,'Second native']]){
    await remote.workspace('create',{id,projectId:'fixture',name});
    await until(()=>remote.snapshots.get('managed-'+id)?.sessionId===id,'native snapshot '+name,35000);
  }
  const inventory=await remote.workspace('list');assert.equal(inventory.sessions.length,2);assert(inventory.sessions.every(s=>s.status==='ready'));
  await remote.workspace('create',{id:first,projectId:'fixture',name:'First native'});assert.equal((await remote.workspace('list')).sessions.length,2);checks.push('Two real Pi RPC instances; repeated create ID does not start a duplicate');
  const host='managed-'+first;assert.equal(remote.snapshots.get(host).cwd,join(root,'project'));
  const lease=await remote.result({type:'remote.control',hostId:host,action:'acquire'});assert.equal(lease.ok,true,lease.code);
  stage='native rename';const renamed=await remote.command(host,{name:'rename_session',title:'Remote native verified'});
  // Protocol command uses the frozen v1 title field; a schema mismatch must fail
  // visibly rather than sending a substitute model prompt.
  assert(['applied','dispatched'].includes(renamed.status),renamed.code??'rename rejected');
  await until(()=>remote.snapshots.get(host)?.sessionName==='Remote native verified','native name projection');
  checks.push('Native session rename projected through office gateway and cloud');
  stage='close and reopen';await remote.workspace('close',{id:second});await until(async()=>((await remote.workspace('list')).sessions.find(s=>s.id===second)?.status)==='stopped','native close');
  remote.snapshots.delete('managed-'+second);await remote.workspace('open',{id:second});await until(()=>remote.snapshots.get('managed-'+second)?.sessionId===second,'native reopen',35000);assert.equal(remote.snapshots.get(host)?.sessionId,first);checks.push('Close/reopen preserves native identity and leaves the other instance unchanged');
  if(credential){
    stage='explicit provider request';const renewed=await remote.result({type:'remote.control',hostId:host,action:'renew'});assert.equal(renewed.ok,true,renewed.code);
    const response=await remote.command(host,{name:'prompt',content:'Return exactly CAFE_REMOTE_NATIVE_OK. Do not use tools.'});assert.equal(response.status,'dispatched',response.code??'prompt not dispatched');
    await until(()=>{const s=remote.snapshots.get(host);return s?.phase==='idle'&&s.messages.some(m=>m.role==='assistant'&&m.status==='complete'&&m.text.includes('CAFE_REMOTE_NATIVE_OK'));},'real native model completion',60000);
    assert.equal(providerRequests,1);assert.equal(providerStatus,200);providerCompleted=true;checks.push('One bounded real provider response delivered through native Pi and remote collaboration protocol');
  }
  stage='native persistence';await remote.workspace('close',{id:first});await until(async()=>((await remote.workspace('list')).sessions.find(s=>s.id===first)?.status)==='stopped','first native close');
  remote.snapshots.delete(host);await remote.workspace('open',{id:first});await until(()=>remote.snapshots.get(host)?.sessionId===first,'first native reopen',35000);assert.equal(remote.snapshots.get(host).sessionName,'Remote native verified');
  if(credential){assert(remote.snapshots.get(host).messages.some(m=>m.role==='assistant'&&m.text.includes('CAFE_REMOTE_NATIVE_OK')));const files=await readdir(join(root,'state/sessions/fixture'));assert(files.some(name=>name.endsWith('.jsonl')));checks.push('Native JSONL message history and renamed session survive close/reopen');}
  else checks.push('Empty native session name survives graceful close/reopen');
  assert.deepEqual(remote.errors,[]);
  const result={passed:true,checks,piVersion:pkg.version,platform:process.platform,providerRequests,providerStatus,providerCompleted,outputTokenCap:512,scope:'isolated temporary native Pi sessions and local cloud/device; no existing user Pi touched'};
  if(report)await writeFile(join(report,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){
  const result={passed:false,stage,checks,piVersion:pkg.version,platform:process.platform,providerRequests,providerStatus,providerCompleted,error:String(error.message).replaceAll(credential?.apiKey??'__no_secret__','[redacted]').slice(0,1000)};
  if(report)await writeFile(join(report,'result.json'),JSON.stringify(result,null,2));console.error(JSON.stringify(result,null,2));process.exitCode=1;
}finally{
  for(const ws of sockets)ws.terminate();
  for(const child of children.reverse())await stop(child);
  if(proxy)await new Promise(res=>{proxy.closeAllConnections();proxy.close(res);});
  await rm(root,{recursive:true,force:true});credential=null;
}
