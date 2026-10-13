// Explicitly owned native acceptance. One offline synthetic turn; no real model/network call.
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,writeFile,rm,readdir } from 'node:fs/promises';
import { join,resolve,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { root,sha } from './build.mjs';
import { baseEnv,launch,until,audit,NativePeer,RPC } from './native-support.mjs';
if(process.platform!=='win32'||!process.argv.includes('--allow-native'))throw Error('Requires isolated Windows --allow-native');
const arg=process.argv.indexOf('--pi-root');assert.ok(arg>=0&&process.argv[arg+1]);const piRoot=resolve(process.argv[arg+1]);
const candidate=join(root,'.refactor/release/package'),binary=join(candidate,'dist/relay/bin/windows-amd64/pi-cafe-relay.exe');
const cli=join(piRoot,'dist/bundle/cli.js'),extension=join(candidate,'dist/extension/index.js');
const out=join(root,'.refactor/reports/R18-managed-sessions');await mkdir(out,{recursive:true});
const work=await mkdtemp(join(root,'.refactor/managed-native-'));const before=await audit();
const report={status:'running',checks:[],realModelCalls:0,agentTurns:0,work,binarySHA256:sha(await readFile(binary)),extensionSHA256:sha(await readFile(extension)),node:process.version,pi:JSON.parse(await readFile(join(piRoot,'package.json'),'utf8')).version};
const owned=[];let peer,rpc,relay,failure;const ok=s=>{report.checks.push(s);console.log('PASS: '+s);};
try{
 for(const name of ['project','agent','state','home','temp','manual-sessions'])await mkdir(join(work,name));
 const project=join(work,'project'),agent=join(work,'agent'),state=join(work,'state');
 const bootstrap=join(work,'extension.ts');
 await writeFile(bootstrap,`import candidate from ${JSON.stringify('./'+relative(work,extension).replaceAll('\\','/'))};\nimport fixture from ${JSON.stringify('./'+relative(work,fileURLToPath(new URL('./session-controls-native-fixture.ts',import.meta.url))).replaceAll('\\','/'))};\nexport default pi=>{candidate(pi);fixture(pi);};\n`);
 await writeFile(join(agent,'settings.json'),JSON.stringify({enableInstallTelemetry:false,compaction:{enabled:false},retry:{enabled:false},defaultProjectTrust:'never',defaultProvider:'controls-offline',defaultModel:'no-calls'}));
 const env={...baseEnv(),PI_CAFE_CONTROL_TEST_DIR:work,PI_CAFE_INPUT_TEST:'1',USERPROFILE:join(work,'home'),APPDATA:join(work,'home'),LOCALAPPDATA:join(work,'home'),TEMP:join(work,'temp'),TMP:join(work,'temp')};
 const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const url=`http://127.0.0.1:${port}`,room='managed-native',hostToken=randomUUID(),clientToken=randomUUID(),config=join(work,'managed.json');
 await writeFile(config,JSON.stringify({node:process.execPath,cli,extension:bootstrap,agentDir:agent,stateDir:state,env,projects:[{id:'project',name:'Isolated native project',room,cwd:project}]}));
 const startRelay=async()=>{const nonce=randomUUID();const p=await launch(binary,['--instance='+nonce],{marker:nonce,cwd:work,env:{...env,PI_COLLAB_HOST:'127.0.0.1',PI_COLLAB_PORT:String(port),PI_COLLAB_HOST_TOKEN:hostToken,PI_COLLAB_CLIENT_TOKEN:clientToken,PI_COLLAB_MANAGED_CONFIG:config}});owned.push(p);await until(async()=>{try{return(await fetch(url+'/healthz',{signal:AbortSignal.timeout(300)})).ok;}catch{return false;}},'isolated manager');return p;};
 relay=await startRelay();
 assert.equal((await(await fetch(url+'/api/config')).json()).managedSessions,true);
 const call=async(operation,fields={},token=clientToken,origin=url)=>{const response=await fetch(url+'/api/workspace',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({room,operation,...fields}),signal:AbortSignal.timeout(10000)});return {status:response.status,data:await response.json()};};
 assert.equal((await call('list',{},hostToken)).status,401);assert.equal((await call('list',{},clientToken,'http://evil.invalid')).status,403);
 assert.equal((await call('create',{id:randomUUID(),projectId:'../outside',name:'No'})).status,409);
 const id=randomUUID();let response=await call('create',{id,projectId:'project',name:'Native independent session'});assert.equal(response.status,200);assert.equal(response.data.status,'starting');
 await until(async()=>{const s=(await call('list')).data.sessions.find(s=>s.id===id);if(s?.status==='failed')throw Error('Native startup failed: '+s.error);return s?.status==='ready';},'native managed Pi ready',40000);
 peer=await new NativePeer({url:url.replace('http:','ws:')+'/ws',roomId:room,token:clientToken,hostId:'managed-'+id}).open();
 let scope=(await peer.wait(m=>m.type==='snapshot'&&m.hostId==='managed-'+id)).snapshot;
 assert.equal(scope.sessionId,id);assert.equal(scope.cwd,project);assert.equal(scope.inputAssist,true);assert.deepEqual(scope.messages,[]);
 assert.equal((await peer.command(scope,{name:'new_session'})).code,'MANAGED_SESSION_FIXED');
 ok('No existing host required: native independent Pi starts in the allowed project with native tools/input capabilities; browser cannot switch its identity');
 const manual=await launch(process.execPath,[cli,'--mode','rpc','--offline','--no-extensions','-e',bootstrap,'--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-approve','--session-dir',join(work,'manual-sessions')],{marker:join(work,'manual-sessions'),cwd:project,env:{...env,PI_CODING_AGENT_DIR:agent,PI_OFFLINE:'1',PI_TELEMETRY:'0',PI_COLLAB_ENABLED:'1',PI_COLLAB_RELAY_URL:url.replace('http:','ws:')+'/ws',PI_COLLAB_ROOM:room,PI_COLLAB_PEER_ID:'unmanaged-fixture',PI_COLLAB_HOST_TOKEN:hostToken}});owned.push(manual);rpc=new RPC(manual.child);const initial=await rpc.call('get_state');
 const second=randomUUID();assert.equal((await call('create',{id:second,projectId:'project',name:'Second independent session'})).status,200);
 await until(async()=>(await call('list')).data.sessions.find(s=>s.id===second)?.status==='ready','second managed Pi',40000);
 assert.equal((await rpc.call('get_state')).sessionId,initial.sessionId);assert.deepEqual((await rpc.call('get_messages')).messages,[]);
 assert.equal((await peer.command(scope,{name:'rename_session',title:'Persisted native name'})).status,'applied');
 assert.equal((await call('create',{id,projectId:'project',name:'Native independent session'})).data.id,id);assert.equal((await call('list')).data.sessions.length,2);
 ok('Two independent sessions coexist; idempotent creation never switches the separate manual Pi or creates a duplicate');
 assert.equal((await call('close',{id})).status,200);await until(async()=>(await call('list')).data.sessions.find(s=>s.id===id)?.status==='stopped','managed stop',15000);
 assert.equal((await rpc.call('get_state')).sessionId,initial.sessionId);
 // Empty-session names are native in-memory setup, retained as registry metadata on close.
 assert.equal((await call('list')).data.sessions.find(s=>s.id===id).title,'Persisted native name');
 peer.close();peer=null;
 assert.equal((await call('open',{id})).status,200);await until(async()=>(await call('list')).data.sessions.find(s=>s.id===id)?.status==='ready','managed reopen',40000);
 peer=await new NativePeer({url:url.replace('http:','ws:')+'/ws',roomId:room,token:clientToken,hostId:'managed-'+id}).open();scope=(await peer.wait(m=>m.type==='snapshot'&&m.hostId==='managed-'+id)).snapshot;assert.equal(scope.sessionId,id);assert.equal(scope.sessionName,'Persisted native name');
 ok('Closing stops only the managed Pi; reopening restores its exact ID and empty-session rename without manufacturing JSONL');
 assert.equal((await peer.command(scope,{name:'prompt',content:'REFERENCE_CHECK managed native persistence'})).status,'dispatched');
 await peer.wait(m=>m.type==='event'&&m.event.kind==='session_state'&&m.event.phase==='idle');
 const files=await readdir(join(state,'sessions','project'));assert.ok(files.some(f=>f.includes(id)&&f.endsWith('.jsonl')));
 assert.equal((await readFile(join(work,'synthetic-inputs.jsonl'),'utf8')).trim().split('\n').length,1);report.agentTurns=1;report.syntheticProviderResponses=1;
 assert.equal((await call('close',{id})).status,200);await until(async()=>(await call('list')).data.sessions.find(s=>s.id===id)?.status==='stopped','close saved native session',15000);
 peer.close();peer=null;await call('open',{id});await until(async()=>(await call('list')).data.sessions.find(s=>s.id===id)?.status==='ready','reopen saved native conversation',40000);
 peer=await new NativePeer({url:url.replace('http:','ws:')+'/ws',roomId:room,token:clientToken,hostId:'managed-'+id}).open();scope=(await peer.wait(m=>m.type==='snapshot'&&m.hostId==='managed-'+id)).snapshot;
 assert.ok(scope.messages.some(m=>m.text.includes('managed native persistence')));assert.ok(scope.messages.some(m=>m.text.includes('Synthetic response')));
 ok('One offline synthetic native turn is saved by Pi and restored on reopen; zero real provider calls');
 // Prove OS Job Object ownership, including crash cleanup. This stops ONLY the
 // freshly launched test Relay with its recorded PID/creation/executable.
 const childBefore=await audit(work);const managedPids=childBefore.remaining.filter(p=>p.ParentProcessId===relay.child.pid).map(p=>p.ProcessId);
 assert.equal(managedPids.length,2);peer.close();peer=null;await relay.stop();
 await until(async()=>{const now=await audit(work);return managedPids.every(pid=>!now.remaining.some(p=>p.ProcessId===pid));},'owned children exit with manager',20000);
 assert.equal((await rpc.call('get_state')).sessionId,initial.sessionId);
 relay=await startRelay();assert.equal((await call('list')).data.sessions.length,2);assert.ok((await call('list')).data.sessions.every(s=>s.status==='stopped'));
 assert.equal((await call('create',{id,projectId:'project',name:'Native independent session'})).data.status,'stopped');
 ok('Relay crash closes its owned Job trees, leaves manual Pi intact, and reloads saved registry without silently restarting sessions');
 report.status='passed';
}catch(e){failure=e;report.status='failed';report.failure=e.message;}
finally{
 peer?.close();rpc?.dispose();for(const process of owned.reverse())await process.stop();
 const after=await audit(work);report.disposed=after.remaining.length===0;report.listenerDelta=after.listeners.filter(p=>!before.listeners.some(b=>b.LocalPort===p.LocalPort&&b.OwningProcess===p.OwningProcess));
 if(!report.disposed||report.listenerDelta.length){report.status='failed';report.cleanupError='owned processes/listeners remain';}
 await writeFile(join(out,'native.json'),JSON.stringify(report,null,2)+'\n');if(report.disposed&&report.status==='passed')await rm(work,{recursive:true,force:true});
}
if(failure)throw failure;assert.equal(report.status,'passed');console.log(JSON.stringify(report,null,2));
