import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, writeFile, truncate, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { SessionManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import register from './index.js';
import { createRelayServer } from '../relay/server.js';
import { applyEvent, decodeWireMessage, type EventEnvelope, type SessionSnapshot, type WireMessage } from '../protocol/index.js';

type Handler = (...args: any[]) => unknown;
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
class Inbox {
  private messages: WireMessage[] = [];
  private waiters = new Set<() => void>();
  constructor(readonly socket: WebSocket) {
    socket.on('message', data => { this.messages.push(decodeWireMessage(data.toString())); for (const wake of this.waiters) wake(); });
    socket.on('error', () => {});
  }
  next(predicate: (message: any) => boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(wake); reject(Error('synthetic parts message timeout')); }, 5000);
      const wake = () => {
        const index = this.messages.findIndex(predicate);
        if (index < 0) return;
        clearTimeout(timer); this.waiters.delete(wake); resolve(this.messages.splice(index, 1)[0]);
      };
      this.waiters.add(wake); wake();
    });
  }
}
const content = [
  { type: 'text', text: '先检查' },
  { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a' } },
  { type: 'text', text: '再检查' },
  { type: 'toolCall', id: 't2', name: 'read', arguments: { path: 'b' } },
  { type: 'text', text: '检查结束' },
];
const assistant = (blocks = content) => ({ role: 'assistant', content: blocks, timestamp: 1, stopReason: 'toolUse' });
async function harness(initial: unknown[] = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cafe-parts-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sessionDir = join(root, 'custom-sessions'); await mkdir(sessionDir);
  const relay = await createRelayServer({ host: '127.0.0.1', port: 0, hostToken: 'host-token', clientToken: 'client-token', allowedOrigins: [], logger: { info() {}, warn() {}, error() {} } }).listen();
  cleanups.push(() => relay.close());
  vi.stubEnv('PI_COLLAB_ENABLED', '1'); vi.stubEnv('PI_COLLAB_RELAY_URL', relay.url.replace(/^http/, 'ws') + '/ws');
  vi.stubEnv('PI_COLLAB_ROOM', 'parts'); vi.stubEnv('PI_COLLAB_HOST_TOKEN', 'host-token'); vi.stubEnv('PI_COLLAB_PEER_ID', 'parts-host');
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Handler>();
  let sessionName: string | undefined;
  const pi = { registerFlag() {}, getFlag(name: string) { return name === 'collab' ? true : undefined; }, on(name: string, fn: Handler) { handlers.set(name, fn); }, registerCommand(name: string, command: { handler: Handler }) { commands.set(name, command.handler); }, getSessionName() { return sessionName; }, setSessionName: vi.fn((name: string) => { sessionName = name; handlers.get('session_info_changed')?.({ name }, ctx); }), getCommands: vi.fn(() => [{ name: 'review:2', description: 'Review locally', source: 'extension', sourceInfo: { path: 'hidden-path' } }, { name: 'skill:check', source: 'skill' }, { name: 'template', source: 'prompt' }, { name: 'review:2', source: 'prompt', description: 'Shadowed template' }, { name: 'collab-session-control', source: 'extension' }, { name: 'cafe', source: 'extension' }]), sendUserMessage: vi.fn(), getThinkingLevel() { return 'off'; } } as unknown as ExtensionAPI;
  let branch = initial;
  const ctx = { cwd: root, hasUI: false, isIdle: () => true, hasPendingMessages: () => false, model: null, sessionManager: { getBranch: () => branch, getSessionId: () => 'current', getLeafId: () => null, getSessionDir: () => sessionDir } } as unknown as ExtensionContext;
  register(pi);
  cleanups.push(() => { handlers.get('session_shutdown')?.(); });
  await handlers.get('session_start')?.({}, ctx);
  let clientId = 0;
  const connect = async () => {
    const socket = new WebSocket(relay.url.replace(/^http/, 'ws') + '/ws');
    const inbox = new Inbox(socket);
    cleanups.push(async () => { if (socket.readyState === WebSocket.CLOSED) return; const closed = once(socket, 'close'); socket.terminate(); await closed; });
    await once(socket, 'open');
    const ready = inbox.next(m => m.type === 'snapshot');
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: 1, peerRole: 'client', peerId: `client-${++clientId}`, roomId: 'parts', token: 'client-token' }));
    const { snapshot } = await ready;
    return { socket, inbox, snapshot: snapshot as SessionSnapshot };
  };
  return { root, sessionDir, ctx, pi, commands, connect, setBranch(value: unknown[]) { branch = value; }, fire(name: string, event: unknown) { return handlers.get(name)?.(event, ctx); } };
}
it('commands use native expansion; bounded references reuse file guards and fences without partial dispatch', async () => {
  const h = await harness(); const c = await h.connect(); let sequence = 0;
  expect(c.snapshot.inputAssist).toBe(true);
  const request = async (payload: object, fence: object = {}) => {
    const requestId = `input-${++sequence}`;
    const result = c.inbox.next(m => m.type === 'command_result' && m.requestId === requestId);
    c.socket.send(JSON.stringify({ type: 'command', requestId, targetHostId: 'parts-host', expectedStreamId: c.snapshot.streamId, expectedSessionId: 'current', expectedCwd: h.root, payload, ...fence }));
    return result;
  };
  const inventory = await request({ name: 'list_commands' });
  expect(inventory.data.commands.map((x: any) => x.name)).toEqual(['review:2', 'skill:check', 'template']);
  expect(JSON.stringify(inventory.data)).not.toContain('hidden-path');
  expect(inventory.data.commands[0].source).toBe('extension');
  for (const command of ['/missing', '/reload', '/collab-session-control fake', '/cafe', '/cafe share']) expect((await request({ name: 'run_command', command })).code).toBe('COMMAND_UNAVAILABLE');
  expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
  expect((await request({ name: 'run_command', command: '/review:2\targument' })).status).toBe('dispatched');
  expect(h.pi.sendUserMessage).toHaveBeenLastCalledWith('/review:2 argument', { expandPromptTemplates: true });
  await mkdir(join(h.root, 'src')); await writeFile(join(h.root, 'src', '咖啡 note.ts'), 'const value = 42;');
  await writeFile(join(h.root, '.env'), 'never include'); await writeFile(join(h.root, 'large.txt'), 'x'.repeat(65537));
  await writeFile(join(h.root, 'binary.bin'), Buffer.from([0, 1, 2]));
  for (const [path, code] of [['.env', 'SENSITIVE_PATH'], ['../outside', 'PATH_NOT_ALLOWED'], ['large.txt', 'FILE_TOO_LARGE'], ['binary.bin', 'BINARY_FILE'], ['missing', 'PATH_NOT_FOUND']]) {
    expect((await request({ name: 'prompt', content: 'review', files: ['src/咖啡 note.ts', path] })).code).toBe(code);
  }
  expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1);
  expect((await request({ name: 'prompt', content: 'review', files: ['src/咖啡 note.ts'] }, { expectedCwd: undefined })).code).toBe('STALE_SESSION');
  expect((await request({ name: 'prompt', content: 'review', files: ['src/咖啡 note.ts', 'src/咖啡 note.ts'] })).status).toBe('dispatched');
  const sent = vi.mocked(h.pi.sendUserMessage).mock.calls.at(-1)![0] as string;
  expect(sent).toContain('const value = 42;'); expect(sent.match(/const value/g)).toHaveLength(1);
  vi.spyOn(h.ctx, 'hasPendingMessages').mockReturnValue(true);
  expect((await request({ name: 'run_command', command: '/review:2' })).code).toBe('SESSION_BUSY');
  expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(2);
});
it('session controls use native naming, guarded command context, cancellation and shutdown handoff without model prompts', async () => {
  const h = await harness(); const c = await h.connect();
  expect(c.snapshot.sessionControl).toBe(true);
  expect(h.fire('input', { source: 'extension', text: '/collab-session-control unissued-token' })).toEqual({ action: 'handled' });
  expect(h.fire('input', { source: 'extension', text: 'ordinary prompt' })).toBeUndefined();
  let sequence = 0;
  const request = async (payload: object, fence: object = {}) => {
    const requestId = `control-${++sequence}`;
    const result = c.inbox.next(m => m.type === 'command_result' && m.requestId === requestId);
    c.socket.send(JSON.stringify({ type: 'command', requestId, targetHostId: 'parts-host', expectedStreamId: c.snapshot.streamId, expectedSessionId: 'current', expectedCwd: h.root, payload, ...fence }));
    return result;
  };
  expect((await request({ name: 'rename_session', title: '  Café review  ' })).status).toBe('applied');
  expect(h.pi.setSessionName).toHaveBeenCalledWith('Café review');
  expect((await c.inbox.next(m => m.type === 'snapshot' && m.snapshot.sessionName === 'Café review')).snapshot.streamId).toBe(c.snapshot.streamId);
  expect((await request({ name: 'new_session' }, { expectedSessionId: 'wrong' })).code).toBe('STALE_SESSION');
  expect((await request({ name: 'new_session' }, { expectedCwd: undefined })).code).toBe('STALE_SESSION');
  const pending = vi.spyOn(h.ctx, 'hasPendingMessages').mockReturnValue(true);
  expect((await request({ name: 'new_session' })).code).toBe('SESSION_BUSY'); pending.mockReturnValue(false);
  const native = { ...h.ctx, newSession: vi.fn(async () => ({ cancelled: true })) };
  await h.commands.get('collab-session-control')!('unissued-token', native);
  expect(native.newSession).not.toHaveBeenCalled();
  vi.mocked(h.pi.sendUserMessage).mockImplementation((text, options) => {
    expect(options).toEqual({ expandPromptTemplates: true });
    expect(text).toMatch(/^\/collab-session-control [a-f0-9-]{36}$/);
    void h.commands.get('collab-session-control')!(String(text).split(' ')[1], native);
  });
  expect((await request({ name: 'new_session' })).code).toBe('SESSION_CANCELLED');
  expect(native.newSession).toHaveBeenCalledTimes(1);
  native.newSession.mockImplementation(async () => {
    h.fire('session_shutdown', { reason: 'new' });
    Object.defineProperty(native, 'cwd', { get() { throw Error('old command context used after replacement'); } });
    return { cancelled: false };
  });
  expect((await request({ name: 'new_session' })).status).toBe('dispatched');
  expect(native.newSession).toHaveBeenCalledTimes(2);
  expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(2);
});
it('resume resolves only an opaque ID in the current project and rechecks context after async lookup', async () => {
  const h = await harness(); const c = await h.connect();
  const path = join(h.sessionDir, 'synthetic.jsonl'); await writeFile(path, 'synthetic test only');
  let openedCwd = h.root;
  const list = vi.spyOn(SessionManager, 'list').mockResolvedValue([{ id: 'saved/%2F:id', path, cwd: h.root, created: new Date(0), modified: new Date(0), messageCount: 0, firstMessage: '', allMessagesText: '' }]);
  vi.spyOn(SessionManager, 'open').mockImplementation(() => ({ getSessionId: () => 'saved/%2F:id', getCwd: () => openedCwd }) as unknown as SessionManager);
  const native = { ...h.ctx, switchSession: vi.fn(async (_path: string) => ({ cancelled: true })) };
  vi.mocked(h.pi.sendUserMessage).mockImplementation(text => { void h.commands.get('collab-session-control')!(String(text).split(' ')[1], native); });
  let sequence = 0;
  const request = async (sessionId = 'saved/%2F:id') => {
    const requestId = `resume-${++sequence}`;
    const result = c.inbox.next(m => m.type === 'command_result' && m.requestId === requestId);
    c.socket.send(JSON.stringify({ type: 'command', requestId, targetHostId: 'parts-host', expectedStreamId: c.snapshot.streamId, expectedSessionId: 'current', expectedCwd: h.root, payload: { name: 'resume_session', sessionId } }));
    return result;
  };
  expect((await request(path)).code).toBe('SESSION_NOT_FOUND');
  openedCwd = join(h.root, 'other'); expect((await request()).code).toBe('SESSION_INVALID');
  expect(native.switchSession).not.toHaveBeenCalled();
  openedCwd = h.root; expect((await request()).code).toBe('SESSION_CANCELLED');
  expect(native.switchSession).toHaveBeenCalledExactlyOnceWith(path);
  list.mockImplementationOnce(async () => { Object.defineProperty(native, 'cwd', { get() { throw Error('invalidated'); } }); return []; });
  expect((await request()).status).toBe('rejected');
  expect(native.switchSession).toHaveBeenCalledTimes(1);
});
it('closing local UI restores native idle/running authority even without an agent turn', async () => {
  const h = await harness(); const c = await h.connect();
  const idle = vi.spyOn(h.ctx, 'isIdle');
  for (const isIdle of [true, false]) {
    idle.mockReturnValue(isIdle);
    h.fire('ui_prompt_start', { title: 'Synthetic command confirmation' });
    await c.inbox.next(m => m.type === 'event' && m.event.kind === 'ui_wait' && m.event.waiting);
    h.fire('ui_prompt_end', {});
    await c.inbox.next(m => m.type === 'event' && m.event.kind === 'ui_wait' && !m.event.waiting);
    expect((await c.inbox.next(m => m.type === 'event' && m.event.kind === 'session_state')).event.phase).toBe(isIdle ? 'idle' : 'running');
  }
});
it('streams actual indexes through new objects; inline call evidence survives reverse completion, empty results and reconnect', async () => {
  const h = await harness(); const c = await h.connect(); let state = c.snapshot;
  const fire = async (name: string, event: unknown, kind: string) => {
    const pending = c.inbox.next(m => m.type === 'event' && m.event.kind === kind);
    h.fire(name, event);
    const wire = await pending as EventEnvelope;
    state = applyEvent(state, wire);
    return wire.event;
  };
  await fire('message_start', { message: assistant([]) }, 'message_started');
  await fire('message_update', { message: assistant([{ type: 'text', text: '先检查' }]), assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '先检查' } }, 'message_delta');
  expect(state.messages[0]?.parts).toStrictEqual([{ index: 0, type: 'text', text: '先检查' }]);
  const messageId = state.messages[0]!.id;
  await fire('message_end', { message: assistant() }, 'message_finished');
  expect(state.messages).toHaveLength(1);
  expect(state.messages[0]?.id).toBe(messageId);
  expect(state.messages[0]?.parts?.map(p => p.index)).toEqual([0, 1, 2, 3, 4]);
  for (const id of ['t1', 't2']) await fire('tool_execution_start', { toolCallId: id, toolName: 'read', args: {} }, 'tool_started');
  expect(state.tools.map(t => t.parentMessageId)).toEqual([messageId, messageId]);
  await fire('tool_execution_update', { toolCallId: 't1', partialResult: { content: [{ type: 'text', text: 'partial' }] } }, 'tool_updated');
  await fire('tool_execution_end', { toolCallId: 't2', toolName: 'read', result: { content: [{ type: 'text', text: 'failure' }] }, isError: true }, 'tool_finished');
  await fire('tool_execution_end', { toolCallId: 't1', toolName: 'read', result: { content: [] }, isError: false }, 'tool_finished');
  for (const [id, isError] of [['t2', true], ['t1', false]] as const) await fire('message_end', { message: { role: 'toolResult', timestamp: 2, toolCallId: id, toolName: 'read', content: [], isError } }, 'message_finished');
  expect(state.tools[0]?.output).toBe('');
  expect(state.tools[1]?.status).toBe('error');
  expect(state.messages.slice(1).map(m => [m.toolCallId, m.text, m.toolIsError, m.status])).toEqual([['t2', '', true, 'error'], ['t1', '', false, 'complete']]);
  const fresh = await h.connect(); expect(fresh.snapshot.messages).toStrictEqual(state.messages); expect(fresh.snapshot.tools).toStrictEqual(state.tools);
  // Scope reset removes the old reverse index, including repeated call IDs.
  const reset = c.inbox.next(m => m.type === 'snapshot' && m.snapshot.streamId !== state.streamId);
  h.fire('session_tree', {}); state = (await reset).snapshot;
  const event = await fire('tool_execution_start', { toolCallId: 't1', toolName: 'read', args: {} }, 'tool_started');
  expect(event.kind === 'tool_started' && event.tool.parentMessageId).toBeUndefined();
});
it('rebuilds structured history in a fresh host and recovers hostile callbacks without escaping', async () => {
  const entries = [{ type: 'message', id: 'saved-a1', message: assistant() }, { type: 'message', id: 'saved-t1', message: { role: 'toolResult', timestamp: 2, toolCallId: 't1', toolName: 'read', content: [], isError: false } }];
  const h = await harness(entries); const c = await h.connect();
  expect(c.snapshot.messages[0]?.parts?.map(p => p.index)).toEqual([0, 1, 2, 3, 4]);
  expect(c.snapshot.messages[1]).toMatchObject({ text: '', toolIsError: false });
  for (const bad of [{ get message() { throw Error('getter'); } }, { message: new Proxy({}, { get() { throw Error('proxy'); } }) }]) {
    const recovery = c.inbox.next(m => m.type === 'snapshot' && m.snapshot.historyTruncated);
    expect(() => h.fire('message_start', bad)).not.toThrow(); await recovery;
  }
  const next = c.inbox.next(m => m.type === 'event' && m.event.kind === 'message_finished');
  h.fire('message_end', { message: assistant([{ type: 'text', text: 'recovered' }]) });
  expect((await next).event.message.parts).toEqual([{ index: 0, type: 'text', text: 'recovered' }]);
});
it('history uses current custom sessionDir and preserves parts; rejects opened ID/cwd and 64MiB violations before projection', async () => {
  const h = await harness(); const c = await h.connect();
  const path = join(h.sessionDir, 'synthetic.jsonl'); await writeFile(path, 'synthetic test only');
  let id = 'historical'; let openedId = id; let openedCwd = h.root;
  const list = vi.spyOn(SessionManager, 'list').mockImplementation(async () => [{ id, path, cwd: h.root, created: new Date(0), modified: new Date(0), messageCount: 1, firstMessage: '', allMessagesText: '' }]);
  const open = vi.spyOn(SessionManager, 'open').mockImplementation(() => ({ getSessionId: () => openedId, getCwd: () => openedCwd, getLeafId: () => 'saved-a', getBranch: () => [{ type: 'message', id: 'saved-a', message: assistant() }] }) as unknown as SessionManager);
  let seq = 0;
  const request = async (payload: object) => {
    const requestId = `request-${++seq}`;
    const result = c.inbox.next(m => m.type === 'command_result' && m.requestId === requestId);
    c.socket.send(JSON.stringify({ type: 'command', requestId, targetHostId: 'parts-host', expectedStreamId: c.snapshot.streamId, expectedSessionId: 'current', expectedCwd: h.root, payload }));
    return result;
  };
  expect((await request({ name: 'list_sessions' })).status).toBe('applied');
  expect(list).toHaveBeenLastCalledWith(h.root, h.sessionDir);
  const result = await request({ name: 'get_session', sessionId: id });
  expect(result.status).toBe('applied');
  expect(result.data.messages[0].parts.map((p: any) => p.index)).toEqual([0, 1, 2, 3, 4]);
  expect(list).toHaveBeenLastCalledWith(h.root, h.sessionDir);
  id = 'wrong-id'; openedId = 'other';
  expect((await request({ name: 'get_session', sessionId: id })).code).toBe('SESSION_INVALID');
  id = 'wrong-cwd'; openedId = id; openedCwd = join(h.root, 'elsewhere');
  expect((await request({ name: 'get_session', sessionId: id })).code).toBe('SESSION_INVALID');
  id = 'oversized'; openedId = id; openedCwd = h.root;
  await truncate(path, 64 * 1024 * 1024 + 1); open.mockClear();
  expect((await request({ name: 'get_session', sessionId: id })).code).toBe('SESSION_INVALID');
  expect(open).not.toHaveBeenCalled();
});

