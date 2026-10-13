import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
const {values}=parseArgs({strict:true,options:{package:{type:'string'},report:{type:'string'},'server-output':{type:'string'}}});
assert(values.package);const packageRoot=await realpath(values.package);const root=await realpath(await mkdtemp(join(tmpdir(),'cafe-install-integration-')));
let child;const checks=[];const hash=b=>createHash('sha256').update(b).digest('hex');
function command(script,args){const p=spawnSync(process.execPath,[join(packageRoot,'scripts/remote',script),...args],{encoding:'utf8',timeout:90000});if(p.status!==0)throw Error(script+' failed: '+p.stderr.slice(0,1200));return p.stdout;}
async function eventually(fn,label){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error(label+' timed out');}
async function stop(){if(!child||child.exitCode!==null||child.signalCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await Promise.race([done,delay(15000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await done;}}
try{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const prefix=join(root,'installed-v1'),state=join(root,'room-state'),credentials=join(root,'credentials','credentials-'+port+'.json'),origin='https://127.0.0.1:9';
 const output=command('install-client.mjs',['--prefix',prefix,'--state',state,'--server',origin,'--port',String(port),'--credentials',credentials]);const installed=JSON.parse(output);
 assert(!installed.registeredPi&&!installed.serviceEnabled);assert((await stat(join(prefix,'AI_INSTALL.md'))).isFile());assert((await stat(join(prefix,'node_modules/ws/package.json'))).isFile());
 checks.push('Prebuilt package installs into a new prefix with runtime dependency and AI guides, without global Pi/service changes');
 let logs='';child=spawn(process.execPath,[join(prefix,'scripts/remote/room-bootstrap.mjs'),'--config',join(state,'room-device.json'),'--credentials',credentials,'--port',String(port)],{cwd:root,stdio:['ignore','pipe','pipe']});for(const s of [child.stdout,child.stderr])s.on('data',b=>logs=(logs+b).slice(-2000));
 const local='http://127.0.0.1:'+port;
 await eventually(async()=>{try{return(await(await fetch(local+'/api/config')).json()).setupRequired===true;}catch{return false;}},'initialization page');
 await assert.rejects(stat(credentials),{code:'ENOENT'});
 const challenge=await(await fetch(local+'/api/setup',{headers:{'X-Cafe-Setup':'1'}})).json();
 const result=await fetch(local+'/api/setup',{method:'POST',headers:{Origin:local,'Content-Type':'application/json','X-Cafe-Setup':challenge.nonce},body:JSON.stringify({token:'123456',confirmToken:'123456'})});assert.equal(result.status,201);
 await eventually(async()=>{try{return(await(await fetch(local+'/api/config')).json()).roomShare===true;}catch{return false;}},'automatic room transition');
 const identity=join(state,'identity/room.json'),before=hash(await readFile(identity));const credBefore=hash(await readFile(credentials));
 const response=await fetch(local+'/api/room/share',{method:'POST',headers:{Origin:local,'Content-Type':'application/json','X-Cafe-Room':'1'},body:JSON.stringify({operation:'status',token:'123456'})});assert.equal(response.status,200);const share=await response.json();assert(share.url.startsWith(origin+'/#/room/'));assert(!share.online);assert(!('password'in share));
 checks.push('Fresh bootstrap creates no password, accepts user setup, then automatically runs room gateway with a stable identity');
 await stop();
 const prefix2=join(root,'installed-v2');command('install-client.mjs',['--prefix',prefix2,'--state',state,'--reuse-state','--server',origin,'--port',String(port),'--credentials',credentials]);
 assert.equal(hash(await readFile(identity)),before);assert.equal(hash(await readFile(credentials)),credBefore);
 checks.push('Explicit versioned upgrade preserves the existing room identity and local credential bytes');
 const outputDir=values['server-output']?resolve(values['server-output']):join(root,'server-existing');
 command('configure-server.mjs',['--out',outputDir,'--origin','https://rooms.example','--public-ip','8.8.8.8','--arch','amd64','--proxy','existing']);
 const cfg=JSON.parse(await readFile(join(outputDir,'cloud.json'),'utf8'));assert(cfg.roomAccess&&cfg.enableWebRTC&&!cfg.users&&!cfg.devices);const conf=await readFile(join(outputDir,'turn/turnserver.conf'),'utf8');assert(conf.includes('static-auth-secret='+cfg.turn.sharedSecret+'\n'),'TURN secret consistency');
 const yaml=await readFile(join(outputDir,'compose.yaml'),'utf8');assert(!yaml.includes('\n  caddy:'));assert(yaml.includes('127.0.0.1:37892:37892'));assert(yaml.includes('network_mode: host'));assert(yaml.includes('no-new-privileges:true'));
 const manifest=(await readFile(join(outputDir,'MANIFEST.sha256'),'utf8')).trim().split('\n');for(const line of manifest){const [sum,name]=line.split('  ');assert.equal(hash(await readFile(join(outputDir,name))),sum,'generated manifest consistency');}
 const sh=spawnSync('/bin/sh',['-n',join(outputDir,'start-server.sh')],{encoding:'utf8'});assert.equal(sh.status,0,sh.stderr);
 const fresh=join(root,'server-caddy');command('configure-server.mjs',['--out',fresh,'--origin','https://rooms.example','--public-ip','8.8.8.8','--arch','amd64','--proxy','caddy']);assert((await readFile(join(fresh,'compose.yaml'),'utf8')).includes('image: caddy:2.11.6'));
 checks.push('Self-host generator produces verified Docker payloads for existing proxy or new Caddy, with no room passwords or server actions');
 const report={passed:true,checks,serviceActivated:false,piRegistered:false,providerRequests:0,serverOutput:values['server-output']?outputDir:null,scope:'isolated Mac prefix/state/bootstrap and generated Linux templates; no systemd/Windows live activation or remote Docker start'};
 if(values.report){await mkdir(values.report,{recursive:true});await writeFile(join(values.report,'result.json'),JSON.stringify(report,null,2));}console.log(JSON.stringify(report,null,2));
}catch(error){const report={passed:false,checks,error:error.message};if(values.report){await mkdir(values.report,{recursive:true});await writeFile(join(values.report,'result.json'),JSON.stringify(report,null,2));}console.error(JSON.stringify(report,null,2));process.exitCode=1;}
finally{await stop();await rm(root,{recursive:true,force:true});}
