import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import OpenAI from "openai";
import { Agent, ProxyAgent, fetch as httpFetch } from "undici";
import { ResponsesWS } from "openai/resources/responses/ws";
import { ResponsesWebSocketSession, type ResponsesWebSocketLane, type ResponsesWebSocketEvent } from "openai/lib/responses/responses-websocket-session";
import { lazyStream, openAIResponsesApi, type AssistantMessageEvent, type Model, type ProviderResponse, type SimpleStreamOptions, type StreamOptions, type TranscriptContext, type Transport } from "@earendil-works/pi-ai/compat";
import { continuedBody, continuationFor, MAX_BYTES, type Body, type Continuation } from "./continuation.ts";
import { proxyAgent, proxyFor } from "./proxy.ts";

const IDLE_MS = 5 * 60_000;
const MAX_AGE_MS = 55 * 60_000;
const MAX_CONNECTIONS = 16;
const MAX_STATES = 64;
const WS_RETRIES = 5;
const SAFE_PROVIDER_CODES = ["websocket_connection_limit_reached", "context_length_exceeded", "rate_limit_exceeded", "insufficient_quota", "invalid_api_key", "previous_response_not_found", "invalid_request_error", "unsupported_value", "max_output_tokens", "aether_codex_ws_protocol_error"];
const SAFE_EVENT_TYPES = ["response.created", "response.in_progress", "response.output_item.added", "response.output_item.done", "response.output_text.delta", "response.function_call_arguments.delta", "response.reasoning_summary_text.delta", "response.completed", "response.incomplete", "response.failed", "error"];
const encoder = new TextEncoder();
const terminal = (event: ResponsesWebSocketEvent) => ["response.completed", "response.incomplete", "response.failed", "error"].includes(event.type);

class TransportError extends Error {
  readonly reason: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(reason: string, status?: number, retryAfterMs?: number) {
    super(`Responses WS ${reason}${status === undefined ? (reason === "connect_failed" ? ": network error" : "") : ` (HTTP ${status})`}`);
    this.reason = reason; this.status = status; this.retryAfterMs = retryAfterMs;
  }
}

type WsDiagnostic = {
  handshakeStatus?: number; phase: "warmup" | "generation"; requestSent: boolean; framesReceived: number; eventsReceived: number;
  lastFrame?: "text" | "binary"; lastEvent?: string; closeCode?: number;
  clientFailure?: "binary_frame" | "non_json_frame" | "sdk_error" | "buffer_limit";
  providerCode?: string; providerReason?: "canonical_identity_required" | "step_fence_required";
  identity: { sessionHeader: boolean; threadHeader: boolean; sessionMetadata: boolean; threadMetadata: boolean };
};

type Entry = {
  key?: string; sessionId?: string; ws: ResponsesWS; session: ResponsesWebSocketSession; lane: ResponsesWebSocketLane;
  agent: ReturnType<typeof proxyAgent>; busy: boolean; closed: boolean; born: number; timer?: ReturnType<typeof setTimeout>;
  handshake?: ProviderResponse; httpStatus?: number; retryAfterMs?: number; continuation?: Continuation; diagnostic?: WsDiagnostic;
  prepared?: boolean;
};
type Recovery = { sessionId?: string; until: number; probing: boolean };
export type Status = {
  provider?: string;
  configured: Transport; actual: "not connected" | "sse" | "websocket";
  connectionsCreated: number; connectionsReused: number; fullRequests: number; deltaRequests: number;
  lastRequestBytes: number; lastFullBytes: number; lastReason?: string; lastHttpStatus?: number; lastWs?: WsDiagnostic;
  warmupRequests: number; warmupsCompleted: number; lastWarmup?: "completed" | "failed"; lastRetryDelayMs?: number;
};

type Pending = { entry: Entry; body: Body; reused: boolean; sent: boolean; delta?: boolean; removeAbort: () => void };

export class ResponsesTransport {
  private readonly pool = new Map<string, Entry>();
  private readonly entries = new Set<Entry>();
  private readonly recovery = new Map<string, Recovery>();
  private readonly statuses = new Map<string, Status>();
  private readonly active = new Map<AbortController, string | undefined>();
  private readonly now: () => number;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;

  private readonly random: () => number;
  private readonly prewarm: boolean;
  private readonly recover: boolean;

