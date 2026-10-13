import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const script=fileURLToPath(new URL('./room-setup.mjs',import.meta.url));
const run=args=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',timeout:15000});
test('room configuration is public-origin only, secret-free and create-only',async()=>{
 const root=await mkdtemp(join(tmpdir(),'room-setup-test-'));const out=join(root,'new');
 try{
  const p=run(['--out',out,'--origin','https://space.example','--name','Office']);assert.equal(p.status,0,p.stderr);
  const cfg=JSON.parse(await readFile(join(out,'room-device.json'),'utf8'));
  assert.equal(cfg.cloudUrl,'wss://space.example/room/host');assert.equal(cfg.roomIdentityFile,join(out,'identity/room.json'));assert.equal(cfg.maxRole,'operator');assert.deepEqual(cfg.rooms,['main']);
  for(const key of ['deviceToken','deviceId','password','privateKey','users','devices'])assert(!(key in cfg));
  if(process.platform!=='win32'){assert.equal((await stat(out)).mode&0o777,0o700);assert.equal((await stat(join(out,'room-device.json'))).mode&0o777,0o600);}
  await writeFile(join(out,'keep'),'untouched');assert.notEqual(run(['--out',out]).status,0);assert.equal(await readFile(join(out,'keep'),'utf8'),'untouched');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('invalid origins cannot create a room configuration',async()=>{
 const root=await mkdtemp(join(tmpdir(),'room-invalid-test-'));
 try{for(const [i,origin]of ['http://space.example','https://user:pass@space.example','https://space.example/?token=x','https://space.example/#room'].entries()){const p=run(['--out',join(root,String(i)),'--origin',origin]);assert.notEqual(p.status,0);await assert.rejects(stat(join(root,String(i))),{code:'ENOENT'});}}
 finally{await rm(root,{recursive:true,force:true});}
});
