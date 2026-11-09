import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { releaseFiles } from './release.mjs';

test('release allowlist includes the independent room bridge without source, tests or credentials', () => {
 const files = releaseFiles(['windows-amd64']);
 assert(files.includes('MANAGED_SESSIONS.md'));
 assert.deepEqual(files.filter(file => file.startsWith('dist/collaboration/')), ['client', 'commands', 'extension', 'listener'].map(name => 'dist/collaboration/' + name + '.js'));
 assert(!files.some(file => file.startsWith('src/') || file.includes('.test.') || file.endsWith('.map') || file.includes('credentials') || file.includes('member.json')));
 assert(files.includes('dist/extension/private-json.js'));
 assert(files.includes('scripts/space-agent.mjs'), 'the universal client must be available in the installed package');
 assert(files.includes('scripts/collaboration-goal.mjs'), 'the universal client must include its Goal dependency');
 assert(files.includes('scripts/listener-events.mjs'), 'the Pi bridge must include its shared event formatter');
});
test('the bridge shared script imports exist in the release allowlist', async () => {
 const files = releaseFiles(['windows-amd64']);
 const sources = await Promise.all(['client.ts', 'extension.ts'].map(name => readFile(new URL('../../src/collaboration/' + name, import.meta.url), 'utf8')));
 const scripts = [...sources.join('\n').matchAll(/from ['"]\.\.\/\.\.\/(scripts\/[^'"]+\.mjs)['"]/g)].map(match => match[1]);
 assert(scripts.includes('scripts/collaboration-goal.mjs'));
 assert(scripts.includes('scripts/listener-events.mjs'));
 for (const script of scripts) { assert(files.includes(script), script); await readFile(new URL('../../' + script, import.meta.url)); }
});
test('release packages the managed ACP host and target enumerator without offline-test fixtures', () => {
 const files=releaseFiles(['windows-amd64']);
 const runtime=files.filter(file=>file.startsWith('scripts/acp/'));
 assert.deepEqual(runtime,[
  'scripts/acp/adapter.mjs','scripts/acp/probe.mjs','scripts/acp/shared-bridge.mjs','scripts/acp/shared-check.mjs',
  'scripts/acp/shared-policy.mjs','scripts/acp/shared-probe.mjs','scripts/acp/space-host.mjs','scripts/acp/space-run.mjs','scripts/acp/targets.mjs',
 ].sort());
 assert(!runtime.some(file=>file.includes('.test.')||file.endsWith('README.md')));
});
test('the package keeps the original default entry and declares the bridge host-provided schema peer', async () => {
 const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
 assert.deepEqual(manifest.pi.extensions, ['./dist/extension/index.js']);
 assert.equal(manifest.peerDependencies.typebox, '*');
 assert.equal(manifest.dependencies.typebox, undefined);
 const lock = JSON.parse(await readFile(new URL('../../../../package-lock.json', import.meta.url), 'utf8'));
 assert.equal(lock.packages['packages/pi-cafe-space'].peerDependencies.typebox, '*');
});
