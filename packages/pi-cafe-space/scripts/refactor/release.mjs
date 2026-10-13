import { mkdir, readFile, writeFile, readdir, cp, copyFile, rm, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, sha, treeDigest } from './build.mjs';
import { validateAssets, ordinaryDirectory } from './assets.mjs';
import { binaryMatches, platforms } from './candidate-overrides/scripts/relay-path.mjs';
const runtimeScripts = ['build-source.mjs','process-owner.ps1','relay-path.mjs','run-relay.mjs','source-verify.mjs','start-pi.ps1','start-relay.ps1','stop-relay.ps1','verify-artifacts.mjs'];
const remoteScripts = ['setup.mjs', 'run.mjs', 'room-setup.mjs', 'room-run.mjs', 'room-bootstrap.mjs', 'install-client.mjs', 'configure-server.mjs', 'doctor.mjs'];
export function releaseFiles(tags) {
 if (!tags.length || tags.some(tag=>!platforms.includes(tag))) throw Error('Invalid release platforms');
 return ['package.json','README.md','INSTALL.md','AI_INSTALL.md','LICENSE','THIRD-PARTY-NOTICES.txt','dist/relay/build.json',
  ...['index','connection-warning','file-commands','private-json','local-relay','local-relay-go','cafe','cafe-actions','cafe-client','cafe-render','cafe-approvals','cafe-owner-client','thinking-capability','execution-tracker'].map(name=>`dist/extension/${name}.js`),'dist/protocol/index.js','dist/protocol/execution.js',
  ...tags.map(tag=>`dist/relay/bin/${tag}/pi-cafe-relay${tag.startsWith('windows')?'.exe':''}`),
  ...runtimeScripts.map(name=>`scripts/${name}`),...remoteScripts.map(name=>`scripts/remote/${name}`),...['build.mjs','assets.mjs','hash-router-only.mjs'].map(name=>`scripts/build-tools/${name}`),'scripts/build-tools/licenses/metadata-only.json'].sort();
}
async function inventory(directory,allowed,prefix='') {
 const files=[];
 for (const entry of await readdir(directory,{withFileTypes:true})) {
  const path=join(directory,entry.name);const name=prefix+entry.name;
  if(!allowed.has(name+(entry.isDirectory()?'/':'')))throw Error('Unknown release output retained');
  const stat=await lstat(path);
  if(stat.isSymbolicLink())throw Error('Unknown linked release output retained');
  if(stat.isDirectory()){files.push(`${name}/`,...await inventory(path,allowed,`${name}/`));}
  else if(stat.isFile()&&stat.nlink===1)files.push(name);else throw Error('Unknown release output retained');
 }
 return files;
}
export async function stageRelease(requireAll = false, selectedTags) {
 if (selectedTags && (!selectedTags.length || selectedTags.some(tag => !platforms.includes(tag)) || new Set(selectedTags).size !== selectedTags.length)) throw Error('Invalid release platform selection');
 const base = join(root, '.refactor'); const build = JSON.parse(await readFile(join(base, 'build.json'), 'utf8'));
 if (await treeDigest(join(base, 'ts')) !== build.tsDigest) throw Error('TypeScript staging is stale; rebuild');
 if (!/^[a-f0-9]{64}$/.test(build.goDigest ?? '') || await treeDigest(join(root, 'relay')) !== build.goDigest) throw Error('Go staging is stale; rebuild');
 const assets = await validateAssets(join(base, 'web')); if (assets.manifest.digest !== build.webDigest) throw Error('Web staging is stale; rebuild');
 const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
 if (build.version !== manifest.version) throw Error('Build version is stale');
 const records = {}; const missing = [];
 for (const platform of platforms) {
  if (selectedTags && !selectedTags.includes(platform)) { missing.push(platform); continue; }
  let record; try { record = JSON.parse(await readFile(join(base, 'bin', platform, 'build.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; missing.push(platform); continue; }
  const filename = platform.startsWith('windows') ? 'pi-cafe-relay.exe' : 'pi-cafe-relay'; const path = join(base, 'bin', platform, filename);
  await ordinaryDirectory(join(base, 'bin', platform)); const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw Error('Invalid matrix binary');
  const bytes = await readFile(path);
  if (record.platform !== platform || record.goDigest !== build.goDigest || record.tsDigest !== build.tsDigest || record.webDigest !== build.webDigest || record.version !== build.version || sha(bytes) !== record.sha256 || !binaryMatches(bytes, platform)) throw Error('Matrix binary identity/platform/checksum mismatch');
  records[platform] = record;
 }
 if (!records[build.platform] || requireAll && missing.length) throw Error(`Required platform matrix incomplete: ${missing.join(', ')}`);
 const parent = join(base, 'release'); await mkdir(parent, { recursive: true }); await ordinaryDirectory(parent);
 const target = join(parent, 'package');
 try {
  await ordinaryDirectory(target);
  const allowed=new Set(['.candidate-owned',...releaseFiles(platforms)]);
  for(const name of [...allowed]){const parts=name.split('/');parts.pop();while(parts.length){allowed.add(parts.join('/')+'/');parts.pop();}}
  await inventory(target,allowed);
  const marker=join(target,'.candidate-owned');
  if((await lstat(marker)).size!==Buffer.byteLength('pi-cafe-candidate-v1') || await readFile(marker,'utf8')!=='pi-cafe-candidate-v1')throw Error('Refusing unowned release directory');
  await rm(target, { recursive: true });
 } catch (error) { if (error.code !== 'ENOENT') throw error; }
 await mkdir(target); await writeFile(join(target, '.candidate-owned'), 'pi-cafe-candidate-v1');
 for (const folder of ['extension', 'protocol']) await cp(join(base, 'ts', folder), join(target, 'dist', folder), { recursive: true, dereference: false });
 for (const [platform] of Object.entries(records)) {
  const filename = platform.startsWith('windows') ? 'pi-cafe-relay.exe' : 'pi-cafe-relay'; const directory = join(target, 'dist/relay/bin', platform); await mkdir(directory, { recursive: true }); await copyFile(join(base, 'bin', platform, filename), join(directory, filename));
 }
 const metadata = { version: build.version, webDigest: build.webDigest, platforms: records, unverifiedPlatforms: missing };
 await writeFile(join(target, 'dist/relay/build.json'), JSON.stringify(metadata, null, 2));
 const scripts = join(target, 'scripts'); await mkdir(scripts);
 const sourceScripts=join(root,'scripts/refactor/candidate-overrides/scripts');
 if(JSON.stringify((await readdir(sourceScripts)).sort())!==JSON.stringify(runtimeScripts))throw Error('Unexpected candidate script source');
 for (const file of runtimeScripts) await copyFile(join(sourceScripts, file), join(scripts, file));
 await mkdir(join(scripts, 'remote'));
 for (const file of remoteScripts) await copyFile(join(root, 'scripts/remote', file), join(scripts, 'remote', file));
 const tools = join(scripts, 'build-tools'); await mkdir(tools);
 for (const file of ['build.mjs', 'assets.mjs', 'hash-router-only.mjs']) await copyFile(join(root, 'scripts/refactor', file), join(tools, file));
 await mkdir(join(tools,'licenses'));await copyFile(join(root,'scripts/refactor/licenses/metadata-only.json'),join(tools,'licenses/metadata-only.json'));
 const overlay = JSON.parse(await readFile(join(root, 'scripts/refactor/candidate-overrides/package-fields.json'), 'utf8'));
 if (manifest.private !== true || manifest.engines.node !== '>=22.19.0') throw Error('Unexpected package privacy/engine policy');
 const dependencies = {}; const development = { ...manifest.dependencies, ...manifest.devDependencies, ...overlay.sourceBuildPins };
 for (const name of overlay.runtimeDependencies) { if (!manifest.dependencies[name]) throw Error('Unknown runtime dependency'); dependencies[name] = manifest.dependencies[name]; delete development[name]; }
 // React/Vite are compiled into the executable, not Node runtime dependencies.
 // This also prevents an installed prebuilt extension from resolving a fresh,
 // unnecessary assistant-ui dependency graph. Source builds use locked tools.
 const candidate = { ...manifest, scripts: overlay.scripts, files: overlay.files, dependencies, devDependencies: development };
 await writeFile(join(target, 'package.json'), JSON.stringify(candidate, null, 2));
 await copyFile(join(root, 'LICENSE'), join(target, 'LICENSE')); await copyFile(join(base, 'THIRD-PARTY-NOTICES.txt'), join(target, 'THIRD-PARTY-NOTICES.txt'));
 await writeFile(join(target, 'README.md'), `# Pi Cafe Space candidate\n\nPrivate prebuilt candidate ${build.version}. Platforms built into this package (not a claim of runtime testing on every platform): ${Object.keys(records).join(', ')}. Web digest: ${build.webDigest}.\n\nRun the matching dist/relay/bin binary directly; no Node or Go runtime is required for that executable. The Pi extension requires Node >=22.19.0 and the Pi peer package. No installation or production switching is performed by this package. Source builds require the full source checkout plus its locked Node and Go toolchains. Build/prepack deliberately refuse an installed artifact without source; do not implicitly build at Pi startup.\n\nOptional independent background sessions (Windows, macOS and Linux implementations; consult the acceptance report for actually tested platforms): set PI_COLLAB_MANAGED_CONFIG to an absolute local JSON config path. This requires a loopback bind and distinct strong explicit host/client tokens. Config keys: node (absolute executable), cli (absolute native Pi CLI file), extension (this package dist/extension/index.js), agentDir (existing native Pi settings/credentials directory), stateDir (existing dedicated manager directory), env (explicit OS/tool environment, no NODE_OPTIONS/NODE_PATH or PI_COLLAB_*), projects (up to 16 objects with id, name, room, cwd). No browser-supplied command/path is accepted. A new session starts a separate native RPC Pi; it never switches an existing client. The manager retains a bounded registry (100 entries, 8 running), owns only its spawned Windows Job trees or POSIX supervisor process groups and never writes Pi JSONL. Closing a managed instance stops its tasks/tools; native saved history remains available via Open. Relay restarts leave sessions stopped. Empty-session names are retained on graceful close; a crash before the first turn follows native unsaved setup semantics. Background Pi loads only this explicit collaboration extension, not discovered third-party extensions, and uses --offline/--no-approve (no automatic startup network or project trust approval). Explicit later user prompts still use native configured providers. Read source docs/MANAGED_SESSIONS.md for setup and boundaries.\n\nOther platforms and real Pi/Chrome are not certified by deterministic tests. See THIRD-PARTY-NOTICES.txt; two upstream MIT packages ship metadata/README without a separate copyright/license file, explicitly noted there.\n`);
 for (const guide of ['INSTALL.md', 'AI_INSTALL.md']) await copyFile(join(root, 'docs', guide), join(target, guide));
 const roomGuide = await readFile(join(root, 'docs/ROOMS.md'), 'utf8');
 const remoteGuide = (await readFile(join(root, 'docs/REMOTE_ACCESS.md'), 'utf8')).replaceAll('(refactor/REMOTE_ACCEPTANCE.md)', '(#remote-acceptance)');
 const acceptance = await readFile(join(root, 'docs/refactor/REMOTE_ACCEPTANCE.md'), 'utf8');
 await writeFile(join(target, 'README.md'), (await readFile(join(target, 'README.md'), 'utf8')) + '\n\n## Install\n\nRead [INSTALL.md](INSTALL.md), or give [AI_INSTALL.md](AI_INSTALL.md) and this verified package to your installation assistant. Choose the public service or your own Docker server.\n\n---\n\n' + roomGuide + '\n---\n\n## Legacy remote mode and local setup\n\n' + remoteGuide + '\n\n## Remote acceptance\n\n' + acceptance);
 return { target, metadata };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await stageRelease(process.argv.includes('--require-all'))));
