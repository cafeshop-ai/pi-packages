import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=new URL('../',import.meta.url);
test('default scripts target the same Go/React release pipeline and legacy is explicit',async()=>{
 const manifest=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
 assert.equal(manifest.scripts.build,'node scripts/build.mjs');assert.equal(manifest.scripts.pack,manifest.scripts['remote:pack']);assert.equal(manifest.scripts.start,manifest.scripts.relay);
 assert(manifest.scripts['legacy:build'].includes('web/public'));assert.equal(manifest.scripts['legacy:relay'],'node dist/relay/index.js');
 const source=await readFile(new URL('scripts/build.mjs',root),'utf8');assert(source.includes('buildCandidate()'));assert(source.includes('stageRelease(false'));assert(!source.includes('npm pack'));
 const release=JSON.parse(await readFile(new URL('scripts/refactor/candidate-overrides/package-fields.json',root),'utf8'));assert.equal(release.scripts.relay,'node scripts/run-relay.mjs');
});
test('npm run pack reaches its verified packer despite the prepack lifecycle hook',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('scripts/prepack.mjs',root))],{encoding:'utf8',env:{...process.env,npm_command:'run-script'}});assert.equal(result.status,0);assert.equal(result.stderr,'');
});
test('packing a source checkout cannot silently publish stale legacy dist',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('scripts/prepack.mjs',root))],{encoding:'utf8',env:{...process.env,npm_command:'pack'}});assert.equal(result.status,1);assert(result.stderr.includes('npm run pack'));
});
