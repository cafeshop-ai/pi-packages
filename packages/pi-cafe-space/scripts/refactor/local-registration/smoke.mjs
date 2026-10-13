import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,realpath} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import WebSocket from 'ws';
import {root,run,sha} from '../build.mjs';
import {baseEnv,launch,RPC,until,delay,audit} from '../native-support.mjs';
const installed=process.env.CAFE_LEGACY_INSTALLED_DIR,piRoot=process.env.CAFE_LEGACY_PI_ROOT;
assert(installed&&isAbsolute(installed),'Set CAFE_LEGACY_INSTALLED_DIR to the intended absolute registration directory');
assert(piRoot&&isAbsolute(piRoot),'Set CAFE_LEGACY_PI_ROOT to the intended absolute Pi package directory');
const entry=join(installed,'extension.ts');
const credentials=JSON.parse(await readFile(join(root,'.refactor/manual-trial/credentials.json'),'utf8'));
const work=await mkdtemp(join(root,'.refactor/registration-'));const room='registration-'+randomBytes(8).toString('hex');const report={status:'failed',modelCalls:0,hosts:0,disabledStayedOffline:false,sourceHashes:{},work,checks:[]};
const children=[],rpcs=[],received=[],diagnostics=[];let ws,failure;
try{
 report.before=await audit(work);
 const require=createRequire(join(piRoot,'package.json'));const paths={};
 for(const name of ['@earendil-works/pi-coding-agent'])for(const directory of require.resolve.paths(name)){try{const pkg=join(directory,name);const info=JSON.parse(await readFile(join(pkg,'package.json'),'utf8'));paths[name]=[await realpath(join(pkg,info.types))];break;}catch(e){if(e.code!=='ENOENT')throw e;}}
 const tsconfig=join(work,'tsconfig.json');await writeFile(tsconfig,JSON.stringify({compilerOptions:{strict:true,target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',noEmit:true,skipLibCheck:true,allowImportingTsExtensions:true,paths,types:['node'],typeRoots:[join(root,'../../node_modules/@types')]},files:[entry]}));
 run(process.execPath,[createRequire(import.meta.url).resolve('typescript/bin/tsc'),'-p',tsconfig],{timeout:30000});report.checks.push('actual installed Pi types checked');
 ws=new WebSocket('ws://127.0.0.1:37983/ws',{handshakeTimeout:5000});ws.on('error',()=>{});ws.on('message',data=>{received.push(JSON.parse(data.toString()));assert.ok(received.length<500);});await once(ws,'open');ws.send(JSON.stringify({type:'hello',protocolVersion:1,peerRole:'client',peerId:'registration-verifier',roomId:room,token:credentials.clientToken}));await until(()=>received.some(m=>m.type==='welcome'),'test-room authentication');
 const states=[];
 for(const label of ['one','two','disabled']){
  const agent=join(work,label+'-agent'),project=join(work,label+'-project'),sessions=join(work,label+'-sessions'),home=join(work,label+'-home');for(const dir of [agent,project,sessions,home])await mkdir(dir);
  // Only the selected global registration entry is mirrored, not unrelated
  // packages or provider secrets. No -e, no --collab, no explicit relay/token.
  await writeFile(join(agent,'settings.json'),JSON.stringify({packages:[entry],defaultProjectTrust:'never',enableInstallTelemetry:false,retry:{enabled:false},compaction:{enabled:false}}));
  await writeFile(join(agent,'models.json'),JSON.stringify({providers:{'registration-local':{api:'openai-responses',baseUrl:'https://example.invalid/v1',apiKey:'NEVER_USED_TEST_KEY',models:[{id:'probe',contextWindow:128000,maxTokens:1024}]}}}));
  await writeFile(join(project,'credentials.json'),'NOT_A_SECRET_TEST_FILE');
  const child=await launch(process.execPath,[join(piRoot,'dist/cli.js'),'--mode','rpc','--offline','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-builtin-tools','--provider','registration-local','--model','probe','--session-dir',sessions,'--name','registration '+label],{marker:sessions,cwd:project,env:{...baseEnv(),PI_CODING_AGENT_DIR:agent,PI_COLLAB_ROOM:room,...(label==='disabled'?{PI_COLLAB_ENABLED:'0'}:{}),USERPROFILE:home,HOME:home,APPDATA:home,LOCALAPPDATA:home,PI_TELEMETRY:'0',PI_OFFLINE:'1'}});children.push(child);child.child.stdout.on('data',chunk=>{if(diagnostics.length<20)diagnostics.push(chunk.toString().replaceAll(credentials.hostToken,'[redacted]').replaceAll(credentials.clientToken,'[redacted]').slice(0,4096));});const rpc=new RPC(child.child);rpcs.push(rpc);
  if(label!=='disabled')await until(()=>received.some(m=>m.type==='snapshot'&&m.hostId?.startsWith('pi-host-'+child.child.pid+'-')),'automatic registration on Relay',45000);else await delay(1500);
  const state=await rpc.call('get_state');states.push(state);assert.equal((await rpc.call('get_messages')).messages.length,0);
  if(label!=='disabled')await until(()=>received.some(m=>m.type==='snapshot'&&m.snapshot.sessionId===state.sessionId),'native host snapshot');
 }
 const snapshots=states.slice(0,2).map(s=>received.find(m=>m.type==='snapshot'&&m.snapshot.sessionId===s.sessionId));assert.notEqual(snapshots[0].hostId,snapshots[1].hostId);assert.notEqual(snapshots[0].snapshot.cwd,snapshots[1].snapshot.cwd);report.hosts=2;report.checks.push('two actual native Pi processes registered automatically from the package setting, independent IDs/contexts');
 await delay(1000);assert.equal(received.some(m=>m.type==='snapshot'&&m.snapshot.sessionId===states[2].sessionId),false);report.disabledStayedOffline=true;report.checks.push('PI_COLLAB_ENABLED=0 kept the third Pi offline');
 const m=snapshots[0],requestId='secret-path-check';ws.send(JSON.stringify({type:'command',requestId,targetHostId:m.hostId,expectedStreamId:m.snapshot.streamId,expectedSessionId:m.snapshot.sessionId,expectedCwd:m.snapshot.cwd,payload:{name:'read_file',path:'credentials.json',offset:0}}));const response=await until(()=>received.find(m=>m.type==='command_result'&&m.requestId===requestId),'sensitive path rejection');assert.equal(response.status,'rejected');assert.equal(response.code,'SENSITIVE_PATH');report.checks.push('existing file policy rejects credentials.json, without exposing contents');
 for(const rpc of rpcs)assert.equal(rpc.events.some(e=>e.type==='agent_start'),false);
 for(const name of ['extension.ts','defaults.ts'])report.sourceHashes[name]=sha(await readFile(join(installed,name)));
 report.status='passed';
}catch(e){failure=e;report.error=String(e);report.startupDiagnostics=diagnostics;report.childStatus=children.map(p=>({exitCode:p.child.exitCode,stderr:p.stderr().replaceAll(credentials.hostToken,'[redacted]').replaceAll(credentials.clientToken,'[redacted]')}));console.error(String(e));}
finally{
 ws?.terminate();for(const rpc of rpcs)rpc.dispose();let clean=true;for(const child of children.reverse()){try{await child.stop();}catch{clean=false;}}
 try{report.after=await audit(work);assert.deepEqual(report.after.remaining,[]);assert.deepEqual(report.after.listeners,report.before.listeners);}catch{clean=false;}
 report.cleaned=clean;if(clean)await rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:200});await writeFile(join(root,'.refactor/reports/R18-registration/smoke.json'),JSON.stringify(report,null,2));
 if(!clean)throw Error('Cleanup identity failure; test directory retained');
}
if(failure)throw failure;console.log('PASS: native automatic registration x2, opt-out, sensitive-file rejection, no model requests, no existing process stopped.');
