import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertRelayOwner, assertUpdateScope, digest, replaceVerifiedFile } from './relay-update-safety.mjs';

test('relay-only update rejects Pi/Chrome, mismatched identity and extra arguments', () => {
  const binary = 'C:\\trial\\pi-cafe-relay.exe';
  const marker = 'a'.repeat(32);
  const record = { pid: 42, creation: '123', executable: binary, commandLine: `"${binary}" --instance=${marker}` };
  const entry = { role: 'relay', marker, executable: binary, record };
  assertRelayOwner(entry, record, binary, [{ LocalPort: 37983, OwningProcess: 42 }]);
  for (const role of ['pi', 'chrome']) assert.throws(() => assertRelayOwner({ ...entry, role }, record, binary, []));
  for (const change of [{ creation: '456' }, { pid: 43 }, { commandLine: record.commandLine + ' --extra' }, { executable: 'C:\\node.exe' }]) {
    assert.throws(() => assertRelayOwner(entry, { ...record, ...change }, binary, [{ LocalPort: 37983, OwningProcess: 42 }]));
  }
  assert.throws(() => assertRelayOwner(entry, record, binary, [{ LocalPort: 37983, OwningProcess: 99 }]));
});

test('only the embedded Relay, its metadata and generated README may change', () => {
  const allowed = ['README.md', 'dist/relay/build.json', 'dist/relay/bin/windows-amd64/pi-cafe-relay.exe'];
  assertUpdateScope(allowed);
  const radix = [...allowed, 'package.json'];
  assertUpdateScope(radix, [...allowed, 'package.json']);
  for (const file of ['dist/extension/index.js', '../credentials.json']) assert.throws(() => assertUpdateScope([...radix, file], [...allowed, 'package.json']));
  assert.throws(() => assertUpdateScope([...allowed, 'package.json']));
  assert.throws(() => assertUpdateScope(['README.md']));
  assert.throws(() => assertUpdateScope([...allowed, 'README.md']));
});

test('verified replacement is atomic, detects a concurrent change, and supports rollback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cafe-relay-update-test-'));
  const file = join(directory, 'artifact');
  try {
    await writeFile(file, 'old');
    await assert.rejects(replaceVerifiedFile(file, digest('not-old'), Buffer.from('new')));
    assert.equal(await readFile(file, 'utf8'), 'old');
    await replaceVerifiedFile(file, digest('old'), Buffer.from('new'));
    assert.equal(await readFile(file, 'utf8'), 'new');
    await replaceVerifiedFile(file, digest('new'), Buffer.from('old'));
    assert.equal(await readFile(file, 'utf8'), 'old');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
