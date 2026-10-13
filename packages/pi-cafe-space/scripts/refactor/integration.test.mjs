import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { JSDOM, VirtualConsole } from 'jsdom';
import WebSocket from 'ws';
import { root, run, sha } from './build.mjs';
import { stageRelease } from './release.mjs';
import { relayBinary } from './candidate-overrides/scripts/relay-path.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,label,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){const value=await predicate();if(value)return value;await delay(20);}throw Error(`Timed out: ${label}`);}
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
class Peer{
 constructor(url){this.messages=[];this.code=null;this.ws=new WebSocket(url);this.ws.on('message',bytes=>{if(this.messages.length>=2500)throw Error('Test peer queue exceeded bound');this.messages.push(JSON.parse(bytes.toString()));});this.ws.on('error',()=>{});this.closed=new Promise(resolve=>this.ws.once('close',code=>{this.code=code;resolve(code);}));}
 async hello(role,id){await once(this.ws,'open');const welcome=this.wait(m=>m.type==='welcome');this.send({type:'hello',protocolVersion:1,peerRole:role,peerId:id,roomId:'fixture',token:role==='host'?'fixture-host':'fixture-client'});await welcome;return this;}
 send(message){this.ws.send(JSON.stringify(message));}
 wait(predicate){return until(()=>{const index=this.messages.findIndex(predicate);if(index>=0)return this.messages.splice(index,1)[0];},'peer message');}
 end(){this.ws.terminate();}
}
test('fresh embedded Go + actual compiled React bundle: hosts, ordered parts, fenced command, cached history, reconnect, sequence and transport bounds', {timeout:100000},async()=>{
 const {target,metadata}=await stageRelease();const binary=await relayBinary(target);const fixture=JSON.parse(await readFile(join(root,'protocol/fixtures/parts/ordered.json'),'utf8'));
 const identity=JSON.parse(run(binary,['--version']));assert.equal(identity.webDigest,metadata.webDigest);
 const directory=await mkdtemp(join(root,'.refactor/integration-'));const port=await freePort();const base=`http://127.0.0.1:${port}`;const peers=[];const browserSockets=new Set();let dom;const browserErrors=[];
 const child=spawn(binary,[],{cwd:directory,env:{SystemRoot:process.env.SystemRoot,PATH:'',PI_COLLAB_HOST:'127.0.0.1',PI_COLLAB_PORT:String(port),PI_COLLAB_HOST_TOKEN:'fixture-host',PI_COLLAB_CLIENT_TOKEN:'fixture-client'},stdio:'ignore'});
 const connect=async(role,id)=>{const peer=new Peer(base.replace('http:','ws:')+'/ws');peers.push(peer);return peer.hello(role,id);};
 try{
  await until(async()=>{if(child.exitCode!==null)throw Error('Owned binary exited');try{return(await fetch(base+'/healthz',{signal:AbortSignal.timeout(300)})).ok;}catch{return false;}},'fresh binary ready');
  let host=await connect('host','h1');const other=await connect('host','h2');const observer=await connect('client','observer');
  let pending=observer.wait(m=>m.type==='snapshot'&&m.hostId==='h1');host.send({type:'snapshot',snapshot:fixture.initial});await pending;
  pending=observer.wait(m=>m.type==='snapshot'&&m.hostId==='h2');other.send({type:'snapshot',snapshot:{...fixture.initial,streamId:'stream2',sessionId:'session2',cwd:'C:/other-synthetic',phase:'idle'}});await pending;
  for(const event of fixture.events){pending=observer.wait(m=>m.type==='event'&&m.hostId==='h1'&&m.seq===event.seq);host.send(event);await pending;}
  const seq=fixture.expectedFinal.lastEventSeq+1;pending=observer.wait(m=>m.type==='event'&&m.hostId==='h1'&&m.seq===seq);host.send({type:'event',streamId:'stream',sessionId:'session',seq,emittedAt:'synthetic',event:{kind:'session_state',phase:'idle',hasPendingMessages:false}});await pending;
  const final={...fixture.expectedFinal,phase:'idle',lastEventSeq:seq};
  const reconnect=await connect('client','fresh');assert.deepEqual((await reconnect.wait(m=>m.type==='snapshot'&&m.hostId==='h1')).snapshot,final);
  const duplicateError=host.wait(m=>m.type==='error'&&m.code==='EVENT_SEQUENCE');host.send(fixture.events[0]);await duplicateError;assert.equal(await host.closed,1011);
  const duplicate=await connect('client','duplicate');assert.deepEqual((await duplicate.wait(m=>m.type==='snapshot'&&m.hostId==='h1')).snapshot,final);duplicate.end();reconnect.end();
  host=await connect('host','h1');pending=observer.wait(m=>m.type==='snapshot'&&m.hostId==='h1');host.send({type:'snapshot',snapshot:final});await pending;
  // Execute the exact JS returned by this binary, not a separately imported App
  // or mocked transport. jsdom is not a geometry/CSP/real-Chrome substitute.
  const html=await(await fetch(base+'/')).text();const script=/src="(\/assets\/[^\"]+\.js)"/.exec(html)[1];const bytes=Buffer.from(await(await fetch(base+script)).arrayBuffer());
  const manifest=JSON.parse(await readFile(join(root,'relay/internal/webui/assets/asset-manifest.json'),'utf8'));assert.equal(sha(bytes),manifest.entries.find(e=>'/'+e.name===script).sha256);
  const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>browserErrors.push(error.message));
  dom=new JSDOM(html,{url:base+'/#/rooms/fixture',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole});
  const window=dom.window;window.TextEncoder=TextEncoder;window.TextDecoder=TextDecoder;
  window.sessionStorage.setItem('pi-collab-room','other-cached-room');
  // jsdom omits standard browser Web Streams; supply Node's actual WHATWG
  // implementations, not mocked application/runtime/transport behavior.
  window.TransformStream=TransformStream;window.ReadableStream=ReadableStream;window.WritableStream=WritableStream;
  const OriginalSocket=window.WebSocket;
  window.WebSocket=class extends OriginalSocket{constructor(...args){super(...args);browserSockets.add(this);}};
  window.eval(bytes.toString('utf8'));
  const button=text=>[...window.document.querySelectorAll('button')].find(node=>node.getAttribute('aria-label')===text||node.textContent.trim()===text);
  (await until(()=>button('English'),'language')).click();
  const input=(selector,value)=>{const node=window.document.querySelector(selector);assert.ok(node,selector);const proto=node.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(node,value);node.dispatchEvent(new window.Event('input',{bubbles:true}));return node;};
  await until(()=>window.document.querySelector('[aria-label="Client token"]'),'login');assert.equal(window.document.querySelector('input[aria-label="Room"]'),null);input('[aria-label="Client token"]','fixture-client');button('Connect').click();
  const hostButton=await until(()=>[...window.document.querySelectorAll('button')].find(n=>n.querySelector('strong')?.textContent==='h1'),'host selection');hostButton.click();
  const message=await until(()=>window.document.querySelector('[data-source-id="a1"]'),'ordered message');
  const first=[...message.querySelectorAll('p')].find(n=>n.textContent==='先检查');const middle=[...message.querySelectorAll('p')].find(n=>n.textContent==='再检查');const last=[...message.querySelectorAll('p')].find(n=>n.textContent==='检查结束');
  const t1=message.querySelector('[data-tool-id="t1"]');const t2=message.querySelector('[data-tool-id="t2"]');
  for(const [before,after] of [[first,t1],[t1,middle],[middle,t2],[t2,last]]){assert.ok(before&&after);assert.ok(before.compareDocumentPosition(after)&window.Node.DOCUMENT_POSITION_FOLLOWING);}
  assert.match(t1.textContent,/Empty output/);assert.match(t2.textContent,/Failed/);assert.equal(message.querySelectorAll('[data-tool-id]').length,2);
  await until(()=>window.document.querySelector('textarea[aria-label="Message"]'),'composer');const composer=input('textarea[aria-label="Message"]','synthetic end-to-end prompt');
  await until(()=>button('Send')&&!button('Send').disabled,'send enabled after input commit');
  const routed=host.wait(m=>m.type==='routed_command'&&m.payload.name==='prompt');composer.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  const command=await routed;assert.equal(command.targetHostId,'h1');assert.equal(command.expectedStreamId,'stream');assert.equal(command.expectedSessionId,'session');assert.equal(command.expectedCwd,'C:/synthetic');assert.equal(command.payload.content,'synthetic end-to-end prompt');assert.ok(!other.messages.some(m=>m.type==='routed_command'));
  host.send({type:'host_command_result',relayRequestId:command.relayRequestId,status:'dispatched',code:null,message:null});await until(()=>composer.value==='','ack clears draft');
  assert.ok(!window.location.href.includes('fixture-client'));assert.equal(window.document.querySelectorAll('[data-tool-id]').length,2);
  const oldSocket=[...browserSockets].at(-1);oldSocket.close(1000,'synthetic reconnect');await until(()=>browserSockets.size>=2&&[...browserSockets].at(-1).readyState===1,'browser reconnect');await until(()=>window.document.querySelector('[data-tool-id="t1"]')&&!window.document.querySelector('textarea')?.disabled,'reconnect parts and authority');assert.equal(window.document.querySelectorAll('[data-tool-id]').length,2);
  assert.ok(!host.messages.some(m=>m.type==='routed_command'&&m.payload.name==='prompt'),'reconnect must not replay a write');
  const archived='saved/%2F:id';const sessions={kind:'sessions',currentSessionId:'session',sessions:[{sessionId:archived,name:'Archived',cwd:'C:/synthetic',created:'2026-01-01',modified:'2026-01-01',messageCount:3,firstMessage:''}],historyTruncated:false};
  const history={kind:'session',sessionId:archived,name:'Archived',cwd:'C:/synthetic',activeLeafId:null,model:null,thinkingLevel:'off',messages:final.messages,historyTruncated:false,modified:'2026-01-01'};
  for(const [name,data] of [['list_sessions',sessions],['get_session',history]]){
   const requestId='cache-'+name;const reply=observer.wait(m=>m.type==='command_result'&&m.requestId===requestId);const route=host.wait(m=>m.type==='routed_command'&&m.clientRequestId===requestId);
   observer.send({type:'command',requestId,targetHostId:'h1',expectedStreamId:'stream',expectedSessionId:'session',expectedCwd:'C:/synthetic',payload:{name,...(name==='get_session'?{sessionId:archived}:{})}});
   host.send({type:'host_command_result',relayRequestId:(await route).relayRequestId,status:'applied',code:null,message:null,data});assert.equal((await reply).status,'applied');
  }
  pending=observer.wait(m=>m.type==='host_status'&&m.hosts?.some(h=>h.hostId==='h1'&&!h.connected));host.ws.close();await pending;
  await until(()=>button('Load history')&&!button('Load history').disabled,'history button');button('Load history').click();const archivedLink=await until(()=>[...window.document.querySelectorAll('a')].find(n=>n.getAttribute('aria-label')==='Archived'),'offline cached list');archivedLink.click();
  await until(()=>window.document.body.textContent.includes('Read-only history'),'offline cached detail');assert.equal(window.document.querySelector('textarea'),null);assert.equal(window.document.querySelectorAll('[data-tool-id]').length,2);
  assert.equal(window.location.hash,'#/rooms/fixture/history/saved%2F%252F%3Aid');assert.equal(window.sessionStorage.getItem('pi-collab-room'),'fixture');assert.deepEqual(browserErrors,[]);
  const oldRoomSocket=[...browserSockets].at(-1);window.location.hash='#/rooms/empty-room';
  await until(()=>window.sessionStorage.getItem('pi-collab-room')==='empty-room'&&window.document.body.textContent.includes('Select a host'),'URL room switch');
  assert.equal(window.document.querySelectorAll('[data-tool-id]').length,0);assert.equal(window.document.querySelector('textarea'),null);
  await until(()=>oldRoomSocket.readyState===3,'previous room disconnected');
  button('Log out').click();await until(()=>window.document.querySelector('[aria-label="Client token"]'),'room logout');assert.equal(window.location.hash,'#/rooms/empty-room');assert.equal(window.sessionStorage.getItem('pi-collab-token'),null);
  for(const ws of browserSockets)ws.close();window.close();dom=null;
  const badSequence=other.wait(m=>m.type==='error'&&m.code==='EVENT_SEQUENCE');other.send({type:'event',streamId:'wrong-stream',sessionId:'session2',seq:1,emittedAt:'synthetic',event:{kind:'notice',level:'info',message:'wrong scope'}});await badSequence;assert.equal(await other.closed,1011);
  host=await connect('host','h1');pending=observer.wait(m=>m.type==='snapshot'&&m.hostId==='h1');host.send({type:'snapshot',snapshot:final});await pending;
  const oversized=await connect('client','oversize');oversized.ws.send('x'.repeat(262145));assert.equal(await oversized.closed,1009);
  const slow=await connect('client','slow');await slow.wait(m=>m.type==='snapshot'&&m.hostId==='h1');slow.ws._socket.pause();
  for(let index=1;index<=900;index++){
   const next=seq+index;const received=observer.wait(m=>m.type==='event'&&m.seq===next&&m.hostId==='h1');host.send({type:'event',streamId:'stream',sessionId:'session',seq:next,emittedAt:'synthetic',event:{kind:'notice',level:'info',message:'x'.repeat(16384)}});await received;
  }
  assert.equal((await fetch(base+'/healthz')).status,200);slow.ws._socket.resume();await until(()=>slow.code!==null,'slow client bounded close',10000);assert.ok([1006,1013].includes(slow.code));
  const after=await connect('client','after-pressure');assert.equal((await after.wait(m=>m.type==='snapshot'&&m.hostId==='h1')).snapshot.lastEventSeq,seq+900);
  assert.equal(child.exitCode,null);console.log(`Verified binary ${identity.platform}, Web ${identity.webDigest}; actual bundle, owned synthetic peers, no Pi/provider/Chrome.`);
 }finally{
  for(const ws of browserSockets){try{ws.close();}catch{}}dom?.window.close();for(const peer of peers){peer.ws._socket?.resume();peer.end();}
  if(child.exitCode===null){const stopped=once(child,'exit');child.kill();await stopped;}await rm(directory,{recursive:true,force:true});
 }
});
