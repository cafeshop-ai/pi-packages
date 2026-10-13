import { access } from 'node:fs/promises';
// The staged launcher already validates the executable's platform and digest.
const launcher = new URL('../.refactor/release/package/scripts/run-relay.mjs', import.meta.url);
try { await access(launcher); }
catch { throw Error('No built Go/React package. Run npm run build first.'); }
await import(launcher.href);
