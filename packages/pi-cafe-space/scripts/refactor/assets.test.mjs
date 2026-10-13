import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAssets, stageAssets } from './assets.mjs';
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'cafe-assets-'));
  const source = join(root, 'web'); const target = join(root, 'embedded');
  await mkdir(join(source, 'assets'), { recursive: true });
  await writeFile(join(source, 'index.html'), '<!doctype html><script type="module" src="/assets/index-abcdefgh.js"></script><link rel="stylesheet" href="/assets/index-abcdefgh.css"><link rel="manifest" href="/manifest.webmanifest">');
  await writeFile(join(source, 'assets/index-abcdefgh.js'), 'export const version = 1;');
  await writeFile(join(source, 'assets/index-abcdefgh.css'), 'body { margin: 0; }');
  await writeFile(join(source, 'manifest.webmanifest'), JSON.stringify({ icons: [{ src: '/icon.svg' }] }));
  await writeFile(join(source, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  try { await fn({ root, source, target }); } finally { await rm(root, { recursive: true, force: true }); }
}
test('validates exact reachable assets, hashes and stages a private manifest', () => fixture(async ({ source, target }) => {
  const checked = await validateAssets(source);
  assert.equal(checked.manifest.entries.length, 5);
  assert.match(checked.manifest.digest, /^[a-f0-9]{64}$/);
  await stageAssets(source, target);
  const manifest = JSON.parse(await readFile(join(target, 'asset-manifest.json'), 'utf8'));
  assert.deepEqual(manifest, checked.manifest);
  assert.equal(manifest.entries.some(e => e.name === 'asset-manifest.json'), false);
}));
test('rejects missing, empty, unrecognized or orphan assets and invalid references', () => fixture(async ({ source, target }) => {
  await assert.rejects(validateAssets(join(source, 'missing')));
  await writeFile(join(source, 'extra.map'), 'source map'); await assert.rejects(validateAssets(source)); await rm(join(source, 'extra.map'));
  await writeFile(join(source, '.env'), 'synthetic'); await assert.rejects(validateAssets(source)); await rm(join(source, '.env'));
  await writeFile(join(source, 'assets/orphan-abcdefgh.js'), 'export const orphan = true;'); await assert.rejects(validateAssets(source), /unreferenced/); await rm(join(source, 'assets/orphan-abcdefgh.js'));
  await writeFile(join(source, 'assets/index-abcdefgh.js'), 'import "./missing-abcdefgh.js";'); await assert.rejects(validateAssets(source), /reference/);
  await writeFile(join(source, 'assets/index-abcdefgh.js'), 'import "https://example.invalid/a.js";'); await assert.rejects(validateAssets(source), /reference/);
  await writeFile(join(source, 'index.html'), ''); await assert.rejects(stageAssets(source, target));
}));
test('follows static/dynamic JS imports and CSS url references, rejecting inline scripts', () => fixture(async ({ source }) => {
  await writeFile(join(source, 'assets/child-abcdefgh.js'), 'export const child = true;');
  await writeFile(join(source, 'assets/index-abcdefgh.js'), 'export async function load() { return import("./child-abcdefgh.js"); }');
  assert.equal((await validateAssets(source)).manifest.entries.length, 6);
  await writeFile(join(source, 'assets/index-abcdefgh.css'), 'body { background: url("./missing-abcdefgh.png"); }'); await assert.rejects(validateAssets(source), /reference/);
  await writeFile(join(source, 'index.html'), '<script>alert(1)</script>'); await assert.rejects(validateAssets(source), /inline|entry/);
}));
test('accepts Tailwind selector escapes but rejects escaped or external CSS resource syntax', () => fixture(async ({ source }) => {
  await writeFile(join(source, 'assets/index-abcdefgh.css'), String.raw`.hover\:bg-primary:hover,.w-1\/2 { color: red; } @media (min-width: 40rem) { .sm\:flex { display: flex; } }`);
  assert.equal((await validateAssets(source)).manifest.entries.length, 5);
  for (const css of [
    '@import "https://example.invalid/a.css";',
    String.raw`@\69mport "https://example.invalid/a.css";`,
    'a { background: url(https://example.invalid/a.png) }',
    String.raw`a { background: \75rl(https://example.invalid/a.png) }`,
    String.raw`a { background: url("\68ttps://example.invalid/a.png") }`,
    'a { background: url(./missing-abcdefgh.png) }',
    'a { background: url("unterminated) }',
  ]) {
    await writeFile(join(source, 'assets/index-abcdefgh.css'), css);
    await assert.rejects(validateAssets(source));
  }
}));
test('rejects links/junctions without following or deleting their target', () => fixture(async ({ root, source, target }) => {
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'keep');
  const linked = join(root, 'linked'); await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateAssets(linked));
  await symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stageAssets(source, target));
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
}));
test('enforces 4MiB file and 16MiB aggregate limits without changing them', () => fixture(async ({ source }) => {
  await writeFile(join(source, 'assets/index-abcdefgh.js'), 'x'.repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(validateAssets(source), /file budget/);
  await writeFile(join(source, 'assets/index-abcdefgh.js'), 'x'.repeat(4 * 1024 * 1024));
  for (let i = 0; i < 4; i++) await writeFile(join(source, `assets/large${i}-abcdefgh.js`), 'x'.repeat(4 * 1024 * 1024));
  await assert.rejects(validateAssets(source), /total budget/);
}));
test('bounds asset counts and preserves unknown files in an otherwise owned output', () => fixture(async ({ source, target }) => {
  await stageAssets(source, target); await writeFile(join(target, 'keep.txt'), 'user-owned');
  await assert.rejects(stageAssets(source, target), /unowned/);
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'user-owned');
  for (let index = 0; index < 257; index++) await writeFile(join(source, `assets/entry${index}-abcdefgh.js`), 'export const x = 1;');
  await assert.rejects(validateAssets(source), /count budget/);
}));
test('invalidates owned prior staging on failure but refuses unknown destination data', () => fixture(async ({ source, target }) => {
  await mkdir(target); await writeFile(join(target, 'keep.txt'), 'unowned');
  await assert.rejects(stageAssets(source, target));
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'unowned');
  await rm(target, { recursive: true }); await stageAssets(source, target);
  await writeFile(join(source, 'extra.map'), 'bad'); await assert.rejects(stageAssets(source, target));
  await assert.rejects(readFile(join(target, 'asset-manifest.json')));
}));
