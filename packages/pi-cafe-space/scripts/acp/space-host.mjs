import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';

// Uses the existing authenticated Space host channel. No browser-to-agent bypass.
export class AcpSpaceHost {
  #protocol; #adapter; #socket; #config; #agentSessionId; #welcomed = false; #closed = false;
  #snapshot; #results = new Map(); #userMessages = new Set(); #current = null; #resolveClosed;
  closed = new Promise(resolve => { this.#resolveClosed = resolve; });
  constructor({ protocol, adapter, sessionId, agentSessionId = sessionId, cwd, name, model = null, thinkingLevel = 'off', config }) {
    const url = new URL(config.relayUrl);
    assert(url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash, 'ACP host requires a loopback WebSocket relay');
    assert(protocol.hasSufficientTokenEntropy(config.token), 'A strong host token is required');
    protocol.decodeWireMessage(JSON.stringify({ type: 'hello', protocolVersion: 1, peerRole: 'host', peerId: config.hostId, roomId: config.roomId, token: config.token }));
    this.#protocol = protocol; this.#adapter = adapter; this.#config = config; this.#agentSessionId = agentSessionId;
    this.#snapshot = {
      protocolVersion: 1, streamId: randomUUID(), sessionId, sessionName: name, cwd, activeLeafId: null,
      model, thinkingLevel, phase: 'idle', hasPendingMessages: false, sessionControl: false, inputAssist: false,
      agent: { name, modelControl: false, deliveryControl: false },
      messages: [], historyTruncated: true, tools: [], lastEventSeq: 0,
    };
    assert(protocol.isSessionSnapshot(this.#snapshot), 'Invalid agent snapshot');
    const canonical = protocol.decodeWireMessage(JSON.stringify({ type: 'snapshot', snapshot: this.#snapshot }));
    assert(canonical.snapshot.agent?.modelControl === false, 'Rebuild the Space protocol before starting ACP');
  }
  get snapshot() { return structuredClone(this.#snapshot); }
  #send(message) {
    if (!this.#welcomed || this.#socket?.readyState !== WebSocket.OPEN) return;
    assert(this.#socket.bufferedAmount < 1024 * 1024, 'Slow Space connection');
    const text = JSON.stringify(this.#protocol.decodeWireMessage(JSON.stringify(message)));
    this.#socket.send(text);
  }
  #event(event) {
    const envelope = { type: 'event', streamId: this.#snapshot.streamId, sessionId: this.#snapshot.sessionId,
      seq: this.#snapshot.lastEventSeq + 1, emittedAt: new Date().toISOString(), event };
    this.#snapshot = this.#protocol.applyEvent(this.#snapshot, envelope);
    let pruned = false;
    while (this.#snapshot.messages.length > 24 || this.#snapshot.tools.length > 24 || Buffer.byteLength(JSON.stringify(this.#snapshot)) > 200000) {
      if (this.#snapshot.tools.length) this.#snapshot.tools.shift();
      else if (this.#snapshot.messages.length) this.#snapshot.messages.shift();
      else throw new Error('ACP snapshot exceeds limit');
      this.#snapshot.historyTruncated = true; pruned = true;
    }
    this.#send(pruned ? { type: 'snapshot', snapshot: this.#snapshot } : envelope);
  }
  #finish(status = 'complete') {
    if (!this.#current) return;
    const message = this.#snapshot.messages.find(m => m.id === this.#current);
    if (message) this.#event({ kind: 'message_finished', message: { ...message, status } });
    this.#current = null;
  }
  state(running, outcome = 'none') {
    if (this.#closed) return;
    if (!running) this.#finish(outcome === 'error' || outcome === 'unknown' ? 'error' : 'complete');
    this.#event({ kind: 'session_state', phase: running ? 'running' : 'idle', hasPendingMessages: false });
  }
  event(event) {
    if (this.#closed || event.sessionId !== this.#agentSessionId) return;
    if (event.type === 'user') {
      if (this.#userMessages.has(event.messageId)) return;
      this.#userMessages.add(event.messageId);
      if (this.#userMessages.size > 512) this.#userMessages.delete(this.#userMessages.values().next().value);
      this.#finish();
    }
    const update = event.update;
    if (this.#snapshot.phase === 'idle' && (event.type === 'user' || event.type === 'text' || ['user_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(update?.sessionUpdate))) this.state(true);
    if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
      assert(typeof update.toolCallId === 'string', 'Missing ACP tool ID');
      const toolCallId = createHash('sha256').update(update.toolCallId).digest('hex');
      const previous = this.#snapshot.tools.find(tool => tool.toolCallId === toolCallId);
      const output = update.content?.filter(item => item.type === 'content' && item.content?.type === 'text').map(item => item.content.text).join('\n');
      const tool = { toolCallId, toolName: (update.title ?? previous?.toolName ?? 'ACP tool').slice(0, 128),
        argsText: update.rawInput === undefined ? previous?.argsText ?? '' : JSON.stringify(update.rawInput).slice(0, 8192),
        output: output === undefined ? previous?.output ?? '' : output.slice(0, 8192),
        status: update.status === 'completed' ? 'complete' : update.status === 'failed' ? 'error' : previous?.status ?? 'running' };
      this.#event({ kind: tool.status === 'running' ? 'tool_started' : 'tool_finished', tool });
      return;
    }
    const role = event.type === 'user' || update?.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant';
    const thinking = update?.sessionUpdate === 'agent_thought_chunk';
    const text = event.type === 'user' || event.type === 'text' ? event.text : (role === 'user' || thinking) && update?.content?.type === 'text' ? update.content.text : null;
    if (text === null) return;
    const previous = this.#snapshot.messages.find(m => m.id === this.#current);
    if (!previous || previous.role !== role) {
      this.#finish(); this.#current = randomUUID();
      this.#event({ kind: 'message_started', message: { id: this.#current, role, text: '', thinking: '', timestamp: Date.now(), status: 'streaming', toolName: null, toolCallId: null } });
    }
    const message = this.#snapshot.messages.find(m => m.id === this.#current);
    const channel = thinking ? 'thinking' : 'text';
    const delta = text.slice(0, Math.max(0, 16000 - message[channel].length));
    if (delta) this.#event({ kind: 'message_delta', messageId: this.#current, channel, delta });
  }
  async connect() {
    assert(!this.#socket && !this.#closed, 'Host already started');
    const ws = this.#socket = new WebSocket(this.#config.relayUrl, { maxPayload: this.#protocol.MAX_FRAME_BYTES });
    ws.on('error', () => {});
    ws.on('close', () => this.close());
    ws.on('message', raw => {
      try {
        const message = this.#protocol.decodeWireMessage(raw.toString('utf8'));
        if (message.type === 'welcome') {
          assert(message.peerRole === 'host' && message.roomId === this.#config.roomId && !this.#welcomed, 'Invalid relay welcome');
          this.#welcomed = true;
          this.#send({ type: 'snapshot', snapshot: this.#snapshot });
        } else if (message.type === 'routed_command') {
          assert(this.#welcomed, 'Command before authentication');
          void this.command(message).then(result => this.#send(result)).catch(() => this.close());
        } else if (message.type === 'error') this.close();
      } catch { this.close(); }
    });
    const timer = setTimeout(() => this.close(), 15000);
    try {
      await once(ws, 'open');
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, peerRole: 'host', peerId: this.#config.hostId, roomId: this.#config.roomId, token: this.#config.token }));
      while (!this.#welcomed && !this.#closed) {
        await Promise.race([once(ws, 'message'), once(ws, 'close')]);
      }
      assert(this.#welcomed && !this.#closed, 'Space handshake failed');
    } finally { clearTimeout(timer); }
  }
  command(message) {
    // Validate independently of relay. Agent capabilities never grant device authorization.
    const canonical = this.#protocol.decodeWireMessage(JSON.stringify(message));
    assert.equal(canonical.type, 'routed_command');
    const key = JSON.stringify([message.sourcePeerId, message.clientRequestId]);
    const prior = this.#results.get(key);
    const signature = JSON.stringify([message.expectedStreamId, message.expectedSessionId, message.expectedCwd, message.payload]);
    const result = (status, code = null) => ({ type: 'host_command_result', relayRequestId: message.relayRequestId, status, code, message: null });
    if (prior) return prior.signature === signature ? prior.promise.then(value => ({ ...value, relayRequestId: message.relayRequestId })) : Promise.resolve(result('rejected', 'REQUEST_CONFLICT'));
    if (this.#results.size >= 1000) return Promise.resolve(result('rejected', 'HOST_CAPACITY'));
    const promise = (async () => {
      if (this.#closed || message.expectedStreamId !== this.#snapshot.streamId || message.expectedSessionId !== this.#snapshot.sessionId || message.expectedCwd !== this.#snapshot.cwd) return result('rejected', 'STALE_SESSION');
      const payload = message.payload;
      if (payload.name === 'abort') {
        if (this.#adapter.state !== 'running') return result('rejected', 'NO_OWNED_TURN');
        await this.#adapter.cancel(); return result('dispatched');
      }
      if (payload.name !== 'prompt' || payload.delivery || payload.files?.length) return result('rejected', 'CAPABILITY_UNSUPPORTED');
      if (this.#snapshot.phase !== 'idle' || this.#adapter.state !== 'idle') return result('rejected', 'SESSION_BUSY');
      if (!payload.content.trim() || payload.content.length > 4096) return result('rejected', 'PROMPT_TOO_LARGE');
      // Do not fabricate a user transcript from the request; only native events add messages.
      try {
        const response = await this.#adapter.prompt(payload.content);
        this.state(false, response.stopReason === 'end_turn' ? 'completed' : 'error');
        return result('applied');
      } catch {
        this.state(false, 'unknown');
        const unknown = this.#adapter.state === 'unknown';
        if (unknown) this.close();
        return result('rejected', unknown ? 'HOST_OFFLINE' : 'AGENT_ERROR');
      }
    })();
    this.#results.set(key, { signature, promise });
    return promise;
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#adapter.close(); // Never calls session/close or cancels an external terminal turn.
    this.#socket?.terminate();
    this.#resolveClosed();
  }
}
