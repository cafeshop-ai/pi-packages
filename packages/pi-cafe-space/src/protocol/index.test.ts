import { describe, expect, it } from "vitest";
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolDecodeError,
  applyEvent,
  canonicalCommandPayload,
  canonicalEvent,
  decodeWireMessage,
  fitCommandResult,
  hasSufficientTokenEntropy,
  isPeerRole,
  isThinkingLevel,
  type CollabEvent,
  type EventEnvelope,
  type CommandResultMessage,
  type SessionSnapshot,
} from "./index.js";

const snapshot: SessionSnapshot = {
  protocolVersion: PROTOCOL_VERSION,
  streamId: "stream-1",
  sessionId: "session-1",
  sessionName: null,
  cwd: "D:/work",
  activeLeafId: null,
  model: { provider: "cafe", id: "gpt-5.6-sol" },
  thinkingLevel: "high",
  phase: "idle",
  hasPendingMessages: false,
  messages: [],
  historyTruncated: false,
  tools: [],
  lastEventSeq: 0,
};

describe("protocol decoding", () => {
  it("accepts a valid host hello", () => {
    const message = decodeWireMessage(JSON.stringify({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      peerRole: "host",
      peerId: "host-1",
      roomId: "main",
      token: "secret",
    }));
    expect(message.type).toBe("hello");
  });

  it("rejects unsupported prompt delivery modes", () => {
    expect(() => decodeWireMessage(JSON.stringify({
      type: "command",
      requestId: "request-1",
      expectedStreamId: "stream-1",
      payload: { name: "prompt", content: "hello", delivery: "nextTurn" },
    }))).toThrow(ProtocolDecodeError);
  });

  it("normalizes snapshots from an older extension without historyTruncated", () => {
    const legacy = { ...snapshot } as Partial<SessionSnapshot>;
    delete legacy.historyTruncated;
    const message = decodeWireMessage(JSON.stringify({ type: "snapshot", snapshot: legacy }));
    expect(message.type).toBe("snapshot");
    if (message.type === "snapshot") expect(message.snapshot.historyTruncated).toBe(false);
  });
  it("accepts multi-host status and targeted commands", () => {
    expect(decodeWireMessage(JSON.stringify({
      type: "host_status",
      connected: true,
      hostId: "pi-one",
      streamId: "stream-one",
      sessionId: "session-one",
      hosts: [{ hostId: "pi-one", connected: true, ready: true, streamId: "stream-one", sessionId: "session-one", sessionName: null, cwd: "D:/one" }],
    }))).toMatchObject({ type: "host_status", hosts: [{ hostId: "pi-one" }] });
    expect(decodeWireMessage(JSON.stringify({
      type: "command",
      requestId: "targeted-1",
      targetHostId: "pi-one",
      expectedStreamId: "stream-one",
      expectedSessionId: "session-one",
      payload: { name: "abort" },
    }))).toMatchObject({ type: "command", targetHostId: "pi-one" });
    expect(decodeWireMessage(JSON.stringify({
      type: "host_status",
      connected: true,
      streamId: "stream-one",
      sessionId: "session-one",
      hosts: [{ hostId: "legacy-host", connected: true, streamId: "stream-one", sessionId: "session-one", sessionName: null, cwd: "D:/legacy" }],
    }))).toMatchObject({ type: "host_status", hosts: [{ hostId: "legacy-host" }] });
  });

  it("rejects a host status list beyond the room host cap", () => {
    const host = { hostId: "host", connected: false, streamId: null, sessionId: null, sessionName: null, cwd: null };
    expect(() => decodeWireMessage(JSON.stringify({
      type: "host_status", connected: false, streamId: null, sessionId: null,
      hosts: Array.from({ length: 65 }, (_, index) => ({ ...host, hostId: `host-${index}` })),
    }))).toThrow(ProtocolDecodeError);
  });

  it("accepts read-only file commands and structured results", () => {
    expect(decodeWireMessage(JSON.stringify({
      type: "command",
      requestId: "file-1",
      expectedStreamId: "stream-1",
      payload: { name: "read_file", path: "README.md", offset: 0, limit: 1024 },
    }))).toMatchObject({ type: "command", payload: { name: "read_file" } });
    expect(decodeWireMessage(JSON.stringify({
      type: "command_result",
      hostId: "pi-one",
      requestId: "file-1",
      status: "applied",
      code: null,
      message: null,
      data: { kind: "file", path: "README.md", content: "hello", truncated: false },
    }))).toMatchObject({ type: "command_result", hostId: "pi-one", data: { kind: "file" } });
  });
});


