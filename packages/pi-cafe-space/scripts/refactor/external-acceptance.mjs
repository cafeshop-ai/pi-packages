// Opt-in external acceptance; not part of ordinary builds/tests and never packed.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { root, run, sha } from './build.mjs';
import { relayBinary } from './candidate-overrides/scripts/relay-path.mjs';
import { releaseFiles } from './release.mjs';
import { audit, baseEnv, launch, RPC, CDP, until, delay } from './native-support.mjs';
import { controls } from './native-browser.mjs';
const dry=process.argv.includes('--dry-run');
if(process.platform!=='win32'||(!dry&&!process.argv.includes('--allow-external-2x1024-60s')))throw Error('Explicit external acceptance authorization required');
const argument=name=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw Error(`Missing ${name}`);return resolve(process.argv[i+1]);};
const piRoot=argument('--pi-root'),archive=argument('--archive'),npm=argument('--npm-cli'),chrome=argument('--chrome');
const reports=join(root,'.refactor/reports/R18-external');await mkdir(reports,{recursive:true});
// This fixed ledger is never automatically removed or reset. One user approval,
// one armed run, including failures. A later external run needs fresh approval.
const authorization=join(reports,'authorized-once.jsonl');
if(!dry){try{await access(authorization);throw Error('Authorization already spent; no external rerun permitted');}catch(error){if(error.code!=='ENOENT')throw error;}}
async function free(port){const server=createServer();await new Promise((yes,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',yes);});await new Promise(r=>server.close(r));}
for(const port of [37983,9333])await free(port);
const work=await mkdtemp(join(root,'.refactor/external-'));const install=join(work,'install'),project=join(work,'project'),agent=join(work,'agent'),sessions=join(work,'sessions'),profile=join(work,'chrome-profile');
const owned=[];let rpc,page,browser,failure,watchdog;let stage='setup';
const report={work,dry,externalModeRequested:!dry,externalModel:false,nodeVersion:process.version,provider:'cafe',model:'gpt-6-astra',checks:[]};
const nonce=randomBytes(16).toString('hex');const ok=label=>{report.checks.push(label);console.log('PASS: '+label);};
try{
 report.before=await audit(work);
 for(const directory of [install,project,agent,sessions,profile,join(work,'home'),join(work,'temp')])await mkdir(directory);
 report.piVersion=JSON.parse(await readFile(join(piRoot,'package.json'),'utf8')).version;assert.equal(report.piVersion,'0.85.1');
 const pack=JSON.parse(await readFile(join(dirname(archive),'pack-report.json'),'utf8'));report.archiveSha256=sha(await readFile(archive));assert.equal(report.archiveSha256,pack.sha256);assert.equal(pack.sha256,'32ee907b902174495ed3e1ea9307a8f339cd8df79ede3e7f23e50eeccc94bfd2');assert.deepEqual(pack.files,releaseFiles(pack.platforms));
 const tar=join(process.env.SystemRoot,'System32/tar.exe');assert.deepEqual(run(tar,['-tzf',archive]).trim().split(/\r?\n/).sort(),pack.files.map(n=>'package/'+n).sort());assert.ok(run(tar,['-tvzf',archive]).trim().split(/\r?\n/).every(n=>n.startsWith('-')));
 await writeFile(join(work,'npmrc'),'');await writeFile(join(work,'global-npmrc'),'');
 await writeFile(join(install,'package.json'),JSON.stringify({name:'r18-external-install',private:true,dependencies:{'@earendil-works/pi-coding-agent':'file:'+piRoot,'@cafecodework/pi-cafe-space':'file:'+archive}}));
 run(process.execPath,[npm,'install','--prefix',install,'--workspaces=false','--omit=dev','--ignore-scripts','--package-lock=false','--no-audit','--no-fund','--offline','--logs-dir',join(work,'npm-logs'),'--userconfig',join(work,'npmrc'),'--globalconfig',join(work,'global-npmrc')],{cwd:install,timeout:120000,env:baseEnv()});
 const pkg=join(install,'node_modules/@cafecodework/pi-cafe-space');const require=createRequire(join(pkg,'package.json'));assert.ok((await realpath(require.resolve('ws'))).toLowerCase().startsWith(install.toLowerCase()));
 const metadata=JSON.parse(await readFile(join(pkg,'dist/relay/build.json'),'utf8'));report.webDigest=metadata.webDigest;assert.equal(metadata.webDigest,pack.webDigest);const binary=await relayBinary(pkg);report.binarySha256=sha(await readFile(binary));
 ok('same SHA-verified native-accepted candidate installed in a fresh isolated prefix');
 stage='typecheck';const piRequire=createRequire(join(piRoot,'package.json'));const paths={};
 for(const name of ['@earendil-works/pi-ai','@earendil-works/pi-coding-agent','typebox']){
  for(const directory of piRequire.resolve.paths(name)){try{const dir=join(directory,name),info=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));paths[name]=[await realpath(join(dir,info.types))];break;}catch(error){if(error.code!=='ENOENT')throw error;}}
  assert.ok(paths[name]);
 }
 const fixture=fileURLToPath(new URL('./external-fixture.ts',import.meta.url));const tsconfig=join(work,'fixture-tsconfig.json');
 await writeFile(tsconfig,JSON.stringify({compilerOptions:{strict:true,target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',noEmit:true,skipLibCheck:true,allowImportingTsExtensions:true,paths,types:['node'],typeRoots:[join(root,'../../node_modules/@types')]},files:[fixture]}));run(process.execPath,[createRequire(import.meta.url).resolve('typescript/bin/tsc'),'-p',tsconfig],{timeout:30000});ok('external fixture and budget typecheck against the actual installed Pi API');
 await writeFile(join(agent,'settings.json'),JSON.stringify({enableInstallTelemetry:false,compaction:{enabled:false},retry:{enabled:false,maxRetries:0},defaultProjectTrust:'never'}));
 const models=dry?join(work,'test-models.json'):argument('--models');
 if(dry)await writeFile(models,JSON.stringify({providers:{cafe:{api:'openai-responses',baseUrl:'https://example.invalid/v1',apiKey:'NON_SECRET_TEST_KEY',models:[{id:'gpt-6-astra',contextWindow:128000,reasoning:true,thinkingLevelMap:{off:null,minimal:null,low:'low'}}]}}}));
 stage='relay';await free(37983);
 const relay=await launch(binary,[`--instance=${nonce}`],{marker:nonce,cwd:work,env:{SystemRoot:process.env.SystemRoot,PATH:'',PI_COLLAB_HOST:'127.0.0.1',PI_COLLAB_PORT:'37983',PI_COLLAB_HOST_TOKEN:'r18-host-token',PI_COLLAB_CLIENT_TOKEN:'r18-client-token'}});owned.push(relay);
 assert.ok((await audit(work)).listeners.some(p=>p.LocalPort===37983&&p.OwningProcess===relay.child.pid));
 await until(async()=>{try{return(await fetch('http://127.0.0.1:37983/healthz',{signal:AbortSignal.timeout(400)})).ok;}catch{return false;}},'relay ready');
 stage='Pi readiness';
 const pi=await launch(process.execPath,[join(piRoot,'dist/cli.js'),'--mode','rpc','--offline','--no-extensions','-e',pkg,'-e',fixture,'--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-approve','--no-builtin-tools','--tools','r18_external_probe','--provider','cafe','--model','gpt-6-astra','--thinking','low','--session-dir',sessions,'--name','R18 isolated external'],{marker:sessions,cwd:project,env:{...baseEnv(),USERPROFILE:join(work,'home'),APPDATA:join(work,'home'),LOCALAPPDATA:join(work,'home'),TEMP:join(work,'temp'),TMP:join(work,'temp'),PI_CODING_AGENT_DIR:agent,PI_OFFLINE:'1',PI_TELEMETRY:'0',R18_PI_ROOT:piRoot,R18_SOURCE_MODELS:models,R18_EXTERNAL_DRY_RUN:dry?'1':'0',R18_EXTERNAL_LEDGER:dry?join(work,'dry-once.jsonl'):authorization,PI_COLLAB_ENABLED:'1',PI_COLLAB_RELAY_URL:'ws://127.0.0.1:37983/ws',PI_COLLAB_ROOM:'r18-native',PI_COLLAB_PEER_ID:'r18-native-pi',PI_COLLAB_HOST_TOKEN:'r18-host-token',PI_COLLAB_CLIENT_TOKEN:'r18-client-token'}});owned.push(pi);rpc=new RPC(pi.child);
 await rpc.wait(e=>e.type==='extension_ui_request'&&e.message==='R18_EXTERNAL_READY','external fixture ready',30000);
 const state=await rpc.call('get_state');assert.equal(state.model.provider,'cafe');assert.equal(state.model.id,'gpt-6-astra');assert.equal(state.thinkingLevel,'low');report.thinkingLevel='low';assert.equal(dirname(state.sessionFile),sessions);
 stage='Chrome';await free(9333);
 const chromeProcess=await launch(chrome,[`--user-data-dir=${profile}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=9333','--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--metrics-recording-only','about:blank'],{marker:profile,cwd:work,env:baseEnv()});owned.push(chromeProcess);
 assert.ok((await audit(work)).listeners.some(p=>p.LocalPort===9333&&p.OwningProcess===chromeProcess.child.pid));
 const version=await until(async()=>{try{return await(await fetch('http://127.0.0.1:9333/json/version',{signal:AbortSignal.timeout(400)})).json();}catch{return false;}},'Chrome CDP');report.chrome=version.Browser;browser=await new CDP(version.webSocketDebuggerUrl).open();const target=await browser.send('Target.createTarget',{url:'about:blank'});const targets=await(await fetch('http://127.0.0.1:9333/json/list',{signal:AbortSignal.timeout(3000)})).json();page=await new CDP(targets.find(t=>t.id===target.targetId&&t.type==='page').webSocketDebuggerUrl).open();
 const errors=[],externalRequests=[],commands=[];
 page.on('Runtime.exceptionThrown',()=>errors.push('runtime exception'));page.on('Runtime.consoleAPICalled',e=>{if(e.type==='error')errors.push('console error');});page.on('Log.entryAdded',e=>{if(e.entry.source==='security')errors.push('security log');});page.on('Network.loadingFailed',e=>{if(!e.canceled)errors.push('network failure');});page.on('Network.responseReceived',e=>{if(e.response.status>=400)errors.push('HTTP error');});
 page.on('Network.requestWillBeSent',e=>{if(/^https?:/.test(e.request.url)&&!e.request.url.startsWith('http://127.0.0.1:37983/'))externalRequests.push('external page request');});page.on('Network.webSocketFrameSent',e=>{try{const m=JSON.parse(e.response.payloadData);if(m.type==='command')commands.push(m);}catch{}});
 for(const name of ['Page','Runtime','Log','Network'])await page.send(name+'.enable');
 await page.send('Page.addScriptToEvaluateOnNewDocument',{source:"window.__r18Csp=0;document.addEventListener('securitypolicyviolation',()=>window.__r18Csp++);"});await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await page.send('Page.navigate',{url:'http://127.0.0.1:37983/#/'});
 const {evaluate,click,input,send}=controls(page);await click('English');await input('Client token','r18-client-token');await input('Room','r18-native');await click('Connect');await until(()=>evaluate(`!!document.querySelector('textarea')&&!document.querySelector('textarea').disabled`),'host authority');
 ok('isolated native Pi/AgentSession and real Chrome ready; no request sent before arming');
 stage='authorized model operation';
 const settled=rpc.wait(e=>e.type==='agent_settled','external agent settled',60000);const armed=rpc.wait(e=>e.type==='extension_ui_request'&&e.message==='R18_EXTERNAL_ARMED','budget armed');
 watchdog=setTimeout(()=>{void rpc.call('abort').catch(()=>{});},60000);
 await rpc.call('prompt',{message:'/r18-external-arm'});await armed;
 await send('Call r18_external_probe exactly once with marker R18_ONLY. After its result, reply with exactly R18_EXTERNAL_OK. This is a synthetic acceptance test.');await settled;clearTimeout(watchdog);
 const stats=rpc.wait(e=>e.type==='extension_ui_request'&&e.message?.startsWith('R18_EXTERNAL_STATS:'),'budget accounting');await rpc.call('prompt',{message:'/r18-external-stats'});report.budget=JSON.parse((await stats).message.slice('R18_EXTERNAL_STATS:'.length));
 assert.equal(report.budget.dry,dry);assert.equal(report.budget.failed,false);assert.equal(report.budget.calls,2);assert.equal(report.budget.requests,2);assert.deepEqual(report.budget.statuses,[200,200]);assert.equal(report.budget.tools,1);assert.equal(report.budget.closed,true);assert.ok(report.budget.elapsedMs<60000);assert.deepEqual(report.budget.completions.map(c=>c.stopReason),['toolUse','stop']);assert.ok(report.budget.completions.every(c=>c.outputTokens>0&&c.outputTokens<=1024));
 const messages=(await rpc.call('get_messages')).messages;const assistants=messages.filter(m=>m.role==='assistant');const tool=assistants[0].content.find(p=>p.type==='toolCall');assert.ok(tool);const results=messages.filter(m=>m.role==='toolResult');assert.equal(results.length,1);assert.equal(results[0].toolCallId,tool.id);assert.equal(results[0].content[0].text,'R18_TOOL_OK');assert.equal(assistants[1].content.filter(p=>p.type==='text').map(p=>p.text).join('').trim(),'R18_EXTERNAL_OK');
 ok(dry?'dry fake HTTP responses passed through the real Responses SDK and native tool loop (not external evidence)':'two external Responses requests completed through native AgentSession; one controlled tool executed locally');
 stage='browser projection';await until(()=>evaluate(`document.querySelector('[role="log"]')?.textContent.includes('R18_EXTERNAL_OK')&&document.querySelectorAll('[data-tool-id]').length===1`),'external DOM');assert.equal(await evaluate(`document.querySelector('[data-tool-id]').getAttribute('data-tool-id')`),tool.id);assert.equal(await evaluate(`document.querySelector('[data-tool-id]').textContent.includes('R18_TOOL_OK')`),true);
 assert.equal(commands.filter(m=>m.payload.name==='prompt').length,1);report.browserPromptCount=1;report.browserErrors=errors;report.pageExternalRequests=externalRequests;assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);assert.equal(await evaluate('window.__r18Csp'),0);
 await page.send('Page.reload',{ignoreCache:true});await until(()=>evaluate(`document.querySelector('[role="log"]')?.textContent.includes('R18_EXTERNAL_OK')&&document.querySelectorAll('[data-tool-id]').length===1`),'reload persisted real parts');assert.equal((await rpc.call('get_messages')).messages.filter(m=>m.role==='user').length,1);assert.equal(commands.filter(m=>m.payload.name==='prompt').length,1);
 for(const [width,height] of [[1440,900],[1024,768],[390,844]]){await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<768});await delay(100);assert.equal(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),true);}
 ok('real Chrome preserves actual tool-call identity, result and final text across reload, without prompt replay or browser external requests');
 report.status='passed';
}catch(error){failure=true;report.status='failed';report.failureStage=stage;if(dry){report.error=String(error);report.rpcEvents=rpc?.events;report.diagnostics=owned.map(p=>({exitCode:p.child.exitCode,stderr:p.stderr()}));console.error(report.error);console.error(JSON.stringify(report.diagnostics));}else console.error('External acceptance failed at '+stage+'; private diagnostics suppressed');}
finally{
 clearTimeout(watchdog);let clean=true;
 if(rpc){try{await rpc.call('abort');if(!report.budget){const stats=rpc.wait(e=>e.type==='extension_ui_request'&&e.message?.startsWith('R18_EXTERNAL_STATS:'),'final accounting');await rpc.call('prompt',{message:'/r18-external-stats'});report.budget=JSON.parse((await stats).message.slice('R18_EXTERNAL_STATS:'.length));}await rpc.call('prompt',{message:'/r18-external-shutdown'});}catch{}}
 try{if(browser)await browser.send('Browser.close').catch(()=>{});}catch{}page?.close();browser?.close();rpc?.dispose();
 for(const process of owned.reverse()){try{await process.stop();}catch{clean=false;}}
 try{report.after=await audit(work);assert.deepEqual(report.after.remaining,[]);assert.equal(report.after.listeners.some(p=>[37983,9333].includes(p.LocalPort)),false);assert.deepEqual(report.after.listeners,report.before.listeners);}catch{clean=false;}
 report.cleanedProcesses=clean;report.externalModel=!dry&&(report.budget?.requests??0)>0;
 await writeFile(join(reports,(dry?'dry':'external')+'-latest.json'),JSON.stringify(report,null,2));await writeFile(join(reports,work.split(/[\\/]/).at(-1)+'.json'),JSON.stringify(report,null,2));
 if(clean)await rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:300});else throw Error('Unproven cleanup; isolated work retained');
}
if(failure)throw Error('Acceptance failed; inspect the redacted report. Never automatically repeat an external run.');
