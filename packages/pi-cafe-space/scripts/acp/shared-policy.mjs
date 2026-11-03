import assert from 'node:assert/strict';

// Codex-specific transport guard, not a second message/event adapter. codex-acp keeps that job.
const GLOBAL_READS = new Set(['initialize', 'config/read', 'configRequirements/read', 'account/read', 'model/list', 'collaborationMode/list', 'skills/list']);
const THREAD_READS = new Set(['thread/read', 'thread/goal/get', 'thread/backgroundTerminals/list']);

export class SharedPolicy {
  #thread;
  #budget;
  #attempts = 0;
  #ownedTurns = new Set();
  #pending = new Map();
  #permissions = new Map();
  #stats = { forwarded: {}, blocked: {}, strippedOverrides: 0 };

  constructor({ threadId, promptBudget = 0 }) {
    assert(typeof threadId === 'string' && /^[a-f0-9-]{36}$/.test(threadId), 'Invalid target thread');
    assert(promptBudget === null || Number.isInteger(promptBudget) && promptBudget >= 0 && promptBudget <= 1, 'Shared prompt budget must be null, 0 or 1');
    this.#thread = threadId; this.#budget = promptBudget;
  }
  get stats() { return structuredClone({ ...this.#stats, promptAttempts: this.#attempts }); }
  get threadId() { return this.#thread; }

  client(message) {
    assert(message && typeof message === 'object' && !Array.isArray(message), 'Invalid RPC message');
    if (!message.method) {
      const expectedTurn = this.#permissions.get(message.id);
      assert(expectedTurn && this.#ownedTurns.has(expectedTurn), 'Unowned approval response');
      this.#permissions.delete(message.id);
      // Shared spike denies all approval options, including remembered/always approvals.
      return { id: message.id, error: { code: -32000, message: 'Shared probe denies tool approval' } };
    }
    const { method } = message, params = message.params ?? {};
    const reject = () => {
      this.#stats.blocked[method] = (this.#stats.blocked[method] ?? 0) + 1;
      throw new Error('Operation not allowed on borrowed runtime');
    };
    let safe;
    if (method === 'initialized') safe = { method, params: {} };
    else if (GLOBAL_READS.has(method)) safe = { ...message };
    else {
      if (params.threadId !== this.#thread) return reject();
      if (method === 'thread/resume') {
        // Omission preserves existing settings. Never forward adapter mode/provider/trust overrides.
        safe = { ...message, params: { threadId: this.#thread, excludeTurns: true } };
      } else if (THREAD_READS.has(method)) {
        if (method === 'thread/read' && params.includeTurns === true) return reject();
        safe = { ...message, params: { ...params, ...(method === 'thread/read' ? { includeTurns: false } : {}) } };
      } else if (method === 'turn/start') {
        if (this.#budget !== null && this.#attempts >= this.#budget || !Array.isArray(params.input) || params.input.length !== 1) return reject();
        const item = params.input[0];
        if (item.type !== 'text' || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 4096) return reject();
        this.#attempts++; // Never refunded, even when delivery is uncertain.
        safe = { ...message, params: { threadId: this.#thread, input: [{ type: 'text', text: item.text, text_elements: [] }] } };
      } else if (method === 'turn/interrupt') {
        if (!this.#ownedTurns.has(params.turnId)) return reject();
        safe = { ...message, params: { threadId: this.#thread, turnId: params.turnId } };
      } else if (method === 'thread/unsubscribe') {
        safe = { ...message, params: { threadId: this.#thread } }; // Detach only our connection.
      } else return reject();
    }
    if (safe.params && params !== safe.params) this.#stats.strippedOverrides += Object.keys(params).filter(key => !(key in safe.params)).length;
    this.#stats.forwarded[method] = (this.#stats.forwarded[method] ?? 0) + 1;
    if (message.id != null) {
      assert(!this.#pending.has(message.id), 'Duplicate pending RPC ID');
      this.#pending.set(message.id, method);
    }
    return safe;
  }

  server(message) {
    if (!message.method) {
      const method = this.#pending.get(message.id);
      if (!method) return null;
      this.#pending.delete(message.id);
      if (method === 'turn/start' && message.result?.turn?.id) this.#ownedTurns.add(message.result.turn.id);
      return message;
    }
    const params = message.params ?? {};
    const id = params.threadId ?? params.thread?.id;
    if (id !== this.#thread) return null; // No foreign session events or broad account/config pushes.
    if (message.id != null) {
      if (!this.#ownedTurns.has(params.turnId)) return null; // Other client's approvals are not ours.
      this.#permissions.set(message.id, params.turnId);
    }
    if (message.method === 'turn/completed') this.#ownedTurns.delete(params.turn?.id);
    return message;
  }
}
