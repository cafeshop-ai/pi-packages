// Acceptance-only transport fence. No provider secrets are persisted here.
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
export const EXTERNAL_LIMITS = Object.freeze({ calls: 2, outputTokens: 1024, durationMs: 60_000, bodyBytes: 16_384 });
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Options = { url: string; apiKey: string; ledger: string; fetch: Fetch; now?: () => number };
export class ExternalBudget {
  #options: Options;
  #now: () => number;
  #started: number | undefined;
  #closed = false;
  #ended: number | undefined;
  #fd: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #controller = new AbortController();
  #calls = 0;
  #requests = 0;
  #statuses: number[] = [];
  constructor(options: Options) {
    const url = new URL(options.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || options.apiKey.length < 8) throw Error('EXTERNAL_CONFIG_REJECTED');
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
  }
  get signal() { return this.#controller.signal; }
  #record(value: object) {
    if (this.#fd !== undefined) { writeSync(this.#fd, JSON.stringify(value) + '\n'); fsyncSync(this.#fd); }
  }
  arm() {
    if (this.#started !== undefined || this.#closed) throw Error('ALREADY_ARMED');
    // A spent authorization is deliberately retained across failed runs.
    this.#fd = openSync(this.#options.ledger, 'wx', 0o600);
    this.#started = this.#now();
    this.#record({ kind: 'armed', limits: EXTERNAL_LIMITS, time: new Date().toISOString() });
    this.#timer = setTimeout(() => this.close(), EXTERNAL_LIMITS.durationMs);
    this.#timer.unref();
  }
  #check() {
    if (this.#started === undefined) throw Error('NOT_ARMED');
    if (this.#now() - this.#started >= EXTERNAL_LIMITS.durationMs) { this.close(); throw Error('DEADLINE'); }
    if (this.#closed) throw Error('BUDGET_CLOSED');
  }
  reserve() {
    this.#check();
    if (this.#calls >= EXTERNAL_LIMITS.calls) throw Error('CALL_LIMIT');
    const call = ++this.#calls;
    this.#record({ kind: 'call', call });
    let used = false;
    const fetch: Fetch = async (input, init = {}) => {
      this.#check();
      if (used) throw Error('ALREADY_SENT');
      const destination = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
      if (destination !== this.#options.url || init.method !== 'POST' || typeof init.body !== 'string' || Buffer.byteLength(init.body) > EXTERNAL_LIMITS.bodyBytes) throw Error('REQUEST_REJECTED');
      if (new Headers(init.headers).get('authorization') !== `Bearer ${this.#options.apiKey}` || init.body.includes(this.#options.apiKey)) throw Error('REQUEST_REJECTED');
      let body: Record<string, unknown>;
      try { body = JSON.parse(init.body); } catch { throw Error('REQUEST_REJECTED'); }
      const fields = ['model', 'input', 'stream', 'store', 'max_output_tokens', 'tools', 'tool_choice', 'reasoning', 'include'];
      if (!body || typeof body !== 'object' || Object.keys(body).some(key => !fields.includes(key)) || body.model !== 'gpt-6-astra' || body.max_output_tokens !== EXTERNAL_LIMITS.outputTokens || body.stream !== true || body.store !== false || !Array.isArray(body.input)) throw Error('REQUEST_REJECTED');
      used = true;
      this.#requests++;
      this.#record({ kind: 'request', call, request: this.#requests, bytes: Buffer.byteLength(init.body), maxOutputTokens: body.max_output_tokens, redirect: 'error' });
      const signal = init.signal ? AbortSignal.any([init.signal, this.signal]) : this.signal;
      try {
        const response = await this.#options.fetch(input, { ...init, redirect: 'error', signal });
        this.#statuses.push(response.status);this.#record({ kind: 'response', call, status: response.status });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          this.close();
          return new Response(JSON.stringify({ error: { message: 'External acceptance provider request failed; details suppressed' } }), { status: response.status, headers: { 'Content-Type': 'application/json' } });
        }
        return response;
      } catch {
        this.close();
        throw Error('EXTERNAL_REQUEST_FAILED');
      }
    };
    return { call, fetch, timeoutMs: Math.max(1, Math.floor(EXTERNAL_LIMITS.durationMs - (this.#now() - this.#started!))) };
  }
  summary() {
    return { calls: this.#calls, requests: this.#requests, statuses: [...this.#statuses], closed: this.#closed, elapsedMs: this.#started === undefined ? 0 : Math.ceil((this.#ended ?? this.#now()) - this.#started), limits: EXTERNAL_LIMITS };
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#ended = this.#now();
    clearTimeout(this.#timer);this.#controller.abort();
    this.#record({ kind: 'closed', calls: this.#calls, requests: this.#requests });
    if (this.#fd !== undefined) { closeSync(this.#fd);this.#fd = undefined; }
  }
}