describe("snapshot projection", () => {
  it("applies ordered message deltas", () => {
    const started: EventEnvelope = {
      type: "event",
      streamId: "stream-1",
      sessionId: "session-1",
      seq: 1,
      emittedAt: new Date(0).toISOString(),
      event: {
        kind: "message_started",
        message: {
          id: "assistant-1",
          role: "assistant",
          text: "",
          thinking: "",
          timestamp: 0,
          status: "streaming",
          toolName: null,
          toolCallId: null,
        },
      },
    };
    const delta: EventEnvelope = {
      ...started,
      seq: 2,
      event: { kind: "message_delta", messageId: "assistant-1", channel: "text", delta: "Hello" },
    };
    const next = applyEvent(applyEvent(snapshot, started), delta);
    expect(next.messages[0]?.text).toBe("Hello");
    expect(next.lastEventSeq).toBe(2);
  });

  it("rejects sequence gaps", () => {
    const event: EventEnvelope = {
      type: "event",
      streamId: "stream-1",
      sessionId: "session-1",
      seq: 2,
      emittedAt: new Date(0).toISOString(),
      event: { kind: "session_state", phase: "running", hasPendingMessages: false },
    };
    expect(() => applyEvent(snapshot, event)).toThrow("Event sequence gap");
  });

  it("does not mark a projection truncated merely on reaching its message cap", () => {
    const current: SessionSnapshot = {
      ...snapshot,
      messages: Array.from({ length: 999 }, (_, index) => ({
        id: `message-${index}`,
        role: "assistant" as const,
        text: "",
        thinking: "",
        timestamp: index,
        status: "complete" as const,
        toolName: null,
        toolCallId: null,
      })),
    };
    const event: EventEnvelope = {
      type: "event",
      streamId: "stream-1",
      sessionId: "session-1",
      seq: 1,
      emittedAt: new Date(0).toISOString(),
      event: {
        kind: "message_started",
        message: {
          id: "message-new",
          role: "assistant",
          text: "",
          thinking: "",
          timestamp: 999,
          status: "complete",
          toolName: null,
          toolCallId: null,
        },
      },
    };
    const next = applyEvent(current, event);
    expect(next.messages).toHaveLength(1_000);
    expect(next.historyTruncated).toBe(false);
  });

  it("marks the projection truncated when old tools are evicted", () => {
    let current: SessionSnapshot = { ...snapshot, tools: Array.from({ length: 500 }, (_, index) => ({
      toolCallId: `tool-${index}`,
      toolName: "read",
      argsText: "",
      output: "",
      status: "complete" as const,
    })) };
    const event: EventEnvelope = {
      type: "event",
      streamId: "stream-1",
      sessionId: "session-1",
      seq: 1,
      emittedAt: new Date(0).toISOString(),
      event: {
        kind: "tool_started",
        tool: { toolCallId: "tool-new", toolName: "read", argsText: "", output: "", status: "running" },
      },
    };
    current = applyEvent(current, event);
    expect(current.tools).toHaveLength(500);
    expect(current.tools.at(-1)?.toolCallId).toBe("tool-new");
    expect(current.historyTruncated).toBe(true);
  });

  it("does not leave a lone surrogate when bounding streamed text", () => {
    const started: EventEnvelope = {
      type: "event",
      streamId: "stream-1",
      sessionId: "session-1",
      seq: 1,
      emittedAt: new Date(0).toISOString(),
      event: {
        kind: "message_started",
        message: {
          id: "surrogate-message",
          role: "assistant",
          text: "",
          thinking: "",
          timestamp: 0,
          status: "streaming",
          toolName: null,
          toolCallId: null,
        },
      },
    };
    const delta: EventEnvelope = {
      ...started,
      seq: 2,
      event: { kind: "message_delta", messageId: "surrogate-message", channel: "text", delta: "x".repeat(65_535) + "🙂" },
    };
    const next = applyEvent(applyEvent(snapshot, started), delta);
    const text = next.messages[0]?.text ?? "";
    expect(text).toBe("x".repeat(65_535));
    expect(text).not.toMatch(/[\uD800-\uDFFF]/);
  });

  it("bounds streamed text and tool output in the projection", () => {
    const started: EventEnvelope = {
      type: "event",
      streamId: "stream-1",
      sessionId: "session-1",
      seq: 1,
      emittedAt: new Date(0).toISOString(),
      event: {
        kind: "message_started",
        message: {
          id: "bounded-message",
          role: "assistant",
          text: "",
          thinking: "",
          timestamp: 0,
          status: "streaming",
          toolName: null,
          toolCallId: null,
        },
      },
    };
    const textDelta: EventEnvelope = {
      ...started,
      seq: 2,
      event: { kind: "message_delta", messageId: "bounded-message", channel: "text", delta: "x".repeat(64 * 1024 + 1) },
    };
    const tool: EventEnvelope = {
      ...started,
      seq: 3,
      event: {
        kind: "tool_started",
        tool: { toolCallId: "tool-1", toolName: "read", argsText: "", output: "z".repeat(64 * 1024 + 1), status: "running" },
      },
    };
    const toolUpdate: EventEnvelope = {
      ...started,
      seq: 4,
      event: { kind: "tool_updated", toolCallId: "tool-1", output: "y".repeat(64 * 1024 + 1) },
    };
    const next = applyEvent(applyEvent(applyEvent(applyEvent(snapshot, started), textDelta), tool), toolUpdate);
    expect(next.messages[0]?.text).toHaveLength(64 * 1024);
    expect(next.tools[0]?.output).toHaveLength(64 * 1024);
    expect(next.historyTruncated).toBe(true);
  });
});

