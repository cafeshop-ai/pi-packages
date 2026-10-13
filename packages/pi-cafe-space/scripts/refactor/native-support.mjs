import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import WebSocket from 'ws';
const exec=promisify(execFile);
const ps=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const helper=fileURLToPath(new URL('./native-process.ps1',import.meta.url));
export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function until(fn,label,ms=12000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await delay(40);}throw Error(`Timeout: ${label}`);}
export function baseEnv(){return Object.fromEntries(['SystemRoot','WINDIR','COMSPEC','PATH','PATHEXT','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));}
async function owner(operation,pid,record){const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',helper,'-Operation',operation,'-ProcessId',String(pid)];if(record)args.push('-ExpectedBase64',Buffer.from(JSON.stringify(record)).toString('base64'));const {stdout}=await exec(ps,args,{env:baseEnv(),windowsHide:true,timeout:10000,maxBuffer:32768});return stdout.trim()?JSON.parse(stdout):null;}
export async function rejectMismatchedOwner(process){
 for(const mismatch of [{creation:'0'},{executable:process.record.executable+'.wrong'},{commandLine:process.record.commandLine+' --not-owned'}]){
  if(await owner('Stop',process.child.pid,{...process.record,...mismatch})!==false)throw Error('Mismatched owner was not rejected');
  if(process.child.exitCode!==null)throw Error('Identity rejection terminated the owned probe');
 }
}
export async function audit(marker=''){
 const {stdout}=await exec(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',helper,'-Operation','Audit','-ExpectedBase64',Buffer.from(marker).toString('base64')],{env:baseEnv(),windowsHide:true,timeout:15000,maxBuffer:32768});return JSON.parse(stdout);
}
export async function launch(file,args,options){
 const {marker,...spawnOptions}=options;if(!marker||!args.some(arg=>arg.includes(marker)))throw Error('Unique ownership marker required');
 const expectedExecutable=(await realpath(file)).toLowerCase();
 const child=spawn(file,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],...spawnOptions});
 child.on('error',()=>{});let stderr='';child.stderr?.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4096);});
 await once(child,'spawn');const record=await owner('Query',child.pid);
 if(!record||record.executable.toLowerCase()!==expectedExecutable||!record.commandLine.includes(marker)||child.exitCode!==null){if(child.exitCode===null)child.kill();throw Error('Cannot prove newly spawned owner; '+stderr.slice(-1000));}
 return {child,record,stderr:()=>stderr,async stop(){if(child.exitCode!==null)return;const stopped=once(child,'exit');if(!await owner('Stop',child.pid,record)){if(child.exitCode!==null)return;throw Error('Owner recheck failed; process and directory retained');}await stopped;}};
}
export class RPC {
 constructor(child){this.child=child;this.events=[];this.pending=new Map();this.next=1;const decoder=new StringDecoder('utf8');let buffer='';child.stdout.on('data',chunk=>{buffer+=decoder.write(chunk);if(buffer.length>8*1024*1024)throw Error('RPC buffer limit');let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n).replace(/\r$/,'');buffer=buffer.slice(n+1);let item;try{item=JSON.parse(line);}catch{continue;}if(item.type==='response'&&this.pending.has(item.id)){const waiter=this.pending.get(item.id);this.pending.delete(item.id);clearTimeout(waiter.timer);item.success?waiter.resolve(item.data):waiter.reject(Error(`RPC ${item.command}: ${item.error}`));}else{this.events.push(item);if(this.events.length>5000)this.events.shift();}}});}
 call(type,fields={}){const id=String(this.next++);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`RPC timeout: ${type}`));},12000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,type,...fields})+'\n');});}
 wait(predicate,label,ms=12000){const pending=until(()=>{const i=this.events.findIndex(predicate);if(i>=0)return this.events.splice(i,1)[0];},label,ms);pending.catch(()=>{});return pending;}
 dispose(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('RPC disposed'));}this.pending.clear();}
}
export class NativePeer {
 constructor({url='ws://127.0.0.1:37983/ws',roomId='r18-native',token='r18-client-token',hostId='r18-native-pi'}={}){this.roomId=roomId;this.token=token;this.hostId=hostId;this.messages=[];this.next=1;this.ws=new WebSocket(url,{handshakeTimeout:5000});this.ws.on('error',()=>{});this.ws.on('message',data=>{this.messages.push(JSON.parse(data.toString()));if(this.messages.length>2500)this.messages.shift();});}
 async open(){await once(this.ws,'open');const pending=this.wait(m=>m.type==='welcome');this.ws.send(JSON.stringify({type:'hello',protocolVersion:1,peerRole:'client',peerId:'r18-observer',roomId:this.roomId,token:this.token}));await pending;return this;}
 wait(predicate){const pending=until(()=>{const i=this.messages.findIndex(predicate);if(i>=0)return this.messages.splice(i,1)[0];},'native relay peer');pending.catch(()=>{});return pending;}
 command(scope,payload){const requestId='native-'+this.next++;const pending=this.wait(m=>m.type==='command_result'&&m.requestId===requestId);this.ws.send(JSON.stringify({type:'command',requestId,targetHostId:this.hostId,expectedStreamId:scope.streamId,expectedSessionId:scope.sessionId,expectedCwd:scope.cwd,payload}));return pending;}
 close(){this.ws.terminate();}
}
export class CDP {
 constructor(url){this.ws=new WebSocket(url,{handshakeTimeout:5000});this.next=1;this.pending=new Map();this.listeners=new Map();this.ws.on('error',()=>{});this.ws.on('message',bytes=>{const m=JSON.parse(bytes.toString());if(m.id){const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}else for(const f of this.listeners.get(m.method)||[])f(m.params);});}
 async open(){await once(this.ws,'open');return this;}
 on(name,handler){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(handler);}
 send(method,params={}){const id=this.next++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`CDP timeout: ${method}`));},10000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
 async evaluate(expression){const result=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||'Browser exception');return result.result.value;}
 close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('CDP closed'));}this.pending.clear();this.ws.terminate();}
}
