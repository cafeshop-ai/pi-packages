import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlatforms } from './matrix.mjs';

test('matrix defaults to the native build and accepts explicit server/office targets', () => {
  assert.deepEqual(parsePlatforms(), []);
  assert.deepEqual(parsePlatforms('linux-amd64,windows-amd64'), ['linux-amd64', 'windows-amd64']);
  assert.deepEqual(parsePlatforms('darwin-arm64,linux-arm64'), ['darwin-arm64', 'linux-arm64']);
});

test('matrix rejects unknown targets, duplicates and path-like input', () => {
  for (const value of [null, 3, [], 'all', 'linux', 'linux-amd64,linux-amd64', 'linux-amd64,', '../linux-amd64', ' linux-amd64', 'windows-arm64']) {
    assert.throws(() => parsePlatforms(value));
  }
});
