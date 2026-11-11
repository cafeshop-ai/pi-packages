import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, copyFile, rm, rename, open, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { build as bundle } from 'esbuild';
import { stageAssets, ordinaryDirectory } from './assets.mjs';
import { hashRouterOnly } from './hash-router-only.mjs';
export const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
export const sha = data => createHash('sha256').update(data).digest('hex');
export async function treeDigest(directory, prefix = '') {
  const entries = [];
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    if (item.isSymbolicLink()) throw Error('Unexpected staging link');
    const path = join(directory, item.name); const name = prefix + item.name;
    if (item.isDirectory()) entries.push([name, await treeDigest(path)]); else entries.push([name, sha(await readFile(path))]);
  }
  return sha(JSON.stringify(entries));
}
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw Error(`${command} failed (${result.status}): ${result.error?.message ?? result.stderr ?? ''}`);
  return result.stdout;
}
export function platformTag(platform = process.platform, arch = process.arch) {
  const tags = { 'win32-x64': 'windows-amd64', 'linux-x64': 'linux-amd64', 'linux-arm64': 'linux-arm64', 'darwin-x64': 'darwin-amd64', 'darwin-arm64': 'darwin-arm64' };
  const value = tags[`${platform}-${arch}`]; if (!value) throw Error('Unsupported relay platform'); return value;
}
async function sourceCopy(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = join(from, entry.name); const dest = join(to, entry.name);
    if (entry.isSymbolicLink()) throw Error('Source links are not build inputs');
    if (entry.isDirectory()) await sourceCopy(src, dest);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) await copyFile(src, dest);
  }
}
async function notices(ids) {
  const records = new Map();
  for (const id of ids) {
    if (id.includes('\0') || !id.replaceAll('\\', '/').includes('/node_modules/')) continue;
    let directory = dirname(id.split('?')[0]);
    while (directory !== dirname(directory)) {
      try {
        const data = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (!data.name || !data.version) { directory = dirname(directory); continue; }
        records.set(`${data.name}@${data.version}`, { directory, license: data.license ?? 'see package license' }); break;
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; directory = dirname(directory); }
    }
  }
  // Tailwind resolves CSS imports before Rollup sees module IDs. Their license
  // notices must still accompany the embedded, compiled stylesheet.
  for (const name of ['tailwindcss', 'tw-animate-css']) {
    let found = false;
    for (const modules of require.resolve.paths(name) ?? []) {
      try {
        const directory = join(modules, name);
        const data = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        records.set(`${data.name}@${data.version}`, { directory, license: data.license }); found = true; break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!found) throw Error(`CSS dependency missing: ${name}`);
  }
  const go = run('go', ['list', '-m', '-json', 'all'], { cwd: join(root, 'relay') });
  for (const text of go.match(/\{[\s\S]*?\n\}/g) ?? []) { const m = JSON.parse(text); if (!m.Main && m.Dir) records.set(`${m.Path}@${m.Version}`, { directory: m.Dir, license: 'see upstream license below' }); }
  const missing = [];
  const metadataOnly = JSON.parse(await readFile(new URL('./licenses/metadata-only.json', import.meta.url), 'utf8'));
  const mit = (await readFile(join(root, 'LICENSE'), 'utf8')).split('Permission is hereby granted')[1];
  if (!mit) throw Error('MIT reference terms missing');
  const result = ['Third-party notices for the embedded Web, terminal utilities and Go relay. Pi runtime dependencies retain their own package licenses.',
    '\n## shadcn/ui — local Base Nova registry components\n' + await readFile(join(root, 'web/src/components/ui/shadcn/LICENSE'), 'utf8')];
  for (const [name, record] of [...records].sort(([a], [b]) => a.localeCompare(b))) {
    const files = (await readdir(record.directory)).filter(name => /^(LICENSE|LICENCE|COPYING|NOTICE)(\.[\w-]+)?$/i.test(name));
    result.push(`\n## ${name}\nDeclared license: ${record.license}`);
    for (const file of files) { const stat = await lstat(join(record.directory, file)); if (!stat.isFile() || stat.size > 512 * 1024) throw Error('Invalid license file'); result.push(await readFile(join(record.directory, file), 'utf8')); }
    if (!files.length) {
      const reviewed = metadataOnly[name];
      if (!reviewed || reviewed.license !== record.license || record.license !== 'MIT') { missing.push(name); continue; }
      result.push(`The reviewed npm package supplies no standalone root license file. Its published source revision is ${reviewed.gitHead}. Attribution from package metadata or source headers: ${reviewed.attribution}. Repository: ${reviewed.repository}. The upstream README follows; standard MIT terms are reproduced without inventing an upstream copyright notice.`);
      result.push(await readFile(join(record.directory, 'README.md'), 'utf8'));
      result.push('MIT License\n\nPermission is hereby granted' + mit);
    }
  }
  if (missing.length) throw Error(`License text missing for ${missing.join(', ')}`);
  return result.join('\n');
}
// The files agents download from the server, each bundled into one file that imports only Node
// built-ins: the official room listener (docs/LISTENER.md) and the Pi room bridge (the cafe collab
// extension, src/collaboration/extension.ts), which Pi loads from its extensions directory. The
// relay embeds them with one manifest, and the room guide names each SHA-256 so an agent can check
// a download before running or loading it. The listener protocol version comes from LISTENER.md.
export async function bundleAgentFiles(version, directory = join(root, 'relay/internal/agentdist')) {
  const protocol = /^# .* v(\d+\.\d+)\s*$/m.exec(await readFile(join(root, 'docs/LISTENER.md'), 'utf8'))?.[1];
  if (!protocol) throw Error('docs/LISTENER.md does not name a listener protocol version');
  const files = [
    { name: 'space-agent.mjs', entry: 'scripts/space-agent.mjs', protocol, banner: `// space-agent ${version}, listener protocol ${protocol}, bundled from scripts/space-agent.mjs` },
    { name: 'cafe-room.js', entry: 'src/collaboration/extension.ts', banner: `// Café Space Pi room bridge ${version}, bundled from src/collaboration/extension.ts; it does nothing until a room is bound` },
  ];
  const entries = [];
  for (const file of files) {
    const outfile = join(directory, file.name);
    await bundle({ entryPoints: [join(root, file.entry)], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
      legalComments: 'none', logLevel: 'silent', banner: { js: file.banner } });
    const body = await readFile(outfile);
    // Only Node built-ins may stay imports: anything else would need an installation the guide does not allow.
    for (const [, specifier] of body.toString('utf8').matchAll(/^import\b[^'"]*['"]([^'"]+)['"]/gm)) if (!specifier.startsWith('node:')) throw Error(`${file.name} imports ${specifier}`);
    run(process.execPath, ['--check', outfile]);
    entries.push({ name: file.name, ...(file.protocol ? { protocol: file.protocol } : {}), bytes: body.length, sha256: sha(body) });
  }
  const record = { format: 'pi-cafe-space-agent-v2', version, files: entries };
  await writeFile(join(directory, 'agent.json'), JSON.stringify(record));
  return record;
}
export async function buildCandidate() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 19) throw Error('Node >=22.19.0 required');
  const output = join(root, '.refactor'); await mkdir(output, { recursive: true }); await ordinaryDirectory(output);
  const lockPath = join(output, 'build.lock'); const lock = await open(lockPath, 'wx');
  try {
    await rm(join(output, 'build.json'), { force: true });
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const ids = new Set();
    await build({ configFile: join(root, 'web/vite.config.ts'), plugins: [hashRouterOnly(), { name: 'cafe-license-inventory', generateBundle() { for (const id of this.getModuleIds()) ids.add(id); } }] });
    const assets = await stageAssets(join(output, 'web'), join(root, 'relay/internal/webui/assets'));
    const agent = await bundleAgentFiles(manifest.version);
    const tag = platformTag(); const exe = tag.startsWith('windows') ? 'pi-cafe-relay.exe' : 'pi-cafe-relay';
    const binDir = join(output, 'bin', tag); await mkdir(binDir, { recursive: true }); await ordinaryDirectory(binDir);
    console.log(run('go', ['test', '-tags', 'webembed', './...'], { cwd: join(root, 'relay'), env: { ...process.env, CGO_ENABLED: '0' } }));
    const binary = join(binDir, exe); const next = join(binDir, `${exe}.next`);
    run('go', ['build', '-trimpath', '-buildvcs=false', '-tags', 'webembed', '-ldflags', `-X main.version=${manifest.version}`, '-o', next, './cmd/pi-cafe-relay'], { cwd: join(root, 'relay'), env: { ...process.env, CGO_ENABLED: '0' } });
    const identity = JSON.parse(run(next, ['--version']));
    if (identity.webDigest !== assets.digest || identity.platform !== tag || identity.version !== manifest.version) throw Error('Binary does not match this Web build');
    await rename(next, binary);
    const source = join(output, 'source'); await mkdir(source, { recursive: true }); await ordinaryDirectory(source);
    await rm(join(source, 'src'), { recursive: true, force: true }); await sourceCopy(join(root, 'src'), join(source, 'src'));
    for (const directory of [join(source, 'scripts'), join(output, 'scripts')]) {
      await mkdir(directory, { recursive: true });
      for (const file of ['collaboration-goal.mjs', 'collaboration-goal.d.mts', 'listener-events.mjs', 'listener-events.d.mts']) await copyFile(join(root, 'scripts', file), join(directory, file));
    }
    try {
      const overlay = JSON.parse(await readFile(join(root, 'scripts/refactor/candidate-overrides/extension-import.json'), 'utf8'));
      const path = join(source, 'src/extension/index.ts'); const code = await readFile(path, 'utf8');
      if (code.split(overlay.from).length !== 2) throw Error('Extension overlay no longer matches once');
      await writeFile(path, code.replace(overlay.from, overlay.to));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(join(source, 'package.json'), '{"type":"module","private":true}');
    await writeFile(join(source, 'tsconfig.json'), JSON.stringify({ extends: join(root, 'tsconfig.json'), compilerOptions: { rootDir: './src', outDir: '../ts', sourceMap: false, declaration: false }, include: ['./src/**/*.ts'], exclude: ['**/*.test.ts'] }));
    await rm(join(output, 'ts'), { recursive: true, force: true });
    console.log(run(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(source, 'tsconfig.json')]));
    const terminal = await bundle({ entryPoints: [join(source, 'src/extension/cafe-render.ts')], outfile: join(output, 'ts/extension/cafe-render.js'), bundle: true, external: ['@earendil-works/pi-tui'], format: 'esm', platform: 'node', target: 'node22', treeShaking: true, metafile: true, logLevel: 'warning' });
    for (const input of Object.keys(terminal.metafile.inputs)) ids.add(resolve(input));
    await writeFile(join(output, 'THIRD-PARTY-NOTICES.txt'), await notices(ids));
    const record = { format: 'pi-cafe-build-v1', ...identity, sha256: sha(await readFile(binary)), agentSha256: agent.files[0].sha256, piBridgeSha256: agent.files[1].sha256, goVersion: run('go', ['version']).trim(), goDigest: await treeDigest(join(root, 'relay')), nodeVersion: process.version, binary: `bin/${tag}/${exe}`, tsDigest: await treeDigest(join(output, 'ts')), createdAt: new Date().toISOString() };
    await writeFile(join(binDir, 'build.json'), JSON.stringify(record, null, 2));
    await writeFile(join(output, 'build.json'), JSON.stringify(record, null, 2)); console.log(JSON.stringify(record)); return record;
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildCandidate();
