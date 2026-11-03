#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { AcpSpaceHost } from './space-host.mjs';
import { launchAgent } from './probe.mjs';
import { launchSharedAgent, openObserver, settingsFingerprint } from './shared-probe.mjs';

const sessionIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

// Explicit local opt-in. Does not discover credentials, start a gateway or install an agent.
export async function readHostConfig(path) {
  let config;
  if (path === null) {
    const raw = process.env.CAFE_ACP_CONFIG_JSON;
    delete process.env.CAFE_ACP_CONFIG_JSON;
    assert(typeof raw === 'string' && raw.length <= 32768, 'Missing local host configuration');
    config = JSON.parse(raw);
  } else {
    assert(isAbsolute(path), 'An absolute config path is required');
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32768, 'Config must be an ordinary small file');
    assert(process.platform === 'win32' || (stat.mode & 0o077) === 0, 'Config must have mode 600');
    config = JSON.parse(await readFile(path, 'utf8'));
  }
  assert(config && typeof config === 'object' && !Array.isArray(config), 'Invalid config');
  const keys = ['mode', 'relayUrl', 'roomId', 'hostId', 'token', 'acpRoot', 'codex', 'cwd', 'socket', 'threadId', 'expectedCwd', 'name', 'stateDirectory', 'promptBudget', 'managed', 'managedSessionId'];
  assert(Object.keys(config).every(key => keys.includes(key)), 'Unknown config option');
  assert(['new', 'restore', 'attach'].includes(config.mode), 'Unsupported ACP session mode');
  assert(config.managed === undefined || typeof config.managed === 'boolean', 'Invalid managed launch flag');
  if (config.managed === true) {
    assert(config.promptBudget === null || config.promptBudget === undefined, 'Managed ACP hosts do not use the prototype prompt budget');
    assert(typeof config.managedSessionId === 'string' && sessionIdPattern.test(config.managedSessionId), 'Managed session ID required');
  } else {
    assert(config.managedSessionId === undefined, 'Managed session ID is internal');
    assert(Number.isInteger(config.promptBudget) && config.promptBudget >= 0 && config.promptBudget <= (config.mode === 'attach' ? 1 : 2), 'Explicit prototype prompt budget required');
  }
  for (const key of ['acpRoot', 'codex', 'stateDirectory']) assert(typeof config[key] === 'string' && isAbsolute(config[key]), `Absolute ${key} required`);
  for (const key of ['relayUrl', 'roomId', 'hostId', 'token']) assert(typeof config[key] === 'string' && config[key].length > 0, `Missing ${key}`);
  if (config.name !== undefined) assert(typeof config.name === 'string' && config.name.trim().length > 0 && config.name.length <= 256 && !/[\x00-\x1f\x7f]/.test(config.name), 'Invalid managed session name');
  if (config.mode === 'new') assert(typeof config.cwd === 'string' && isAbsolute(config.cwd) && config.threadId === undefined && config.expectedCwd === undefined, 'Absolute cwd required');
  if (config.mode === 'restore') assert(config.managed === true && typeof config.cwd === 'string' && isAbsolute(config.cwd) && typeof config.threadId === 'string' && sessionIdPattern.test(config.threadId) && config.socket === undefined && config.expectedCwd === undefined, 'Restore requires an owned ACP session ID and cwd');
  if (config.mode === 'attach') {
    assert(typeof config.socket === 'string' && isAbsolute(config.socket) && Buffer.byteLength(config.socket, 'utf8') <= 4096 && !/[\x00-\x1f\x7f]/.test(config.socket), 'Absolute socket required');
    assert(typeof config.expectedCwd === 'string' && isAbsolute(config.expectedCwd), 'Attach requires the approved project directory');
    assert(typeof config.threadId === 'string' && sessionIdPattern.test(config.threadId), 'Exact loaded thread ID required');
    assert(config.cwd === undefined, 'Borrowed cwd comes from the native session, not config');
  }
  return config;
}

