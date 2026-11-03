#!/usr/bin/env node
import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { listSpaceThreads } from './shared-probe.mjs';

export async function readTargetsConfig(path) {
  assert(isAbsolute(path), 'Absolute config path required');
  const stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32768, 'Config must be an ordinary small file');
  const value = JSON.parse(await readFile(path, 'utf8'));
  assert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['codex', 'socket', 'projects'].includes(key)), 'Invalid target-list config');
  assert(isAbsolute(value.codex) && isAbsolute(value.socket) && Buffer.byteLength(value.socket, 'utf8') <= 4096 && !/[\x00-\x1f\x7f]/.test(value.socket) && Array.isArray(value.projects) && value.projects.length > 0 && value.projects.length <= 16, 'Incomplete target-list config');
  for (const project of value.projects) assert(project && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(project.id) && typeof project.cwd === 'string' && isAbsolute(project.cwd), 'Invalid approved project');
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' } }, strict: true });
    const config = await readTargetsConfig(values.config ?? '');
    const result = await listSpaceThreads(config);
    process.stdout.write(JSON.stringify({ type: 'cafe_space_targets', ...result }) + '\n');
  } catch {
    process.stderr.write('ACP target discovery failed. No session history was returned.\n');
    process.exitCode = 1;
  }
}
