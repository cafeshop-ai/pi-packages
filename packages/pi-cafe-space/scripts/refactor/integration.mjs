import { buildCandidate, run, root } from './build.mjs';
import { join } from 'node:path';
// Always rebuild and validate first. No implicit fallback to an old binary or
// Web tree; all listeners, synthetic hosts and browser DOM belong to the test.
await buildCandidate();
run(process.execPath,['--test',join(root,'scripts/refactor/integration.test.mjs')],{stdio:'inherit',timeout:150000});
