#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection, createServer as tcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({ strict:true, options:{ binary:{type:'string'}, candidate:{type:'string'}, cli:{type:'string'}, report:{type:'string'} } });
for (const key of ['binary','candidate','cli']) assert(values[key] && isAbsolute(values[key]),`Missing absolute --${key}`);
const root = await mkdtemp(join(tmpdir(),'cafe-warning-test-'));
const children=[], sockets=new Set(), notifications=[], statuses=[], checks=[];
let proxy, allowUpgrade=true, healthRequests=0, authenticatedTransitions=0, pi;
async function until(check,label,timeout=18000) { const end=Date.now()+timeout; while(Date.now()<end){if(await check())return;await delay(50);}throw Error(label+' timed out'); }
async function port() {const s=tcpServer();await new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',ok);});const p=s.address().port;await new Promise(ok=>s.close(ok));return p;}
function start(exe,args,env) {const p=spawn(exe,args,{cwd:root,env,stdio:['pipe','pipe','pipe']});children.push(p);p.on('error',()=>{});p.stderr.resume();return p;}
async function stop(p){if(!p||p.exitCode!==null||p.signalCode!==null)return;const exited=new Promise(ok=>p.once('exit',ok));p.stdin.end();p.kill('SIGTERM');await Promise.race([exited,delay(3000)]);if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await exited;}}
try {
  for(const name of ['home','agent'])await mkdir(join(root,name),{mode:0o700});
  await writeFile(join(root,'agent/settings.json'),JSON.stringify({enableInstallTelemetry:false,enableAnalytics:false,retry:{enabled:false},extensions:[],skills:[],themes:[],prompts:[]}),{mode:0o600});
  const backendPort=await port();
  const hostToken=randomBytes(32).toString('base64url'),clientToken=randomBytes(32).toString('base64url');
  const env={HOME:join(root,'home'),USERPROFILE:join(root,'home'),TMPDIR:root,TMP:root,TEMP:root,PATH:process.execPath.slice(0,process.execPath.lastIndexOf('/'))+':/usr/bin:/bin',PI_COLLAB_HOST:'127.0.0.1',PI_COLLAB_PORT:String(backendPort),PI_COLLAB_HOST_TOKEN:hostToken,PI_COLLAB_CLIENT_TOKEN:clientToken};
  for(const key of ['SystemRoot','WINDIR'])if(process.env[key])env[key]=process.env[key];
  const relay=start(values.binary,[],env);relay.stdout.resume();
  await until(async()=>{try{return(await fetch(`http://127.0.0.1:${backendPort}/healthz`,{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}},'Go relay');
  // An intentionally broken health probe does not imply a broken data path.
  proxy=createServer((req,res)=>{if(req.url==='/healthz')healthRequests++;res.writeHead(503,{'Content-Type':'application/json'});res.end('{"ok":false}');});
  proxy.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
  proxy.on('upgrade',(req,socket,head)=>{
    if(!allowUpgrade||req.url!=='/ws'){socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
    const backend=createConnection({host:'127.0.0.1',port:backendPort});sockets.add(backend);
    backend.once('close',()=>{sockets.delete(backend);socket.destroy();});backend.on('error',()=>socket.destroy());socket.on('error',()=>backend.destroy());socket.once('close',()=>backend.destroy());
    backend.once('connect',()=>{
      let headers=`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for(let i=0;i<req.rawHeaders.length;i+=2)headers+=req.rawHeaders[i]+': '+req.rawHeaders[i+1]+'\r\n';
      backend.write(headers+'\r\n');if(head.length)backend.write(head);backend.pipe(socket);socket.pipe(backend);
    });
  });
  await new Promise((ok,no)=>{proxy.once('error',no);proxy.listen(0,'127.0.0.1',ok);});const proxyPort=proxy.address().port;
  pi=start(process.execPath,[values.cli,'--mode','rpc','--offline','--no-extensions','-e',join(values.candidate,'dist/extension/index.js'),'--no-tools','--no-approve','--no-session','--no-context-files','--no-skills','--no-prompt-templates','--no-themes'],{...env,PI_CODING_AGENT_DIR:join(root,'agent'),PI_COLLAB_RELAY_URL:`ws://127.0.0.1:${proxyPort}/ws`,PI_COLLAB_ROOM:'main',PI_COLLAB_PEER_ID:'warning-isolated-native'});
  let pending='';pi.stdout.on('data',b=>{pending+=b.toString();let n;while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);try{const event=JSON.parse(line);if(event.type==='extension_ui_request'){if(event.method==='setStatus'){statuses.push(event.statusText);if(event.statusText==='café space: connected')authenticatedTransitions++;}if(event.method==='notify')notifications.push({message:event.message,level:event.notifyType});}}catch{}}if(pending.length>65536)pending='';});
  await until(()=>authenticatedTransitions>=1,'initial authenticated connection');await delay(3300);
  assert(healthRequests>0,'preflight failure was not exercised');
  assert(!notifications.some(n=>/local relay is unavailable|host connecting|still reconnecting/.test(n.message)),'startup false warning survived');
  checks.push('Real Pi authenticated to real Go Relay despite HTTP health=503; no false warning or static connecting notice');
  allowUpgrade=false;for(const s of [...sockets])s.destroy();
  await until(()=>notifications.some(n=>n.message.startsWith('Café Space is still reconnecting')),'persistent disconnect warning');
  await delay(600);assert.equal(notifications.filter(n=>n.message.startsWith('Café Space is still reconnecting')).length,1);
  checks.push('Sustained WebSocket failure is reported once after grace, with retries continuing');
  allowUpgrade=true;
  await until(()=>authenticatedTransitions>=2,'recovered authenticated connection');
  assert.equal(notifications.filter(n=>n.message.includes('previous connection warning is resolved')).length,1);
  const count=notifications.length;await delay(3300);assert.equal(notifications.length,count,'late warning after success');
  assert.equal(statuses.at(-1),'café space: connected');checks.push('Recovery updates live status, resolves the previous warning and cancels delayed notifications');
  const result={passed:true,checks,providerRequests:0,healthProbeFailed:true,realPi:true,realGoRelay:true,scope:'temporary credentials and loopback proxy; no live user process or configuration modified'};
  if(values.report){await mkdir(values.report,{recursive:true});await writeFile(join(values.report,'result.json'),JSON.stringify(result,null,2));}console.log(JSON.stringify(result,null,2));
} catch(e){console.error(JSON.stringify({passed:false,checks,error:e.message,statuses,notificationCount:notifications.length,providerRequests:0}));process.exitCode=1;}
finally{for(const p of children.reverse())await stop(p);for(const s of sockets)s.destroy();if(proxy)await new Promise(ok=>proxy.close(ok));await rm(root,{recursive:true,force:true});}
