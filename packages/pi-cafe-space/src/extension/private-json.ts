import fs from 'node:fs';
import { dirname } from 'node:path';

/** Read a small private JSON file without following a leaf symlink or accepting a replaced file. */
export function readPrivateJSON(path: string): Record<string, unknown> {
  let directory: number | undefined, file: number | undefined;
  try {
    // Windows path stat can report dev=0; the parent HANDLE supplies the real volume ID.
    if (process.platform === 'win32') directory = fs.openSync(dirname(path), 'r');
    const volume = directory === undefined ? undefined : fs.fstatSync(directory, { bigint: true }).dev;
    const before = fs.lstatSync(path, { bigint: true });
    const privateFile = (stat: fs.BigIntStats) => stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384n &&
      (process.platform === 'win32' || (stat.mode & 0o077n) === 0n && stat.uid === BigInt(process.getuid!()));
    if (!privateFile(before)) throw Error('Private JSON must be a private regular file');
    file = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(file, { bigint: true });
    if (!privateFile(opened) || opened.ino !== before.ino || opened.dev !== (volume ?? before.dev) ||
        before.dev !== 0n && opened.dev !== before.dev || opened.size !== before.size) throw Error('Private JSON file identity changed');
    const bytes = Buffer.alloc(16385);
    let size = 0, count: number;
    while (size < bytes.length && (count = fs.readSync(file, bytes, size, bytes.length - size, null)) > 0) size += count;
    const after = fs.fstatSync(file, { bigint: true });
    if (size > 16384 || BigInt(size) !== opened.size || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) throw Error('Private JSON changed while reading');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Private JSON must be an object');
    return value as Record<string, unknown>;
  } finally {
    try { if (file !== undefined) fs.closeSync(file); } finally { if (directory !== undefined) fs.closeSync(directory); }
  }
}
