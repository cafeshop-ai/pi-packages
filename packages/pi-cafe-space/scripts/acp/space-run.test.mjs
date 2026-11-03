import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { borrowedUserEvent, createEventBuffer, readHostConfig, samePath } from './space-run.mjs';

test('borrowed user projection uses only confirmed text from the exact live thread', () => {
 const native={method:'item/started',params:{threadId:'target',item:{type:'userMessage',id:'native-user-id',content:[{type:'text',text:'hello'},{type:'image',url:'private'},{type:'text',text:'world'}]}}};
 assert.deepEqual(borrowedUserEvent(native,'target'),{type:'user',sessionId:'target',messageId:'native-user-id',text:'hello\nworld'});
 assert.deepEqual(borrowedUserEvent({...native,method:'item/completed'},'target'),borrowedUserEvent(native,'target'));
 assert.equal(borrowedUserEvent(native,'foreign'),null);
 assert.equal(borrowedUserEvent({...native,method:'request'},'target'),null);
 assert.equal(borrowedUserEvent({...native,params:{...native.params,item:{type:'agentMessage'}}},'target'),null);
 assert.equal(borrowedUserEvent({...native,params:{...native.params,item:{...native.params.item,content:[{type:'text',text:5}]}}},'target'),null);
 assert.equal(borrowedUserEvent({...native,params:{...native.params,item:{...native.params.item,content:[{type:'text',text:'x'.repeat(20000)}]}}},'target').text.length,16000);
});

test('approved cwd matching is case-insensitive only on Windows', () => {
 assert.equal(samePath('C:/Work/Repo','c:/work/repo','win32'),true);
 assert.equal(samePath('/Work/Repo','/work/repo','linux'),false);
});

test('event buffer keeps bounded load events in order and streams after attach', () => {
 const buffer=createEventBuffer({maxEvents:2,maxBytes:1024});const seen=[];
 buffer.push({text:'one'});buffer.push({text:'two'});buffer.push({text:'three'});
 buffer.attach({event:event=>seen.push(event.text)});assert.deepEqual(seen,['two','three']);
 buffer.push({text:'live'});assert.deepEqual(seen,['two','three','live']);
 assert.throws(()=>buffer.attach({event(){}}),/already attached/);
});

test('load replay evicts by bytes and tolerates single oversized events', () => {
 const buffer=createEventBuffer({maxEvents:512,maxBytes:100});const seen=[];
 for(let i=0;i<700;i++) buffer.push({text:String(i)});
 buffer.push({text:'x'.repeat(200)});
 buffer.push({text:'tail'});
 buffer.attach({event:event=>seen.push(event)});
 assert.equal(seen.at(-1).text,'tail');
 assert(Buffer.byteLength(seen.map(event=>JSON.stringify(event)).join(''))<=100);
 assert(!seen.some(event=>event.text.length>100));
});

test('startup failure closes control input and returns a safe error without waiting for stdin EOF', async () => {
 const root=await mkdtemp(join(tmpdir(),'cafe-acp-failed-start-'));
 const config={mode:'new',relayUrl:'ws://127.0.0.1:1234/ws',roomId:'main',hostId:'test',token:'host-private-marker',acpRoot:root,codex:process.execPath,cwd:root,stateDirectory:root,promptBudget:0};
 const child=spawn(process.execPath,[fileURLToPath(new URL('./space-run.mjs',import.meta.url)),'--config-env'],{env:{...process.env,CAFE_ACP_CONFIG_JSON:JSON.stringify(config)},stdio:['pipe','pipe','pipe']});
 const exited=once(child,'close');let output='',errors='',timedOut=false;child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);child.stdin.on('error',()=>{});
 const timer=setTimeout(()=>{timedOut=true;child.kill();},5000);
 try {const [code]=await exited;assert.equal(timedOut,false);assert.equal(code,1);assert.deepEqual(JSON.parse(output),{type:'cafe_space_error',error:'MANAGED_PROCESS_EXITED'});assert(!(output+errors).includes(config.token));}
 finally {clearTimeout(timer);child.stdin.destroy();if(child.exitCode===null&&child.signalCode===null)child.kill();await rm(root,{recursive:true,force:true});}
});

test('explicit local host config validates budgets, paths, borrowed identity and unknown options', async () => {
 const root = await mkdtemp(join(tmpdir(), 'cafe-acp-config-test-'));
 const path = join(root, 'host.json');
 const base = { mode:'new', relayUrl:'ws://127.0.0.1:1234/',roomId:'test',hostId:'test',token:'test',acpRoot:root,codex:join(root,'codex.exe'),cwd:root,stateDirectory:join(root,'state'),promptBudget:0 };
 const read = async value => { await writeFile(path, JSON.stringify(value), {mode:0o600}); return readHostConfig(path); };
 try {
   assert.equal((await read(base)).mode,'new');
   const managed={...base,managed:true,managedSessionId:'11111111-1111-4111-8111-111111111111',promptBudget:null};assert.equal((await read(managed)).managed,true);
   await assert.rejects(read({...base,managed:true,promptBudget:null}), /Managed session ID/);
   await assert.rejects(read({...base,managedSessionId:'11111111-1111-4111-8111-111111111111'}), /internal/);
   const restored={...managed,mode:'restore',threadId:'00000000-0000-7000-8000-000000000001'};delete restored.socket;assert.equal((await read(restored)).mode,'restore');
   const unmanagedRestore={...restored,managed:false,promptBudget:0};delete unmanagedRestore.managedSessionId;
   await assert.rejects(read(unmanagedRestore), /Restore requires/i);
   await assert.rejects(read({...base, unexpected:true}), /Unknown/);
   await assert.rejects(read({...base,promptBudget:3}), /budget/);
   await assert.rejects(read({...base,codex:'relative.exe'}), /Absolute/);
   const attached={...base,mode:'attach',socket:join(root,'socket'),expectedCwd:root,threadId:'11111111-1111-4111-8111-111111111111'}; delete attached.cwd;
   assert.equal((await read(attached)).mode,'attach');
   assert.equal((await read({...attached,socket:join(root,'socket %!^&.sock')})).mode,'attach');
   await assert.rejects(read({...attached,socket:join(root,'界'.repeat(1400))}), /socket/i);
   await assert.rejects(read({...attached,cwd:root}), /Borrowed cwd/);
   await assert.rejects(read({...attached,promptBudget:2}), /budget/);
   await assert.rejects(read({...attached,threadId:'guessed'}), /thread ID/);
   await assert.rejects(readHostConfig(root), /ordinary/);
   await assert.rejects(readHostConfig('relative.json'), /absolute/);
 } finally {await rm(root,{recursive:true,force:true});}
});
