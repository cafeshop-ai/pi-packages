// Persistent, user-controlled side-by-side trial, not a production switch.
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { baseEnv, launch, audit, CDP, until, delay } from './native-support.mjs';
import { verifyManual } from './manual-verify.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(await readFile(join(root,'credentials.json'),'utf8'));assert.equal(config.format,'pi-cafe-space-manual-trial-v1');assert.equal(config.root,root);
const ps=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');const exec=promisify(execFile);
async function powershell(file,args=[]){return (await exec(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,file),...args],{env:baseEnv(),windowsHide:true,timeout:30000,maxBuffer:65536})).stdout.trim();}
async function owner(operation,record){const args=['-Operation',operation,'-ProcessId',String(record.pid)];if(operation==='Stop')args.push('-ExpectedBase64',Buffer.from(JSON.stringify(record)).toString('base64'));const text=await powershell('native-process.ps1',args);return text?JSON.parse(text):null;}
async function json(name,fallback){try{return JSON.parse(await readFile(join(root,name),'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
async function free(port){const server=createServer();await new Promise((yes,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',yes);});await new Promise(r=>server.close(r));}
const equal=(a,b)=>a&&a.pid===b.pid&&a.creation===b.creation&&a.commandLine===b.commandLine&&a.executable.toLowerCase()===b.executable.toLowerCase();
async function stop(){
 const services=await json('service-owners.json',[]);const chrome=services.find(p=>p.role==='chrome');
 const records=[{role:'pi',record:await json('pi-owner.json',null)},{role:'console',record:await json('console-owner.json',null)},...services.slice().reverse()].filter(p=>p.record);
 for(const item of records){
  const marker=item.role==='pi'?join(root,'sessions'):item.role==='console'?join(root,'pi-console.ps1'):item.role==='chrome'?join(root,'chrome-profile'):item.marker;
  const executable=item.role==='pi'?config.node:item.role==='console'?ps:item.role==='chrome'?config.chrome:item.executable;
  if(!marker||!executable||!item.record.commandLine.includes(marker)||item.record.executable.toLowerCase()!==executable.toLowerCase())throw Error('Untrusted owner record retained');
 }
 if(chrome&&equal(await owner('Query',chrome.record),chrome.record)){
  const listeners=(await audit()).listeners;
  if(listeners.some(l=>l.LocalPort===9333&&l.OwningProcess===chrome.record.pid)){
   let cdp;try{const version=await(await fetch('http://127.0.0.1:9333/json/version',{signal:AbortSignal.timeout(1500)})).json();cdp=await new CDP(version.webSocketDebuggerUrl).open();await cdp.send('Browser.close').catch(()=>{});}catch{}finally{cdp?.close();}
  }
 }
 for(const item of records){
  const actual=await owner('Query',item.record);
  if(equal(actual,item.record)&&!await owner('Stop',item.record))throw Error('Owned process could not be stopped; records retained');
  // Different creation/full command means the recorded process is gone, not
  // authority to stop the current process at a recycled PID.
 }
 for(const name of ['service-owners.json','pi-owner.json','console-owner.json','ready.json'])await unlink(join(root,name)).catch(e=>{if(e.code!=='ENOENT')throw e;});
 const after=await audit(root);await writeFile(join(root,'stopped-report.json'),JSON.stringify(after,null,2));console.log('Stopped only recorded trial processes. Installed files and sessions retained.');
}
async function start(){
 for(const name of ['service-owners.json','pi-owner.json','console-owner.json']){try{await access(join(root,name));throw Error('Trial owner records exist. Use Stop.cmd before restarting.');}catch(e){if(e.code!=='ENOENT')throw e;}}
 for(const port of [37983,9333])await free(port);
 const before=await audit();const relayModule=await import(pathToFileURL(join(config.package,'scripts/relay-path.mjs')).href);const binary=await relayModule.relayBinary(config.package);
 const services=[];let page;
 const save=()=>writeFile(join(root,'service-owners.json'),JSON.stringify(services));
 try{
  const nonce=randomBytes(16).toString('hex');
  const relay=await launch(binary,[`--instance=${nonce}`],{marker:nonce,cwd:root,detached:true,stdio:'ignore',env:{SystemRoot:process.env.SystemRoot,PATH:'',PI_COLLAB_HOST:'127.0.0.1',PI_COLLAB_PORT:'37983',PI_COLLAB_HOST_TOKEN:config.hostToken,PI_COLLAB_CLIENT_TOKEN:config.clientToken,...(await json('managed-config.json',null)?{PI_COLLAB_MANAGED_CONFIG:join(root,'managed-config.json')}:{})}});relay.child.unref();services.push({role:'relay',record:relay.record,marker:nonce,executable:binary});await save();
  assert.ok((await audit()).listeners.some(l=>l.LocalPort===37983&&l.OwningProcess===relay.child.pid));
  await until(async()=>{try{return(await fetch('http://127.0.0.1:37983/healthz',{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}},'trial Relay');
  await powershell('launch-console.ps1');
  await until(async()=>!!await json('ready.json',null),'native TTY initialization',45000);
  const profile=join(root,'chrome-profile');
  const chrome=await launch(config.chrome,[`--user-data-dir=${profile}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=9333','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--metrics-recording-only','--new-window','--window-size=1440,900','http://127.0.0.1:37983/'],{marker:profile,cwd:root,detached:true,stdio:'ignore',windowsHide:false,env:baseEnv()});chrome.child.unref();services.push({role:'chrome',record:chrome.record});await save();
  assert.ok((await audit()).listeners.some(l=>l.LocalPort===9333&&l.OwningProcess===chrome.child.pid));
  const targets=await until(async()=>{try{const result=await(await fetch('http://127.0.0.1:9333/json/list',{signal:AbortSignal.timeout(500)})).json();return result.find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:37983/'));}catch{return false;}},'trial page target');
  page=await new CDP(targets.webSocketDebuggerUrl).open();await page.send('Runtime.enable');
  await until(()=>page.evaluate(`!!document.querySelector('input[type="password"],textarea')`),'trial application');
  if(await page.evaluate(`!!document.querySelector('input[type="password"]')`)){
   await page.evaluate(`(()=>{const form=document.querySelector('input[type="password"]').form;const inputs=[...form.querySelectorAll('input')];const values=[${JSON.stringify(config.clientToken)},${JSON.stringify(config.room)}];inputs.forEach((n,i)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,values[i]);n.dispatchEvent(new Event('input',{bubbles:true}));});})()`);
   await delay(100);await page.evaluate(`document.querySelector('input[type="password"]').form.requestSubmit()`);
  }
  await until(()=>page.evaluate(`!!document.querySelector('textarea')&&!document.querySelector('textarea').disabled`),'connected, ready native Pi');
  const report=await verifyManual(root);assert.deepEqual(report.processAudit.listeners.filter(l=>[37891,9222].includes(l.LocalPort)),before.listeners.filter(l=>[37891,9222].includes(l.LocalPort)));
  console.log('READY: http://127.0.0.1:37983/');console.log('Native Pi window is open. No prompt/model request was sent. Use Stop.cmd to stop this trial.');
 }catch(error){console.error('Trial startup did not complete; cleaning only recorded trial processes.');await stop();throw error;}finally{page?.close();}
}
if(process.argv[2]==='start')await start();else if(process.argv[2]==='stop')await stop();else throw Error('Expected start or stop');
