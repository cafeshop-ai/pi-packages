import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
// Legacy device-access diagnostic: explicit target and credential path only.
const {values}=parseArgs({options:{report:{type:'string'},mode:{type:'string'},browser:{type:'string'},credentials:{type:'string'},device:{type:'string'},origin:{type:'string'}},strict:true});
assert(values.credentials&&isAbsolute(values.credentials)&&values.device,'Pass --credentials /absolute/path and --device NAME for the intended legacy device');
const origin=values.origin||'https://space.cafecode.work';
const {accessToken}=JSON.parse(await readFile(values.credentials,'utf8'));
const modes=values.mode?[values.mode]:['relay','direct','turn-udp','turn-tcp'];
for(const mode of modes)assert(['relay','direct','turn-udp','turn-tcp'].includes(mode));
let browser;const results=[];let activeMode='';
try{
 browser=await chromium.launch({executablePath:values.browser||'/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',headless:true,chromiumSandbox:true});
 for(const mode of modes){
  activeMode=mode;
  const context=await browser.newContext({viewport:{width:390,height:844},locale:'en-US',colorScheme:'dark'});
  try{
   await context.addInitScript(({mode})=>{
    const counters={types:{},connectedHosts:0,selected:null,unauthorizedWrites:0,iceErrors:[]};
    const pcs=[];window.__cafeTest={counters,pcs};
    const business=(raw)=>{try{const m=JSON.parse(raw);counters.types[m.type]=(counters.types[m.type]||0)+1;if(m.type==='host_status')counters.connectedHosts=Math.max(counters.connectedHosts,(m.hosts||[]).filter(h=>h.connected).length);}catch{}};
    const OriginalWS=window.WebSocket;
    window.WebSocket=class extends OriginalWS{
     constructor(...args){super(...args);this.addEventListener('message',event=>{try{const f=JSON.parse(event.data);if(f.type==='selected')counters.selected=f.mode;if(f.type==='data')business(new TextDecoder().decode(Uint8Array.from(atob(f.payload),c=>c.charCodeAt(0))));}catch{}});}
     send(raw){try{const f=JSON.parse(raw);if(f.type==='data'){const m=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(f.payload),c=>c.charCodeAt(0))));if(m.type==='remote.control'||m.type==='remote.workspace'||m.payload?.name==='prompt')counters.unauthorizedWrites++;}}catch{}return super.send(raw);}
    };
    const OriginalPC=window.RTCPeerConnection;
    window.RTCPeerConnection=class extends OriginalPC{
     constructor(config){
      if(mode==='direct')config={...config,iceServers:[]};
      if(mode.startsWith('turn-'))config={...config,iceTransportPolicy:'relay',iceServers:(config.iceServers||[]).map(s=>({...s,urls:(Array.isArray(s.urls)?s.urls:[s.urls]).filter(u=>u.startsWith('turn:')&&u.endsWith('transport='+mode.slice(5)))})).filter(s=>s.urls.length)};
      super(config);pcs.push(this);
      this.addEventListener('icecandidateerror',e=>counters.iceErrors.push(e.errorCode));
     }
     createDataChannel(...args){const dc=super.createDataChannel(...args);let bytes=null,total=0;
      dc.addEventListener('message',event=>{try{if(!(event.data instanceof ArrayBuffer))return;const v=new DataView(event.data);if(v.getUint32(0)!==0x50434431)return;const offset=v.getUint32(12);if(offset===0){total=v.getUint32(8);if(total>262144)return;bytes=new Uint8Array(total);}if(!bytes)return;bytes.set(new Uint8Array(event.data,16),offset);if(offset+event.data.byteLength-16===total){business(new TextDecoder().decode(bytes));bytes=null;}}catch{}});
      const send=dc.send.bind(dc);dc.send=data=>{try{if(data instanceof ArrayBuffer){const v=new DataView(data);if(v.getUint32(12)===0&&v.getUint32(8)===data.byteLength-16){const m=JSON.parse(new TextDecoder().decode(new Uint8Array(data,16)));if(m.type==='remote.control'||m.type==='remote.workspace'||m.payload?.name==='prompt')counters.unauthorizedWrites++;}}}catch{}return send(data);};return dc;
     }
    };
   },{mode});
   const page=await context.newPage();page.setDefaultTimeout(20000);
   await page.goto(origin+'/#/rooms/main');await page.getByRole('button',{name:'English',exact:true}).click();
   await page.getByLabel('Access key',{exact:true}).fill(accessToken);
   await page.getByRole('button',{name:'Find my computers',exact:true}).click();
   await page.getByRole('button').filter({hasText:values.device}).filter({hasText:'Online'}).waitFor();
   await page.getByRole('combobox',{name:'Connection',exact:true}).click();
   await page.getByRole('option',{name:mode==='relay'?'Cloud relay':'WebRTC / TURN only',exact:true}).click();
   await page.getByRole('button',{name:'Connect to computer',exact:true}).click();
   const end=Date.now()+35000;let observed;
   while(Date.now()<end){
    observed=await page.evaluate(async()=>{
     const {counters,pcs}=window.__cafeTest;const pairs=[];
     for(const pc of pcs){const stats=await pc.getStats();let pair;stats.forEach(s=>{if(s.type==='transport'&&s.selectedCandidatePairId)pair=stats.get(s.selectedCandidatePairId);});
      if(pair){const local=stats.get(pair.localCandidateId),remote=stats.get(pair.remoteCandidateId);pairs.push({state:pc.connectionState,localType:local?.candidateType,remoteType:remote?.candidateType,relayProtocol:local?.relayProtocol,protocol:local?.protocol,bytesSent:pair.bytesSent,bytesReceived:pair.bytesReceived});}
     }
     return {counters,pairs,overflow:document.documentElement.scrollWidth>innerWidth+1};
    });
    if(observed.counters.types.welcome&&observed.counters.types.host_status&&observed.counters.connectedHosts>0)break;
    await delay(250);
   }
   assert(observed?.counters.types.welcome,'authenticated business welcome not received');assert(observed.counters.connectedHosts>0,'no connected Pi in authoritative inventory');assert.equal(observed.counters.unauthorizedWrites,0);
   assert.equal(observed.counters.selected,mode==='relay'?'relay':'webrtc');
   if(mode!=='relay'){
    const pair=observed.pairs.find(p=>p.state==='connected');assert(pair,'ICE pair missing');assert(pair.bytesReceived>0&&pair.bytesSent>0);
    if(mode==='direct'){assert.notEqual(pair.localType,'relay');assert.notEqual(pair.remoteType,'relay');}
    else {assert.equal(pair.localType,'relay');assert.equal(pair.relayProtocol,mode.slice(5));}
   }
   const result={mode,passed:true,...observed};results.push(result);console.log(JSON.stringify(result));
  }finally{await context.close();}
 }
 const report={passed:true,results,browser:await browser.version(),origin,providerRequests:0,promptsSent:0,controlTaken:false,scope:'real production HTTPS signaling and Mac device; forced TURN uses public server; direct case is browser and Pi on same Mac, not cellular or a second physical device'};
 if(values.report){await mkdir(values.report,{recursive:true});await writeFile(values.report+'/result.json',JSON.stringify(report,null,2));}console.log(JSON.stringify({allPassed:true,modes:results.map(r=>r.mode)}));
}catch(error){
 const failure={passed:false,mode:activeMode,results,errorName:error.name,error:String(error.message).split('\n')[0].slice(0,240),providerRequests:0};
 if(values.report){await mkdir(values.report,{recursive:true});await writeFile(values.report+'/result.json',JSON.stringify(failure,null,2));}console.error(JSON.stringify(failure));process.exitCode=1;
}finally{await browser?.close();}
