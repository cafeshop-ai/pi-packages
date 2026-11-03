// Experimental single-session adapter; uses the official SDK, not a second RPC stack.
export class AcpAdapter {
  #connection;
  #onEvent;
  #budget;
  #timeoutMs;
  #promptTimeoutMs;
  #state = 'new';
  #sessionId;
  #info;
  #sharedTransport;
  #attempts = 0;

  constructor({ sdk, transport, onEvent = () => {}, promptBudget = 0, timeoutMs = 600_000, promptTimeoutMs = timeoutMs, sharedTransport = false, onDisconnect = () => {} }) {
    if (promptBudget !== null && (!Number.isInteger(promptBudget) || promptBudget < 0 || promptBudget > 2)) {
      throw new Error('Prompt budget must be null or an integer from 0 to 2');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || (promptTimeoutMs !== null && (!Number.isInteger(promptTimeoutMs) || promptTimeoutMs < 1))) throw new Error('Invalid timeout');
    this.#sharedTransport = sharedTransport;
    this.#onEvent = onEvent;
    this.#budget = promptBudget;
    this.#timeoutMs = timeoutMs;
    this.#promptTimeoutMs = promptTimeoutMs;
    this.#connection = sdk.client({ name: 'cafe-space-acp-prototype' })
      .onRequest('session/request_permission', () => ({ outcome: { outcome: 'cancelled' } }))
      .onNotification('session/update', ({ params }) => {
        if (this.#state === 'closed' || this.#state === 'unknown' || params.sessionId !== this.#sessionId) return;
        const update = params.update;
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          this.#onEvent({ type: 'text', sessionId: this.#sessionId, text: update.content.text });
        } else {
          this.#onEvent({ type: 'activity', sessionId: this.#sessionId, kind: update.sessionUpdate, update });
        }
      })
      .connect(transport);
    this.#connection.closed.then(() => {
      if (this.#state !== 'closed') { this.#state = 'unknown'; onDisconnect(); }
    });
  }

  get state() { return this.#state; }
  get sessionId() { return this.#sessionId; }
  get promptAttempts() { return this.#attempts; }
  get capabilities() {
    return {
      restoreHistory: this.#info?.agentCapabilities?.loadSession === true,
      // This requires our guarded borrowed-runtime transport, not just session/load.
      sharedLiveSession: this.#sharedTransport && this.#info?.agentCapabilities?.sessionCapabilities?.resume != null,
    };
  }

  #requireState(expected) {
    if (this.#state !== expected) throw new Error(`Expected ${expected}; adapter is ${this.#state}`);
  }

  async #request(method, params) {
    try {
      const timeoutMs = method === 'session/prompt' ? this.#promptTimeoutMs : this.#timeoutMs;
      return await this.#connection.agent.request(method, params, {
        signal: timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // A lost response is not evidence the agent rejected the operation. Never retry.
      if (this.#state !== 'closed') this.#state = 'unknown';
      throw error;
    }
  }

  async initialize() {
    this.#requireState('new');
    this.#state = 'initializing';
    // shortcut: v1 only in this spike; add v2 after independent lifecycle tests, not by renaming methods.
    const response = await this.#request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'cafe-space-acp-prototype', version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    if (response.protocolVersion !== 1) {
      this.close();
      throw new Error('Unsupported negotiated ACP version');
    }
    this.#info = response;
    if (this.#state !== 'initializing') throw new Error('Connection closed during initialization');
    this.#state = 'ready';
    return response;
  }

  async create(cwd) {
    this.#requireState('ready');
    if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('cwd is required');
    this.#state = 'opening';
    const response = await this.#request('session/new', { cwd, mcpServers: [] });
    if (typeof response.sessionId !== 'string' || !response.sessionId) {
      this.#state = 'unknown';
      throw new Error('Agent returned no session ID');
    }
    if (this.#state !== 'opening') throw new Error('Connection closed during session creation');
    this.#sessionId = response.sessionId;
    this.#state = 'idle';
    return response;
  }

  async restore(sessionId, cwd) {
    this.#requireState('ready');
    if (!this.capabilities.restoreHistory) throw new Error('History restore is not supported');
    if (typeof sessionId !== 'string' || !sessionId || typeof cwd !== 'string' || !cwd.trim()) {
      throw new Error('sessionId and cwd are required');
    }
    this.#state = 'opening';
    this.#sessionId = sessionId; // Replay can precede the load response.
    const response = await this.#request('session/load', { sessionId, cwd, mcpServers: [] });
    if (this.#state !== 'opening') throw new Error('Connection closed during history restore');
    this.#state = 'idle';
    return response;
  }

  async attach(sessionId, cwd) {
    this.#requireState('ready');
    if (!this.capabilities.sharedLiveSession) throw new Error('Shared resume is not supported');
    if (typeof sessionId !== 'string' || !sessionId || typeof cwd !== 'string' || !cwd.trim()) {
      throw new Error('sessionId and cwd are required');
    }
    this.#state = 'opening';
    this.#sessionId = sessionId;
    // No replay, model selection, mode change or MCP replacement. Transport strips native overrides.
    const response = await this.#request('session/resume', { sessionId, cwd, mcpServers: [] });
    if (this.#state !== 'opening') throw new Error('Connection closed during shared attach');
    this.#state = 'idle';
    return response;
  }

  async prompt(text) {
    this.#requireState('idle');
    if (typeof text !== 'string' || !text.trim() || text.length > 4096) throw new Error('Invalid prompt');
    if (this.#budget !== null && this.#attempts >= this.#budget) throw new Error('Prompt budget exhausted');
    this.#attempts++; // Failed/unknown requests still consume budget.
    this.#state = 'running';
    const response = await this.#request('session/prompt', {
      sessionId: this.#sessionId, prompt: [{ type: 'text', text }],
    });
    if (this.#state !== 'running' && this.#state !== 'cancelling') throw new Error('Prompt outcome unknown');
    this.#state = 'idle';
    return response;
  }

  async cancel() {
    if (this.#state !== 'running') return;
    this.#state = 'cancelling';
    try {
      await this.#connection.agent.notify('session/cancel', { sessionId: this.#sessionId });
    } catch (error) {
      if (this.#state !== 'closed') this.#state = 'unknown';
      throw error;
    }
    // A sent cancellation is not a completed turn; wait for prompt's stop reason.
  }

  close() {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#connection.close(); // Disconnect only: no process kill or remote session deletion.
  }
}
