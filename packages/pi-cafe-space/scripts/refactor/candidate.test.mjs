import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdtemp, rm, rename, copyFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { root, run } from './build.mjs';
import { stageRelease } from './release.mjs';
import { relayBinary, binaryMatches, platformTag, platforms } from './candidate-overrides/scripts/relay-path.mjs';
export async function freePort() { const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r)); return port; }
export async function waitHealth(base, child) { for (let i = 0; i < 80; i++) { if (child.exitCode !== null) throw Error('Owned relay exited before readiness'); try { const response = await fetch(base + '/healthz', { signal: AbortSignal.timeout(300) }); if (response.ok) return; } catch {} await new Promise(r => setTimeout(r, 50)); } throw Error('Owned relay readiness timeout'); }
test('candidate matrix/platform/checksum and self-contained scripts', async () => {
 const { target, metadata } = await stageRelease(); const binary = await relayBinary(target);
 assert.match(run(process.execPath, [join(target, 'scripts/verify-artifacts.mjs')]), /PASS/);
 assert.match(run(process.execPath, [join(target, 'scripts/source-verify.mjs'),'check']), /Prebuilt artifact verification only/);
 assert.match(run(process.execPath, [join(target, 'scripts/source-verify.mjs'),'test']), /Prebuilt artifact verification only/);
 assert.throws(() => platformTag('win32', 'arm64'));
 const different = platforms.find(tag => tag !== platformTag());
 assert.equal(binaryMatches(await readFile(binary), different), false);
 const missing = platforms.find(tag => !metadata.platforms[tag]);
 if (missing) {
  await assert.rejects(relayBinary(target, missing));
  await assert.rejects(stageRelease(true), /incomplete/);
 } else {
  await stageRelease(true);
 }
 const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')); assert.equal(manifest.private, true); assert.equal(manifest.engines.node, '>=22.19.0');assert.deepEqual(manifest.dependencies,{ws:'8.21.3'});assert.equal(manifest.devDependencies['@assistant-ui/core'],'0.3.17');
 for (const name of ['build-source.mjs','verify-artifacts.mjs','run-relay.mjs','start-relay.ps1','stop-relay.ps1','start-pi.ps1','remote/setup.mjs','remote/run.mjs']) await readFile(join(target,'scripts',name));
 assert.match(run(process.execPath,[join(target,'scripts/remote/setup.mjs'),'--help']),/--output/);
 assert.match(run(process.execPath,[join(target,'scripts/remote/run.mjs'),'--help']),/--profile/);
 assert.match(await readFile(join(target,'README.md'),'utf8'),/多设备、多人协作/);
 assert.throws(() => run(process.execPath, [join(target,'scripts/build-source.mjs')]), /complete source checkout/);
 assert.equal((await readdir(join(target, 'dist/relay'))).includes('index.js'), false);
});
test('mismatched Go source digests cannot enter a release', async () => {
 const path = join(root, '.refactor/bin', platformTag(), 'build.json');
 const before = await readFile(path, 'utf8');
 try {
  await writeFile(path, JSON.stringify({ ...JSON.parse(before), goDigest: '0'.repeat(64) }));
  await assert.rejects(stageRelease(), /Matrix binary identity\/platform\/checksum mismatch/);
 } finally {
  await writeFile(path, before);
 }
});
test('unknown release output is retained rather than deleted on restaging', async () => {
 const {target}=await stageRelease();const unknown=join(target,'user-owned.txt');await writeFile(unknown,'keep this file');
 try{await assert.rejects(stageRelease(),/Unknown release output retained/);assert.equal(await readFile(unknown,'utf8'),'keep this file');}
 finally{await rm(unknown);}
 await stageRelease();
});
test('fresh native binary serves embedded bytes without Node/Go, disk assets or writable executable', async () => {
 const { target, metadata } = await stageRelease(); const binary = await relayBinary(target);
 const directory = await mkdtemp(join(tmpdir(), 'cafe-binary-')); const local = join(directory, 'relay.exe'); await copyFile(binary, local); await chmod(local,0o555);
 const port = await freePort(); const base = `http://127.0.0.1:${port}`;
 const child = spawn(local, [], { cwd: directory, env: { SystemRoot: process.env.SystemRoot, PATH: '', PI_COLLAB_HOST: '127.0.0.1', PI_COLLAB_PORT: String(port), PI_COLLAB_HOST_TOKEN: 'fixture-host', PI_COLLAB_CLIENT_TOKEN: 'fixture-client' }, stdio: 'ignore' });
 try {
  await waitHealth(base,child); const entry = await fetch(base + '/'); assert.equal(entry.status,200); assert.match(entry.headers.get('content-security-policy'), /default-src 'self'/); assert.equal(entry.headers.get('cache-control'),'no-store');
  const html = await entry.text(); const script = /src="(\/assets\/[^\"]+\.js)"/.exec(html)[1];
  const js = await fetch(base+script); assert.match(js.headers.get('content-type'), /javascript/); assert.ok((await js.text()).includes('Framework route modules are disabled'));
  const head = await fetch(base+script,{method:'HEAD'}); assert.equal(head.status,200); assert.equal(await head.text(),'');
  for (const path of ['/asset-manifest.json','/assets/asset-manifest.json','/.env','/assets/no.map','/missing.js']) assert.equal((await fetch(base+path)).status,404);
  assert.equal(JSON.parse(run(local,['--version'], {env:{SystemRoot:process.env.SystemRoot,PATH:''}})).webDigest,metadata.webDigest);
  assert.deepEqual(await readdir(directory),['relay.exe']);
 } finally { if(child.exitCode===null) { const exit=once(child,'exit');child.kill();await exit; } await chmod(local,0o666);await rm(directory,{recursive:true,force:true}); }
});
test('without staged assets ordinary Go tests work, production tag fails rather than silently producing stub', async () => {
 const source = join(root,'relay/internal/webui/assets'); const backup=join(root,'.refactor/embedding-test-backup');
 await rename(source,backup);
 try { run('go',['test','./...'],{cwd:join(root,'relay')}); assert.throws(()=>run('go',['build','-tags','webembed','-o',join(root,'.refactor/must-not-build.exe'),'./cmd/pi-cafe-relay'],{cwd:join(root,'relay')}),/assets|no matching files/); }
 finally { await rename(backup,source); }
});
