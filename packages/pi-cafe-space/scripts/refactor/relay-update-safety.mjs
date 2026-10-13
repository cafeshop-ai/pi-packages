// Safety primitives for the explicitly authorized, local Relay-only update.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function regularBytes(path) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 64 * 1024 * 1024, 'Untrusted update file');
  return readFile(path);
}
export function assertRelayOwner(entry, actual, binary, listeners) {
  assert.equal(entry?.role, 'relay');
  assert.match(entry.marker, /^[a-f0-9]{32}$/);
  assert.equal(entry.executable.toLowerCase(), binary.toLowerCase());
  assert.equal(entry.record.executable.toLowerCase(), binary.toLowerCase());
  assert.deepEqual(actual, entry.record, 'Relay owner changed; retained');
  assert.ok([`${binary} --instance=${entry.marker}`, `"${binary}" --instance=${entry.marker}`].some(value => value.toLowerCase() === actual.commandLine.trim().toLowerCase()), 'Unexpected Relay command');
  const owners = listeners.filter(item => item.LocalPort === 37983);
  assert.ok(owners.length > 0 && owners.every(item => item.OwningProcess === actual.pid), 'Unexpected listener owner');
}
export function assertUpdateScope(changed, expected = ['README.md', 'dist/relay/bin/windows-amd64/pi-cafe-relay.exe', 'dist/relay/build.json']) {
  assert.deepEqual([...changed].sort(), [...expected].sort());
}
export async function replaceVerifiedFile(path, expectedHash, bytes) {
  assert.equal(digest(await regularBytes(path)), expectedHash, 'Concurrent file change; retained');
  const temporary = `${path}.relay-update-${randomBytes(12).toString('hex')}`;
  let created = false;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' }); created = true;
    assert.equal(digest(await regularBytes(path)), expectedHash, 'Concurrent file change; retained');
    await rename(temporary, path);
    created = false;
  } finally {
    if (created) await unlink(temporary);
  }
}
