import { readFileSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as piSdk from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { localDefaults, type LocalConnection } from './defaults.ts';
function readJson(path: string) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw Error('Invalid local registration file');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export default async function (pi: ExtensionAPI) {
  let connection: LocalConnection;
  let entry: string;
  try {
    const setup = readJson(join(dirname(fileURLToPath(import.meta.url)), 'connection.json'));
    if (setup.format !== 'pi-cafe-space-local-registration-v1' || typeof setup.credentialsFile !== 'string') throw Error();
    const trial = readJson(setup.credentialsFile);
    if (trial.format !== 'pi-cafe-space-manual-trial-v1' || typeof trial.package !== 'string' || typeof trial.room !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(trial.room) || ![trial.hostToken, trial.clientToken].every(v => typeof v === 'string' && v.length >= 16 && v.length <= 4096)) throw Error();
    connection = { relayUrl: 'ws://127.0.0.1:37983/ws', room: trial.room, hostToken: trial.hostToken, clientToken: trial.clientToken };
    entry = join(trial.package, 'dist/extension/index.js');
  } catch { throw Error('Pi Cafe Space local registration configuration unavailable; private details suppressed'); }
  // Native import() keeps old ESM modules across /reload, including relative
  // dependencies. Use this retained workspace's jiti, not the running Pi's
  // installation (pnpm can remove it during an upgrade while Pi stays alive).
  const { createJiti } = createRequire(entry)('jiti');
  const loader = createJiti(entry, {
    moduleCache: false, tryNative: false,
    transformModules: ['@cafecodework/pi-cafe-space'],
    nativeModules: ['ws'],
    // Pi supplies this import, including its embedded SDK in bundled builds.
    virtualModules: { '@earendil-works/pi-coding-agent': piSdk },
  });
  // Use the synchronous transformer: jiti.import() may still select native
  // ESM caching for .js files even with moduleCache disabled.
  const candidate: { default: (api: ExtensionAPI) => void } = loader(entry);
  const applied = new Map<string, { previous: string | undefined; value: string }>();
  // Flags are fully parsed by session_start. Register this hook before the
  // candidate's startup hook so explicit remote flags never inherit local keys.
  pi.on('session_start', () => {
    for (const [key, value] of Object.entries(localDefaults(connection, process.env, pi.getFlag('collab-relay'), pi.getFlag('collab-room')))) {
      if (!applied.has(key)) applied.set(key, { previous: process.env[key], value });
      process.env[key] = value;
    }
  });
  pi.on('session_shutdown', () => {
    for (const [key, state] of applied) if (process.env[key] === state.value) {
      if (state.previous === undefined) delete process.env[key]; else process.env[key] = state.previous;
    }
    applied.clear();
  });
  candidate.default(pi);
}
