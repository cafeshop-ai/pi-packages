import { lstat, mkdir, readdir, readFile, writeFile, copyFile, chmod, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir, hostname } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const xml = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const sh = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const systemd = value => '"' + String(value).replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%') + '"';
export function plainOrigin(raw) { const url = new URL(raw); if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw Error('Use a plain HTTPS server origin'); return url.origin; }
function absolute(raw, name) { if (!raw || !isAbsolute(raw) || /[\u0000-\u001f\u007f]/.test(raw)) throw Error(name+' must be an absolute path without control characters'); return resolve(raw); }
async function metadata(path) { try { return await lstat(path); } catch(e) { if(e.code==='ENOENT')return null; throw e; } }
async function privateDirectory(path) { const s=await lstat(path); if(!s.isDirectory()||s.isSymbolicLink()||process.platform!=='win32'&&(s.mode&0o077)!==0)throw Error('State directory must be private and not a symlink'); }
async function copyTree(source,target) { const s=await lstat(source); if(s.isSymbolicLink())throw Error('Installation source contains a symlink'); if(s.isDirectory()){await mkdir(target,{mode:0o700});for(const name of await readdir(source))await copyTree(join(source,name),join(target,name));}else if(s.isFile()){await copyFile(source,target,1);await chmod(target,s.mode&0o111?0o700:0o600);}else throw Error('Unsupported installation file type'); }
export function serviceFiles(platform,prefix,state,credentials,port,node=process.execPath,home=homedir()) {
 const args=[node,join(prefix,'scripts/remote/room-bootstrap.mjs'),'--config',join(state,'room-device.json'),'--credentials',credentials,'--port',String(port)];
 const name='com.cafecodework.pi-cafe-room';
 if(platform==='darwin')return{path:join(home,'Library/LaunchAgents',name+'.plist'),name,content:'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>'+name+'</string><key>ProgramArguments</key><array>'+args.map(a=>'<string>'+xml(a)+'</string>').join('')+'</array><key>EnvironmentVariables</key><dict><key>HOME</key><string>'+xml(home)+'</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ExitTimeOut</key><integer>20</integer><key>StandardOutPath</key><string>'+xml(join(state,'gateway.log'))+'</string><key>StandardErrorPath</key><string>'+xml(join(state,'gateway.err.log'))+'</string></dict></plist>\n',startCommand:args.map(sh).join(' ')};
 if(platform==='linux')return{path:join(home,'.config/systemd/user/pi-cafe-room.service'),name:'pi-cafe-room.service',content:'[Unit]\nDescription=Cafe Space personal room gateway\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart='+args.map(systemd).join(' ')+'\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=20\nUMask=0077\nNoNewPrivileges=yes\n\n[Install]\nWantedBy=default.target\n',startCommand:args.map(sh).join(' ')};
 return{path:null,name:null,content:'& '+args.map(a=>"'"+a.replaceAll("'","''")+"'").join(' ')+'\n',startCommand:'PowerShell: '+args.map(a=>JSON.stringify(a)).join(' ')};
}
export async function install(values) {
 const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||major===22&&minor<19)throw Error('Node 22.19+ is required');
 const source=await realpath(packageRoot),prefix=absolute(values.prefix,'--prefix'),state=absolute(values.state,'--state');
 const origin=plainOrigin(values.server??'https://space.cafecode.work'),port=Number(values.port??37891);
 if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Use an unprivileged local port');
 const credentials=absolute(values.credentials??join(homedir(),'.config/pi-cafe-space',`credentials-${port}.json`),'--credentials');
 const inside=(a,b)=>a===b||relative(a,b)&&!relative(a,b).startsWith('..')&&!isAbsolute(relative(a,b));
 if(inside(source,prefix)||inside(prefix,source)||inside(prefix,state)||inside(state,prefix)||inside(prefix,credentials))throw Error('Package and persistent state must be separate');
 if(await metadata(prefix))throw Error('Installation prefix already exists; use a new versioned prefix');
 const name=values.name??hostname();if(!name||name.length>128||name.trim()!==name||/[\u0000-\u001f\u007f]/.test(name))throw Error('Invalid room name');
 const s=await metadata(state);let existing=null;
 if(s){if(!values['reuse-state'])throw Error('State exists; explicitly use --reuse-state after reviewing it');await privateDirectory(state);const p=join(state,'room-device.json');const st=await lstat(p);if(!st.isFile()||st.isSymbolicLink()||st.size>16384||process.platform!=='win32'&&(st.mode&0o077)!==0)throw Error('Existing config is not a private file');existing=JSON.parse(await readFile(p,'utf8'));if(existing.mode!=='device'||existing.publicOrigin!==origin||existing.cloudUrl!==origin.replace(/^http/,'ws')+'/room/host'||existing.deviceToken||existing.deviceId||JSON.stringify(existing.rooms)!=='["main"]'||existing.maxRole!=='operator'||!existing.enableWebRTC||existing.roomIdentityFile!==join(state,'identity/room.json'))throw Error('Existing room configuration differs; do not reset it implicitly');}
 const credentialStat=await metadata(credentials);if(credentialStat&&(!credentialStat.isFile()||credentialStat.isSymbolicLink()||process.platform!=='win32'&&(credentialStat.mode&0o077)!==0))throw Error('Existing credentials must be a private regular file');
 const service=serviceFiles(process.platform,prefix,state,credentials,port);
 if(values['enable-service']){
  if(!service.path)throw Error('Automatic service activation supports macOS and Linux; Windows receives a foreground PowerShell launcher');
  if(await metadata(service.path))throw Error('Service already exists; preserve it and perform an explicit reviewed upgrade');
  await new Promise((done,fail)=>{const server=createServer();server.once('error',()=>fail(Error('Local port is in use; do not stop an unknown process')));server.listen(port,'127.0.0.1',()=>server.close(done));});
 }
 let piCli;if(values['register-pi']){piCli=absolute(values['pi-cli'],'--pi-cli');if(!(await lstat(piCli)).isFile())throw Error('Pi CLI file is missing');}
 const {relayBinary}=await import(pathToFileURL(join(source,'scripts/relay-path.mjs')));await relayBinary(source);
 let npmCli=values['npm-cli']??process.env.npm_execpath;if(npmCli)npmCli=absolute(npmCli,'--npm-cli');
 if(values['install-dependencies']&&!npmCli)throw Error('Pass the installed npm CLI path through --npm-cli');
 let runtimeSource;
 if(!values['install-dependencies']){try{const req=createRequire(join(source,'package.json'));const wsPackage=req.resolve('ws/package.json');if(JSON.parse(await readFile(wsPackage,'utf8')).version!=='8.21.3')throw Error('Unexpected ws version');runtimeSource=dirname(wsPackage);}catch{throw Error('Runtime ws 8.21.3 unavailable; use --install-dependencies with --npm-cli');}}
 await mkdir(dirname(prefix),{recursive:true,mode:0o700});await mkdir(prefix,{mode:0o700});
 const allowed=['package.json','dist','scripts','README.md','INSTALL.md','AI_INSTALL.md','LICENSE','THIRD-PARTY-NOTICES.txt'];
 for(const file of allowed)await copyTree(join(source,file),join(prefix,file));
 const log={format:'pi-cafe-install-v1',prefix,state,origin,port,credentials,registeredPi:false,serviceEnabled:false,stateReused:!!existing};
 const save=()=>writeFile(join(prefix,'install-result.json'),JSON.stringify(log,null,2)+'\n',{mode:0o600});await save();
 const env={...process.env,PATH:dirname(process.execPath)+delimiter+(process.env.PATH??'')};
 const command=(exe,args,cwd=prefix)=>{const r=spawnSync(exe,args,{cwd,env,stdio:'inherit',timeout:180000});if(r.error||r.status!==0)throw Error('Installer command failed; see install-result.json. Existing state was not deleted.');};
 if(values['install-dependencies'])command(process.execPath,[npmCli,'install','--omit=dev','--ignore-scripts','--legacy-peer-deps','--package-lock=false']);
 else{await mkdir(join(prefix,'node_modules'),{mode:0o700});await copyTree(runtimeSource,join(prefix,'node_modules/ws'));}
 if(!s){await mkdir(dirname(state),{recursive:true,mode:0o700});await mkdir(state,{mode:0o700});const config={mode:'device',publicOrigin:origin,cloudUrl:origin.replace(/^http/,'ws')+'/room/host',roomIdentityFile:join(state,'identity/room.json'),deviceName:name,rooms:['main'],maxRole:'operator',enableWebRTC:true};await writeFile(join(state,'room-device.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});}
 await writeFile(join(prefix,process.platform==='win32'?'start-room.ps1':'start-room.sh'),process.platform==='win32'?service.content:'#!/bin/sh\nexec '+service.startCommand+'\n',{flag:'wx',mode:0o700});
 if(service.path)await writeFile(join(prefix,process.platform==='darwin'?'room-agent.plist':'room.service'),service.content,{flag:'wx',mode:0o600});
 if(values['register-pi']){command(process.execPath,[piCli,'install',prefix,'--no-approve']);log.registeredPi=true;await save();}
 if(values['enable-service']){await mkdir(dirname(service.path),{recursive:true});await writeFile(service.path,service.content,{flag:'wx',mode:0o600});if(process.platform==='darwin')command('/bin/launchctl',['bootstrap','gui/'+process.getuid(),service.path]);else{command('systemctl',['--user','daemon-reload']);command('systemctl',['--user','enable','--now',service.name]);}log.serviceEnabled=true;await save();}
 return{...log,firstUseURL:`http://127.0.0.1:${port}/`,startCommand:service.startCommand,next:'Start the gateway using startCommand unless its service is already enabled. Start Pi (or /reload an idle Pi), then use /cafe to share a QR code or copy the room link. Only a fresh setup asks you to choose a local token; existing credentials are preserved. Verify the room is online and test on a second device. No provider was configured.'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const{values}=parseArgs({strict:true,options:{prefix:{type:'string'},state:{type:'string'},server:{type:'string'},port:{type:'string'},credentials:{type:'string'},name:{type:'string'},'reuse-state':{type:'boolean'},'install-dependencies':{type:'boolean'},'npm-cli':{type:'string'},'register-pi':{type:'boolean'},'pi-cli':{type:'string'},'enable-service':{type:'boolean'},help:{type:'boolean'}}});
 if(values.help)console.log('install-client --prefix <new install directory> --state <private room directory> [--server https://space.cafecode.work] [--credentials <existing local file>] [--reuse-state] [--install-dependencies --npm-cli <npm-cli.js>] [--register-pi --pi-cli <cli.js>] [--enable-service]\nDefault: no global installation, no provider changes, no service activation. Installation source must be a verified prebuilt package.');else console.log(JSON.stringify(await install(values),null,2));}
 catch(e){console.error('Café Space installation: '+e.message);process.exitCode=1;}
}