  constructor(now: () => number = Date.now, wait = (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }),
    { random = Math.random, prewarm = true, recover = true }: { random?: () => number; prewarm?: boolean; recover?: boolean } = {}) {
    this.now = now; this.wait = wait; this.random = random; this.prewarm = prewarm; this.recover = recover;
  }

  private status(sessionId?: string): Status {
    const key = sessionId ?? "";
    let status = this.statuses.get(key);
    if (!status) {
      if (this.statuses.size >= MAX_STATES) this.statuses.delete(this.statuses.keys().next().value!);
      status = { configured: "auto", actual: "not connected", connectionsCreated: 0, connectionsReused: 0, fullRequests: 0, deltaRequests: 0, lastRequestBytes: 0, lastFullBytes: 0, warmupRequests: 0, warmupsCompleted: 0 };
      this.statuses.set(key, status);
    }
    return status;
  }

  snapshot(sessionId?: string) {
    const state = [...this.recovery.values()].filter(s => s.sessionId === sessionId);
    return { ...structuredClone(this.status(sessionId)), activeConnections: [...this.entries].filter(e => e.sessionId === sessionId).length,
      recovery: state.some(s => s.probing) ? "probing" : state.some(s => s.until > this.now()) ? "sse cooldown" : "ready" };
  }

  clear(sessionId?: string): void {
    for (const [controller, id] of this.active) if (sessionId === undefined || id === sessionId) controller.abort();
    for (const entry of this.entries) if (sessionId === undefined || entry.sessionId === sessionId) this.close(entry);
    for (const [key, state] of this.recovery) if (sessionId === undefined || state.sessionId === sessionId) this.recovery.delete(key);
    if (sessionId === undefined) this.statuses.clear(); else this.statuses.delete(sessionId);
  }

  private close(entry: Entry): void {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.continuation = undefined;
    entry.session.close();
    entry.ws.close({ code: 1000, reason: "released" });
    entry.ws.socket.platformSocket.terminate();
    entry.agent?.destroy();
    this.entries.delete(entry);
    if (entry.key && this.pool.get(entry.key) === entry) this.pool.delete(entry.key);
  }

  private acquire(key: string | undefined, sessionId: string | undefined, baseUrl: string, headers: Headers, proxy: string | undefined, timeout: number): { entry: Entry; reused: boolean } {
    const cached = key ? this.pool.get(key) : undefined;
    if (cached && !cached.busy) {
      if (!cached.closed && cached.ws.socket.readyState === 1 && this.now() - cached.born < MAX_AGE_MS) {
        clearTimeout(cached.timer); cached.busy = true;
        return { entry: cached, reused: true };
      }
      this.close(cached);
    }
    if (this.entries.size >= MAX_CONNECTIONS) {
      const idle = [...this.entries].find(e => !e.busy);
      if (idle) this.close(idle); else throw new TransportError("connection_limit");
    }
    const agent = proxyAgent(proxy);
    const client = new OpenAI({ apiKey: "unused", baseURL: baseUrl, maxRetries: 0, organization: null, project: null });
    const handshakeHeaders = new Headers(headers);
    if (!handshakeHeaders.has("openai-beta")) handshakeHeaders.set("openai-beta", "responses_websockets=2026-02-06");
    for (const name of ["content-length", "content-type", "accept", "accept-encoding", "connection", "upgrade", "host"]) handshakeHeaders.delete(name);
    for (const name of [...handshakeHeaders.keys()]) if (name.startsWith("sec-websocket-")) handshakeHeaders.delete(name);
    // SDK 7.19 supports null to delete default headers; ws typings omit that documented runtime case.
    const wsHeaders = { ...Object.fromEntries(handshakeHeaders), authorization: handshakeHeaders.get("authorization") } as Record<string, string>;
    const ws = new ResponsesWS(client, { headers: wsHeaders, agent, handshakeTimeout: timeout, maxPayload: MAX_BYTES, perMessageDeflate: false, reconnect: null });
    const session = new ResponsesWebSocketSession(ws, { maxLanes: 1, maxBufferedEvents: 1024, maxBufferedBytes: MAX_BYTES });
    const entry: Entry = { key: cached?.busy ? undefined : key, sessionId, ws, session, lane: session.lane(), agent, busy: true, closed: false, born: this.now() };
    // Keep an error listener even while idle; never expose SDK errors containing server text or credentials.
    ws.socket.platformSocket.prependListener("message", (_data, binary) => {
      if (entry.diagnostic) { entry.diagnostic.framesReceived++; entry.diagnostic.lastFrame = binary ? "binary" : "text"; }
    });
    ws.on("error", error => {
      if (!error.error) {
        if (entry.diagnostic) entry.diagnostic.clientFailure ??= "sdk_error";
        ws.socket.platformSocket.terminate();
      }
    });
    ws.on("raw", () => {
      if (entry.diagnostic) entry.diagnostic.clientFailure = entry.diagnostic.lastFrame === "binary" ? "binary_frame" : "non_json_frame";
      ws.socket.platformSocket.terminate();
    });
    ws.on("event", event => {
      const diagnostic = entry.diagnostic;
      if (!diagnostic) return;
      diagnostic.eventsReceived++;
      diagnostic.lastEvent = SAFE_EVENT_TYPES.includes(event.type) ? event.type : "other";
      if (event.type === "error") {
        const nested = "error" in event ? event.error as { code?: unknown; message?: unknown } | null : undefined;
        const code = nested?.code ?? ("code" in event ? event.code : undefined);
        diagnostic.providerCode = SAFE_PROVIDER_CODES.find(known => code === known);
        if (diagnostic.providerCode === "aether_codex_ws_protocol_error") {
          if (nested?.message === "canonical Codex session_id and thread_id metadata are required") diagnostic.providerReason = "canonical_identity_required";
          if (nested?.message === "sub2api step fence is required") diagnostic.providerReason = "step_fence_required";
        }
      }
    });
    ws.socket.platformSocket.on("upgrade", response => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      entry.handshake = { status: response.statusCode ?? 101, headers };
      if (entry.diagnostic) entry.diagnostic.handshakeStatus = entry.handshake.status;
    });
    ws.socket.platformSocket.on("unexpected-response", (_request, response) => {
      entry.httpStatus = response.statusCode;
      entry.retryAfterMs = retryAfterMs(response.headers, this.now());
      if (entry.diagnostic) entry.diagnostic.handshakeStatus = entry.httpStatus;
      response.destroy(); ws.socket.platformSocket.terminate();
    });
    ws.on("close", code => {
      if (entry.diagnostic) entry.diagnostic.closeCode = code;
      if (!entry.busy) this.close(entry);
    });
    this.entries.add(entry);
    if (entry.key) this.pool.set(entry.key, entry);
    return { entry, reused: false };
  }

  private async open(entry: Entry, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (entry.ws.socket.readyState === 1) return;
    const socket = entry.ws.socket.platformSocket;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { socket.off("open", opened); socket.off("error", failed); socket.off("close", failed); signal.removeEventListener("abort", aborted); };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new TransportError("connect_failed", entry.httpStatus, entry.retryAfterMs)); };
      const aborted = () => { cleanup(); reject(new TransportError("aborted")); };
      socket.once("open", opened); socket.once("error", failed); socket.once("close", failed); signal.addEventListener("abort", aborted, { once: true });
      if (socket.readyState > 1) failed();
      else if (signal.aborted) aborted();
    });
  }

  stream(model: Model<"openai-responses">, context: TranscriptContext, options: StreamOptions = {}, simple = true) {
    const transport = this;
    const run = async function* () {
      const controller = new AbortController();
      transport.active.set(controller, options.sessionId);
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      try { yield* transport.run(model, context, { ...options, signal }, simple); }
      finally { transport.active.delete(controller); }
    };
    return lazyStream(model, async () => run());
  }

  private async *run(model: Model<"openai-responses">, context: TranscriptContext, options: StreamOptions, simple: boolean): AsyncGenerator<AssistantMessageEvent> {
    const api = openAIResponsesApi();
    const mode = options.transport ?? "auto";
    const status = this.status(options.sessionId);
    status.configured = mode; status.provider = model.provider;
    const invoke = (opts: StreamOptions) => simple ? api.streamSimple(model, context, opts as SimpleStreamOptions) : api.stream(model, context, opts);
    if (mode === "sse" || (mode === "auto" && options.fetch)) {
      status.actual = "sse"; status.lastReason = options.fetch ? "custom_fetch" : "configured_sse";
      yield* invoke(options); return;
    }
    if (!["auto", "websocket", "websocket-cached"].includes(mode)) throw new TransportError("unsupported_transport");
    if (options.fetch) throw new TransportError("custom_fetch_requires_sse");
    for (const timeout of [options.timeoutMs, options.websocketConnectTimeoutMs, options.maxRetryDelayMs]) {
      if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 0)) throw new TransportError("invalid_timeout");
    }
    const target = new URL(model.baseUrl);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new TransportError("invalid_endpoint");
    target.pathname = `${target.pathname.replace(/\/+$/, "")}/responses`;
    let proxy: string | undefined;
    try { proxy = proxyFor(target, options.env); } catch { throw new TransportError("invalid_or_unsupported_proxy"); }
    let pending: Pending | undefined;
    let sseAgent: Agent | ProxyAgent | undefined;
    let recoveryKey: string | undefined;
    let recoveryState: Recovery | undefined;
    const responseState: { kind: "sse" | "websocket" } = { kind: "sse" };
    let failure: TransportError | undefined;
    let retries = 0;
    let forceSse = false;
    let warmupAttempted = false;
    let continuationRecovered = false;
    const backoff = async (error: TransportError, signal: AbortSignal, exponential = true) => {
      const delay = error.retryAfterMs ?? (exponential ? Math.round(200 * 2 ** retries * (1 + this.random() * 0.1)) : 0);
      const cap = options.maxRetryDelayMs ?? 60_000;
      // Never shorten a server minimum or let Node overflow its timer into a 1ms retry.
      if (delay > 2_147_483_647 || (error.retryAfterMs !== undefined && cap > 0 && delay > cap)) throw new TransportError("retry_delay_exceeded", error.status);
      status.lastRetryDelayMs = delay;
      try { if (delay > 0) await this.wait(delay, signal); signal.throwIfAborted(); }
      catch { throw new TransportError("aborted"); }
      if (exponential) retries++;
    };
    const identitySessionId = options.sessionId ?? randomUUID();
    const cooldown = () => {
      if (!recoveryKey || !options.sessionId) return;
      if (!this.recovery.has(recoveryKey) && this.recovery.size >= MAX_STATES) this.recovery.delete(this.recovery.keys().next().value!);
      recoveryState = { sessionId: options.sessionId, until: this.now() + IDLE_MS, probing: false };
      this.recovery.set(recoveryKey, recoveryState);
    };
    const readEvent = async (signal: AbortSignal): Promise<ResponsesWebSocketEvent> => {
      const controller = new AbortController();
      const timeout = options.timeoutMs ?? 300_000;
      const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : undefined;
      try {
        const event = await pending!.entry.lane.receive({ signal: AbortSignal.any([signal, controller.signal]) });
        if (event.type === "error") {
          const data = event as { code?: unknown; error?: { code?: unknown; headers?: unknown }; headers?: unknown };
          const code = data.error?.code ?? data.code;
          if (code === "websocket_connection_limit_reached" || (code === "previous_response_not_found" && pending?.delta && !continuationRecovered)) {
            if (code === "previous_response_not_found") continuationRecovered = true;
            throw new TransportError(code, undefined, retryAfterMs(data.error?.headers, this.now()) ?? retryAfterMs(data.headers, this.now()));
          }
        }
        return event;
      } catch (error) {
        if (error instanceof TransportError) throw error;
        if (error instanceof Error && ["Responses WebSocket lane buffer limit exceeded", "Responses WebSocket helper buffer limit exceeded"].includes(error.message) && pending?.entry.diagnostic) pending.entry.diagnostic.clientFailure = "buffer_limit";
        throw new TransportError(signal.aborted ? "aborted" : controller.signal.aborted ? "idle_timeout" : "connection_or_protocol_error");
      } finally { clearTimeout(timer); }
    };
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const signal = request.signal;
      signal.throwIfAborted();
      if (request.method !== "POST" || request.url !== target.href) throw new TransportError("unexpected_request_target");
      const raw = await request.text();
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new TransportError("request_too_large");
      let body: Body;
      try { body = JSON.parse(raw) as Body; } catch { throw new TransportError("invalid_request_body"); }
      if (!body || !Array.isArray(body.input) || body.background === true || body.stream_id !== undefined || body.type !== undefined) throw new TransportError("unsupported_request_shape");
      const sse = async () => {
        responseState.kind = "sse"; status.actual = "sse";
        sseAgent ??= proxy ? new ProxyAgent(proxy) : new Agent();
        const response = await httpFetch(request.url, { method: "POST", headers: Object.fromEntries(request.headers), body: raw, signal, dispatcher: sseAgent, redirect: "error" });
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers) });
      };
      if (forceSse) { status.lastReason = "ws_failed_sse"; return sse(); }
      const wsHeaders = new Headers(request.headers);
      try { body = withWsIdentity(body, wsHeaders, identitySessionId); }
      catch (error) { failure = error as TransportError; status.lastReason = failure.reason; throw failure; }
      const { stream: _stream, background: _background, ...fullWire } = body;
      if (Buffer.byteLength(JSON.stringify({ type: "response.create", ...fullWire })) > MAX_BYTES) {
        failure = new TransportError("request_too_large"); status.lastReason = failure.reason; throw failure;
      }
      const key = createHash("sha256").update(JSON.stringify([model.provider, model.id, body.model, request.url, options.sessionId, [...wsHeaders].sort(), proxy])).digest("hex");
      recoveryKey = key;
      recoveryState = this.recovery.get(key);
      if (recoveryState) {
        if (recoveryState.probing || recoveryState.until > this.now()) { status.lastReason = "sse_cooldown"; return sse(); }
        recoveryState.probing = true;
      }
      const retain = Boolean(options.sessionId) && options.cacheRetention !== "none";
      for (;;) {
        try {
          const acquired = this.acquire(retain ? key : undefined, options.sessionId, model.baseUrl, wsHeaders, proxy, options.websocketConnectTimeoutMs ?? 15_000);
          pending = { ...acquired, body, sent: false, removeAbort: () => {} };
          const metadata = body.client_metadata as { session_id?: unknown; thread_id?: unknown } | null | undefined;
          status.lastWs = acquired.entry.diagnostic = {
            handshakeStatus: acquired.entry.handshake?.status, phase: "generation", requestSent: false, framesReceived: 0, eventsReceived: 0,
            identity: { sessionHeader: wsHeaders.has("session-id"), threadHeader: wsHeaders.has("thread-id"),
              sessionMetadata: typeof metadata?.session_id === "string", threadMetadata: typeof metadata?.thread_id === "string" },
          };
          if (acquired.reused) status.connectionsReused++; else status.connectionsCreated++;
          const abort = () => this.close(acquired.entry);
          signal.addEventListener("abort", abort, { once: true });
          pending.removeAbort = () => signal.removeEventListener("abort", abort);
          await this.open(acquired.entry, signal);
          signal.throwIfAborted();
          if (this.prewarm && retain && !acquired.entry.prepared && !warmupAttempted && body.previous_response_id == null && body.generate === undefined) {
            warmupAttempted = true;
            const warmSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
            try {
              // shortcut: request-time routing warmup only; early preconnect needs finalized options before dispatch.
              const wire = { ...fullWire, input: [], generate: false };
              if (Buffer.byteLength(JSON.stringify({ type: "response.create", ...wire })) > MAX_BYTES) throw new TransportError("request_too_large");
              status.warmupRequests++; status.lastWs.phase = "warmup"; status.lastWs.requestSent = true;
              acquired.entry.lane.create(wire as Parameters<ResponsesWebSocketLane["create"]>[0]);
              let events = 0, bytes = 0;
              for (;;) {
                const event = await readEvent(warmSignal);
                if (++events > 1024 || (bytes += Buffer.byteLength(JSON.stringify(event))) > MAX_BYTES) throw new TransportError("warmup_failed");
                if (event.type === "error") {
                  const data = event as { status?: unknown; status_code?: unknown; code?: unknown; error?: { code?: unknown; headers?: unknown }; headers?: unknown };
                  const code = data.error?.code ?? data.code;
                  const statusCode = data.status ?? data.status_code;
                  const fatalStatus = [401, 403, 429].find(status => status === statusCode)
                    ?? (code === "invalid_api_key" ? 401 : (code === "insufficient_quota" || code === "rate_limit_exceeded") ? 429 : undefined);
                  throw new TransportError("warmup_failed", fatalStatus, retryAfterMs(data.error?.headers, this.now()) ?? retryAfterMs(data.headers, this.now()));
                }
                if (event.type === "response.completed") {
                  const response = event.response as { output?: unknown; status?: unknown } | undefined;
                  if (!Array.isArray(response?.output) || response.output.length || response.status !== "completed") throw new TransportError("warmup_failed");
                  break;
                }
                if (terminal(event) || event.type.startsWith("response.output_") || event.type.startsWith("response.function_call_")) throw new TransportError("warmup_failed");
              }
              acquired.entry.prepared = true; status.warmupsCompleted++; status.lastWarmup = "completed";
              // Warmup events must never enter Pi's transcript, hooks, usage or continuation baseline.
              Object.assign(status.lastWs, { phase: "generation", requestSent: false, framesReceived: 0, eventsReceived: 0, lastFrame: undefined, lastEvent: undefined });
            } catch (error) {
              status.lastWarmup = "failed";
              throw new TransportError(signal.aborted ? "aborted" : "warmup_failed",
                error instanceof TransportError ? error.status : undefined, error instanceof TransportError ? error.retryAfterMs : undefined);
            }
          }
          acquired.entry.prepared = true;
          const cached = (mode === "auto" || mode === "websocket-cached") && retain;
          const outgoing = cached ? continuedBody(body, acquired.entry.continuation) : body;
          pending.delta = outgoing !== body;
          acquired.entry.continuation = undefined;
          const { stream: _stream, background: _background, ...wire } = outgoing;
          const requestBytes = Buffer.byteLength(JSON.stringify({ type: "response.create", ...wire }));
          if (requestBytes > MAX_BYTES) throw new TransportError("request_too_large");
          // Mark before send: even a send failure can have an unknown remote outcome.
          pending.sent = true; status.lastWs.requestSent = true;
          acquired.entry.lane.create(wire as Parameters<ResponsesWebSocketLane["create"]>[0]);
          status.actual = "websocket"; responseState.kind = "websocket";
          status.lastRequestBytes = requestBytes;
          status.lastFullBytes = Buffer.byteLength(JSON.stringify(body));
          if (outgoing !== body) { status.deltaRequests++; status.lastReason = "delta"; }
          else { status.fullRequests++; status.lastReason = "full"; }
          let first: ResponsesWebSocketEvent | undefined = await readEvent(signal);
          const stream = new ReadableStream<Uint8Array>({
            pull: async controller => {
              try {
                const event = first ?? await readEvent(signal); first = undefined;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                if (terminal(event)) controller.close();
              } catch (error) {
                failure = error instanceof TransportError ? error : new TransportError("invalid_stream");
                if (pending) this.close(pending.entry);
                controller.error(failure);
              }
            },
            cancel: () => { if (pending) this.close(pending.entry); },
          });
          return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "x-pi-responses-transport": "websocket" } });
        } catch (error) {
          failure = error instanceof TransportError ? error : new TransportError(signal.aborted ? "aborted" : "connect_failed", pending?.entry.httpStatus);
          status.lastReason = failure.reason; status.lastHttpStatus = failure.status;
          const sent = pending?.sent;
          pending?.removeAbort();
          if (pending) this.close(pending.entry);
          pending = undefined;
          if (this.recover && !signal.aborted && !sent && failure.reason === "connect_failed" && failure.status === 426) {
            cooldown(); forceSse = true; failure = undefined; status.lastReason = "upgrade_required_sse";
            return sse();
          }
          if (this.recover && !signal.aborted && !sent && retryable(failure)) {
            const wsRetry = retries < WS_RETRIES;
            try { await backoff(failure, signal, wsRetry); }
            catch (error) { failure = error as TransportError; status.lastReason = failure.reason; throw failure; }
            if (wsRetry) { failure = undefined; continue; }
            cooldown(); forceSse = true;
            failure = undefined; status.lastReason = "connect_failed_sse";
            return sse();
          }
          throw failure;
        }
      }
    };
    const release = () => {
      if (!pending) return;
      pending.removeAbort();
      const entry = pending.entry;
      if (!entry.closed && entry.key && entry.ws.socket.readyState === 1) {
        entry.busy = false;
        entry.timer = setTimeout(() => this.close(entry), IDLE_MS); entry.timer.unref();
      } else this.close(entry);
      pending = undefined;
    };
    let started = false;
    try {
      for (;;) {
        let retry = false;
        const inner = invoke({ ...options, fetch, maxRetries: 0,
          onResponse: (response, selected) => options.onResponse?.(responseState.kind === "websocket" && pending?.entry.handshake
            ? { status: pending.entry.handshake.status, headers: { ...pending.entry.handshake.headers, "x-pi-responses-transport": "websocket", "x-pi-responses-connection-reused": String(pending.reused) } }
            : response, selected),
        });
        for await (const event of inner) {
          if (event.type === "start") {
            // Pi appends an assistant message on each start; retries must replace, not append.
            if (started) continue;
            started = true;
          }
          if (event.type === "error") {
            if (pending) this.close(pending.entry);
            if (responseState.kind === "websocket" || failure) {
              event.error.errorMessage = failure?.message ?? safeProviderError(event.error.errorMessage, status.lastWs);
              status.lastReason = failure?.reason ?? "provider_error";
            }
            const signal = options.signal!;
            if (this.recover && !forceSse && !signal.aborted && failure && retryable(failure)) {
              release();
              const wsRetry = retries < WS_RETRIES;
              try {
                await backoff(failure, signal, wsRetry);
                if (!wsRetry) { forceSse = true; cooldown(); }
                retry = true;
              } catch (error) {
                failure = error as TransportError; status.lastReason = failure.reason;
                event.reason = signal.aborted ? "aborted" : "error"; event.error.stopReason = event.reason; event.error.errorMessage = failure.message;
              }
              if (retry) { failure = undefined; break; }
            }
          } else if (event.type === "done" && pending && responseState.kind === "websocket") {
            const entry = pending.entry;
            if (recoveryKey && recoveryState === this.recovery.get(recoveryKey)) this.recovery.delete(recoveryKey);
            if (!entry.closed && entry.key && (mode === "auto" || mode === "websocket-cached")) {
              entry.continuation = await continuationFor(model, context, pending.body, event.message);
            }
          }
          if (event.type === "done" || event.type === "error") {
            // Hosts may dispose immediately after a terminal event.
            release();
            await sseAgent?.destroy(); sseAgent = undefined;
          }
          yield event;
        }
        if (!retry) return;
      }
    } finally {
      if (recoveryState) recoveryState.probing = false;
      release();
      await sseAgent?.destroy();
    }
  }
}

