// No sessions, sockets, global settings or model calls: Pi's actual loader only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const piRoot = process.env.PI_CAFE_TEST_PI_ROOT;
for (const embedded of [false, true]) test(`local registration reloads entry/dependencies (${embedded ? 'embedded SDK, removed Pi directory' : 'native Pi loader'})`, { skip: !embedded && !piRoot, timeout: 60000 }, async () => {
  const { loadExtensions, clearExtensionCache } = embedded ? {} : await import(pathToFileURL(join(resolve(piRoot), 'dist/core/extensions/loader.js')).href);
  const { createJiti } = createRequire(import.meta.url)('jiti');
  const SessionManager = class {};
  // Like the installed adapter, retain its workspace dependencies, not Pi's
  // former global installation. No global SDK path exists in embedded mode.
  const work = await mkdtemp(fileURLToPath(new URL('../../../.refactor/registration-reload-', import.meta.url)));
  try {
    const candidate = join(work, 'node_modules', '@cafecodework', 'pi-cafe-space');
    await mkdir(join(candidate, 'dist', 'extension'), { recursive: true });
    await writeFile(join(work, 'package.json'), '{"type":"module"}');
    await writeFile(join(candidate, 'package.json'), '{"type":"module"}');
    for (const name of ['extension.ts', 'defaults.ts']) await copyFile(name === 'extension.ts' && process.env.PI_CAFE_TEST_REGISTRATION ? process.env.PI_CAFE_TEST_REGISTRATION : new URL(name, import.meta.url), join(work, name));
    await writeFile(join(work, 'connection.json'), JSON.stringify({ format: 'pi-cafe-space-local-registration-v1', credentialsFile: join(work, 'credentials.json') }));
    await writeFile(join(work, 'credentials.json'), JSON.stringify({ format: 'pi-cafe-space-manual-trial-v1', package: candidate, room: 'reload-test', hostToken: 'synthetic-host-token-for-test', clientToken: 'synthetic-client-token-for-test' }));
    const entry = join(candidate, 'dist', 'extension', 'index.js');
    const dependency = join(candidate, 'dist', 'extension', 'helper.js');
    const load = async expected => {
      clearExtensionCache?.();
      if (embedded) {
        const loader = createJiti(import.meta.url, { moduleCache: false, virtualModules: { '@earendil-works/pi-coding-agent': { SessionManager } }, alias: { '@earendil-works/pi-coding-agent': join(work, 'removed-pi', 'dist', 'index.js') } });
        const factory = await loader.import(join(work, 'extension.ts'), { default: true });
        const commands = [], sdk = [];
        await factory({ registerCommand: name => commands.push(name), on: (event, handler) => { if (event === 'test-sdk') sdk.push(handler()); } });
        assert.deepEqual(commands, [expected]);
        assert.deepEqual(sdk, [SessionManager], 'candidate must reuse embedded Pi SDK, not another on-disk instance');
      } else {
        const result = await loadExtensions([join(work, 'extension.ts')], work);
        assert.deepEqual(result.errors, []);
        assert.deepEqual([...result.extensions[0].commands.keys()], [expected]);
        result.runtime.invalidate?.();
      }
    };
    await writeFile(dependency, 'export const version = "old";');
    const sdkCheck = 'import { SessionManager } from "@earendil-works/pi-coding-agent";';
    await writeFile(entry, sdkCheck + 'import { version } from "./helper.js"; export default pi => { pi.on("test-sdk", () => SessionManager); pi.registerCommand("old-" + version, { handler: async () => {} }); };');
    // An already-running Pi has the legacy native ESM graph cached.
    await import(pathToFileURL(entry).href);
    await load('old-old');
    await writeFile(dependency, 'export const version = "new";');
    await writeFile(entry, sdkCheck + 'import { version } from "./helper.js"; export default pi => { pi.on("test-sdk", () => SessionManager); pi.registerCommand("new-" + version, { handler: async () => {} }); };');
    await load('new-new');
    await load('new-new');
    // Dependency-only changes must also be picked up (entry URL unchanged).
    await writeFile(dependency, 'export const version = "third";');
    await load('new-third');
  } finally { await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
