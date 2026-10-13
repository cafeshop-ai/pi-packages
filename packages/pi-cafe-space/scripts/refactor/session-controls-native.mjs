// Fresh owned Pi + candidate Go Relay only. No browser, user Pi or model call.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, cp, access, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { root, sha } from './build.mjs';
import { audit, baseEnv, launch, RPC, NativePeer, until } from './native-support.mjs';
if (process.platform !== 'win32' || !process.argv.includes('--allow-native')) throw Error('Requires --allow-native for isolated Windows Pi acceptance');
const candidate = join(root, '.refactor/release/package');
const piArgument = process.argv.indexOf('--pi-root');
if (piArgument >= 0 && !process.argv[piArgument + 1]) throw Error('Missing --pi-root value');
const piRoot = piArgument >= 0 ? resolve(process.argv[piArgument + 1]) : dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
const bundledPi = process.argv.includes('--bundled-pi');
const cli = join(piRoot, bundledPi ? 'dist/bundle/cli.js' : 'dist/cli.js');
const binary = join(candidate, 'dist/relay/bin/windows-amd64/pi-cafe-relay.exe');
const inputAssist = process.argv.includes('--input-assist');
const registrationReload = process.argv.includes('--registration-reload');
const out = join(root, registrationReload && bundledPi ? '.refactor/reports/R18-registration-offline' : registrationReload ? '.refactor/reports/R18-registration-reload' : inputAssist ? '.refactor/reports/R15-input-assist' : '.refactor/reports/R15-session-controls'); await mkdir(out, { recursive: true });
const before = await audit();
const work = await mkdtemp(join(root, '.refactor/session-controls-native-'));
const report = { status: 'running', work, checks: [], modelCalls: 0, nodeVersion: process.version, piVersion: JSON.parse(await readFile(join(piRoot, 'package.json'), 'utf8')).version, binarySHA256: sha(await readFile(binary)), extensionSHA256: sha(await readFile(join(candidate, 'dist/extension/index.js'))) };
const owned = []; let rpc, peer, failure;
const ok = message => { report.checks.push(message); console.log('PASS: ' + message); };
try {
  for (const name of ['project', 'agent', 'sessions', 'home', 'temp']) await mkdir(join(work, name));
  const project = join(work, 'project'), sessions = join(work, 'sessions'), agent = join(work, 'agent');
  if (inputAssist) {
    await mkdir(join(agent, 'prompts')); await mkdir(join(agent, 'skills', 'input-check'), { recursive: true });
    await writeFile(join(agent, 'prompts', 'input-check.md'), '---\ndescription: Shadowed template\n---\nCOLLISION_MUST_NOT_REACH_MODEL');
    await writeFile(join(agent, 'prompts', 'input-template.md'), '---\ndescription: Owned template\n---\nTEMPLATE_CHECK $1');
    await writeFile(join(agent, 'skills', 'input-check', 'SKILL.md'), '---\nname: input-check\ndescription: Owned skill only\n---\nSKILL_CHECK native expansion');
    await writeFile(join(project, 'note 中文.txt'), 'Native file reference contents');
    await writeFile(join(project, '.env'), 'Never send this secret');
  }
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false, compaction: { enabled: false }, retry: { enabled: false }, defaultProjectTrust: 'never' }));
  const probe = createServer(); await new Promise((yes, no) => { probe.once('error', no); probe.listen(0, '127.0.0.1', yes); });
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const nonce = randomUUID(), hostToken = randomUUID(), clientToken = randomUUID();
  const relay = await launch(binary, ['--instance=' + nonce], { marker: nonce, cwd: work, env: { ...baseEnv(), PI_COLLAB_HOST: '127.0.0.1', PI_COLLAB_PORT: String(port), PI_COLLAB_HOST_TOKEN: hostToken, PI_COLLAB_CLIENT_TOKEN: clientToken } }); owned.push(relay);
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(400) })).ok; } catch { return false; } }, 'isolated Go relay');
  const listener = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port}).OwningProcess`], { encoding: 'utf8', timeout: 10000 }).trim();
  assert.equal(Number(listener), relay.child.pid);
  let extension = candidate;
  const registration = join(work, 'registration');
  const reloadPackage = join(work, 'node_modules', '@cafecodework', 'pi-cafe-space');
  if (registrationReload) {
    const arg = process.argv.indexOf('--previous-archive');
    assert.ok(arg >= 0 && process.argv[arg + 1], 'Requires explicit --previous-archive');
    const archive = resolve(process.argv[arg + 1]);
    report.previousArchiveSHA256 = sha(await readFile(archive));
    await mkdir(registration);
    await cp(candidate, reloadPackage, { recursive: true });
    execFileSync(join(process.env.SystemRoot, 'System32/tar.exe'), ['-xzf', archive, '-C', registration], { timeout: 15000 });
    for (const file of ['extension/index.js', 'extension/file-commands.js', 'protocol/index.js']) await copyFile(join(registration, 'package', 'dist', file), join(reloadPackage, 'dist', file));
    const source = fileURLToPath(new URL('./local-registration/extension.ts', import.meta.url));
    report.registrationSHA256 = sha(await readFile(source));
    // Start with the shipped legacy loader to reproduce a user's warm ESM cache.
    const fixed = await readFile(source, 'utf8');
    const legacy = fixed.replace("import { fileURLToPath }", "import { fileURLToPath, pathToFileURL }").replace(/  \/\/ Native import\(\)[\s\S]*?const candidate: [^\n]+\n/, '  const candidate: { default: (api: ExtensionAPI) => void } = await import(pathToFileURL(entry).href);\n');
    assert.notEqual(legacy, fixed);
    extension = join(registration, 'extension.ts');
    await writeFile(extension, legacy);
    await copyFile(fileURLToPath(new URL('./local-registration/defaults.ts', import.meta.url)), join(registration, 'defaults.ts'));
    await writeFile(join(registration, 'package.json'), '{"type":"module"}');
    await writeFile(join(registration, 'connection.json'), JSON.stringify({ format: 'pi-cafe-space-local-registration-v1', credentialsFile: join(registration, 'credentials.json') }));
    await writeFile(join(registration, 'credentials.json'), JSON.stringify({ format: 'pi-cafe-space-manual-trial-v1', package: reloadPackage, room: 'controls', hostToken, clientToken }));
  }
  const pi = await launch(process.execPath, [cli, '--mode', 'rpc', '--offline', '--no-extensions', '-e', extension, '-e', fileURLToPath(new URL('./session-controls-native-fixture.ts', import.meta.url)), ...(inputAssist ? [] : ['--no-skills', '--no-prompt-templates']), '--no-themes', '--no-context-files', '--no-approve', '--no-builtin-tools', '--provider', 'controls-offline', '--model', 'no-calls', '--session-dir', sessions], { marker: sessions, cwd: project, env: { ...baseEnv(), USERPROFILE: join(work, 'home'), APPDATA: join(work, 'home'), LOCALAPPDATA: join(work, 'home'), TEMP: join(work, 'temp'), TMP: join(work, 'temp'), PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_CAFE_CONTROL_TEST_DIR: work, ...(inputAssist ? { PI_CAFE_INPUT_TEST: '1' } : {}), PI_COLLAB_ENABLED: '1', PI_COLLAB_RELAY_URL: `ws://127.0.0.1:${port}/ws`, PI_COLLAB_ROOM: 'controls', PI_COLLAB_PEER_ID: 'controls-host', PI_COLLAB_HOST_TOKEN: hostToken } }); owned.push(pi); rpc = new RPC(pi.child);
  await rpc.wait(e => e.type === 'extension_ui_request' && e.message === 'CONTROLS_READY', 'native Pi readiness', 30000);
  assert.equal(dirname((await rpc.call('get_state')).sessionFile), sessions);
  peer = await new NativePeer({ url: `ws://127.0.0.1:${port}/ws`, roomId: 'controls', token: clientToken, hostId: 'controls-host' }).open();
  let scope = (await peer.wait(m => m.type === 'snapshot' && m.hostId === 'controls-host')).snapshot;
  assert.equal(scope.sessionControl, true);
  if (registrationReload) {
    assert.equal(scope.inputAssist, undefined);
    const originalSession = (await rpc.call('get_state')).sessionId;
    for (const file of ['extension/index.js', 'extension/file-commands.js', 'protocol/index.js']) await copyFile(join(candidate, 'dist', file), join(reloadPackage, 'dist', file));
    // Reload the old adapter after the package update: still stale, as reported.
    let stream = scope.streamId;
    await rpc.call('prompt', { message: '/controls-reload' });
    scope = (await peer.wait(m => m.type === 'snapshot' && m.snapshot.streamId !== stream)).snapshot;
    assert.equal(scope.inputAssist, undefined);
    await copyFile(fileURLToPath(new URL('./local-registration/extension.ts', import.meta.url)), extension);
    for (let attempt = 0; attempt < 2; attempt++) {
      stream = scope.streamId;
      await rpc.call('prompt', { message: '/controls-reload' });
      scope = (await peer.wait(m => m.type === 'snapshot' && m.snapshot.streamId !== stream)).snapshot;
      assert.equal(scope.inputAssist, true);
      assert.equal(scope.sessionId, originalSession);
      assert.equal(scope.cwd, project);
      assert.equal((await rpc.call('get_state')).sessionId, originalSession);
      assert.deepEqual((await rpc.call('get_messages')).messages, []);
    }
    assert.equal(rpc.events.some(e => e.type === 'agent_start'), false);
    ok('Same native Pi: legacy reload stays stale after update; fixed registration reloads entry/dependencies, advertises inputAssist, and preserves session on repeated reload');
  }
  if (inputAssist) {
    assert.equal(scope.inputAssist, true);
    const list = await peer.command(scope, { name: 'list_commands' });
    for (const name of ['input-check', 'input-template', 'skill:input-check']) assert.ok(list.data.commands.some(c => c.name === name), name);
    assert.ok(!list.data.commands.some(c => c.name.startsWith('collab-')));
    assert.equal(list.data.commands.filter(c => c.name === 'input-check').length, 1);
    assert.equal(list.data.commands.find(c => c.name === 'input-check').source, 'extension');
    assert.ok(list.data.commands.every(c => !('sourceInfo' in c)));
    for (const command of ['/unknown-input-command', '/reload', '/collab-session-control fake']) assert.equal((await peer.command(scope, { name: 'run_command', command })).code, 'COMMAND_UNAVAILABLE');
    assert.equal((await peer.command(scope, { name: 'run_command', command: '/input-check hello 中文' })).status, 'dispatched');
    await rpc.wait(e => e.type === 'extension_ui_request' && e.message === 'INPUT_COMMAND:hello 中文', 'native extension command');
    assert.equal(rpc.events.some(e => e.type === 'agent_start'), false);
    ok('Real Pi command discovery, extension dispatch and arguments work; unknown/local-only/internal commands never become model prompts');
    for (const [path, code] of [['.env', 'SENSITIVE_PATH'], ['../outside', 'PATH_NOT_ALLOWED']]) assert.equal((await peer.command(scope, { name: 'prompt', content: 'REFERENCE_CHECK', files: [path] })).code, code);
    const cases = [
      [{ name: 'prompt', content: 'REFERENCE_CHECK @"note 中文.txt"', files: ['note 中文.txt'] }, 'Native file reference contents'],
      [{ name: 'run_command', command: '/input-template argument' }, 'TEMPLATE_CHECK argument'],
      [{ name: 'run_command', command: '/skill:input-check request' }, 'SKILL_CHECK native expansion'],
    ];
    for (const [payload, expected] of cases) {
      assert.equal((await peer.command(scope, payload)).status, 'dispatched');
      await peer.wait(m => m.type === 'event' && m.event.kind === 'session_state' && m.event.phase === 'idle');
      const captured = (await readFile(join(work, 'synthetic-inputs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.ok(captured.at(-1).text.includes(expected), expected);
    }
    report.syntheticProviderCalls = 3;
    assert.equal((await readFile(join(work, 'synthetic-inputs.jsonl'), 'utf8')).trim().split('\n').length, 3);
    ok('References reach native model context; Pi itself expands templates and skills. Three offline synthetic responses, zero network or real model calls');
  }
  await rpc.call('prompt', { message: '/controls-seed' });
  const history = JSON.parse((await rpc.wait(e => typeof e.message === 'string' && e.message.startsWith('CONTROLS_HISTORY:'), 'owned history')).message.slice('CONTROLS_HISTORY:'.length));
  assert.equal(dirname(history.path), sessions);
  assert.equal((await peer.command(scope, { name: 'resume_session', sessionId: history.path })).code, 'SESSION_NOT_FOUND');
  assert.equal((await peer.command(scope, { name: 'resume_session', sessionId: history.sessionId })).status, 'dispatched');
  scope = (await peer.wait(m => m.type === 'snapshot' && m.snapshot.sessionId === history.sessionId)).snapshot;
  assert.equal((await rpc.call('get_state')).sessionId, history.sessionId);
  assert.equal((await rpc.call('get_messages')).messages[0].content, 'Synthetic historical question');
  ok('Opaque historical ID resumes the native AgentSession and saved messages; file paths are not accepted as IDs');
  assert.equal((await peer.command(scope, { name: 'rename_session', title: 'Native renamed / 咖啡' })).status, 'applied');
  const renamed = await peer.wait(m => m.type === 'snapshot' && m.snapshot.sessionName === 'Native renamed / 咖啡');
  assert.equal(renamed.snapshot.streamId, scope.streamId);
  assert.equal((await rpc.call('get_state')).sessionName, 'Native renamed / 咖啡');
  assert.match(await readFile(history.path, 'utf8'), /Native renamed \/ 咖啡/);
  ok('Native rename persists via Pi without rotating stream or discarding messages');
  await rpc.call('prompt', { message: '/controls-cancel-once' });
  const cancellation = peer.command(scope, { name: 'new_session' });
  const dialog = await rpc.wait(e => e.type === 'extension_ui_request' && e.method === 'confirm' && e.title === 'CONTROLS_SWITCH', 'owned Pi local confirmation');
  await peer.wait(m => m.type === 'event' && m.event.kind === 'ui_wait' && m.event.waiting);
  rpc.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: dialog.id, confirmed: false }) + '\n');
  assert.equal((await cancellation).code, 'SESSION_CANCELLED');
  assert.equal((await rpc.call('get_state')).sessionId, history.sessionId);
  await peer.wait(m => m.type === 'event' && m.event.kind === 'session_state' && m.event.phase === 'idle');
  ok('Native local confirmation cancellation preserves the current session and restores idle state');
  const oldScope = scope;
  assert.equal((await peer.command(scope, { name: 'new_session' })).status, 'dispatched');
  const newSessionId = await until(async () => { const current = (await rpc.call('get_state')).sessionId; return current !== history.sessionId && current; }, 'native replacement session');
  scope = (await peer.wait(m => m.type === 'snapshot' && m.snapshot.sessionId === newSessionId && m.snapshot.streamId !== oldScope.streamId)).snapshot;
  assert.equal((await rpc.call('get_state')).sessionId, scope.sessionId);
  assert.deepEqual((await rpc.call('get_messages')).messages, []);
  assert.equal((await peer.command(oldScope, { name: 'rename_session', title: 'Must not apply' })).code, 'STALE_SESSION');
  ok('Native new session reconnects with new fences and an empty transcript; stale writes are rejected');
  const listing = await peer.command(scope, { name: 'list_sessions' });
  assert.ok(listing.data.sessions.some(s => s.sessionId === history.sessionId && s.name === 'Native renamed / 咖啡'));
  assert.equal((await peer.command(scope, { name: 'resume_session', sessionId: history.sessionId })).status, 'dispatched');
  await peer.wait(m => m.type === 'snapshot' && m.snapshot.sessionId === history.sessionId && m.snapshot.streamId !== oldScope.streamId);
  assert.equal((await rpc.call('get_messages')).messages.length, 2);
  await assert.rejects(access(join(work, 'model-calls')), { code: 'ENOENT' });
  if (!inputAssist) assert.equal(rpc.events.some(e => e.type === 'agent_start' || e.type === 'message_start'), false);
  ok(inputAssist ? 'Existing history remains resumable; no unexpected provider calls' : 'Existing renamed history remains resumable; zero agent turns and zero provider calls');
  report.status = 'passed';
} catch (error) { failure = error; report.status = 'failed'; report.error = String(error); report.diagnostics = owned.map(p => ({ exitCode: p.child.exitCode, stderr: p.stderr() })); }
finally {
  peer?.close(); rpc?.dispose(); let clean = true;
  for (const process of owned.reverse()) { try { await process.stop(); } catch (error) { clean = false; report.cleanupError = String(error); } }
  const after = await audit(work); report.after = after;
  try { assert.deepEqual(after.remaining, []); assert.deepEqual(after.listeners, before.listeners); } catch (error) { clean = false; report.cleanupError = String(error); }
  report.cleanedProcesses = clean;
  await writeFile(join(out, 'native.json'), JSON.stringify(report, null, 2));
  if (clean) await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  else throw Error('Unproven ownership; isolated directory retained');
}
if (failure) throw failure;