describe("protocol primitives", () => {
  it("rejects wire messages larger than the frame budget", () => {
    const oversized = JSON.stringify({ type: "error", code: "TOO_LARGE", message: "x".repeat(MAX_FRAME_BYTES) });
    expect(() => decodeWireMessage(oversized)).toThrow("frame limit");
  });

  it("bounds an oversized command result instead of dropping it", () => {
    const result = fitCommandResult({
      type: "command_result",
      hostId: "host-1",
      requestId: "request-1",
      status: "applied",
      code: null,
      message: null,
      data: { kind: "file", content: "🙂".repeat(70_000) },
    });
    expect(result.status).toBe("rejected");
    expect(result.code).toBe("RESULT_TOO_LARGE");
    expect(result.data).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(MAX_FRAME_BYTES);
  });

  it("rejects cyclic and non-JSON result data instead of silently dropping it", () => {
    const data: Record<string, unknown> = {};
    data.self = data;
    const cyclic = fitCommandResult({
      type: "command_result",
      requestId: "request-cycle",
      status: "applied",
      code: null,
      message: null,
      data: data as unknown as import("./index.js").JsonValue,
    });
    expect(cyclic.status).toBe("rejected");
    expect(cyclic.code).toBe("RESULT_TOO_LARGE");
    expect(cyclic.data).toBeUndefined();

    const exotic = fitCommandResult({
      type: "command_result",
      requestId: "request-map",
      status: "applied",
      code: null,
      message: null,
      data: new Map([["value", 1]]) as unknown as import("./index.js").JsonValue,
    });
    expect(exotic.status).toBe("rejected");
    expect(exotic.code).toBe("RESULT_TOO_LARGE");
    expect(exotic.data).toBeUndefined();
  });

  it("rejects result graphs that exceed the aggregate node budget", () => {
    const data = Array.from({ length: 500 }, () => Array.from({ length: 50 }, () => null));
    const result = fitCommandResult({
      type: "command_result",
      requestId: "request-nodes",
      status: "applied",
      code: null,
      message: null,
      data,
    });
    expect(result.status).toBe("rejected");
    expect(result.code).toBe("RESULT_TOO_LARGE");
    expect(result.data).toBeUndefined();

    const encoded = JSON.stringify({
      type: "host_command_result",
      relayRequestId: "request-nodes",
      status: "applied",
      code: null,
      message: null,
      data,
    });
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(MAX_FRAME_BYTES);
    expect(() => decodeWireMessage(encoded)).toThrow(ProtocolDecodeError);
  });

  it("contains hostile result envelope getters", () => {
    const hostile = {
      type: "command_result",
      requestId: "request-getter",
      status: "applied",
      code: null,
      message: null,
      get data(): never { throw new Error("hostile getter"); },
    } as unknown as CommandResultMessage;
    expect(() => fitCommandResult(hostile)).not.toThrow();
    const result = fitCommandResult(hostile);
    expect(result.status).toBe("rejected");
    expect(result.code).toBe("RESULT_TOO_LARGE");
  });

  it("rejects event sequence values outside the bounded lifecycle", () => {
    expect(() => decodeWireMessage(JSON.stringify({
      type: "snapshot",
      snapshot: { ...snapshot, lastEventSeq: 1_000_000_001 },
    }))).toThrow(ProtocolDecodeError);
    expect(() => decodeWireMessage(JSON.stringify({
      type: "event",
      streamId: "stream-1",
      sessionId: "session-1",
      seq: 1_000_000_001,
      emittedAt: new Date(0).toISOString(),
      event: { kind: "session_state", phase: "idle", hasPendingMessages: false },
    }))).toThrow(ProtocolDecodeError);
  });

  it("canonicalizes command payloads before forwarding", () => {
    const payload = canonicalCommandPayload({
      name: "prompt",
      content: "hello",
      delivery: "steer",
      futureField: "discarded",
    } as unknown as import("./index.js").CommandPayload) as Record<string, unknown>;
    expect(payload).toEqual({ name: "prompt", content: "hello", delivery: "steer" });
    expect(payload.futureField).toBeUndefined();
  });

  it("canonicalizes event envelopes before projection or forwarding", () => {
    const event = canonicalEvent({
      kind: "message_started",
      message: {
        id: "message-1",
        role: "assistant",
        text: "hello",
        thinking: "",
        timestamp: 0,
        status: "streaming",
        toolName: null,
        toolCallId: null,
        futureField: "discarded",
      },
      futureField: "discarded",
    } as unknown as CollabEvent) as Record<string, unknown>;
    expect(event.futureField).toBeUndefined();
    expect(event.message).toEqual({
      id: "message-1",
      role: "assistant",
      text: "hello",
      thinking: "",
      timestamp: 0,
      status: "streaming",
      toolName: null,
      toolCallId: null,
    });
  });

  it("does not forward unknown result envelope fields", () => {
    const result = fitCommandResult({
      type: "command_result",
      requestId: "request-1",
      status: "applied",
      code: null,
      message: null,
      data: { kind: "ack" },
      extra: "discarded",
    } as CommandResultMessage & { extra: string }) as unknown as Record<string, unknown>;
    expect(result.extra).toBeUndefined();
    expect(result.data).toEqual({ kind: "ack" });
  });

  it("bounds command result code and message fields", () => {
    const result = fitCommandResult({
      type: "host_command_result",
      relayRequestId: "request-1",
      status: "rejected",
      code: "c".repeat(200),
      message: "m".repeat(3_000),
    });
    expect(result.code).toHaveLength(128);
    expect(result.message).toHaveLength(2_048);
    expect(() => decodeWireMessage(JSON.stringify(result))).not.toThrow();
  });

  it("rejects plainly low-complexity remote token values", () => {
    expect(hasSufficientTokenEntropy("aaaaaaaaaaaaaaaa")).toBe(false);
    expect(hasSufficientTokenEntropy("aaaaaaBCDEFGHIJKLMN")).toBe(false);
    expect(hasSufficientTokenEntropy("abcdefghijklmnop")).toBe(false);
    expect(hasSufficientTokenEntropy("passwordpassword")).toBe(false);
    expect(hasSufficientTokenEntropy("aaaaabbbbbcccccdddddeeeeefffff")).toBe(false);
    expect(hasSufficientTokenEntropy("replace-with-a-long-random-token")).toBe(true);
    expect(hasSufficientTokenEntropy("v7Q2mN9#pL4zR8!x")).toBe(true);
  });

  it("accepts only supported values", () => {
    expect(isThinkingLevel("max")).toBe(true);
    expect(isThinkingLevel("turbo")).toBe(false);
    expect(isPeerRole("client")).toBe(true);
    expect(isPeerRole("admin")).toBe(false);
  });
});
