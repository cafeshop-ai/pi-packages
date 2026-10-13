// Explicit, one-item local Pi registration; no model/provider settings changes.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rename,copyFile,lstat} from 'node:fs/promises';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {root,sha,run} from '../build.mjs';
import {baseEnv} from '../native-support.mjs';
const agent=process.env.CAFE_LEGACY_AGENT_DIR;
assert(agent&&isAbsolute(agent),'Set CAFE_LEGACY_AGENT_DIR to the intended absolute Pi agent directory');
const destination=resolve(agent,'cafe-space-local');const trial=join(root,'.refactor/manual-trial');
const reports=join(root,'.refactor/reports/R18-registration');await mkdir(reports,{recursive:true});
const phase=process.argv[2];
if(phase==='prepare'){
 await mkdir(destination);await writeFile(join(destination,'.owned-by-pi-cafe-space'),'local-registration-v1',{flag:'wx'});
 await writeFile(join(destination,'package.json'),JSON.stringify({private:true,type:'module'}),{flag:'wx'});
 // Rename the trial's relay-credential file to a basename already denied by
 // the frozen remote file policy before registering hosts rooted in this repo.
 for(const [source,name] of [[join(root,'scripts/refactor/manual-runtime.mjs'),'manual-runtime.mjs'],[join(root,'scripts/refactor/manual-verify.mjs'),'manual-verify.mjs'],[join(root,'scripts/refactor/manual-trial/pi-console.ps1'),'pi-console.ps1']]){
  const desired=await readFile(source,'utf8');const installed=await readFile(join(trial,name),'utf8');assert.equal(installed.replaceAll('trial.json','credentials.json'),desired,'Unknown installed helper edits; retained');
 }
 await lstat(join(trial,'credentials.json')).then(()=>{throw Error('Credential destination exists; retained');},e=>{if(e.code!=='ENOENT')throw e;});
 await rename(join(trial,'trial.json'),join(trial,'credentials.json'));
 for(const [source,name] of [[join(root,'scripts/refactor/manual-runtime.mjs'),'manual-runtime.mjs'],[join(root,'scripts/refactor/manual-verify.mjs'),'manual-verify.mjs'],[join(root,'scripts/refactor/manual-trial/pi-console.ps1'),'pi-console.ps1']])await copyFile(source,join(trial,name));
 const readme=join(trial,'README.txt');await writeFile(readme,(await readFile(readme,'utf8')).replaceAll('trial.json','credentials.json'));
 for(const name of ['extension.ts','defaults.ts','README.md'])await copyFile(fileURLToPath(new URL('./'+name,import.meta.url)),join(destination,name));
 await writeFile(join(destination,'connection.json'),JSON.stringify({format:'pi-cafe-space-local-registration-v1',credentialsFile:join(trial,'credentials.json')},null,2),{flag:'wx'});
 console.log('Prepared local registration files. Global settings not changed yet; running processes untouched.');
}else if(phase==='activate'){
 assert.equal(await readFile(join(destination,'.owned-by-pi-cafe-space'),'utf8'),'local-registration-v1');
 const smoke=JSON.parse(await readFile(join(reports,'smoke.json'),'utf8'));assert.equal(smoke.status,'passed');assert.equal(smoke.hosts,2);assert.equal(smoke.modelCalls,0);assert.equal(smoke.cleaned,true);
 for(const name of ['extension.ts','defaults.ts'])assert.equal(sha(await readFile(join(destination,name))),smoke.sourceHashes[name]);
 const settings=join(agent,'settings.json');const info=await lstat(settings);assert.ok(info.isFile()&&!info.isSymbolicLink());const before=await readFile(settings,'utf8');const original=JSON.parse(before);
 const matches=original.packages.map((p,i)=>typeof p==='string'&&resolve(agent,p).toLowerCase()===resolve(root).toLowerCase()?i:-1).filter(i=>i>=0);assert.equal(matches.length,1,'Exactly the existing Cafe Space local package must be selected');const index=matches[0];
 const oldEntry=original.packages[index];const newEntry=join(destination,'extension.ts');const needle=JSON.stringify(oldEntry);assert.equal(before.split(needle).length,2,'Ambiguous settings source; retained');
 const after=before.replace(needle,JSON.stringify(newEntry));const expected=structuredClone(original);expected.packages[index]=newEntry;assert.deepEqual(JSON.parse(after),expected);
 const backup=join(destination,'registration-backup.json');await writeFile(backup,JSON.stringify({format:'pi-cafe-space-registration-backup-v1',oldEntry,newEntry,settingsShaBefore:sha(before),settingsShaAfter:sha(after),timestamp:new Date().toISOString()},null,2),{flag:'wx'});
 const staged=settings+'.cafe-space-new';await writeFile(staged,after,{flag:'wx'});
 // Keep any explicit settings ACL while replacing only this one JSON string.
 const ps=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');const aclScript=join(reports,'settings-acl.ps1');await writeFile(aclScript,`$ErrorActionPreference='Stop'\n$acl=Get-Acl -LiteralPath '${settings.replaceAll("'","''")}'\nSet-Acl -LiteralPath '${staged.replaceAll("'","''")}' -AclObject $acl\n`);
 run(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',aclScript],{env:baseEnv(),timeout:15000});assert.equal(await readFile(settings,'utf8'),before,'Concurrent settings edit; staged change retained, original untouched');await rename(staged,settings);
 assert.deepEqual(JSON.parse(await readFile(settings,'utf8')),expected);
 await writeFile(join(reports,'activation.json'),JSON.stringify({status:'activated',changedSetting:'packages['+index+']',oldEntry,newEntry,otherSettingsUnchanged:true,providerSettingsChanged:false,runningPiReloaded:false,modelCalls:0},null,2));
 console.log('Activated only the Cafe Space package entry. Future normal Pi starts auto-register; existing Pi require user /reload.');
}else throw Error('Expected prepare or activate');
