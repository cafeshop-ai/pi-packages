import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { localCredentialFile, readLocalHostToken } from './local-relay';
const directories: string[] = [];
afterEach(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); directories.length = 0; });
function fixture() { const directory = mkdtempSync(join(tmpdir(), 'cafe-credentials-test-')); directories.push(directory); return join(directory, 'credentials.json'); }
it('only resolves private credentials for a local relay and isolates ports', () => {
  for (const url of ['wss://example.com/ws', 'ws://example.com/ws', 'ws://user:pass@localhost/ws', 'ws://localhost/ws?x=1']) expect(localCredentialFile(url, {})).toBeNull();
  expect(localCredentialFile('ws://localhost:37891/ws', { HOME: '/test-home' })).toBe(join('/test-home', '.config', 'pi-cafe-space', 'credentials-37891.json'));
  expect(() => localCredentialFile('ws://localhost:37891/ws', { PI_CAFE_CREDENTIALS_FILE: 'relative.json' })).toThrow();
});
it('reads a newly created local host token without exposing the browser token', () => {
  const path = fixture(), url = 'ws://127.0.0.1:37891/ws';
  expect(readLocalHostToken(path, url)).toBeNull();
  const hostToken = randomBytes(32).toString('base64url');
  writeFileSync(path, JSON.stringify({ version: 1, port: 37891, hostToken, clientToken: 'browser-only-fixture' }), { mode: 0o600 });
  expect(readLocalHostToken(path, url)).toBe(hostToken);
  expect(() => readLocalHostToken(path, 'ws://localhost:37892/ws')).toThrow();
});
it('never falls back from malformed, linked or publicly readable credentials', () => {
  const path = fixture(), url = 'ws://localhost:37891/ws';
  writeFileSync(path, 'invalid JSON', { mode: 0o600 });
  expect(() => readLocalHostToken(path, url)).toThrow();
  if (process.platform !== 'win32') {
    const linked = path + '.link'; symlinkSync(path, linked); expect(() => readLocalHostToken(linked, url)).toThrow();
    chmodSync(path, 0o644); expect(() => readLocalHostToken(path, url)).toThrow('private');
  }
});
