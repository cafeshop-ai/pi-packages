import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {launch,baseEnv,until,audit} from './native-support.mjs';
const exec=promisify(execFile);
test('manual Stop refuses wrong marker, then stops only the retained dummy owner', {timeout:60000}, async()=>{
 assert.equal(process.platform,'win32');const root=await mkdtemp(fileURLToPath(new URL('../../.refactor/manual-stop-',import.meta.url)));let child;
 const before=await audit();
 try{
  for(const name of ['manual-runtime.mjs','manual-verify.mjs','native-support.mjs','native-process.ps1'])await copyFile(fileURLToPath(new URL('./'+name,import.meta.url)),join(root,name));
  await writeFile(join(root,'credentials.json'),JSON.stringify({format:'pi-cafe-space-manual-trial-v1',root,node:process.execPath}));
  const script=join(root,'owned-dummy.cjs');await writeFile(script,'setInterval(()=>{},1000);');
  child=await launch(process.execPath,[script],{marker:script,cwd:root,env:baseEnv(),stdio:'ignore'});
  const file=join(root,'service-owners.json');const entry={role:'relay',record:child.record,marker:'THIS_MARKER_IS_NOT_IN_THE_COMMAND',executable:process.execPath};await writeFile(file,JSON.stringify([entry]));
  await assert.rejects(exec(process.execPath,[join(root,'manual-runtime.mjs'),'stop'],{cwd:root,env:baseEnv(),timeout:20000}),e=>e.stderr.includes('Untrusted owner record retained'));
  assert.equal(child.child.exitCode,null);assert.equal(JSON.parse(await readFile(file,'utf8'))[0].marker,entry.marker);
  await writeFile(file,JSON.stringify([{...entry,marker:script}]));
  const result=await exec(process.execPath,[join(root,'manual-runtime.mjs'),'stop'],{cwd:root,env:baseEnv(),timeout:20000});assert.match(result.stdout,/Stopped only recorded trial processes/);
  await until(()=>child.child.exitCode!==null,'owned dummy exit');await assert.rejects(stat(file),e=>e.code==='ENOENT');
  assert.deepEqual((await audit()).listeners,before.listeners);
 }finally{if(child)await child.stop();await rm(root,{recursive:true,force:true});}
});
