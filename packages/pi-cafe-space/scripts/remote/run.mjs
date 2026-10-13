#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const here=dirname(fileURLToPath(import.meta.url));
const key=/^[A-Za-z0-9_-]{43,128}$/;
async function readJSON(path,max=512*1024){
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>max)throw Error('Invalid configuration file.');
  return JSON.parse(await readFile(path,'utf8'));
}
export async function loadProfile(path){
  path=resolve(path);const value=await readJSON(path,16384);
  const allowed=['schema','config','host','port','hostToken','clientToken'];
  if(!value||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k))||value.schema!=='pi-cafe-launch-v1'||typeof value.config!=='string'||!value.config||!['127.0.0.1','::1','localhost'].includes(value.host)||!Number.isSafeInteger(value.port)||value.port<1||value.port>65535||!key.test(value.hostToken)||!key.test(value.clientToken)||value.hostToken===value.clientToken)throw Error('Invalid launch profile.');
  const configPath=resolve(dirname(path),value.config);const remote=await readJSON(configPath);
  if(!['cloud','device'].includes(remote.mode))throw Error('Invalid remote mode.');
  return{...value,configPath,mode:remote.mode,rooms:remote.rooms};
}
async function packagedBinary(){
  const root=resolve(here,'../..');
  const platform=process.platform==='win32'?'windows':process.platform;
  const arch=process.arch==='x64'?'amd64':process.arch;
  const tag=`${platform}-${arch}`;
  if(!['windows-amd64','darwin-arm64','darwin-amd64','linux-arm64','linux-amd64'].includes(tag))throw Error('Unsupported binary platform.');
  const name=`pi-cafe-relay${process.platform==='win32'?'.exe':''}`;
  const candidates=[join(root,'dist/relay/bin',tag,name),join(root,'.refactor/release/package/dist/relay/bin',tag,name)];
  for(const binary of candidates){
    try{
      const info=await lstat(binary);if(!info.isFile()||info.isSymbolicLink())continue;
      const metadata=await readJSON(resolve(binary,'../../..','build.json'));
      const bytes=await readFile(binary);const actual=createHash('sha256').update(bytes).digest('hex');
      const record=metadata.platforms?.[tag];
      if(!record||record.sha256!==actual||record.platform!==tag||record.binary!==`bin/${tag}/${name}`)throw Error('Candidate binary identity mismatch.');
      return binary;
    }catch(error){if(error.code==='ENOENT')continue;throw error;}
  }
  throw Error('No packaged Relay binary found. Run npm run refactor:pack first, or provide --binary explicitly.');
}
export function childEnvironment(profile,managed){
  const env={};
  // In particular, do not forward provider keys or inherited PI_COLLAB values.
  for(const name of ['PATH','HOME','USERPROFILE','SystemRoot','WINDIR','COMSPEC','PATHEXT','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','LANG','LC_ALL'])if(process.env[name])env[name]=process.env[name];
  Object.assign(env,{PI_COLLAB_HOST:profile.host,PI_COLLAB_PORT:String(profile.port),PI_COLLAB_HOST_TOKEN:profile.hostToken,PI_COLLAB_CLIENT_TOKEN:profile.clientToken,PI_CAFE_REMOTE_CONFIG:profile.configPath});
  if(managed)env.PI_COLLAB_MANAGED_CONFIG=resolve(managed);
  return env;
}
export async function run(argv=process.argv.slice(2)){
  const{values,positionals}=parseArgs({args:argv,allowPositionals:true,strict:true,options:{profile:{type:'string'},binary:{type:'string'},managed:{type:'string'},'pi-cli':{type:'string'},room:{type:'string'},help:{type:'boolean'}}});
  if(values.help){console.log('node scripts/remote/run.mjs --profile /private/device.launch.json [--binary /absolute/pi-cafe-relay] [--managed /private/managed.json]\nnode scripts/remote/run.mjs --profile /private/device.launch.json --pi-cli /absolute/pi/cli.js [--room main] -- <Pi args>');return 0;}
  if(!values.profile)throw Error('--profile is required.');
  const profile=await loadProfile(values.profile);
  if(profile.mode==='cloud'&&(values.managed||values['pi-cli']))throw Error('The cloud profile cannot own office Pi processes.');
  let command,args,env=childEnvironment(profile,values.managed);
  if(values['pi-cli']){
    if(!isAbsolute(values['pi-cli']))throw Error('--pi-cli must be an absolute path.');
    const cli=await realpath(values['pi-cli']);const info=await lstat(cli);if(!info.isFile())throw Error('Pi CLI must be a regular JavaScript file.');
    const room=values.room??profile.rooms?.[0];if(!profile.rooms?.includes(room))throw Error('The room is not authorized by this device configuration.');
    command=process.execPath;
    const root=resolve(here,'../..');let extension=join(root,'dist/extension/index.js');
    try{await lstat(extension);}catch{extension=join(root,'.refactor/release/package/dist/extension/index.js');await lstat(extension);}
    args=[cli,'-e',extension,...positionals];
    env={...env,PI_COLLAB_ENABLED:'1',PI_COLLAB_ROOM:room,PI_COLLAB_RELAY_URL:`ws://${profile.host==='::1'?'[::1]':profile.host}:${profile.port}/ws`};
    delete env.PI_CAFE_REMOTE_CONFIG;delete env.PI_COLLAB_MANAGED_CONFIG;
  }else{
    if(positionals.length)throw Error('Unexpected Relay arguments.');
    command=values.binary?await realpath(resolve(values.binary)):await packagedBinary();args=[];
  }
  const child=spawn(command,args,{env,stdio:'inherit',windowsHide:false});
  return await new Promise((resolveExit,reject)=>{
    const forward=signal=>{if(child.exitCode===null&&!child.killed)child.kill(signal);};
    const interrupt=()=>forward('SIGINT'),terminate=()=>forward('SIGTERM');
    process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
    const cleanup=()=>{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);};
    child.once('error',error=>{cleanup();reject(error);});
    child.once('exit',(code,signal)=>{cleanup();resolveExit(code??(signal?1:0));});
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.message);process.exitCode=1;});
