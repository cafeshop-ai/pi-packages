import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { hostname } from 'node:os';
const {values}=parseArgs({strict:true,options:{origin:{type:'string',default:'https://space.cafecode.work'},out:{type:'string'},name:{type:'string'},help:{type:'boolean'}}});
try{
 if(values.help){console.log('room-setup --out <new private directory> [--origin https://space.cafecode.work] [--name "Office computer"]\nInitialize the local web access token first. Room password initially uses that existing token, then can be changed separately in Share room.');}
 else{
  if(!values.out||!isAbsolute(values.out))throw Error('--out must be an absolute new directory');
  const origin=new URL(values.origin);if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw Error('A plain HTTPS origin is required');
  const name=values.name||hostname();if(!name||name.length>128||name.trim()!==name||/[\u0000-\u001f\u007f]/.test(name))throw Error('Invalid room name');
  const out=resolve(values.out);await mkdir(out,{mode:0o700});
  const config={mode:'device',publicOrigin:origin.origin,cloudUrl:'wss://'+origin.host+'/room/host',roomIdentityFile:join(out,'identity','room.json'),deviceName:name,rooms:['main'],maxRole:'operator',enableWebRTC:true};
  await writeFile(join(out,'room-device.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({created:true,config:join(out,'room-device.json'),publicOrigin:origin.origin,roomName:name,serverAccountRequired:false,next:'Use room-run with this config and the existing local credential file, then open the local page and choose Share room.'},null,2));
 }
}catch(error){console.error('Café Space room setup: '+error.message);process.exitCode=1;}
