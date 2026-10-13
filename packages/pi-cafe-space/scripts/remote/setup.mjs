#!/usr/bin/env node
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isIP } from 'node:net';

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
export function validateOrigin(raw) {
  const u = new URL(raw);
  const local = ['localhost','127.0.0.1','[::1]'].includes(u.hostname);
  if (u.username || u.password || !['https:','http:'].includes(u.protocol) || u.protocol === 'http:' && !local || u.pathname !== '/' || u.search || u.hash) throw Error('Use an HTTPS origin without a path or credentials. HTTP is allowed only for loopback tests.');
  return u.origin;
}
/** Generates NEW files only; never edits an existing credential/configuration. */
export async function provision({output,origin,deviceId='office',deviceName='Office computer',room='main',stun,turnHost}) {
  if (!isAbsolute(output) || !identifier.test(deviceId) || !identifier.test(room) || typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 128 || /[\x00-\x1f\x7f]/.test(deviceName)) throw Error('Invalid output path, device or room.');
  origin = validateOrigin(origin);
  if (stun && (!/^stuns?:[^\s]+$/.test(stun) || stun.length > 2048)) throw Error('Invalid STUN URL.');
  if (turnHost && !(isIP(turnHost) === 4 || /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(turnHost))) throw Error('TURN must be an explicit DNS name or IPv4 address.');
  const deviceToken=token(),localHostToken=token(),localClientToken=token();
  const users=['admin','operator','viewer'].map(role=>({id:role,name:role==='admin'?'Owner':role==='operator'?'Collaborator':'Viewer',role,accessKey:token()}));
  const cloud={mode:'cloud',publicOrigin:origin,enableWebRTC:true,iceServers:stun?[{urls:[stun]}]:[],devices:[{id:deviceId,name:deviceName,tokenHash:hash(deviceToken)}],users:users.map(user=>({id:user.id,name:user.name,tokenHash:hash(user.accessKey),grants:[{deviceId,room,role:user.role}]}))};
  const endpoint=new URL('/remote/agent',origin);endpoint.protocol=endpoint.protocol==='https:'?'wss:':'ws:';
  const device={mode:'device',deviceId,deviceName,deviceToken,cloudUrl:endpoint.href,rooms:[room],maxRole:'admin',enableWebRTC:true};
  const files={
    'cloud.json':cloud,
    'device.json':device,
    'cloud.launch.json':{schema:'pi-cafe-launch-v1',config:'cloud.json',host:'127.0.0.1',port:37892,hostToken:token(),clientToken:token()},
    'device.launch.json':{schema:'pi-cafe-launch-v1',config:'device.json',host:'127.0.0.1',port:37891,hostToken:localHostToken,clientToken:localClientToken},
    'access-keys.json':{warning:'PRIVATE: distribute only the individual key and role intended for each person. Never upload this file to the web server.',origin,deviceId,room,users},
  };
  let turnConfig;
  if(turnHost){
    const secret=token();cloud.turn={urls:[`turn:${turnHost}:3478?transport=udp`,`turn:${turnHost}:3478?transport=tcp`],sharedSecret:secret,ttlSeconds:600};
    turnConfig=`# Private coturn configuration. Provision DNS/firewall separately.\nlistening-port=3478\nfingerprint\nuse-auth-secret\nstatic-auth-secret=${secret}\nrealm=${turnHost}\nserver-name=${turnHost}\nmin-port=49160\nmax-port=49200\ntotal-quota=256\nuser-quota=16\nmax-bps=10485760\nno-cli\nno-multicast-peers\nno-loopback-peers\nno-tls\nno-dtls\n# For TURN/TLS, remove no-tls, set cert/pkey, and add a turns: URL to cloud.json.\n# If this host is behind NAT, set external-ip explicitly.\n`;
  }
  await mkdir(output,{mode:0o700});
  for(const [name,value] of Object.entries(files))await writeFile(join(output,name),json(value),{flag:'wx',mode:0o600});
  if(turnConfig)await writeFile(join(output,'turnserver.conf'),turnConfig,{flag:'wx',mode:0o600});
  const url=new URL(origin);
  const caddy=url.protocol==='https:'?`${url.host} {\n  reverse_proxy 127.0.0.1:37892\n}\n`:`${origin} {\n  reverse_proxy 127.0.0.1:37892\n}\n`;
  await writeFile(join(output,'Caddyfile'),caddy,{flag:'wx',mode:0o600});
  await writeFile(join(output,'README.txt'),`PRIVATE CONFIGURATION BUNDLE\n\nCloud server: copy cloud.json, cloud.launch.json and Caddyfile only.\nOffice computer: copy device.json and device.launch.json only.\nUsers: distribute only their own entry from access-keys.json through a secure channel.\n${turnHost?'TURN server: copy turnserver.conf privately; do not expose the shared secret.\n':''}\nRun the packaged foreground launcher:\n  node scripts/remote/run.mjs --profile /absolute/path/device.launch.json\n  node scripts/remote/run.mjs --profile /absolute/path/cloud.launch.json\n\nOn the office computer, start an explicitly selected Pi CLI with matching local connection settings:\n  node scripts/remote/run.mjs --profile /absolute/path/device.launch.json --pi-cli /absolute/path/to/pi/cli.js\n\nThe launcher never edits global Pi configuration or kills a process on a busy port.\nFor remotely created Pi sessions, configure --managed separately as documented.\nCloud/WSS is trusted to see application messages. WebRTC authenticates through the configured cloud; it is not independent cryptographic device pairing.\n`,{flag:'wx',mode:0o600});
  return {output,files:[...Object.keys(files),'Caddyfile','README.txt',...(turnHost?['turnserver.conf']:[])],users:users.map(({id,role})=>({id,role}))};
}
async function main(){
  const {values}=parseArgs({options:{output:{type:'string'},origin:{type:'string'},device:{type:'string'},name:{type:'string'},room:{type:'string'},stun:{type:'string'},turn:{type:'string'},help:{type:'boolean'}},strict:true});
  if(values.help){console.log('node scripts/remote/setup.mjs --output /new/private/directory --origin https://cafe.example.com [--device office --room main --stun stun:host:3478 --turn turn.example.com]');return;}
  if(!values.output||!values.origin)throw Error('--output and --origin are required.');
  const result=await provision({output:resolve(values.output),origin:values.origin,deviceId:values.device,deviceName:values.name,room:values.room,stun:values.stun,turnHost:values.turn});
  console.log(JSON.stringify(result,null,2)); // paths/roles only, never credentials
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