it('separates settled outcome from interim errors and preserves it through relay reconnect',async()=>{
 const h=await harness(),c=await h.connect();expect(c.snapshot.execution).toMatchObject({activity:'idle',outcome:'none',runId:null});
 h.ctx.isIdle=()=>false;h.fire('agent_start',{});const running=await c.inbox.next(m=>m.type==='event'&&m.event.kind==='session_state');const runId=running.event.execution.runId;
 const failed={...assistant([{type:'text',text:'temporary failure'}]),stopReason:'error'};h.fire('message_start',{message:failed});h.fire('message_end',{message:failed});h.fire('agent_before_settle',{outcome:'error'});expect((await h.connect()).snapshot.execution).toMatchObject({outcome:'none',runId});
 h.fire('agent_start',{});expect((await c.inbox.next(m=>m.type==='event'&&m.event.kind==='session_state')).event.execution.runId).toBe(runId);
 const recovered={...assistant([{type:'text',text:'recovered'}]),timestamp:2,stopReason:'stop'};h.fire('message_start',{message:recovered});h.fire('message_end',{message:recovered});h.fire('agent_before_settle',{outcome:'completed'});h.ctx.isIdle=()=>true;h.fire('agent_settled',{aborted:false});const completed=await c.inbox.next(m=>m.type==='event'&&m.event.kind==='session_state');expect(completed.event.execution).toMatchObject({activity:'idle',outcome:'completed',runId});expect((await h.connect()).snapshot.execution).toEqual(completed.event.execution);
 h.ctx.isIdle=()=>false;h.fire('agent_start',{});const next=await c.inbox.next(m=>m.type==='event'&&m.event.kind==='session_state');expect(next.event.execution.runId).not.toBe(runId);h.fire('agent_before_settle',{outcome:'completed'});h.ctx.isIdle=()=>true;h.fire('agent_settled',{aborted:true});expect((await c.inbox.next(m=>m.type==='event'&&m.event.kind==='session_state')).event.execution.outcome).toBe('aborted');
 h.fire('session_tree',{});const reset=await c.inbox.next(m=>m.type==='snapshot');expect(reset.snapshot.execution).toMatchObject({runId:null,outcome:'none'});
});

