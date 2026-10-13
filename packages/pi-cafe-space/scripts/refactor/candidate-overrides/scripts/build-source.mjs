import { access, cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const input of ['src/extension/index.ts', 'web/vite.config.ts', 'relay/go.mod', 'tsconfig.json']) {
  try { await access(join(root, input)); } catch { throw Error('Source build requires the complete source checkout and Node/Go toolchains; this prebuilt package never builds implicitly'); }
}
const { buildCandidate } = await import('./build-tools/build.mjs');
const record = await buildCandidate();
// Only this explicit source build promotes artifacts. Migration never invokes
// this script in the live source root; it exists solely in candidate overlays.
const dist = join(root, 'dist'); await rm(dist, { recursive: true, force: true });
for (const part of ['extension', 'protocol']) await cp(join(root, '.refactor/ts', part), join(dist, part), { recursive: true });
const bin = join(dist, 'relay/bin', record.platform); await mkdir(bin, { recursive: true });
await cp(join(root, '.refactor/bin', record.platform), bin, { recursive: true });
await writeFile(join(dist, 'relay/build.json'), JSON.stringify({ version: record.version, webDigest: record.webDigest, platforms: { [record.platform]: record } }));
