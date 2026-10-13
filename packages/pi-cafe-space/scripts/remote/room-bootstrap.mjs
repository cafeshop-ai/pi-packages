import { lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const {values}=parseArgs({strict:true,options:{config:{type:'string'},credentials:{type:'string'},port:{type:'string',default:'37891'},help:{type:'boolean'}}});
let child,stopping=false;
async function stop(){if(stopping)return;stopping=true;if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(12000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
async function exists(){try{await lstat(values.credentials);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function main(){
 if(values.help){console.log('room-bootstrap --config <absolute room config> --credentials <absolute local credentials> [--port 37891]');return;}
 const port=Number(values.port);if(!values.config||!values.credentials||!isAbsolute(values.config)||!isAbsolute(values.credentials)||!Number.isInteger(port)||port<1024||port>65535)throw Error('Absolute paths and an unprivileged port are required');
 if(!await exists()){
  const {trustedGoBinary}=await import('../../dist/extension/local-relay-go.js');const binary=await trustedGoBinary(root);
  const env={};for(const name of ['HOME','USERPROFILE','TMPDIR','TEMP','TMP','SystemRoot','WINDIR','PATH'])if(process.env[name])env[name]=process.env[name];
  Object.assign(env,{PI_COLLAB_HOST:'127.0.0.1',PI_COLLAB_PORT:String(port),PI_CAFE_CREDENTIALS_FILE:values.credentials});
  child=spawn(binary,[],{env,stdio:'inherit'});let failed=false;child.once('error',()=>{failed=true;});
  console.log('Café Space first use: open http://127.0.0.1:'+port+'/ to choose your local access token. No password has been generated.');
  while(!stopping&&!await exists()){if(failed||child.exitCode!==null||child.signalCode!==null)throw Error('Initialization server exited; check the port and directory permissions');await delay(300);}
  if(stopping)return;
  const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await Promise.race([done,delay(12000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await done;}
 }
 if(stopping)return;
 child=spawn(process.execPath,[resolve(root,'scripts/remote/room-run.mjs'),'--config',values.config,'--credentials',values.credentials],{stdio:'inherit',env:process.env});
 await new Promise((resolve,reject)=>{child.once('error',()=>reject(Error('Room launcher could not start')));child.once('exit',code=>{if(!stopping&&code!==0)reject(Error('Room gateway exited unsuccessfully'));else resolve();});});
}
main().catch(e=>{console.error('Café Space bootstrap: '+e.message);process.exitCode=1;}).finally(()=>{process.removeAllListeners('SIGTERM');process.removeAllListeners('SIGINT');});
