import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readPrivateJSON } from './private-json';
const dirs: string[] = [];
function fixture() { const dir = fs.mkdtempSync(join(tmpdir(), 'cafe-private-json-')); dirs.push(dir); const path = join(dir, 'private.json'); fs.writeFileSync(path, '{"ok":true}', { mode: 0o600 }); return path; }
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
it('reads private JSON and preserves missing-file errors', () => {
  const path = fixture(); expect(readPrivateJSON(path)).toEqual({ ok: true }); expect(() => readPrivateJSON(path + '.missing')).toThrow();
});
it.runIf(process.platform === 'win32')('accepts a zero path device ID using the directory handle volume, not a skipped device check', () => {
  const path = fixture(), original = fs.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => { const stat = original(...args)!; return Object.assign(stat, { dev: 0n }); }) as typeof fs.lstatSync);
  expect(readPrivateJSON(path)).toEqual({ ok: true });
});
it.each(['ino', 'dev'] as const)('rejects changed %s and closes all opened handles', field => {
  const path = fixture(), original = fs.fstatSync;
  vi.spyOn(fs, 'fstatSync').mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => { const stat = original(...args)!; if (stat.isFile()) Object.assign(stat, { [field]: BigInt(stat[field]!) + 1n }); return stat; }) as typeof fs.fstatSync);
  const opened = vi.spyOn(fs, 'openSync'), closed = vi.spyOn(fs, 'closeSync');
  expect(() => readPrivateJSON(path)).toThrow('identity changed');
  expect(closed.mock.calls.map(c => c[0]).sort()).toEqual(opened.mock.results.filter(r => r.type === 'return').map(r => r.value).sort());
});
it('uses exact bigint inode comparisons above Number.MAX_SAFE_INTEGER', () => {
  const path = fixture(), original = fs.lstatSync, opened = fs.fstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => Object.assign(original(...args)!, { ino: 2n ** 60n })) as typeof fs.lstatSync);
  vi.spyOn(fs, 'fstatSync').mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => { const stat = opened(...args); if (stat.isFile()) Object.assign(stat, { ino: 2n ** 60n + 1n }); return stat; }) as typeof fs.fstatSync);
  expect(() => readPrivateJSON(path)).toThrow('identity changed');
});
it('rejects leaf links, oversized files, malformed UTF-8 and non-object JSON', () => {
  const path = fixture(); fs.symlinkSync(path, path + '.link'); expect(() => readPrivateJSON(path + '.link')).toThrow('private regular file');
  for (const data of [Buffer.alloc(16385), Buffer.from([0xff]), Buffer.from('[]'), Buffer.from('null')]) { fs.writeFileSync(path, data); expect(() => readPrivateJSON(path)).toThrow(); }
});
it('rejects file growth after validation with a bounded read', () => {
  const path = fixture(), original = fs.readSync; let once = false;
  vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => { if (!once) { once = true; fs.appendFileSync(path, ' '.repeat(20000)); } return original(...args); }) as typeof fs.readSync);
  expect(() => readPrivateJSON(path)).toThrow('changed while reading');
});
it.runIf(process.platform !== 'win32')('rejects public permissions', () => { const path = fixture(); fs.chmodSync(path, 0o644); expect(() => readPrivateJSON(path)).toThrow('private'); });
