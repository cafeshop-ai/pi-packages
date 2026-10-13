import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { plainOrigin } from './install-client.mjs';
async function config(url){
 const response=await fetch(url,{cache:'no-store',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw Error('HTTP_'+response.status);const reader=response.body?.getReader();if(!reader)throw Error('EMPTY_RESPONSE');
 let size=0,parts=[];try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384){await reader.cancel();throw Error('RESPONSE_TOO_LARGE');}parts.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}const value=JSON.parse(new TextDecoder().decode(bytes));
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_RESPONSE');return value;
}
export async function diagnose(values){
 const origin=plainOrigin(values.server??'https://space.cafecode.work'),port=Number(values.port??37891);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid local port');
 const result={format:'pi-cafe-doctor-v1',server:origin,localURL:'http://127.0.0.1:'+port,checks:[],p2pVerified:false,roomOnlineVerified:false};
 for(const [name,url]of [['cloud',origin+'/api/config'],['local',result.localURL+'/api/config']]){
  try{const c=await config(url);result.checks.push({name,reachable:true,protocolVersion:c.protocolVersion,roomAccess:c.roomAccess===true,roomShare:c.roomShare===true,setupRequired:c.setupRequired===true});}
  catch(error){result.checks.push({name,reachable:false,error:error.cause?.code||error.message});}
 }
 if(values.config){if(!isAbsolute(values.config))throw Error('--config must be absolute');const s=await lstat(values.config);if(!s.isFile()||s.isSymbolicLink()||s.size>16384)throw Error('Invalid room config file');const c=JSON.parse(await readFile(values.config,'utf8'));const match=c.publicOrigin===origin&&c.cloudUrl===origin.replace(/^http/,'ws')+'/room/host'&&c.mode==='device'&&!c.deviceToken;
  result.checks.push({name:'roomConfig',matchesServer:match,webRTC:c.enableWebRTC===true});
  if(typeof c.roomIdentityFile==='string'&&isAbsolute(c.roomIdentityFile)){try{const i=await lstat(c.roomIdentityFile);result.checks.push({name:'roomIdentity',exists:true,regular:i.isFile()&&!i.isSymbolicLink(),privatePermissions:process.platform==='win32'?null:(i.mode&0o077)===0});}catch(e){if(e.code==='ENOENT')result.checks.push({name:'roomIdentity',exists:false});else throw e;}}
 }
 result.readyForManualRoomTest=result.checks.some(c=>c.name==='cloud'&&c.reachable&&c.roomAccess)&&result.checks.some(c=>c.name==='local'&&c.reachable&&c.roomShare);
 result.next=result.readyForManualRoomTest?'Open local page, sign in, choose Share room, confirm Online, then scan/copy URL and test password on a second device.':'If setupRequired, choose a token in the local page. Otherwise inspect the gateway log and compare server/config paths. Do not reset credentials to repair connectivity.';
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const{values}=parseArgs({strict:true,options:{server:{type:'string'},port:{type:'string'},config:{type:'string'},help:{type:'boolean'}}});if(values.help)console.log('doctor [--server https://space.cafecode.work] [--port 37891] [--config <absolute room-device.json>]\nRead-only. No tokens, passwords, or private-key contents are read or transmitted.');else{const result=await diagnose(values);console.log(JSON.stringify(result,null,2));if(!result.readyForManualRoomTest)process.exitCode=1;}}
 catch(e){console.error('Café Space diagnosis: '+e.message);process.exitCode=1;}
}
