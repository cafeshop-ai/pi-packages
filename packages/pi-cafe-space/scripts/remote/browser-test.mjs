#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';

const {values}=parseArgs({options:{binary:{type:'string'},browser:{type:'string'},report:{type:'string'}},strict:true});
assert(values.binary&&isAbsolute(values.binary),'--binary must name the candidate executable');
assert(values.browser&&isAbsolute(values.browser),'--browser must name a separately launched test browser');
const binary=await realpath(values.binary),browserExecutable=await realpath(values.browser);
const report=values.report?resolve(values.report):null;
if(report)await mkdir(report,{recursive:true});
const root=await realpath(await mkdtemp(join(tmpdir(),'cafe-remote-browser-')));
const secret=()=>randomBytes(32).toString('base64url');
const digest=value=>createHash('sha256').update(value).digest('hex');
const children=[],hosts=[],contexts=[];let browser;
const results=[],issues=[];let dispatchCount=0;
async function unusedPort(){const server=createServer();await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res)});const port=server.address().port;await new Promise(res=>server.close(res));return port;}
async function eventually(fn,label,timeout=15000){const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){try{if(await fn())return;}catch(error){last=error;}await delay(50);}throw Error(`${label}: ${last?.message??'timeout'}`);}
function start(config,port,hostToken,clientToken){
  const env={};for(const name of ['PATH','HOME','TMPDIR','TEMP','TMP','SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[name])env[name]=process.env[name];
  Object.assign(env,{PI_COLLAB_HOST:'127.0.0.1',PI_COLLAB_PORT:String(port),PI_COLLAB_HOST_TOKEN:hostToken,PI_COLLAB_CLIENT_TOKEN:clientToken,PI_CAFE_REMOTE_CONFIG:config});
  const child=spawn(binary,[],{env,stdio:['ignore','pipe','pipe']});children.push(child);let output='';
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output=(output+b.toString()).slice(-8192);});
  child.on('error',error=>issues.push('Process launch: '+error.code));
  return{child,output:()=>output};
}
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');const closed=new Promise(res=>child.once('exit',res));await Promise.race([closed,delay(6000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}}
async function syntheticPi(port,hostToken,id){
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`);hosts.push(ws);
  const transcript=[{id:'initial-'+id,role:'assistant',text:'Ready on '+id,thinking:'',timestamp:1,status:'complete',toolName:null,toolCallId:null}];
  let sequence=0;
  const snapshot=()=>({protocolVersion:1,streamId:'stream-'+id,sessionId:'session-'+id,sessionName:id,cwd:root,activeLeafId:'leaf-'+id,model:null,thinkingLevel:'off',phase:'idle',hasPendingMessages:false,sessionControl:true,messages:transcript,tools:[],lastEventSeq:sequence,historyTruncated:false});
  const send=v=>{if(ws.readyState===1)ws.send(JSON.stringify(v));};
  const ready=new Promise((res,rej)=>{
    const timer=setTimeout(()=>rej(Error('Synthetic Pi hello timeout')),10000);
    ws.once('error',rej);
    ws.on('message',raw=>{
      const m=JSON.parse(raw.toString());
      if(m.type==='welcome'){send({type:'snapshot',snapshot:snapshot()});clearTimeout(timer);res();}
      if(m.type!=='routed_command')return;
      const q=m.payload;
      const reply=(status,data,code=null)=>send({type:'host_command_result',relayRequestId:m.relayRequestId,status,code,message:code,...data===undefined?{}:{data}});
      if(q.name==='prompt'){
        dispatchCount++;reply('dispatched');sequence++;
        transcript.push({id:'user-'+sequence,role:'user',text:q.content,thinking:'',timestamp:sequence+1,status:'complete',toolName:null,toolCallId:null});
        transcript.push({id:'assistant-'+sequence,role:'assistant',text:'Office reply: '+q.content,thinking:'',timestamp:sequence+2,status:'complete',toolName:null,toolCallId:null});
        send({type:'snapshot',snapshot:snapshot()});
      }else if(q.name==='list_sessions')reply('applied',{kind:'sessions',currentSessionId:'session-'+id,sessions:[],historyTruncated:false});
      else if(q.name==='list_dir')reply('applied',{kind:'directory',path:q.path||'.',entries:[],truncated:false});
      else reply('rejected',undefined,'UNSUPPORTED_TEST_COMMAND');
    });
  });
  await new Promise((res,rej)=>{ws.once('open',res);ws.once('error',rej)});
  send({type:'hello',protocolVersion:1,peerRole:'host',peerId:id,roomId:'main',token:hostToken});
  await ready;
}
async function login(origin,token,mode,viewport={width:1440,height:1000}){
  const context=await browser.newContext({viewport,locale:'en-US',colorScheme:'dark'});contexts.push(context);
  const page=await context.newPage();page.on('pageerror',error=>issues.push('Browser script: '+error.message.slice(0,200)));
  await page.goto(origin+'/#/rooms/main');await page.getByRole('button',{name:'English',exact:true}).click();
  await page.getByLabel('Access key',{exact:true}).fill(token);
  await page.getByRole('button',{name:'Find my computers',exact:true}).click();
  await page.getByRole('button',{name:/Office computer.*Online/}).waitFor();
  if(mode!=='auto'){
    await page.getByRole('combobox',{name:'Connection',exact:true}).click();
    await page.getByRole('option',{name:mode==='relay'?'Cloud relay':'WebRTC / TURN only',exact:true}).click();
  }
  await page.getByRole('button',{name:'Connect to computer',exact:true}).click();
  await page.getByRole('button',{name:/pi-a/}).waitFor({timeout:25000});
  await page.getByRole('button',{name:/pi-a/}).click();
  await page.getByLabel('Message',{exact:true}).waitFor();
  return{page,context};
}
try{
  const cloudPort=await unusedPort(),devicePort=await unusedPort();
  const origin=`http://127.0.0.1:${cloudPort}`;
  const deviceKey=secret(),hostToken=secret(),clientToken=secret();
  const access=Object.fromEntries(['admin','operator','viewer'].map(role=>[role,secret()]));
  const cloud={mode:'cloud',publicOrigin:origin,enableWebRTC:true,devices:[{id:'office',name:'Office computer',tokenHash:digest(deviceKey)}],users:Object.entries(access).map(([role,key])=>({id:role,name:role,tokenHash:digest(key),grants:[{deviceId:'office',room:'main',role}]}))};
  const device={mode:'device',deviceId:'office',deviceToken:deviceKey,cloudUrl:`ws://127.0.0.1:${cloudPort}/remote/agent`,rooms:['main'],maxRole:'admin',enableWebRTC:true};
  for(const[name,value]of Object.entries({cloud,device}))await writeFile(join(root,name+'.json'),JSON.stringify(value),{mode:0o600,flag:'wx'});
  const cloudProcess=start(join(root,'cloud.json'),cloudPort,secret(),secret());
  const deviceProcess=start(join(root,'device.json'),devicePort,hostToken,clientToken);
  await eventually(async()=>{assert(cloudProcess.child.exitCode===null&&deviceProcess.child.exitCode===null,'candidate process exited');return(await fetch(origin+'/healthz')).ok&&(await fetch(`http://127.0.0.1:${devicePort}/healthz`)).ok;},'candidate health');
  for(const id of ['pi-a','pi-b'])await syntheticPi(devicePort,hostToken,id);
  await eventually(async()=>{const response=await fetch(origin+'/api/remote/devices',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+access.admin,'Content-Type':'application/json'},body:'{}'});return(await response.json()).devices?.[0]?.online;},'device registration');
  browser=await chromium.launch({executablePath:browserExecutable,headless:true,chromiumSandbox:true});
  const operator=await login(origin,access.operator,'relay');
  await operator.page.getByText('Cloud relay',{exact:true}).waitFor();
  assert(await operator.page.getByLabel('Message',{exact:true}).isDisabled());
  await operator.page.getByRole('button',{name:'Take control',exact:true}).click();
  await eventually(()=>operator.page.getByLabel('Message',{exact:true}).isEnabled(),'operator control');
  const viewer=await login(origin,access.viewer,'relay');
  assert(await viewer.page.getByLabel('Message',{exact:true}).isDisabled());
  assert.equal(await viewer.page.getByRole('button',{name:'Take control',exact:true}).count(),0);
  await operator.page.getByLabel('Message',{exact:true}).fill('browser-once');await operator.page.getByRole('button',{name:'Send',exact:true}).click();
  await operator.page.getByText('Office reply: browser-once',{exact:true}).waitFor();await viewer.page.getByText('Office reply: browser-once',{exact:true}).waitFor();
  assert.equal(dispatchCount,1);results.push('WSS multi-device viewing, per-instance control and one prompt');
  const admin=await login(origin,access.admin,'webrtc');
  await admin.page.getByText('WebRTC direct',{exact:true}).waitFor({timeout:25000});
  await admin.page.getByRole('button',{name:'Take over control',exact:true}).click();
  await admin.page.getByRole('button',{name:'Confirm takeover',exact:true}).click();
  await eventually(()=>admin.page.getByLabel('Message',{exact:true}).isEnabled(),'administrator takeover');
  await eventually(()=>operator.page.getByLabel('Message',{exact:true}).isDisabled(),'old controller revoked');
  await admin.page.getByLabel('Message',{exact:true}).fill('webrtc-browser-once');await admin.page.getByRole('button',{name:'Send',exact:true}).click();
  await viewer.page.getByText('Office reply: webrtc-browser-once',{exact:true}).waitFor();assert.equal(dispatchCount,2);results.push('Browser WebRTC direct, administrator takeover, shared transcript');
  if(report)await admin.page.screenshot({path:join(report,'desktop.png'),fullPage:true});
  await admin.page.setViewportSize({width:390,height:844});await delay(100);
  assert(await admin.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile horizontal overflow');
  assert(await admin.page.getByLabel('Message',{exact:true}).isVisible());
  if(report)await admin.page.screenshot({path:join(report,'mobile.png'),fullPage:true});
  results.push('390px mobile layout and input visibility');
  await admin.context.close();
  await eventually(async()=>{const button=operator.page.getByRole('button',{name:'Take control',exact:true});return await button.count()===1;},'disconnected controller release');
  await operator.page.getByRole('button',{name:'Take control',exact:true}).click();await eventually(()=>operator.page.getByLabel('Message',{exact:true}).isEnabled(),'remaining collaborator connection');
  assert.equal(dispatchCount,2);results.push('Closing one browser preserves other collaborators and does not replay writes');
  for(const user of cloud.users)if(user.id==='operator')user.disabled=true;
  await writeFile(join(root,'cloud.json'),JSON.stringify(cloud),{mode:0o600});
  await eventually(()=>operator.page.getByLabel('Access key',{exact:true}).count(),'live credential revocation',15000);
  assert(await viewer.page.getByText('Office reply: webrtc-browser-once',{exact:true}).isVisible());results.push('Live account revocation without disrupting another viewer');
  assert.deepEqual(issues,[]);
  const result={passed:true,checks:results,browser:await browser.version(),providerCalls:0,syntheticPromptCount:dispatchCount,scope:'isolated local cloud/device and browser; not external NAT or mobile OS validation'};
  if(report)await writeFile(join(report,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}catch(error){
  const failure={passed:false,checks:results,error:error.message,issues};
  if(report)await writeFile(join(report,'result.json'),JSON.stringify(failure,null,2));
  console.error(JSON.stringify(failure,null,2));process.exitCode=1;
}finally{
  for(const context of contexts)await context.close().catch(()=>{});
  await browser?.close().catch(()=>{});
  for(const host of hosts)host.terminate();
  for(const child of children.reverse())await stop(child);
  await rm(root,{recursive:true,force:true});
}
