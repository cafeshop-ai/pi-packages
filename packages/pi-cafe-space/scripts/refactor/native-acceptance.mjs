import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { root, run, sha } from './build.mjs';
import { relayBinary } from './candidate-overrides/scripts/relay-path.mjs';
import { releaseFiles } from './release.mjs';
import { audit, rejectMismatchedOwner, baseEnv, launch, RPC, CDP, NativePeer, until, delay } from './native-support.mjs';
import { browserAcceptance } from './native-browser.mjs';
import { dataAcceptance } from './native-data.mjs';
if(process.platform!=='win32'||!process.argv.includes('--allow-native'))throw Error('Explicit native Windows acceptance authorization required');
const argument=name=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw Error(`Missing ${name}`);return resolve(process.argv[i+1]);};
const piRoot=argument('--pi-root');const archive=argument('--archive');const npm=argument('--npm-cli');const chrome=argument('--chrome');
async function free(port){const server=createServer();await new Promise((yes,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',yes);});await new Promise(r=>server.close(r));}
for(const port of [37983,9333])await free(port);
const piVersion=JSON.parse(await readFile(join(piRoot,'package.json'),'utf8')).version;
const archiveSha256=sha(await readFile(archive));
await mkdir(join(root,'.refactor/reports/R18-native'),{recursive:true});
const work=await mkdtemp(join(root,'.refactor/native-'));const install=join(work,'install');const project=join(work,'project');const agent=join(work,'agent');const sessions=join(work,'sessions');const profile=join(work,'chrome-profile');
const owned=[];let rpc,page,browser,peer;let failure;const report={work,nodeVersion:process.version,piVersion,archiveSha256,checks:[],externalModel:false};
const nonce=randomBytes(16).toString('hex');
const ok=label=>{report.checks.push(label);console.log('PASS: '+label);};
try{
 report.before=await audit(work);
 const pack=JSON.parse(await readFile(join(dirname(archive),'pack-report.json'),'utf8'));assert.equal(report.archiveSha256,pack.sha256);
 assert.deepEqual(pack.files,releaseFiles(pack.platforms));
 const tar=join(process.env.SystemRoot,'System32/tar.exe');
 assert.deepEqual(run(tar,['-tzf',archive]).trim().split(/\r?\n/).sort(),pack.files.map(name=>'package/'+name).sort());
 const entries=run(tar,['-tvzf',archive]).trim().split(/\r?\n/);assert.equal(entries.length,pack.files.length);assert.ok(entries.every(line=>line.startsWith('-')));report.archiveFiles=entries.length;
 for(const directory of [install,project,agent,sessions,profile,join(work,'home'),join(work,'temp')])await mkdir(directory);
 await writeFile(join(work,'npmrc'),'');await writeFile(join(work,'global-npmrc'),'');
 await writeFile(join(install,'package.json'),JSON.stringify({name:'r18-isolated-install',private:true,dependencies:{'@earendil-works/pi-coding-agent':'file:'+piRoot,'@cafecodework/pi-cafe-space':'file:'+archive}}));
 // Normal peer resolution; only a local Pi peer and approved ws are needed.
 // No second lockfile, global install, lifecycle script or registry upgrade.
 console.log(run(process.execPath,[npm,'install','--prefix',install,'--workspaces=false','--omit=dev','--ignore-scripts','--package-lock=false','--no-audit','--no-fund','--offline','--logs-dir',join(work,'npm-logs'),'--userconfig',join(work,'npmrc'),'--globalconfig',join(work,'global-npmrc')],{cwd:install,timeout:120000,env:baseEnv()}));
 const pkg=join(install,'node_modules/@cafecodework/pi-cafe-space');const require=createRequire(join(pkg,'package.json'));
 assert.ok((await realpath(require.resolve('ws'))).toLowerCase().startsWith(install.toLowerCase()));
 assert.match(await readFile(join(pkg,'dist/extension/index.js'),'utf8'),/from ["']\.\/local-relay-go\.js["']/);
 const metadata=JSON.parse(await readFile(join(pkg,'dist/relay/build.json'),'utf8'));report.webDigest=metadata.webDigest;assert.equal(metadata.webDigest,pack.webDigest);
 const binary=await relayBinary(pkg);report.binarySha256=sha(await readFile(binary));ok('tarball installed in isolated prefix, local Pi peer and own ws; actual candidate Go import');
 assert.equal(JSON.parse(await readFile(require.resolve('ws/package.json'),'utf8')).version,'8.21.3');
 for(const mode of ['check','test'])assert.match(run(process.execPath,[join(pkg,'scripts/source-verify.mjs'),mode],{cwd:install,env:{...baseEnv(),PATH:''},timeout:30000}),/Prebuilt artifact verification only/);
 ok('installed check/test correctly verify artifacts only, with empty PATH');
 const piRequire=createRequire(join(piRoot,'package.json'));const paths={};
 for(const name of ['@earendil-works/pi-ai','@earendil-works/pi-coding-agent','typebox']){
  for(const directory of piRequire.resolve.paths(name)){
   try{const packageDir=join(directory,name);const info=JSON.parse(await readFile(join(packageDir,'package.json'),'utf8'));assert.equal(typeof info.types,'string');paths[name]=[await realpath(join(packageDir,info.types))];break;}
   catch(error){if(error.code!=='ENOENT')throw error;}
  }
  assert.ok(paths[name],`Installed type entry required: ${name}`);
 }
 const tsconfig=join(work,'fixture-tsconfig.json');await writeFile(tsconfig,JSON.stringify({compilerOptions:{strict:true,target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',noEmit:true,skipLibCheck:true,paths,types:['node'],typeRoots:[join(root,'../../node_modules/@types')]},files:[fileURLToPath(new URL('./native-fixture.ts',import.meta.url))]}));
 run(process.execPath,[createRequire(import.meta.url).resolve('typescript/bin/tsc'),'-p',tsconfig],{timeout:30000});ok('acceptance fixture typechecked against the installed Pi API (no any casts)');
 await writeFile(join(project,'fixture.txt'),'R18 plain UTF-8 file\n');await writeFile(join(project,'.env'),'NOT_A_SECRET=acceptance-only\n');
 await writeFile(join(agent,'settings.json'),JSON.stringify({enableInstallTelemetry:false,compaction:{enabled:false},retry:{enabled:false},defaultProjectTrust:'never'}));
 await free(37983);
 const relay=await launch(binary,[`--instance=${nonce}`],{marker:nonce,cwd:work,env:{SystemRoot:process.env.SystemRoot,PATH:'',PI_COLLAB_HOST:'127.0.0.1',PI_COLLAB_PORT:'37983',PI_COLLAB_HOST_TOKEN:'r18-host-token',PI_COLLAB_CLIENT_TOKEN:'r18-client-token'}});owned.push(relay);
 await rejectMismatchedOwner(relay);ok('retained-process termination rejects wrong creation, executable and command line');
 assert.ok((await audit(work)).listeners.some(p=>p.LocalPort===37983&&p.OwningProcess===relay.child.pid),'Relay listener must belong to this retained child');
 await until(async()=>{try{return(await fetch('http://127.0.0.1:37983/healthz',{signal:AbortSignal.timeout(400)})).ok;}catch{return false;}},'relay ready');
 const pi=await launch(process.execPath,[join(piRoot,'dist/cli.js'),'--mode','rpc','--offline','--no-extensions','-e',pkg,'-e',fileURLToPath(new URL('./native-fixture.ts',import.meta.url)),'--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-approve','--no-builtin-tools','--tools','r18_tool','--provider','r18-local','--model','fixture-a','--thinking','minimal','--session-dir',sessions,'--name','R18 controlled native'],{marker:sessions,cwd:project,env:{...baseEnv(),USERPROFILE:join(work,'home'),APPDATA:join(work,'home'),LOCALAPPDATA:join(work,'home'),TEMP:join(work,'temp'),TMP:join(work,'temp'),PI_CODING_AGENT_DIR:agent,PI_OFFLINE:'1',PI_TELEMETRY:'0',PI_COLLAB_ENABLED:'1',PI_COLLAB_RELAY_URL:'ws://127.0.0.1:37983/ws',PI_COLLAB_ROOM:'r18-native',PI_COLLAB_PEER_ID:'r18-native-pi',PI_COLLAB_HOST_TOKEN:'r18-host-token',PI_COLLAB_CLIENT_TOKEN:'r18-client-token'}});owned.push(pi);rpc=new RPC(pi.child);
 await rpc.wait(e=>e.type==='extension_ui_request'&&e.message==='R18_READY','native session_start readiness',30000);
 const state=await rpc.call('get_state');assert.equal(state.model.provider,'r18-local');report.firstSessionId=state.sessionId;assert.equal(dirname(state.sessionFile),sessions);ok('real Pi CLI/RPC AgentSession with isolated config/project/custom sessionDir');
 peer=await new NativePeer().open();const scope=(await peer.wait(m=>m.type==='snapshot'&&m.hostId==='r18-native-pi')).snapshot;assert.equal(scope.sessionId,state.sessionId);
 await free(9333);
 const browserProcess=await launch(chrome,[`--user-data-dir=${profile}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=9333','--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--metrics-recording-only','about:blank'],{marker:profile,cwd:work,env:baseEnv()});owned.push(browserProcess);
 assert.ok((await audit(work)).listeners.some(p=>p.LocalPort===9333&&p.OwningProcess===browserProcess.child.pid),'CDP listener must belong to this profile owner');
 const version=await until(async()=>{try{return await(await fetch('http://127.0.0.1:9333/json/version',{signal:AbortSignal.timeout(400)})).json();}catch{return false;}},'owned Chrome CDP');report.chrome=version.Browser;browser=await new CDP(version.webSocketDebuggerUrl).open();
 const target=await browser.send('Target.createTarget',{url:'about:blank'});
 const targets=await(await fetch('http://127.0.0.1:9333/json/list',{signal:AbortSignal.timeout(3000)})).json();const pageTarget=targets.find(t=>t.id===target.targetId&&t.type==='page');assert.ok(pageTarget);page=await new CDP(pageTarget.webSocketDebuggerUrl).open();
 const security=[];const exceptions=[];const outgoing=[];const network=[];const consoleErrors=[];const networkErrors=[];
 page.on('Runtime.consoleAPICalled',event=>{if(event.type==='error'&&consoleErrors.length<32)consoleErrors.push(event.args.map(arg=>String(arg.value??arg.description??'')).join(' ').slice(0,500));});
 page.on('Network.loadingFailed',event=>{if(!event.canceled&&networkErrors.length<32)networkErrors.push(event.errorText);});
 page.on('Network.responseReceived',({response})=>{if(response.status>=400&&networkErrors.length<32)networkErrors.push({url:response.url,status:response.status});});
 page.on('Network.webSocketFrameSent',({response})=>{try{const m=JSON.parse(response.payloadData);if(m.type==='command')outgoing.push(m);}catch{}});
 page.on('Network.requestWillBeSent',({request})=>{if(/^https?:/.test(request.url)&&!request.url.startsWith('http://127.0.0.1:37983/'))network.push(request.url);});page.on('Log.entryAdded',({entry})=>{if(entry.source==='security')security.push(entry.text.slice(0,500));});page.on('Runtime.exceptionThrown',event=>exceptions.push(event.exceptionDetails.exception?.description?.slice(0,500)||'exception'));
 await page.send('Page.enable');await page.send('Runtime.enable');await page.send('Log.enable');await page.send('Network.enable');
 await page.send('Page.addScriptToEvaluateOnNewDocument',{source:"window.__r18Csp=[];document.addEventListener('securitypolicyviolation',e=>window.__r18Csp.push({directive:e.effectiveDirective,blocked:e.blockedURI}));"});
 await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await page.send('Page.navigate',{url:'http://127.0.0.1:37983/#/'});
 const evaluate=code=>page.evaluate(code);
 const click=async text=>{await until(()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})`),'button '+text);await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);};
 const input=async(label,text)=>{await evaluate(`(()=>{const n=document.querySelector('[aria-label=${JSON.stringify(label)}]');if(!n)throw Error('missing input');const p=n.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(n,${JSON.stringify(text)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);};
 await click('English');await until(()=>evaluate(`!!document.querySelector('[aria-label="Client token"]')`),'login');await input('Client token','r18-client-token');await input('Room','r18-native');await click('Connect');
 await until(()=>evaluate(`!!document.querySelector('textarea')&&!document.querySelector('textarea').disabled`),'native host authority');
 const settled=rpc.wait(e=>e.type==='agent_settled','parts settled');
 await input('Message','PARTS');await until(()=>evaluate(`![...document.querySelectorAll('button')].find(b=>b.textContent==='Send').disabled`),'draft commit');await click('Send');
 await until(()=>evaluate(`document.querySelectorAll('[data-tool-id]').length===2`),'native inline tools');
 await until(()=>evaluate(`document.querySelector('[data-tool-id="native-t1"]')?.textContent.includes('Empty output')&&document.querySelector('[data-tool-id="native-t2"]')?.textContent.includes('Failed')`),'formal results');
 const order=await evaluate(`(()=>{const t1=document.querySelector('[data-tool-id="native-t1"]');const m=t1.closest('[data-source-id]');const nodes=['Before tools','Between tools','After tools'].map(s=>[...m.querySelectorAll('p')].find(p=>p.textContent===s));const t2=m.querySelector('[data-tool-id="native-t2"]');const a=[nodes[0],t1,nodes[1],t2,nodes[2]];return a.every(Boolean)&&a.slice(1).every((n,i)=>!!(a[i].compareDocumentPosition(n)&Node.DOCUMENT_POSITION_FOLLOWING));})()`);assert.equal(order,true);ok('Chrome Composer -> installed extension -> real native tool execution -> ordered DOM, empty/error output');
 await settled;
 const toolEvents=rpc.events.filter(e=>e.type==='tool_execution_end').map(e=>e.toolCallId);assert.deepEqual(toolEvents,['native-t2','native-t1']);
 const nativeMessages=(await rpc.call('get_messages')).messages;assert.deepEqual(nativeMessages.filter(m=>m.role==='toolResult').map(m=>m.toolCallId),['native-t1','native-t2']);
 assert.ok(nativeMessages.some(m=>m.role==='assistant'&&m.content.some(p=>p.type==='thinking')));ok('native parallel completion t2->t1, authoritative results t1->t2, real thinking events');
 await browserAcceptance({page,rpc,peer,scope,report,ok,outgoing});
 await dataAcceptance({page,rpc,peer,scope,project,work,sessions,report,ok});
 report.csp=await evaluate('window.__r18Csp');report.security=security;report.exceptions=exceptions;report.consoleErrors=consoleErrors;report.networkErrors=networkErrors;
 assert.deepEqual(report.csp,[]);assert.deepEqual(security,[]);assert.deepEqual(exceptions,[]);assert.deepEqual(network,[]);assert.deepEqual(consoleErrors,[]);assert.deepEqual(networkErrors,[]);ok('actual Chrome CSP/runtime console clean and no page-origin external requests');
 for(const [width,height] of [[1440,900],[1024,768],[390,844]]){
  await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<768});await delay(150);
  const geometry=await evaluate('({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth})');assert.ok(geometry.scroll<=geometry.client,JSON.stringify({width,...geometry}));
 }
 ok('real DOM no horizontal overflow: 1440x900, 1024x768, 390x844');
 report.status='passed';
}catch(error){failure=error;report.status='failed';report.error=String(error);report.diagnostics=owned.map(p=>({exitCode:p.child.exitCode,stderr:p.stderr()}));report.rpcEventTypes=rpc?.events.map(e=>e.type);console.error(report.error);console.error(JSON.stringify(report.diagnostics));}
finally{
 let clean=true;
 try{if(rpc){await rpc.call('abort').catch(()=>{});await rpc.call('prompt',{message:'/r18-shutdown'}).catch(()=>{});}}catch{}
 try{if(browser)await browser.send('Browser.close').catch(()=>{});}catch{}
 page?.close();browser?.close();rpc?.dispose();peer?.close();
 for(const process of owned.reverse()){try{await process.stop();}catch(error){clean=false;console.error(String(error));}}
 try{report.after=await audit(work);assert.deepEqual(report.after.remaining,[]);assert.equal(report.after.listeners.some(p=>[37983,9333].includes(p.LocalPort)),false);assert.deepEqual(report.after.listeners,report.before.listeners);}
 catch(error){clean=false;report.cleanupError=String(error);}
 report.cleanedProcesses=clean;
 await writeFile(join(root,'.refactor/reports/R18-native/latest.json'),JSON.stringify(report,null,2));
 await writeFile(join(root,'.refactor/reports/R18-native',work.split(/[\\/]/).at(-1)+'.json'),JSON.stringify(report,null,2));
 if(clean)await rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:300});
 if(!clean)throw Error('Unproven process ownership; owned directory retained');
}
if(failure)throw failure;