function retryable(error: TransportError): boolean {
  return ["connect_failed", "connection_or_protocol_error", "idle_timeout", "previous_response_not_found", "websocket_connection_limit_reached", "warmup_failed"].includes(error.reason)
    && (error.status === undefined || error.status >= 500 || [404, 405, 408].includes(error.status));
}

function retryAfterMs(value: unknown, now: number): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const headers = Object.entries(value);
  for (const name of ["retry-after-ms", "retry-after"]) {
    const raw = headers.find(([key]) => key.toLowerCase() === name)?.[1];
    if (typeof raw !== "string" || raw.length > 128 || !raw.trim()) continue;
    const text = raw.trim();
    const delay = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * (name === "retry-after" ? 1000 : 1)
      : name === "retry-after" && /^[a-z]/i.test(text) ? Math.max(0, Date.parse(text) - now) : NaN;
    if (Number.isFinite(delay) && delay >= 0) return Math.ceil(delay);
  }
  return undefined;
}

function withWsIdentity(body: Body, headers: Headers, sessionId: string): Body {
  const supplied = body.client_metadata;
  if (supplied !== undefined && (!supplied || typeof supplied !== "object" || Array.isArray(supplied))) throw new TransportError("invalid_session_identity");
  const metadata = { ...supplied as Record<string, unknown> | undefined };
  for (const [field, name] of [["session_id", "session-id"], ["thread_id", "thread-id"]] as const) {
    const header = headers.get(name);
    const value = metadata[field] !== undefined ? metadata[field] : header ?? sessionId;
    const id = typeof value === "string" ? value.trim() : "";
    // Aether bounds canonical identities to 160 ASCII bytes; headers also exclude controls.
    if (!id || id.length > 160 || /[^\x20-\x7e]/.test(id)) throw new TransportError("invalid_session_identity");
    if (header !== null && header !== id) throw new TransportError("session_identity_conflict");
    metadata[field] = id; headers.set(name, id);
  }
  return { ...body, client_metadata: metadata };
}

function safeProviderError(message = "", diagnostic?: WsDiagnostic): string {
  const code = diagnostic?.providerCode ?? SAFE_PROVIDER_CODES.find(code => message.includes(code));
  return `Responses WS provider error${code ? `: ${code}` : " (details redacted)"}${diagnostic?.providerReason ? ` (${diagnostic.providerReason})` : ""}`;
}