export function samePath(a, b, platform = process.platform) {
  const left = resolve(a), right = resolve(b);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function createEventBuffer({ maxEvents = 512, maxBytes = 512 * 1024 } = {}) {
  assert(Number.isInteger(maxEvents) && maxEvents > 0 && Number.isInteger(maxBytes) && maxBytes > 0, 'Invalid ACP event buffer bounds');
  let host, bytes = 0;
  const events = [];
  return {
    push(event) {
      if (host) { host.event(event); return; }
      const size = Buffer.byteLength(JSON.stringify(event));
      if (size > maxBytes || events.length >= maxEvents || bytes + size > maxBytes) throw new Error('ACP load event buffer limit exceeded');
      events.push({ event, size }); bytes += size;
    },
    attach(target) {
      assert(!host && target && typeof target.event === 'function', 'ACP event buffer already attached');
      host = target;
      for (const item of events) host.event(item.event);
      events.length = 0; bytes = 0;
    },
  };
}

async function persistAgentSession(directory, sessionId) {
  assert(typeof sessionId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(sessionId), 'Invalid ACP session ID');
  const file = await open(join(directory, 'agent-session.json'), 'wx', 0o600);
  try { await file.writeFile(JSON.stringify({ sessionId })); await file.sync(); } finally { await file.close(); }
}

export async function runSpaceHost(config, { protocol, onReady = () => {}, shutdownSignal } = {}) {
  // Validate gateway config before opening an agent. No private config values in errors/output.
  const validation = new AcpSpaceHost({ protocol, adapter: { close() {} }, sessionId: 'validate', cwd: '/', name: 'Codex ACP', config });
  validation.close();
  const packageInfo = JSON.parse(await readFile(join(config.acpRoot, 'node_modules/@agentclientprotocol/codex-acp/package.json'), 'utf8'));
  const sdkInfo = JSON.parse(await readFile(join(config.acpRoot, 'node_modules/@agentclientprotocol/sdk/package.json'), 'utf8'));
  assert.equal(packageInfo.version, '2.5.0', 'Reverify guarded transport before upgrading codex-acp');
  assert.equal(sdkInfo.version, '2.1.0', 'Reverify ACP lifecycle behavior before upgrading the SDK');
  const sdk = await import(pathToFileURL(join(config.acpRoot, 'node_modules/@agentclientprotocol/sdk/dist/v1/stable/acp.js')).href);
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  if (config.mode === 'new') {
    // A lost create result must not silently create another Codex thread.
    const reservation = await open(join(config.stateDirectory, 'host-attempt.json'), 'wx', 0o600);
    await reservation.close();
  }
  let handle, observer, host;
  let nativeRunning = false, stopRequested = false, eventFailure = false;
  let stop;
  const stopped = new Promise(resolveStop => { stop = resolveStop; });
  const signal = () => { stopRequested = true; stop(); };
  process.once('SIGINT', signal); process.once('SIGTERM', signal);
  shutdownSignal?.addEventListener('abort', signal, { once: true });
  if (shutdownSignal?.aborted) signal();
  try {
    let baseline, cwd = config.cwd;
    if (config.mode === 'attach') {
      observer = await openObserver({ codex: config.codex, socket: config.socket, onDisconnect: signal, onEvent(event) {
        try {
        if (event.params?.threadId !== config.threadId) return;
        if (event.method === 'turn/started') { nativeRunning = true; host?.state(true); }
        if (event.method === 'turn/completed') { nativeRunning = false; host?.state(false, event.params.turn?.status === 'failed' ? 'error' : 'completed'); }
        } catch { stop(); }
      } });
      const metadata = await observer.request('thread/read', { threadId: config.threadId, includeTurns: false });
      assert(metadata.thread.id === config.threadId && metadata.thread.status.type === 'idle' && samePath(metadata.thread.cwd, config.expectedCwd), 'Borrowed session must be loaded, idle, and inside the approved project');
      cwd = metadata.thread.cwd;
      baseline = await observer.request('thread/resume', { threadId: config.threadId, excludeTurns: true });
    }
    if (stopRequested) throw new Error('ACP host stopped during startup');
    const eventBuffer = createEventBuffer();
    const onEvent = event => { try { eventBuffer.push(event); } catch { eventFailure = true; signal(); } };
    handle = config.mode === 'attach'
      ? await launchSharedAgent({ sdk, ...config, cwd, parentOwnsTree: config.managed === true, reportPath: config.promptBudget == null ? undefined : join(config.stateDirectory, 'bridge-report.json'), onEvent, onDisconnect: signal })
      : await launchAgent({ sdk, entry: join(config.acpRoot, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js'), codex: config.codex, cwd, onEvent, onDisconnect: signal, parentOwnsTree: config.managed === true, promptBudget: config.promptBudget ?? null });
    if (stopRequested) throw new Error('ACP host stopped during startup');
    const info = await handle.adapter.initialize();
    if (stopRequested) throw new Error('ACP host stopped during initialization');
    let session;
    if (config.mode === 'attach') {
      session = await handle.adapter.attach(config.threadId, cwd);
      const after = await observer.request('thread/resume', { threadId: config.threadId, excludeTurns: true });
      assert.equal(settingsFingerprint(after), settingsFingerprint(baseline), 'Borrowed settings changed; refusing registration');
    } else if (config.mode === 'restore') {
      session = await handle.adapter.restore(config.threadId, cwd);
      assert.equal(session.modes?.currentModeId, 'read-only', 'Restored managed session must remain read-only');
    } else {
      session = await handle.adapter.create(cwd);
      assert.equal(session.modes?.currentModeId, 'read-only', 'Read-only mode must be confirmed');
      await persistAgentSession(config.stateDirectory, handle.adapter.sessionId);
    }
    if (eventFailure) throw new Error('ACP event buffer limit exceeded');
    if (stopRequested) throw new Error('ACP host stopped during session startup');
    const modelId = baseline?.model ?? session.models?.currentModelId;
    host = new AcpSpaceHost({ protocol, adapter: handle.adapter, sessionId: config.managedSessionId ?? randomUUID(), agentSessionId: handle.adapter.sessionId, cwd,
      name: config.name ?? info.agentInfo?.title ?? info.agentInfo?.name ?? 'Codex ACP',
      model: modelId ? { provider: baseline?.modelProvider ?? 'codex', id: modelId } : null,
      thinkingLevel: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(baseline?.reasoningEffort) ? baseline.reasoningEffort : 'off', config });
    eventBuffer.attach(host);
    if (config.mode === 'restore') host.state(false, 'completed');
    else if (nativeRunning) host.state(true);
    await host.connect();
    onReady({ type: 'cafe_space_ready', mode: config.mode, hostId: config.hostId, sessionId: host.snapshot.sessionId, agentSessionId: handle.adapter.sessionId, permissionPolicy: 'deny-all', automaticRetries: 0 });
    await Promise.race([stopped, host.closed]);
    if (eventFailure) throw new Error('ACP event forwarding failed');
  } finally {
    process.off('SIGINT', signal); process.off('SIGTERM', signal);
    shutdownSignal?.removeEventListener('abort', signal);
    host?.close();
    await handle?.close();
    await observer?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' }, 'config-env': { type: 'boolean' } }, strict: true });
    assert((values.config !== undefined) !== (values['config-env'] === true), 'Choose a config file or environment config');
    const config = await readHostConfig(values['config-env'] ? null : values.config);
    const control = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const shutdown = new AbortController();
    control.on('line', line => { try { if (JSON.parse(line)?.type === 'stop') shutdown.abort(); } catch {} });
    control.on('close', () => shutdown.abort());
    const protocol = await import('../../dist/protocol/index.js');
    await runSpaceHost(config, { protocol, shutdownSignal: shutdown.signal, onReady: info => console.log(JSON.stringify(info)) });
    control.close();
  } catch { console.error('ACP host stopped. Check the local config, build and state reservation; no automatic retry was made.'); process.exitCode = 1; }
}
