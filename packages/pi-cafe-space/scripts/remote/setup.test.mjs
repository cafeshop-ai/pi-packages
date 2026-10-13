import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { provision, validateOrigin } from './setup.mjs';
import { loadProfile, childEnvironment, run } from './run.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');

test('provision creates independent hashed identities and never overwrites a bundle',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'cafe-setup-test-'));const output=join(parent,'config');
  try{
    const receipt=await provision({output,origin:'https://cafe.example.com',turnHost:'turn.example.com'});
    const cloud=JSON.parse(await readFile(join(output,'cloud.json'),'utf8'));
    const device=JSON.parse(await readFile(join(output,'device.json'),'utf8'));
    const access=JSON.parse(await readFile(join(output,'access-keys.json'),'utf8'));
    assert.equal(cloud.devices[0].tokenHash,hash(device.deviceToken));
    assert.equal(device.cloudUrl,'wss://cafe.example.com/remote/agent');
    const keys=[device.deviceToken,...access.users.map(u=>u.accessKey)];
    assert.equal(new Set(keys).size,4);
    for(const user of access.users){assert.equal(cloud.users.find(u=>u.id===user.id).tokenHash,hash(user.accessKey));assert(!JSON.stringify(receipt).includes(user.accessKey));assert(!JSON.stringify(cloud).includes(user.accessKey));}
    assert(!JSON.stringify(cloud).includes(device.deviceToken));
    assert.equal(cloud.turn.ttlSeconds,600);assert.equal(cloud.turn.urls.length,2);
    assert((await readFile(join(output,'turnserver.conf'),'utf8')).includes('use-auth-secret'));
    if(process.platform!=='win32'){assert.equal((await stat(output)).mode&0o777,0o700);for(const name of receipt.files)assert.equal((await stat(join(output,name))).mode&0o777,0o600);}
    const before=await readFile(join(output,'cloud.json'),'utf8');await assert.rejects(provision({output,origin:'https://other.example.com'}));assert.equal(await readFile(join(output,'cloud.json'),'utf8'),before);
    const profile=await loadProfile(join(output,'device.launch.json'));assert.equal(profile.mode,'device');
    const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='synthetic-secret-that-must-not-be-inherited';
    try{assert.equal(childEnvironment(profile).OPENAI_API_KEY,undefined);assert.equal(childEnvironment(profile).PI_CAFE_REMOTE_CONFIG,join(output,'device.json'));}finally{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
    await assert.rejects(run(['--profile',join(output,'cloud.launch.json'),'--pi-cli','/missing/cli.js']),/cannot own office Pi/);
    const invalid={...JSON.parse(await readFile(join(output,'device.launch.json'),'utf8')),host:'0.0.0.0'};await writeFile(join(output,'invalid.launch.json'),JSON.stringify(invalid));await assert.rejects(loadProfile(join(output,'invalid.launch.json')));
  }finally{await rm(parent,{recursive:true,force:true});}
});
test('public origins require TLS and cannot smuggle proxy configuration',()=>{
  for(const origin of ['http://example.com','https://user:secret@example.com','https://example.com/path','https://example.com/?key=secret','https://example.com/#secret'])assert.throws(()=>validateOrigin(origin));
  assert.equal(validateOrigin('https://cafe.example.com/'),'https://cafe.example.com');
  assert.equal(validateOrigin('http://127.0.0.1:12345'),'http://127.0.0.1:12345');
});
