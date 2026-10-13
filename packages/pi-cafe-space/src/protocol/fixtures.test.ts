import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as realTimeout, clearTimeout as clearRealTimeout } from "node:timers";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createRelayServer } from "../relay/server.js";
import {
  applyEvent, decodeWireMessage, fitCommandResult, MAX_FRAME_BYTES,
  type EventEnvelope, type SessionSnapshot, type CommandResultMessage,
} from "./index.js";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected fixture object");
  return value as RecordValue;
}
const root = new URL("../../protocol/fixtures/v1/", import.meta.url);
function load(name: string): unknown { return JSON.parse(readFileSync(new URL(name, root), "utf8")); }
const values = record(load("values.json"));

// This DSL belongs to the fixture runner, never to the production protocol.
// All generators are bounded; expected values are checked in, not regenerated from the implementation.
function expand(value: unknown, bindings: Map<string, unknown> = new Map(), depth = 0): unknown {
  if (depth > 40) throw new Error("Fixture template is too deep");
  if (Array.isArray(value)) return value.map((v) => expand(v, bindings, depth + 1));
  if (!value || typeof value !== "object") return value;
  const object = record(value);
  const next = (v: unknown): unknown => expand(v, bindings, depth + 1);
  if (Object.keys(object).length === 1) {
    if (typeof object.$ref === "string") {
      if (bindings.has(object.$ref)) return bindings.get(object.$ref);
      if (!Object.hasOwn(values, object.$ref)) throw new Error(`Unknown fixture reference: ${object.$ref}`);
      return next(values[object.$ref]);
    }
    if (object.$repeat) {
      const spec = record(object.$repeat);
      const count = Number(spec.count);
      if (typeof spec.text !== "string" || !Number.isSafeInteger(count) || count < 0 || count * spec.text.length > 1_048_576) throw new Error("Invalid repeat");
      return spec.text.repeat(count);
    }
    if (object.$array || object.$object) {
      const spec = record(object.$array ?? object.$object);
      const count = Number(spec.count);
      if (!Number.isSafeInteger(count) || count < 0 || count > 20_001) throw new Error("Invalid collection generator");
      const items = Array.from({ length: count }, () => next(spec.value));
      return object.$array ? items : Object.fromEntries(items.map((v, i) => [`k${i}`, v]));
    }
    if (object.$nest) {
      const spec = record(object.$nest);
      const count = Number(spec.depth);
      if (!Number.isSafeInteger(count) || count < 0 || count > 12) throw new Error("Invalid nesting generator");
      let result = next(spec.value);
      for (let i = 0; i < count; i++) result = [result];
      return result;
    }
    if (Array.isArray(object.$merge)) return Object.assign({}, ...object.$merge.map((v) => record(next(v))));
  }
  return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, next(v)]));
}

interface Fixture {
  id: string;
  operation: "decode" | "applyEvent" | "fitCommandResult" | "encode";
  inputText?: string;
  inputBase64?: string;
  inputTemplate?: unknown;
  paddingBytes?: number;
  input?: unknown;
  snapshot?: unknown;
  envelope?: unknown;
  expected: { accepted: boolean; value?: unknown; code?: string; error?: string; bytes?: number };
}
function inputText(test: Fixture): string {
  const sources = [test.inputText, test.inputBase64, test.inputTemplate].filter((v) => v !== undefined);
  if (sources.length !== 1) throw new Error("Exactly one fixture input is required");
  if (test.inputBase64 !== undefined) {
    const bytes = Buffer.from(test.inputBase64, "base64");
    if (bytes.length > MAX_FRAME_BYTES) throw Object.assign(new Error("Message exceeds the relay frame limit"), { code: "INVALID_MESSAGE" });
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw Object.assign(new Error("Message is not valid UTF-8"), { code: "INVALID_MESSAGE" }); }
  }
  let text = test.inputText ?? JSON.stringify(expand(test.inputTemplate));
  if (test.paddingBytes !== undefined) {
    const count = test.paddingBytes - Buffer.byteLength(text);
    if (count < 0 || count > MAX_FRAME_BYTES + 1) throw new Error("Invalid frame padding");
    text += " ".repeat(count);
  }
  return text;
}
const files = ["codec.json", "reducer.json", "budgets.json", "session-controls.json", "input-assist.json"];
const fixtures = files.flatMap((name) => load(name) as Fixture[]);

