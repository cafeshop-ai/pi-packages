import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { root, run } from './build.mjs';
import { stageRelease } from './release.mjs';
test('the final source build/prepack implementation works in an isolated source copy, not live dist', async () => {
 const { target } = await stageRelease(); const copy = await mkdtemp(join(root, '.refactor/source-check-'));
 try {
  for (const folder of ['src','web','relay','protocol']) await cp(join(root,folder),join(copy,folder),{recursive:true,filter:path => !/(?:[\\/]node_modules|[\\/]webui[\\/]assets)(?:[\\/]|$)/.test(path)});
  const overlay=JSON.parse(await readFile(join(root,'scripts/refactor/candidate-overrides/extension-import.json'),'utf8'));
  const entry=join(copy,'src/extension/index.ts');const code=await readFile(entry,'utf8');assert.equal(code.split(overlay.from).length,2);await writeFile(entry,code.replace(overlay.from,overlay.to));
  for (const file of ['package.json','LICENSE']) await cp(join(target,file),join(copy,file));
  await cp(join(root,'vitest.config.ts'),join(copy,'vitest.config.ts'));
  await cp(join(target,'scripts'),join(copy,'scripts'),{recursive:true});
  const base=JSON.parse(await readFile(join(root,'../../tsconfig.base.json'),'utf8')); const ts=JSON.parse(await readFile(join(root,'tsconfig.json'),'utf8'));
  await writeFile(join(copy,'tsconfig.json'),JSON.stringify({...ts,extends:undefined,compilerOptions:{...base.compilerOptions,...ts.compilerOptions}}));
  const result=run(process.execPath,[join(copy,'scripts/build-source.mjs')],{cwd:copy,timeout:180000});
  assert.match(result,/pi-cafe-build-v1/);
  assert.match(await readFile(join(copy,'dist/extension/index.js'),'utf8'),/from ["']\.\/local-relay-go\.js["']/);
  assert.match(run(process.execPath,[join(copy,'scripts/verify-artifacts.mjs')],{cwd:copy}),/PASS/);
  run(process.execPath,[join(copy,'scripts/source-verify.mjs'),'check'],{cwd:copy,timeout:120000});
  run(process.execPath,[join(copy,'scripts/source-verify.mjs'),'test'],{cwd:copy,timeout:120000});
 } finally { await rm(copy,{recursive:true,force:true}); }
});