it('retains prompt kinds and does not reinterpret UI as account authentication',async()=>{
 const h=await harness(),c=await h.connect();
 for(const kind of ['confirm','select','input','editor','custom']){
  h.fire('ui_prompt_start',{kind,title:'test prompt'});const e=await c.inbox.next(m=>m.type==='event'&&m.event.kind==='ui_wait'&&m.event.waiting);expect(e.event.promptKind).toBe(kind);expect((await h.connect()).snapshot.execution).toMatchObject({activity:'waiting',waitKind:kind,outcome:'none'});
  h.fire('ui_prompt_end',{kind,title:'test prompt'});const idle=await c.inbox.next(m=>m.type==='event'&&m.event.kind==='session_state');expect(idle.event.phase).toBe('idle');expect(idle.event.execution.outcome).toBe('none');
 }
});

it('manual compaction reconciles native post-callback idle; automatic compaction retains the run',async()=>{
 const h=await harness(),c=await h.connect();h.ctx.isIdle=()=>false;h.fire('session_before_compact',{reason:'manual'});expect((await c.inbox.next(m=>m.type==='event'&&m.event.kind==='session_state')).event.execution.activity).toBe('compacting');h.fire('session_compact',{reason:'manual'});h.ctx.isIdle=()=>true;const idle=await c.inbox.next(m=>m.type==='event'&&m.event.kind==='session_state'&&m.event.phase==='idle');expect(idle.event.execution.outcome).toBe('none');
 h.ctx.isIdle=()=>false;h.fire('agent_start',{});const start=await c.inbox.next(m=>m.type==='event'&&m.event.kind==='session_state'&&m.event.execution.runId!==null&&m.event.execution.activity==='working');const runId=start.event.execution.runId;
 h.fire('session_before_compact',{reason:'overflow'});const compact=await c.inbox.next(m=>m.type==='event'&&m.event.kind==='session_state'&&m.event.execution.activity==='compacting');expect(compact.event.execution.reason).toBe('overflow');h.fire('session_compact_failed',{reason:'overflow',aborted:true,willRetry:true});expect((await h.connect()).snapshot.execution).toMatchObject({runId,activity:'working',outcome:'none'});h.ctx.isIdle=()=>true;h.fire('agent_settled',{aborted:true});expect((await c.inbox.next(m=>m.type==='event'&&m.event.kind==='session_state'&&m.event.phase==='idle')).event.execution.outcome).toBe('aborted');
});

it('legacy settlement without outcome evidence is unknown, not success',async()=>{const h=await harness(),c=await h.connect();h.fire('agent_start',{});await c.inbox.next(m=>m.type==='event'&&m.event.kind==='session_state');h.fire('agent_settled',{});expect((await c.inbox.next(m=>m.type==='event'&&m.event.kind==='session_state')).event.execution.outcome).toBe('unknown');});