describe("wire v1 frozen fixtures", () => {
  it("has unique IDs and covers every wire, command and event variant", () => {
    expect(new Set(fixtures.map((test) => test.id)).size).toBe(fixtures.length);
    const types = new Set<string>(), commands = new Set<string>(), events = new Set<string>();
    for (const test of fixtures.filter((f) => f.operation === "decode" && f.expected.accepted)) {
      const message = record(expand(test.expected.value));
      types.add(String(message.type));
      if (message.type === "command") commands.add(String(record(message.payload).name));
      if (message.type === "event") events.add(String(record(message.event).kind));
    }
    expect([...types].sort()).toEqual(["hello", "welcome", "host_status", "snapshot", "event", "command", "routed_command", "host_command_result", "command_result", "error"].sort());
    expect([...commands].sort()).toEqual(["prompt", "abort", "set_thinking", "set_model", "list_dir", "read_file", "list_sessions", "get_session", "new_session", "rename_session", "resume_session", "list_commands", "run_command"].sort());
    expect([...events].sort()).toEqual(["session_state", "message_started", "message_delta", "message_finished", "tool_started", "tool_updated", "tool_finished", "model_changed", "thinking_changed", "ui_wait", "notice"].sort());
  });
  for (const test of fixtures) it(test.id, () => {
    let result: unknown;
    let failure: unknown;
    const before = JSON.stringify(test);
    try {
      switch (test.operation) {
        case "decode": result = decodeWireMessage(inputText(test)); break;
        case "encode": {
          const message = decodeWireMessage(inputText(test));
          const encoded = JSON.stringify(message);
          result = JSON.parse(encoded);
          if (test.expected.bytes !== undefined) expect(Buffer.byteLength(encoded)).toBe(test.expected.bytes);
          expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
          break;
        }
        case "applyEvent": result = applyEvent(expand(test.snapshot) as SessionSnapshot, expand(test.envelope) as EventEnvelope); break;
        case "fitCommandResult": result = fitCommandResult(expand(test.input) as CommandResultMessage); break;
        default: throw new Error("Unknown fixture operation");
      }
    } catch (error) { failure = error; }
    expect(JSON.stringify(test)).toBe(before);
    if (test.expected.accepted) {
      expect(failure).toBeUndefined();
      expect(result).toStrictEqual(expand(test.expected.value));
      if (test.operation === "fitCommandResult") expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_FRAME_BYTES - 1024);
    } else {
      expect(failure).toBeInstanceOf(Error);
      if (test.expected.code) expect((failure as { code?: string }).code).toBe(test.expected.code);
      if (test.expected.error) expect((failure as Error).message).toBe(test.expected.error);
    }
  });
});

interface TraceStep {
  action: "connect" | "send" | "receive" | "close" | "expectClose" | "advance";
  peer?: string;
  message?: unknown;
  inputBase64?: string;
  binary?: boolean;
  code?: number;
  reason?: string;
  ms?: number;
}
interface Trace { id: string; steps: TraceStep[]; }

