import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { controls } from './native-browser.mjs';
import { until, delay } from './native-support.mjs';
export async function dataAcceptance({page,rpc,peer,scope,project,work,sessions,report,ok}){
 const {evaluate,click,input,link}=controls(page);
 await click('Load files');await click('fixture.txt');await until(()=>evaluate(`document.querySelector('[aria-label="File preview"] pre')?.textContent===${JSON.stringify('R18 plain UTF-8 file\n')}`),'real file preview');
 const outside=join(work,'outside');await mkdir(outside);await writeFile(join(outside,'fixture.txt'),'Owned outside fixture');await symlink(outside,join(project,'linked'),'junction');await writeFile(join(project,'malformed.txt'),Buffer.from([0x61,0xff]));
 for(const [path,code] of [['.env','SENSITIVE_PATH'],['../outside/fixture.txt','PATH_NOT_ALLOWED'],['fixture.txt:stream','PATH_NOT_ALLOWED'],['malformed.txt','BINARY_FILE']]){
  const response=await peer.command(scope,{name:'read_file',path,offset:0});assert.equal(response.status,'rejected',path);assert.equal(response.code,code,path);
 }
 const linked=await peer.command(scope,{name:'read_file',path:'linked/fixture.txt',offset:0});assert.equal(linked.status,'rejected');assert.equal(linked.code,'PATH_NOT_ALLOWED');ok('actual native file preview, sensitive/traversal/ADS/UTF-8 and Windows junction rejection');
 const notification=rpc.wait(e=>e.type==='extension_ui_request'&&e.message?.startsWith('R18_HISTORY:'),'owned large history');await rpc.call('prompt',{message:'/r18-history'});const history=JSON.parse((await notification).message.slice('R18_HISTORY:'.length));
 assert.ok(history.file.startsWith(sessions));const bytes=(await stat(history.file)).size;assert.ok(bytes>1024*1024&&bytes<64*1024*1024);report.largeHistoryBytes=bytes;
 const listed=await peer.command(scope,{name:'list_sessions'});assert.equal(listed.status,'applied');assert.ok(listed.data.sessions.some(s=>s.sessionId===history.id));
 const result=await peer.command(scope,{name:'get_session',sessionId:history.id});assert.equal(result.status,'applied');assert.equal(result.data.sessionId,history.id);assert.equal(result.data.cwd,project);assert.equal(result.data.historyTruncated,true);assert.ok(result.data.messages.length>0&&result.data.messages.length<=100);assert.ok(Buffer.byteLength(JSON.stringify(result))<=262144);
 await click('Load history');await link('R18 large legal history');await until(()=>evaluate(`document.body.textContent.includes('Read-only history')&&!!document.querySelector('[data-source-id]')`),'actual readonly history');assert.equal(await evaluate(`document.querySelector('textarea')===null`),true);assert.equal((await rpc.call('get_state')).sessionId,scope.sessionId);ok('custom sessionDir, >1MiB legal native history, bounded truncation and browser read-only isolation');
 await link('Return to live conversation');await until(()=>evaluate(`!!document.querySelector('textarea')&&!document.querySelector('textarea').disabled`),'return live');
 // Native list uses readline (lone CR accepted); open uses LF JSONL. These
 // malformed, owned files deterministically exercise the opened identity and
 // cwd checks without mocking SessionManager or racing a user's session file.
 const header=(id,cwd)=>({type:'session',version:3,id,cwd,timestamp:new Date().toISOString()});
 const message={type:'message',id:'abcdef01',parentId:null,timestamp:new Date().toISOString(),message:{role:'user',content:'Owned malformed history fixture',timestamp:Date.now()}};
 for(const [id,openedId,openedCwd] of [['indexed-id','different-id',project],['indexed-cwd','indexed-cwd',outside]]){
  const file=join(sessions,id+'.jsonl');const content=JSON.stringify(header(id,project))+'\r'+JSON.stringify({type:'custom',customType:'r18-malformed'})+'\n'+JSON.stringify(header(openedId,openedCwd))+'\n'+JSON.stringify(message)+'\n';await writeFile(file,content);
  const list=await peer.command(scope,{name:'list_sessions'});assert.ok(list.data.sessions.some(s=>s.sessionId===id),'native index must expose intended test identity');
  const rejected=await peer.command(scope,{name:'get_session',sessionId:id});assert.equal(rejected.status,'rejected');assert.equal(rejected.code,'SESSION_INVALID');assert.equal(await readFile(file,'utf8'),content,'invalid opened file not rewritten');
 }
 ok('actual SessionManager index/open ID and cwd mismatch rejected, without mocks or timing races');
 const current=await peer.command(scope,{name:'get_session',sessionId:scope.sessionId});assert.equal(current.status,'applied');assert.ok(current.data.messages.some(m=>m.parts?.some(p=>p.type==='tool-call'&&p.toolCallId==='native-t1')));ok('persisted native ordered parts survive real history projection');
 await input('Message','old scoped draft');const newSnapshot=peer.wait(m=>m.type==='snapshot'&&m.snapshot.sessionId!==scope.sessionId);assert.equal((await rpc.call('new_session')).cancelled,false);const next=(await newSnapshot).snapshot;assert.notEqual(next.sessionId,scope.sessionId);
 await until(()=>evaluate(`document.querySelector('textarea')?.value===''&&!document.querySelector('textarea')?.disabled`),'new session draft/scope ready');
 const stale=await peer.command(scope,{name:'prompt',content:'MUST_NOT_REACH_PI'});assert.equal(stale.status,'rejected');assert.ok(['STALE_STREAM','STALE_SESSION'].includes(stale.code));assert.equal((await rpc.call('get_messages')).messages.some(m=>m.role==='user'&&JSON.stringify(m.content).includes('MUST_NOT_REACH_PI')),false);ok('real new_session changes authoritative scope, clears draft and rejects stale write');
 // Prime new-context readonly cache from the real host, then remove only its
 // own WebSocket connection with the documented extension command.
 assert.equal((await peer.command(next,{name:'list_sessions'})).status,'applied');assert.equal((await peer.command(next,{name:'get_session',sessionId:history.id})).status,'applied');
 const offline=peer.wait(m=>m.type==='host_status'&&m.hosts?.some(h=>h.hostId==='r18-native-pi'&&!h.connected));await rpc.call('prompt',{message:'/collab-disconnect'});await offline;
 await until(()=>evaluate(`document.querySelector('textarea')?.disabled===true`),'offline writes disabled');await click('Load history');await link('R18 large legal history');await until(()=>evaluate(`document.body.textContent.includes('Read-only history')&&!!document.querySelector('[data-source-id]')`),'offline cached native history');assert.equal(await evaluate(`document.querySelector('textarea')===null`),true);ok('actual native host offline: writes disabled, context-bound cached history readable');
 await delay(100);
}
