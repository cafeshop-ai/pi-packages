// Run separately after installing the tarball in an isolated directory; no real provider is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { server, key } from './helpers.mjs';

test('installed tarball runs in an isolated Pi CLI without workspace dependency resolution', {timeout:30000},async t=>{
  assert.ok(process.env.PI_WS_PACKAGE_TEST_DIR,'Set PI_WS_PACKAGE_TEST_DIR to the isolated npm install directory.');
  const install=await realpath(process.env.PI_WS_PACKAGE_TEST_DIR);
  const extension=join(install,'node_modules','@cafeshop-ai','pi-responses-ws');
  assert.equal(await realpath(extension),resolve(extension),'Installed extension must not be a workspace symlink.');
  const dir=await mkdtemp(join(tmpdir(),'pi-ws-packed-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const s=await server(t);
  await writeFile(join(dir,'models.json'),JSON.stringify({providers:{alternate:{baseUrl:s.baseUrl,api:'openai-responses',apiKey:key,models:[{id:'fixture',reasoning:false,input:['text'],contextWindow:32768,maxTokens:128}]}}}));
  await writeFile(join(dir,'settings.json'),JSON.stringify({transport:'websocket-cached',retry:{enabled:false},compaction:{enabled:false},cacheWarming:'off',enableInstallTelemetry:false}));
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,HOME:dir,USERPROFILE:dir,PI_CODING_AGENT_DIR:dir,NO_PROXY:'*',PI_SKIP_VERSION_CHECK:'1'};
  const cli=join(install,'node_modules','@earendil-works','pi-coding-agent','dist','bundle','cli.js');
  const child=spawn(process.execPath,[cli,'--mode','json','--print','--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-themes','--no-tools','--no-approve','-e',extension,'--model','alternate/fixture','Say hello.'],{cwd:dir,env,stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill());let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,0,stderr+'\n'+stdout);assert.ok(stdout.includes('hello 世界🙂'));assert.equal(s.requests.length,1);assert.equal(s.requests[0].transport,'websocket');assert.equal(s.sockets.size,0);
});