// Lossless FIFO per connection. Matching never skips earlier output or drops IDs.
class TracePeer {
  readonly socket: WebSocket;
  private messages: unknown[] = [];
  private waiter: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
  private closed: { code: number; reason: string } | undefined;
  private closeWaiter: ((value: { code: number; reason: string }) => void) | undefined;
  constructor(url: string) {
    this.socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws`);
    this.socket.on("error", () => {}); // open/close assertions report connection failure
    this.socket.on("message", (bytes, binary) => {
      let message: unknown;
      try { if (binary) throw new Error("Unexpected binary output"); message = JSON.parse(bytes.toString()); }
      catch (error) { this.waiter?.reject(error as Error); return; }
      if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve(message); }
      else this.messages.push(message);
    });
    this.socket.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.closeWaiter?.(this.closed);
      this.waiter?.reject(new Error(`Peer closed before expected message: ${code}`));
    });
  }
  async opened(): Promise<void> {
    await deadline(new Promise<void>((resolve, reject) => {
      this.socket.once("open", resolve); this.socket.once("error", reject);
    }));
  }
  async next(): Promise<unknown> {
    if (this.messages.length) return this.messages.shift();
    if (this.closed) throw new Error("Peer already closed");
    return deadline(new Promise((resolve, reject) => { this.waiter = { resolve, reject }; }));
  }
  async closeResult(): Promise<{ code: number; reason: string }> {
    if (this.closed) return this.closed;
    return deadline(new Promise((resolve) => { this.closeWaiter = resolve; }));
  }
  async barrier(): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    await deadline(new Promise<void>((resolve, reject) => {
      this.socket.once("pong", () => resolve());
      this.socket.ping("fixture-barrier", undefined, (error?: Error) => { if (error) reject(error); });
    }));
  }
  assertDrained(): void { expect(this.messages).toEqual([]); }
}
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof realTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = realTimeout(() => reject(new Error("Fixture transport timed out")), 4000);
    })]);
  } finally { if (timer) clearRealTimeout(timer); }
}
function match(actual: unknown, expected: unknown, bindings: Map<string, unknown>): void {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    const obj = record(expected);
    if (typeof obj.$bind === "string" && Object.keys(obj).length === 1) {
      expect(actual).toEqual(expect.stringMatching(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/));
      if (bindings.has(obj.$bind)) expect(actual).toBe(bindings.get(obj.$bind));
      else { expect([...bindings.values()]).not.toContain(actual); bindings.set(obj.$bind, actual); }
      return;
    }
  }
  const wanted = expand(expected, bindings);
  if (Array.isArray(wanted)) {
    expect(Array.isArray(actual)).toBe(true);
    expect((actual as unknown[]).length).toBe(wanted.length);
    wanted.forEach((v, i) => match((actual as unknown[])[i], v, bindings));
  } else if (wanted && typeof wanted === "object") {
    const a = record(actual), b = record(wanted);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    for (const key of Object.keys(b)) match(a[key], b[key], bindings);
  } else expect(actual).toStrictEqual(wanted);
}

const traces = readdirSync(fileURLToPath(new URL("traces/", root))).filter((f) => f.endsWith(".json")).sort()
  .map((name) => load(`traces/${name}`) as Trace);
describe("wire v1 real Node relay traces (synthetic peers only)", () => {
  for (const trace of traces) it(trace.id, async () => {
    const peers = new Map<string, TracePeer>();
    const bindings = new Map<string, unknown>();
    const relay = await createRelayServer({ host: "127.0.0.1", port: 0,
      hostToken: "fixture-host", clientToken: "fixture-client", allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    }).listen();
    // Fake only the application timers; socket I/O and assertion deadlines stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      for (const [index, step] of trace.steps.entries()) {
        try {
          if (step.action === "advance") { await vi.advanceTimersByTimeAsync(step.ms ?? 0); continue; }
          if (!step.peer) throw new Error("Missing trace peer");
          if (step.action === "connect") {
            if (peers.has(step.peer)) throw new Error("Reuse requires a new connection-generation label");
            const peer = new TracePeer(relay.url); peers.set(step.peer, peer); await peer.opened(); continue;
          }
          const peer = peers.get(step.peer);
          if (!peer) throw new Error("Unknown trace peer");
          switch (step.action) {
            case "send":
              peer.socket.send(step.inputBase64 === undefined ? JSON.stringify(expand(step.message, bindings)) : Buffer.from(step.inputBase64, "base64"), { binary: step.binary ?? false });
              break;
            case "receive": match(await peer.next(), step.message, bindings); break;
            case "close": peer.socket.close(step.code ?? 1000, step.reason ?? "fixture complete"); await peer.closeResult(); break;
            case "expectClose": expect(await peer.closeResult()).toEqual({ code: step.code, reason: step.reason }); break;
          }
        } catch (error) { throw new Error(`${trace.id} step ${index} (${step.action}/${step.peer ?? "clock"}): ${(error as Error).message}`, { cause: error }); }
      }
      for (const peer of peers.values()) { await peer.barrier(); peer.assertDrained(); }
    } finally {
      for (const peer of peers.values()) peer.socket.terminate();
      vi.useRealTimers();
      await relay.close();
    }
  }, 20_000);
});
