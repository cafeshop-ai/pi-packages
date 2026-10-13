import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, readFile, writeFile, readdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, run } from './build.mjs';
import { stageRelease } from './release.mjs';
const exec=promisify(execFile);
const powershell=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const ps=(file,args=[])=>exec(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,...args],{timeout:45000,maxBuffer:1024*1024});
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
test('native Windows launch race, real CIM ownership, PID/nonce/path fences, readonly locks and cleanup',async()=>{
 const {target}=await stageRelease();const directory=await mkdtemp(join(root,'.refactor/launcher-check-'));const packageRoot=join(directory,'owned package');await cp(target,packageRoot,{recursive:true});
 const api=await import(pathToFileURL(join(packageRoot,'dist/extension/local-relay-go.js')).href);
 const runtime=join(packageRoot,'.runtime-go');let owner;let denied=false;let user;
 try {
  const port=await freePort();const config={relayUrl:`ws://127.0.0.1:${port}/ws`,hostToken:'fixture-host'};
  const results=await Promise.all([api.ensureLocalRelay(config,{packageRoot,environment:{SystemRoot:process.env.SystemRoot,PI_COLLAB_CLIENT_TOKEN:'fixture-client'}}),ps(join(packageRoot,'scripts/start-relay.ps1'),['-Port',String(port),'-HostToken','fixture-host','-ClientToken','fixture-client'])]);
  assert.ok(['started','already_running'].includes(results[0]));
  const names=(await readdir(runtime)).filter(n=>n.endsWith('.json'));assert.equal(names.length,1);
  const marker=join(runtime,names[0]);const raw=await readFile(marker,'utf8');owner=JSON.parse(raw);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,200);
  assert.equal(await api.ownerRequest(packageRoot,'Stop',owner.pid,{...owner,creation:'1'}),false);
  assert.equal(await api.ownerRequest(packageRoot,'Stop',owner.pid,{...owner,instance:'0'.repeat(32)}),false);
  assert.equal(await api.ownerRequest(packageRoot,'Stop',owner.pid,{...owner,executable:join(directory,'wrong.exe')}),false);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status,200);
  await writeFile(marker,JSON.stringify({...owner,creation:'1'}));await ps(join(packageRoot,'scripts/stop-relay.ps1'));
  assert.equal(JSON.parse(await readFile(marker,'utf8')).creation,'1');assert.ok(await api.ownerRequest(packageRoot,'Query',owner.pid));
  await writeFile(marker,raw);await ps(join(packageRoot,'scripts/stop-relay.ps1'));await assert.rejects(readFile(marker));
  assert.equal(await api.ownerRequest(packageRoot,'Query',owner.pid),null);owner=undefined;
  const blockedPort=await freePort();const blocked={relayUrl:`ws://127.0.0.1:${blockedPort}/ws`,hostToken:'fixture-host'};
  const lock=join(runtime,`relay.127.0.0.1-${blockedPort}.lock`);await writeFile(lock,'unknown-owner');await chmod(lock,0o444);
  assert.equal(await api.ensureLocalRelay(blocked,{packageRoot}),'unavailable');assert.equal(await readFile(lock,'utf8'),'unknown-owner');await chmod(lock,0o666);await rm(lock);
  user=run(powershell,['-NoProfile','-Command','[Security.Principal.WindowsIdentity]::GetCurrent().Name']).trim();
  run('icacls.exe',[runtime,'/deny',`${user}:(W)`]);denied=true;
  assert.equal(await api.ensureLocalRelay(blocked,{packageRoot}),'unavailable');
  run('icacls.exe',[runtime,'/remove:d',user]);denied=false;
  assert.deepEqual(await readdir(runtime),[]);
  // Legacy markers are not deleted or converted by candidate stop.
  await writeFile(join(packageRoot,'.relay.pid'),String(process.pid));await ps(join(packageRoot,'scripts/stop-relay.ps1'));assert.equal(await readFile(join(packageRoot,'.relay.pid'),'utf8'),String(process.pid));
 } finally {
  if(denied)run('icacls.exe',[runtime,'/remove:d',user]);
  if(owner){const stopped=await api.ownerRequest(packageRoot,'Stop',owner.pid,owner);if(!stopped && await api.ownerRequest(packageRoot,'Query',owner.pid))throw Error('Owned test process could not be cleaned up');}
  await rm(directory,{recursive:true,force:true});
 }
});
test('PowerShell5.1 parsing and arbitrary PiArgs/environment restoration with a function shim, no real Pi',async()=>{
 const {target}=await stageRelease();const dir=await mkdtemp(join(root,'.refactor/piargs-check-'));
 try {
  const output=join(dir,'args.json');const wrapper=join(dir,'check.ps1');const start=join(target,'scripts/start-pi.ps1');
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  await writeFile(wrapper,`\uFEFF$ErrorActionPreference='Stop'\n$paths=Get-ChildItem -LiteralPath ${quote(join(target,'scripts'))} -Filter *.ps1\nforeach($p in $paths){$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile($p.FullName,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'PowerShell parse failed'}}\n$env:PI_COLLAB_ROOM='before';$env:PI_COLLAB_HOST_TOKEN='before-token'\nfunction global:pi { $args | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 -LiteralPath ${quote(output)}; if($env:PI_COLLAB_ROOM -cne 'fixture'){throw 'missing child environment'};throw 'synthetic-pi-failure' }\ntry { & ${quote(start)} -Room fixture -HostToken fixture-host -PiArgs @('--model','model with spaces','a"b','x;y','$literal','中文');throw 'shim did not throw' } catch {if($_.Exception.Message -notmatch 'synthetic-pi-failure'){throw}}\nif($env:PI_COLLAB_ROOM -cne 'before' -or $env:PI_COLLAB_HOST_TOKEN -cne 'before-token'){throw 'environment not restored'}\nWrite-Output 'PASS: shim args and environment restored'\n`,'utf8');
  assert.match((await ps(wrapper)).stdout,/PASS/);
  assert.deepEqual(JSON.parse((await readFile(output,'utf8')).replace(/^\uFEFF/,'')),['--collab','--model','model with spaces','a"b','x;y','$literal','中文']);
  const code=await readFile(start,'utf8');assert.ok(!code.includes('npm run build'));
  await writeFile(wrapper,`\uFEFF$ErrorActionPreference='Stop'\n. ${quote(join(target,'scripts/process-owner.ps1'))}\nfunction Get-GoRecord { param([int]$IdValue) return $null }\nif(Stop-GoOwned $PID 'C:\\unverifiable.exe' '00000000000000000000000000000000' '1'){throw 'stopped without identity'}\n$env:PI_COLLAB_ROOM='before'\nfunction global:pi { $global:LASTEXITCODE=37 }\n& ${quote(start)} -Room fixture -PiArgs @('--version')\nif($LASTEXITCODE -ne 37 -or $env:PI_COLLAB_ROOM -cne 'before'){throw 'exit code or environment changed'}\nWrite-Output 'PASS: exit 37 and unavailable identity'\nexit 37\n`,'utf8');
  await assert.rejects(ps(wrapper),error=>error.code===37 && error.stdout.includes('PASS: exit 37'));
 } finally {await rm(dir,{recursive:true,force:true});}
});
