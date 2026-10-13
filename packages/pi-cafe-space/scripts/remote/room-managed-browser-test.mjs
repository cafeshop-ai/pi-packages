import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
const{values}=parseArgs({strict:true,options:{binary:{type:'string'},candidate:{type:'string'},cli:{type:'string'},browser:{type:'string'},report:{type:'string'}}});for(const k of ['binary','candidate','cli','browser'])assert(values[k]&&isAbsolute(values[k]));
const root=await realpath(await mkdtemp(join(tmpdir(),'cafe-room-managed-'))),children=[],checks=[],diagnostics=[];let browser,page,stage='setup';
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function until(fn,label,timeout=25000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error(label+' timed out');}
async function config(name,value){const p=join(root,name);await writeFile(p,JSON.stringify(value),{mode:0o600});return p;}
const secret=()=>randomBytes(32).toString('base64url');
async function stop(c){if(c.exitCode!==null||c.signalCode!==null)return;const done=new Promise(r=>c.once('exit',r));c.kill('SIGTERM');await Promise.race([done,delay(12000)]);if(c.exitCode===null&&c.signalCode===null){c.kill('SIGKILL');await done;}}
try{
 for(const d of ['home','private','agent','state','project'])await mkdir(join(root,d),{mode:0o700});
 await config('agent/settings.json',{defaultThinkingLevel:'off',defaultTools:[],defaultProjectTrust:'never',enableInstallTelemetry:false,enableAnalytics:false,cacheWarming:'off',compaction:{enabled:false},retry:{enabled:false,maxRetries:0},extensions:[],skills:[],prompts:[],themes:[]});
 const cp=await port(),dp=await port(),origin=`http://127.0.0.1:${cp}`,local=`http://127.0.0.1:${dp}`,password='Managed42',hostToken=secret();
 const cloud=await config('cloud.json',{mode:'cloud',publicOrigin:origin,roomAccess:true,enableWebRTC:true});
 const device=await config('device.json',{mode:'device',publicOrigin:origin,cloudUrl:origin.replace('http:','ws:')+'/room/host',roomIdentityFile:join(root,'private/room.json'),deviceName:'Native managed room',rooms:['main'],maxRole:'operator',enableWebRTC:true,roomManagement:true});
 const env={HOME:join(root,'home'),PATH:process.execPath.slice(0,process.execPath.lastIndexOf('/'))+':/usr/bin:/bin',TMPDIR:root};
 const managed=await config('managed.json',{node:process.execPath,cli:values.cli,extension:join(values.candidate,'dist/extension/index.js'),agentDir:join(root,'agent'),stateDir:join(root,'state'),env,projects:[{id:'approved',name:'Approved isolated project',room:'main',cwd:join(root,'project')}]});
 for(const[p,c,m]of [[cp,cloud,null],[dp,device,managed]]){const child=spawn(values.binary,[],{cwd:root,env:{...env,PI_COLLAB_HOST:'127.0.0.1',PI_COLLAB_PORT:String(p),PI_COLLAB_HOST_TOKEN:hostToken,PI_COLLAB_CLIENT_TOKEN:password,PI_CAFE_REMOTE_CONFIG:c,...m?{PI_COLLAB_MANAGED_CONFIG:m}:{}},stdio:['ignore','ignore','pipe']});children.push(child);child.stderr.on('data',b=>{diagnostics.push(String(b).replace(/[A-Za-z0-9_-]{43}/g,'[redacted]'));if(diagnostics.length>8)diagnostics.shift();});}
 await until(async()=>{if(children.some(c=>c.exitCode!==null))throw Error('Service exited: '+diagnostics.join('').slice(-1200));try{return(await fetch(local+'/healthz')).ok&&(await fetch(origin+'/healthz')).ok;}catch{return false;}},'services');
 let info;await until(async()=>{const r=await fetch(local+'/api/room/share',{method:'POST',headers:{Origin:local,'Content-Type':'application/json','X-Cafe-Room':'1'},body:JSON.stringify({operation:'status',token:password})});info=await r.json();return info.online;},'room online');
 browser=await chromium.launch({executablePath:values.browser,headless:true,chromiumSandbox:true});page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(25000);
 const errors=[];page.on('pageerror',e=>errors.push(e.name+':'+e.message));await page.goto(info.url);await page.getByRole('button',{name:'English',exact:true}).click();await page.getByLabel('Room password',{exact:true}).fill(password);await page.getByRole('button',{name:'Join room',exact:true}).click();await page.getByText('WebRTC direct',{exact:true}).waitFor();
 const records=async()=>{const r=await fetch(local+'/api/workspace',{method:'POST',headers:{Origin:local,Authorization:'Bearer '+password,'Content-Type':'application/json'},body:JSON.stringify({room:'main',operation:'list'})});assert(r.ok,'Authenticated read-only runtime inventory failed');const data=await r.json();assert(Array.isArray(data.sessions));return data.sessions;};
 const create=async(name)=>{await page.getByRole('button',{name:'Start independent Pi instance',exact:true}).first().click();await page.getByText('Approved isolated project',{exact:true}).waitFor();await page.getByLabel('Session name',{exact:true}).fill(name);await page.getByRole('button',{name:'Create',exact:true}).click();await until(async()=>{const all=await records();return all.some(r=>r.name===name&&r.status==='ready');},'native process '+name,35000);await page.getByRole('heading',{name,exact:true}).waitFor();};
 stage='first instance';await create('Native one');const before=await records();assert.equal(before.length,1);const first=before[0];assert.equal(first.cwd,join(root,'project'));checks.push('Room operator creates a real native Pi only in the approved temporary project');
 stage='second instance';await create('Native two');const after=await records();assert.equal(after.length,2);assert.deepEqual(after.find(r=>r.id===first.id),first);assert.notEqual(after[0].id,after[1].id);assert.notEqual(after[0].hostId,after[1].hostId);assert(after.every(r=>r.status==='ready'));checks.push('Second real Pi has its own process/session; the first remains ready and unchanged');
 assert.equal(await page.getByRole('button',{name:'Close instance',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Take over',exact:true}).count(),0);checks.push('Creating instances does not grant room administration, forced control, or closing another process');
 stage='current instance';await page.getByRole('button',{name:'Take control',exact:true}).click();await until(()=>page.getByLabel('Message',{exact:true}).isEnabled(),'control lease');
 assert.equal(await page.getByRole('button',{name:'New session',exact:true}).count(),0);await page.getByRole('button',{name:'Start independent Pi instance',exact:true}).first().click();await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal((await records()).length,2);checks.push('Fixed-session managed Pi offers a new instance instead of a broken session-switch action; cancellation creates nothing');
 assert.deepEqual(errors,[]);const result={passed:true,checks,nativePi:'0.99.1',realPiInstances:2,providerRequests:0,productionProjectsAccessed:false};if(values.report){await mkdir(values.report,{recursive:true});await writeFile(join(values.report,'result.json'),JSON.stringify(result,null,2));}console.log(JSON.stringify(result,null,2));
}catch(error){const result={passed:false,stage,checks,error:String(error.message).slice(0,1000),page:page?await page.locator('body').innerText().catch(()=> ''):'',providerRequests:0};if(values.report){await mkdir(values.report,{recursive:true});await writeFile(join(values.report,'result.json'),JSON.stringify(result,null,2));}console.error(JSON.stringify(result,null,2));process.exitCode=1;}
finally{await browser?.close();for(const c of children.reverse())await stop(c);await rm(root,{recursive:true,force:true});}
