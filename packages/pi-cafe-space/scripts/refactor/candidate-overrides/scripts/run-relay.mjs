import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { relayBinary } from './relay-path.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const binary = await relayBinary(root);
// Forward only local Relay settings and its private credential path, never provider secrets.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|PI_COLLAB_HOST|PI_COLLAB_PORT|PI_COLLAB_HOST_TOKEN|PI_COLLAB_CLIENT_TOKEN|PI_COLLAB_ALLOWED_ORIGINS|PI_COLLAB_MANAGED_CONFIG|PI_CAFE_CREDENTIALS_FILE)$/i.test(key)));
const child = spawn(binary, [], { cwd: root, env: environment, stdio: 'inherit' });
child.once('error', () => { console.error('Relay could not start'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (child.exitCode === null) child.kill(signal); });
child.once('exit', code => { process.exitCode = code ?? 1; });
