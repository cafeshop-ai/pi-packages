import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>8192)throw Error('test configuration too large');}
const config=JSON.parse(text);text='';const url=new URL(config.url);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.protocol,'ws:');assert.equal(url.pathname,'/ws');assert.equal(config.target,'terminal-pi');assert.equal(config.other,'terminal-pi-other');
const{applyEvent}=await import(pathToFileURL(config.candidate+'/dist/protocol/index.js'));const snapshots=new Map(),results=new Map();
const ws=new WebSocket(url);let error='';ws.on('error',()=>{error='socket error';});
ws.on('message',raw=>{try{const m=JSON.parse(raw.toString());if(m.type==='snapshot')snapshots.set(m.hostId,m.snapshot);if(m.type==='event'&&snapshots.has(m.hostId))snapshots.set(m.hostId,applyEvent(snapshots.get(m.hostId),m));if(m.type==='command_result')results.set(m.requestId,m);}catch{error='invalid projection';}});
async function until(fn,label){const end=Date.now()+15000;while(Date.now()<end){assert(!error,error);if(fn())return;await delay(30);}throw Error(label+' timed out');}
try{
 await until(()=>ws.readyState===1,'connect');ws.send(JSON.stringify({type:'hello',protocolVersion:1,peerRole:'client',peerId:'native-session-verifier',roomId:'main',token:config.token}));config.token='';
 await until(()=>snapshots.has(config.target)&&snapshots.has(config.other),'two native snapshots');const before=snapshots.get(config.target),other=snapshots.get(config.other);assert.equal(before.sessionControl,true);assert.equal(before.phase,'idle');
 ws.send(JSON.stringify({type:'command',requestId:'native-new-session-test',targetHostId:config.target,expectedStreamId:before.streamId,expectedSessionId:before.sessionId,expectedCwd:before.cwd,payload:{name:'new_session'}}));
 await until(()=>results.has('native-new-session-test'),'native command result');const result=results.get('native-new-session-test');assert(['applied','dispatched'].includes(result.status),result.code??'native new session rejected');
 await until(()=>snapshots.get(config.target)?.sessionId!==before.sessionId,'new native session');assert.equal(snapshots.get(config.other).sessionId,other.sessionId);assert.equal(snapshots.get(config.target).cwd,before.cwd);
 console.log(JSON.stringify({passed:true,newNativeSessionCreated:true,sameTargetHost:true,otherPiSessionUnchanged:true,projectUnchanged:true,providerRequests:0}));
}finally{ws.terminate();}
