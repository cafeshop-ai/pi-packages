#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { AcpAdapter } from './adapter.mjs';

export const SMOKE_PROMPT = 'Reply exactly CAFE_ACP_OK. Do not use tools, browse, inspect files, create agents, or perform any other action.';

export async function reserveLiveAttempt(directory) {
  // Fail closed on rerun, including after an unknown result. Never delete this automatically.
  const file = await open(join(directory, 'live-attempt.json'), 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify({ reservedPromptAttempts: 1, automaticRetries: 0, at: new Date().toISOString() }) + '\n');
  } finally { await file.close(); }
}

export async function launchAgent({ sdk, entry, codex, cwd, onEvent, promptBudget, timeoutMs, shared, onDisconnect, parentOwnsTree = false }) {
  assert(isAbsolute(entry) && isAbsolute(codex) && isAbsolute(cwd), 'Use absolute executable and work paths');
  const env = { ...process.env };
  // No implicit login, provider override or adapter logs containing credentials/transcripts.
  for (const key of ['DEFAULT_AUTH_REQUEST', 'MODEL_PROVIDER', 'APP_SERVER_LOGS', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
  for (const key of Object.keys(env)) if (key.startsWith('PI_COLLAB_') || key.startsWith('PI_CAFE_') || key.startsWith('CAFE_SHARED_') || key.startsWith('CAFE_ACP_')) delete env[key];
  if (shared) {
    delete env.CODEX_CONFIG; delete env.INITIAL_AGENT_MODE;
    Object.assign(env, { CODEX_PATH: codex, NO_BROWSER: '1',
      CAFE_SHARED_CODEX: shared.codex, CAFE_SHARED_SOCKET: shared.socket,
      CAFE_SHARED_THREAD: shared.threadId, CAFE_SHARED_BUDGET: promptBudget === null ? 'unlimited' : String(promptBudget),
      ...(promptBudget !== null && shared.reportPath ? { CAFE_SHARED_REPORT: shared.reportPath } : {}),
    });
  } else Object.assign(env, {
    CODEX_PATH: codex, NO_BROWSER: '1', INITIAL_AGENT_MODE: 'read-only',
    CODEX_CONFIG: JSON.stringify({
      hooks: {}, sandbox_mode: 'read-only', web_search: 'disabled',
      model_reasoning_effort: 'low', features: { shell_tool: false },
    }),
  });
  const child = spawn(process.execPath, [entry], {
    cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32' && !parentOwnsTree,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  child.stdin.on('error', () => {});
  const exited = new Promise(resolveExit => {
    child.once('close', (code, signal) => resolveExit({ code, signal }));
    child.once('error', () => resolveExit({ spawnError: true }));
  });
  await once(child, 'spawn');
  let adapter, closed = false;
  const handle = {
    get adapter() { return adapter; }, pid: child.pid,
    async close() {
      if (closed) return;
      closed = true;
      adapter?.close();
      child.stdin.end();
      let timer;
      try {
        await Promise.race([exited, new Promise(resolveWait => { timer = setTimeout(resolveWait, 8000); })]);
      } finally { clearTimeout(timer); }
      if (child.exitCode === null && child.signalCode === null) {
        // Only this owned process tree; never look up or stop the user's Codex daemon.
        if (process.platform === 'win32') {
          const killer = spawn(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          const [code] = await once(killer, 'exit');
          if (code !== 0 && child.exitCode === null) throw new Error('Owned process cleanup failed');
        } else if (process.platform !== 'win32' && !parentOwnsTree) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
        await exited;
      }
    },
  };
  try {
    adapter = new AcpAdapter({
      sdk, transport: sdk.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout), { maxMessageBytes: 1024 * 1024 }),
      onEvent, promptBudget, timeoutMs, sharedTransport: !!shared, onDisconnect,
    });
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function runProbe({ acpRoot, codex, output, live = false, timeoutMs = 600_000 }) {
  await mkdir(output, { recursive: true });
  if (live) await reserveLiveAttempt(output);
  const sdk = await import(pathToFileURL(join(acpRoot, 'node_modules/@agentclientprotocol/sdk/dist/v1/stable/acp.js')).href);
  const work = await mkdtemp(join(tmpdir(), 'cafe-acp-empty-'));
  const report = {
    mode: live ? 'single-prompt' : 'handshake-only', stage: 'launch', passed: false,
    reservedPromptAttempts: live ? 1 : 0, promptAttempts: 0, adapterAutomaticRetries: 0,
    providerHttpRequests: 'not-instrumented',
    transport: 'stdio', wireProtocol: 1, sharedLiveSession: 'not-verified',
    nativeTerminalSharing: 'not-tested', permissionPolicy: 'deny-all',
    temporaryWorkspace: work, textCharacters: 0, toolActivity: 0,
  };
  let handle, text = '';
  try {
    handle = await launchAgent({ sdk,
      entry: join(acpRoot, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js'),
      codex, cwd: work, timeoutMs, promptBudget: live ? 1 : 0,
      onEvent(event) {
        if (event.type === 'text') {
          report.textCharacters += event.text.length;
          text = (text + event.text).slice(0, 4096);
          if (report.textCharacters > 4096) void handle.adapter.cancel().catch(() => {});
        }
        if (event.kind === 'tool_call' || event.kind === 'tool_call_update') {
          report.toolActivity++;
          void handle.adapter.cancel().catch(() => {});
        }
      },
    });
    report.stage = 'initialize';
    const init = await handle.adapter.initialize();
    report.agent = init.agentInfo;
    report.wireProtocol = init.protocolVersion;
    report.capabilities = handle.adapter.capabilities;
    if (live) {
      report.stage = 'create';
      const session = await handle.adapter.create(work);
      assert.equal(session.modes?.currentModeId, 'read-only', 'Read-only mode must be confirmed before a prompt');
      report.confirmedMode = session.modes.currentModeId;
      report.stage = 'prompt';
      const response = await handle.adapter.prompt(SMOKE_PROMPT);
      report.stopReason = response.stopReason;
      report.expectedReply = text.trim() === 'CAFE_ACP_OK';
      assert.equal(response.stopReason, 'end_turn');
      assert.equal(report.expectedReply, true);
      assert.equal(report.toolActivity, 0);
      assert(report.textCharacters <= 4096);
    }
    report.passed = true;
    report.stage = 'complete';
  } catch (error) {
    // No raw provider errors: they can contain private URLs, requests or auth details.
    report.error = { name: error?.name ?? 'Error', ...(typeof error?.code === 'number' ? { code: error.code } : {}) };
    report.state = handle?.adapter.state;
  } finally {
    report.promptAttempts = handle?.adapter.promptAttempts ?? 0;
    if (handle) {
      try { await handle.close(); report.ownedProcessClosed = true; }
      catch { report.ownedProcessClosed = false; report.passed = false; }
    }
    await writeFile(join(output, live ? 'live-report.json' : 'handshake-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    'acp-root': { type: 'string' }, codex: { type: 'string' }, output: { type: 'string' }, live: { type: 'boolean', default: false },
  }, strict: true });
  for (const key of ['acp-root', 'codex', 'output']) {
    if (!values[key] || !isAbsolute(values[key])) throw new Error(`--${key} requires an absolute path`);
  }
  const result = await runProbe({ acpRoot: values['acp-root'], codex: values.codex, output: values.output, live: values.live });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
}
