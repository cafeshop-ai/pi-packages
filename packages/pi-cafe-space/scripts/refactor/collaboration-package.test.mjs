import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { releaseFiles } from './release.mjs';

test('release allowlist includes the independent room bridge without source, tests or credentials', () => {
 const files = releaseFiles(['windows-amd64']);
 assert.deepEqual(files.filter(file => file.startsWith('dist/collaboration/')), ['client', 'extension', 'listener'].map(name => 'dist/collaboration/' + name + '.js'));
 assert(!files.some(file => file.startsWith('src/') || file.includes('.test.') || file.endsWith('.map') || file.includes('credentials') || file.includes('member.json')));
 assert(files.includes('dist/extension/private-json.js'));
 assert(files.includes('scripts/space-agent.mjs'), 'the universal client must be available in the installed package');
 assert(files.includes('scripts/collaboration-goal.mjs'), 'the universal client must include its Goal dependency');
});
test('the package keeps the original default entry and declares the bridge host-provided schema peer', async () => {
 const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
 assert.deepEqual(manifest.pi.extensions, ['./dist/extension/index.js']);
 assert.equal(manifest.peerDependencies.typebox, '*');
 assert.equal(manifest.dependencies.typebox, undefined);
 const lock = JSON.parse(await readFile(new URL('../../../../package-lock.json', import.meta.url), 'utf8'));
 assert.equal(lock.packages['packages/pi-cafe-space'].peerDependencies.typebox, '*');
});
