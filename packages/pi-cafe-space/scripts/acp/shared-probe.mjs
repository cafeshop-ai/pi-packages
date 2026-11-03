#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connectProxy } from './shared-check.mjs';
import { launchAgent, reserveLiveAttempt, SMOKE_PROMPT } from './probe.mjs';

export function observerRequestError(error) {
  const failure = new Error(`Observer request failed (${Number.isInteger(error?.code) ? error.code : 'unknown'})`);
  if (error?.code === -32600 && /^no rollout found for thread id /i.test(error.message ?? '')) failure.code = 'ACP_SESSION_NOT_SAVED';
  return failure;
}

export async function openObserver({ codex, socket, onEvent = () => {}, onDisconnect = () => {} }) {
  const child = spawn(codex, ['app-server', 'proxy', '--sock', socket], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  child.stdin.on('error', () => {});
  const ended = new Promise(resolveExit => { child.once('close', resolveExit); child.once('error', resolveExit); });
  const waiters = new Map(); let id = 0, transport, pump, closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    for (const waiter of waiters.values()) waiter.reject(new Error('Observer disconnected'));
    transport?.ws.terminate(); child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await ended; await pump?.catch(() => {}); await transport?.messages.return().catch(() => {});
  };
  const request = async (method, params) => {
    assert(['initialize', 'thread/loaded/list', 'thread/read', 'thread/resume'].includes(method), 'Observer mutation forbidden');
    if (method === 'thread/loaded/list') assert(params.limit === 20 && (params.cursor === undefined || typeof params.cursor === 'string') && Object.keys(params).every(key => ['limit', 'cursor'].includes(key)), 'Invalid loaded-thread query');
    if (method === 'thread/read') assert(params.includeTurns === false && typeof params.threadId === 'string' && Object.keys(params).every(key => ['threadId', 'includeTurns'].includes(key)), 'Observer history forbidden');
    if (method === 'thread/resume') assert(params.excludeTurns === true && typeof params.threadId === 'string' && Object.keys(params).every(key => ['threadId', 'excludeTurns'].includes(key)), 'Observer override/history forbidden');
    const requestId = ++id; let timer;
    try {
      return await new Promise((resolveReply, reject) => {
        timer = setTimeout(() => reject(new Error('Observer metadata timed out')), 15000);
        waiters.set(requestId, { resolve: resolveReply, reject });
        transport.writer.write({ id: requestId, method, params }).catch(reject);
      });
    } finally { clearTimeout(timer); waiters.delete(requestId); }
  };
  try {
    await once(child, 'spawn'); transport = connectProxy(child);
    const timer = setTimeout(() => transport.ws.terminate(), 15000);
    try { await once(transport.ws, 'open'); } finally { clearTimeout(timer); }
    pump = (async () => {
      for (;;) {
        const { value, done } = await transport.reader.read(); if (done) break;
        const waiter = waiters.get(value.id);
        if (waiter) {
          if (value.error) waiter.reject(observerRequestError(value.error));
          else waiter.resolve(value.result);
        } else if (value.method && value.id == null) onEvent(value);
        // Never answer permissions for another client.
      }
      for (const waiter of waiters.values()) waiter.reject(new Error('Observer disconnected'));
      if (!closed) onDisconnect();
    })();
    pump.catch(() => { for (const waiter of waiters.values()) waiter.reject(new Error('Observer disconnected')); if (!closed) onDisconnect(); });
    await request('initialize', { clientInfo: { name: 'cafe_shared_observer', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    await transport.writer.write({ method: 'initialized', params: {} });
    return { request, close };
  } catch (error) { await close(); throw error; }
}

export function settingsFingerprint(response) {
  const fields = ['model', 'modelProvider', 'reasoningEffort', 'approvalPolicy', 'approvalsReviewer', 'sandbox', 'activePermissionProfile', 'cwd', 'runtimeWorkspaceRoots', 'serviceTier', 'collaborationMode', 'disabledPluginIds', 'instructionSources'];
  return createHash('sha256').update(JSON.stringify(fields.map(key => [key, response[key] ?? null]))).digest('hex');
}

export function projectLoadedThreads(projects, responses) {
  const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
  return responses.flatMap(response => {
    const thread = response?.thread;
    assert(thread && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(thread.id) && typeof thread.cwd === 'string' && isAbsolute(thread.cwd) && typeof thread.status?.type === 'string', 'Invalid loaded thread metadata');
    const project = projects.find(item => samePath(item.cwd, thread.cwd));
    if (!project) return [];
    const name = typeof thread.name === 'string' && thread.name.trim().length <= 256 && !/[\x00-\x1f\x7f]/.test(thread.name) ? thread.name.trim() : 'Codex session';
    return [{ id: thread.id, projectId: project.id, name, cwd: project.cwd, status: ['idle', 'active', 'systemError'].includes(thread.status.type) ? thread.status.type : 'unknown' }];
  });
}

export async function listLoadedThreads(observer, projects) {
  const ids = new Set(), cursors = new Set(); let cursor; let truncated = false;
  for (let page = 0; page < 5; page++) {
    const params = { limit: 20, ...(cursor ? { cursor } : {}) };
    const response = await observer.request('thread/loaded/list', params);
    assert(Array.isArray(response?.data) && response.data.length <= 20 && response.data.every(id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)), 'Invalid loaded thread list');
    for (const id of response.data) ids.add(id);
    const next = response.nextCursor;
    if (next === null || next === undefined) break;
    assert(typeof next === 'string' && next.length > 0 && !cursors.has(next), 'Invalid loaded thread cursor');
    cursors.add(next); cursor = next;
    if (page === 4) truncated = true;
  }
  const all = [...ids], metadata = [];
  for (let i = 0; i < all.length; i += 8) {
    metadata.push(...await Promise.all(all.slice(i, i + 8).map(threadId => observer.request('thread/read', { threadId, includeTurns: false }))));
  }
  return { threads: projectLoadedThreads(projects, metadata), truncated };
}

export async function listSpaceThreads({ codex, socket, projects }) {
  assert(isAbsolute(codex) && isAbsolute(socket) && Array.isArray(projects) && projects.length > 0 && projects.length <= 16, 'Invalid ACP list configuration');
  const observer = await openObserver({ codex, socket });
  try { return await listLoadedThreads(observer, projects); }
  finally { await observer.close(); }
}

export async function launchSharedAgent({ sdk, acpRoot, codex, socket, threadId, cwd, reportPath, promptBudget = 0, onEvent, onDisconnect, timeoutMs = 600000, promptTimeoutMs, parentOwnsTree = false }) {
  const directory = await mkdtemp(join(tmpdir(), 'cafe-shared-launch-'));
  const script = fileURLToPath(new URL('./shared-bridge.mjs', import.meta.url));
  let launcher;
  if (process.platform === 'win32') {
    for (const path of [process.execPath, script]) assert(!/[\r\n"%!^&|<>]/.test(path), 'Unsupported cmd launcher path');
    launcher = join(directory, 'codex-shared.cmd');
    await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${script}" app-server\r\n`, { mode: 0o600 });
  } else {
    const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
    for (const path of [process.execPath, script]) assert(!/[\r\n\0]/.test(path), 'Unsupported ACP launcher path');
    launcher = join(directory, 'codex-shared');
    await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} app-server\n`, { mode: 0o700 });
  }
  try {
    const handle = await launchAgent({ sdk, entry: join(acpRoot, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js'), codex: launcher,
      cwd, reportPath, promptBudget, onEvent, onDisconnect, timeoutMs, promptTimeoutMs, parentOwnsTree, shared: { codex, socket, threadId, reportPath } });
    return { ...handle, async close() { try { await handle.close(); } finally { await rm(directory, { recursive: true, force: true }); } } };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

export async function runSharedProbe({ acpRoot, codex, socket, threadId, output, live = false }) {
  await mkdir(output, { recursive: true });
  if (live) await reserveLiveAttempt(output);
  const report = { mode: live ? 'shared-single-prompt' : 'shared-attach-only', passed: false, stage: 'observer', promptAttempts: 0, historyReplay: false, nativeTerminalDisplay: 'requires-human-confirmation' };
  const native = { turnIds: new Set(), text: '', completed: false }; let observer, handle, acpText = '';
  const bridgeReport = join(output, 'bridge-report.json');
  try {
    observer = await openObserver({ codex, socket, onEvent(message) {
      const p = message.params;
      if (p?.threadId !== threadId) return;
      if (message.method === 'turn/started') native.turnIds.add(p.turn.id);
      if (native.turnIds.has(p.turnId) && message.method === 'item/agentMessage/delta') native.text = (native.text + p.delta).slice(0, 4096);
      if (message.method === 'turn/completed' && native.turnIds.has(p.turn.id)) native.completed = true;
    } });
    const metadata = await observer.request('thread/read', { threadId, includeTurns: false });
    assert.equal(metadata.thread.id, threadId);
    assert.equal(metadata.thread.status.type, 'idle', 'Wait until the shared terminal is idle');
    const before = await observer.request('thread/resume', { threadId, excludeTurns: true });
    const fingerprint = settingsFingerprint(before);
    const sdk = await import(pathToFileURL(join(acpRoot, 'node_modules/@agentclientprotocol/sdk/dist/v1/stable/acp.js')).href);
    report.stage = 'launch';
    handle = await launchSharedAgent({ sdk, acpRoot, codex, socket, threadId, cwd: metadata.thread.cwd, reportPath: bridgeReport, promptBudget: live ? 1 : 0,
      onEvent(event) {
        if (event.type === 'text') acpText = (acpText + event.text).slice(0, 4096);
        if (event.kind === 'tool_call' || event.kind === 'tool_call_update') {
          report.toolActivity = (report.toolActivity ?? 0) + 1;
          void handle.adapter.cancel().catch(() => {});
        }
      } });
    await handle.adapter.initialize(); report.stage = 'attach';
    await handle.adapter.attach(threadId, metadata.thread.cwd);
    assert.equal(handle.adapter.sessionId, threadId);
    report.attachedToOriginal = true;
    if (live) {
      report.stage = 'prompt';
      const reply = await handle.adapter.prompt(SMOKE_PROMPT);
      assert.equal(reply.stopReason, 'end_turn');
      assert.equal(acpText.trim(), 'CAFE_ACP_OK');
      // Native observer must receive the same live output; restored history cannot satisfy this.
      assert.equal(native.text.trim(), 'CAFE_ACP_OK');
      assert.equal(native.turnIds.size, 1); assert.equal(native.completed, true);
      assert.equal(report.toolActivity ?? 0, 0);
      report.nativeObserverSameTurn = true; report.stopReason = reply.stopReason;
    }
    report.stage = 'settings-check';
    const after = await observer.request('thread/resume', { threadId, excludeTurns: true });
    assert.equal(settingsFingerprint(after), fingerprint, 'Shared settings changed');
    report.settingsPreserved = true;
    report.passed = true; report.stage = 'complete';
  } catch (error) { report.error = { name: error.name, ...(typeof error.code === 'number' ? { code: error.code } : {}) }; }
  finally {
    report.promptAttempts = handle?.adapter.promptAttempts ?? 0;
    await handle?.close(); await observer?.close();
    report.ownedConnectionsClosed = true;
    try { report.bridge = JSON.parse(await readFile(bridgeReport, 'utf8')); } catch { report.bridge = null; }
    await writeFile(join(output, live ? 'shared-live-report.json' : 'shared-attach-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { 'acp-root': { type: 'string' }, codex: { type: 'string' }, socket: { type: 'string' }, thread: { type: 'string' }, output: { type: 'string' }, live: { type: 'boolean', default: false } }, strict: true });
  for (const key of ['acp-root', 'codex', 'socket', 'output']) assert(values[key] && isAbsolute(values[key]), `--${key} must be absolute`);
  const report = await runSharedProbe({ acpRoot: values['acp-root'], codex: values.codex, socket: values.socket, threadId: values.thread, output: values.output, live: values.live });
  console.log(JSON.stringify(report, null, 2)); process.exitCode = report.passed ? 0 : 1;
}
