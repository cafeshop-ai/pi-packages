import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import WebSocket from 'ws';
import { audit, until } from './native-support.mjs';
export async function verifyManual(root) {
  const config=JSON.parse(await readFile(join(root,'credentials.json'),'utf8'));
  const ready=await until(async()=>{try{return JSON.parse(await readFile(join(root,'ready.json'),'utf8'));}catch{return false;}},'native interactive Pi',45000);
  assert.equal(ready.interactive,true);assert.equal(ready.provider,'cafe');assert.equal(ready.model,'gpt-6-astra');assert.equal(ready.cwd.toLowerCase(),join(root,'project').toLowerCase());
  const ws=new WebSocket('ws://127.0.0.1:37983/ws',{handshakeTimeout:5000});const messages=[];ws.on('error',()=>{});ws.on('message',data=>{if(messages.length<100)messages.push(JSON.parse(data.toString()));});
  let snapshot;
  try{await once(ws,'open');ws.send(JSON.stringify({type:'hello',protocolVersion:1,peerRole:'client',peerId:'manual-readonly-verifier',roomId:config.room,token:config.clientToken}));const item=await until(()=>messages.find(m=>m.type==='snapshot'&&m.hostId===config.peer),'real Pi host snapshot');snapshot=item.snapshot;assert.equal(snapshot.sessionId,ready.sessionId);assert.equal(snapshot.model.provider,'cafe');assert.equal(snapshot.model.id,'gpt-6-astra');assert.equal(snapshot.cwd.toLowerCase(),ready.cwd.toLowerCase());}finally{ws.terminate();}
  const identity=await audit(root);
  const installed=await import(pathToFileURL(join(config.package,'scripts/relay-path.mjs')).href);const binary=await installed.relayBinary(config.package);
  const owners=JSON.parse(await readFile(join(root,'service-owners.json'),'utf8'));
  assert.ok(owners.some(p=>p.role==='relay'&&p.record.executable.toLowerCase()===binary.toLowerCase()&&identity.listeners.some(l=>l.LocalPort===37983&&l.OwningProcess===p.record.pid)));
  assert.ok(owners.some(p=>p.role==='chrome'&&identity.listeners.some(l=>l.LocalPort===9333&&l.OwningProcess===p.record.pid)));
  const report={ready:true,interactive:true,provider:ready.provider,model:ready.model,thinkingLevel:snapshot.thinkingLevel,phase:snapshot.phase,sessionId:snapshot.sessionId,cwd:snapshot.cwd,messageCount:snapshot.messages.length,toolCount:snapshot.tools.length,url:'http://127.0.0.1:37983/',modelRequestSentByInstaller:false,processAudit:identity};
  await writeFile(join(root,'manual-ready-report.json'),JSON.stringify(report,null,2));return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){await verifyManual(resolve(process.argv[2]));console.log('PASS: installed native interactive Pi, authenticated Go snapshot and owned listeners; no prompt sent');}
