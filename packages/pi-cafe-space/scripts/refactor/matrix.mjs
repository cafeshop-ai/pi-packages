import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, run, sha, treeDigest } from './build.mjs';
import { ordinaryDirectory, validateAssets } from './assets.mjs';
import { binaryMatches, platforms } from './candidate-overrides/scripts/relay-path.mjs';

export function parsePlatforms(value = '') {
  if (typeof value !== 'string') throw Error('Platforms must be a comma-separated string');
  if (value === '') return [];
  const tags = value.split(',');
  if (tags.length > platforms.length || tags.some(tag => !platforms.includes(tag)) || new Set(tags).size !== tags.length) {
    throw Error('Unsupported or duplicate platform');
  }
  return tags;
}

// Call after buildCandidate. The native build remains authoritative for the
// shared Web and extension. Foreign executables are inspected, never executed.
export async function buildAdditionalPlatforms(tags) {
  const selected = parsePlatforms(tags.join(','));
  if (!selected.length) return [];
  const base = join(root, '.refactor');
  await ordinaryDirectory(base);
  const lockPath = join(base, 'build.lock');
  const lock = await open(lockPath, 'wx');
  try {
    const primary = JSON.parse(await readFile(join(base, 'build.json'), 'utf8'));
    if (!platforms.includes(primary.platform) || primary.format !== 'pi-cafe-build-v1') throw Error('Native candidate build required');
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const assets = await validateAssets(join(base, 'web'));
    if (!/^[a-f0-9]{64}$/.test(primary.goDigest ?? '') || primary.goDigest !== await treeDigest(join(root, 'relay')) || primary.version !== manifest.version || primary.webDigest !== assets.manifest.digest || primary.tsDigest !== await treeDigest(join(base, 'ts'))) {
      throw Error('Stale native candidate; rebuild before cross-compiling');
    }
    const records = [];
    for (const tag of selected) {
      if (tag === primary.platform) continue;
      const [goos, goarch] = tag.split('-');
      const directory = join(base, 'bin', tag);
      await mkdir(directory, { recursive: true });
      await ordinaryDirectory(directory);
      const temporary = await mkdtemp(join(directory, '.matrix-'));
      try {
        const filename = tag.startsWith('windows') ? 'pi-cafe-relay.exe' : 'pi-cafe-relay';
        const output = join(temporary, filename);
        run('go', ['build', '-trimpath', '-buildvcs=false', '-tags', 'webembed', '-ldflags', `-X main.version=${manifest.version}`, '-o', output, './cmd/pi-cafe-relay'], {
          cwd: join(root, 'relay'),
          env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
        });
        const bytes = await readFile(output);
        if (bytes.length > 64 * 1024 * 1024 || !binaryMatches(bytes, tag)) throw Error('Cross-compiled binary platform mismatch');
        const record = {
          ...primary, platform: tag, binary: `bin/${tag}/${filename}`,
          sha256: sha(bytes), createdAt: new Date().toISOString(), verification: 'cross-compiled-not-runtime-tested',
        };
        await writeFile(join(temporary, 'build.json'), JSON.stringify(record, null, 2));
        await rename(output, join(directory, filename));
        await rename(join(temporary, 'build.json'), join(directory, 'build.json'));
        records.push(record);
        console.log(JSON.stringify({ platform: tag, sha256: record.sha256, verification: record.verification }));
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    return records;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
