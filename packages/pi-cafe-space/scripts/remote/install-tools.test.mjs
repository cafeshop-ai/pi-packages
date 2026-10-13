import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceFiles, plainOrigin, install } from './install-client.mjs';
import { serverOptions } from './configure-server.mjs';
const here=fileURLToPath(new URL('.',import.meta.url));
test('installation help is available without global Pi, Docker or a built binary',()=>{
 for(const name of ['install-client.mjs','configure-server.mjs','doctor.mjs','room-bootstrap.mjs','room-run.mjs','room-setup.mjs']){const p=spawnSync(process.execPath,[join(here,name),'--help'],{encoding:'utf8',timeout:10000});assert.equal(p.status,0,p.stderr);assert(p.stdout.length>30);}
});
test('server origin and IPv4 parameters are explicit and cannot inject configuration',()=>{
 assert.equal(plainOrigin('https://space.example/'),'https://space.example');
 for(const origin of ['http://space.example','https://user:pass@space.example','https://space.example/path','https://space.example/?token=x','https://space.example/#room'])assert.throws(()=>plainOrigin(origin));
 const base={out:'/new/stack',origin:'https://rooms.example','public-ip':'8.8.8.8'};
 assert.equal(serverOptions(base).proxy,'existing');assert.equal(serverOptions({...base,proxy:'caddy'}).proxy,'caddy');
 for(const ip of ['127.0.0.1','10.1.2.3','192.168.1.2','169.254.169.254','not-an-IP','8.8.8.8\nsecret=x'])assert.throws(()=>serverOptions({...base,'public-ip':ip}));
 assert.throws(()=>serverOptions({...base,origin:'https://rooms.example:8443'}));assert.throws(()=>serverOptions({...base,proxy:'replace-existing'}));assert.throws(()=>serverOptions({...base,arch:'x86'}));
});
test('service templates preserve argument boundaries and user-owned state',()=>{
 const prefix='/tmp/Package A&B',state='/tmp/State % Local',credentials='/tmp/Creds/key.json',node='/test/node';
 const mac=serviceFiles('darwin',prefix,state,credentials,37891,node,'/home/test');assert(mac.content.includes('Package A&amp;B'));assert(mac.content.includes('<string>--credentials</string>'));assert(!mac.content.includes('password'));
 const linux=serviceFiles('linux',prefix,state,credentials,37891,node,'/home/test');assert(linux.content.includes('State %% Local'));assert(linux.content.includes('NoNewPrivileges=yes'));assert(linux.path.replaceAll('\\','/').includes('/systemd/user/'));
 const win=serviceFiles('win32',"C:\\User's\\Package",state,credentials,37891,node);assert.equal(win.path,null);assert(win.content.includes("User''s"));
});
test('an existing versioned installation is never overwritten',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cafe-installer-protect-'));try{await writeFile(join(dir,'keep'),'unchanged');await assert.rejects(install({prefix:dir,state:join(dir,'state')}));assert.equal(await readFile(join(dir,'keep'),'utf8'),'unchanged');}finally{await rm(dir,{recursive:true,force:true});}
});
