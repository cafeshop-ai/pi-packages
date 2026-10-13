import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { hashRouterOnly } from './hash-router-only.mjs';
test('only the reviewed upstream framework loader is disabled, not arbitrary imports', async () => {
  const require = createRequire(import.meta.url); const root = dirname(require.resolve('react-router/package.json'));
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, '7.18.2');
  const directory = join(root, 'dist/development'); let matches = 0;
  for (const name of await readdir(directory)) {
    if (!/^chunk-.*\.mjs$/.test(name)) continue;
    const id = join(directory, name); const code = await readFile(id, 'utf8'); const plugin = hashRouterOnly();
    const transformed = plugin.transform(code, id); if (!transformed) continue;
    matches++; plugin.buildEnd();
    const replacement = /async function loadRouteModule\(\) \{[^\n]+?\}/.exec(transformed.code)[0];
    const loader = vm.runInNewContext(replacement + '; loadRouteModule');
    await assert.rejects(loader(), /disabled/);
    assert.throws(() => hashRouterOnly().transform(code.replace('route.id in routeModulesCache', 'route.id in changedCache'), id), /review required/);
    assert.equal(hashRouterOnly().transform(code, '/app/my-module.mjs'), null);
  }
  assert.equal(matches, 1); assert.throws(() => hashRouterOnly().buildEnd(), /exactly one/);
});
