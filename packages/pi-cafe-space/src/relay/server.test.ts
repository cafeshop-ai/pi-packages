import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FRAME_BYTES } from "../protocol/index.js";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import { createRelayServer, type RunningRelayServer } from "./server.js";

const hostToken = "host-token";
const clientToken = "client-token";
let running: RunningRelayServer | undefined;
const sockets: WebSocket[] = [];
const temporaryDirectories: string[] = [];

class Inbox {
  private readonly messages: Record<string, unknown>[] = [];
  private readonly waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const waiter = this.waiters.splice(index, 1)[0];
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      } else {
        this.messages.push(message);
      }
    });
  }

  wait(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) {
      const message = this.messages.splice(index, 1)[0];
      return Promise.resolve(message as Record<string, unknown>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
        reject(new Error("Timed out waiting for WebSocket message"));
      }, 3_000);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }
}

function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws`);
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

const baseSnapshot = {
  protocolVersion: 1,
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

afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets.length = 0;
  await running?.close();
  running = undefined;
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("relay server", () => {
  it("routes a client command to one host and broadcasts events", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const host = await connect(running.url);
    const hostInbox = new Inbox(host);
    host.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "pi-1", roomId: "main", token: hostToken }));
    await hostInbox.wait((message) => message.type === "welcome");
    host.send(JSON.stringify({ type: "snapshot", snapshot: baseSnapshot }));

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "web-1", roomId: "main", token: clientToken }));
    await clientInbox.wait((message) => message.type === "welcome");
    await clientInbox.wait((message) => message.type === "snapshot");

    client.send(JSON.stringify({
      type: "command",
      requestId: "request-1",
      expectedStreamId: "stream-1",
      payload: { name: "prompt", content: "Hello from phone" },
    }));
    const routed = await hostInbox.wait((message) => message.type === "routed_command");
    expect(routed.sourcePeerId).toBe("web-1");
    expect((routed.payload as Record<string, unknown>).name).toBe("prompt");

    host.send(JSON.stringify({
      type: "host_command_result",
      relayRequestId: routed.relayRequestId,
      status: "dispatched",
      code: null,
      message: "Prompt dispatched to Pi",
      data: { kind: "ack", relay: true },
    }));
    const result = await clientInbox.wait((message) => message.type === "command_result");
    expect(result.requestId).toBe("request-1");
    expect(result.hostId).toBe("pi-1");
    expect(result.status).toBe("dispatched");
    expect(result.data).toEqual({ kind: "ack", relay: true });

    host.send(JSON.stringify({
      type: "event",
      streamId: "stream-1",
      sessionId: "session-1",
      seq: 1,
      emittedAt: new Date().toISOString(),
      event: { kind: "session_state", phase: "running", hasPendingMessages: false, futureField: "discarded" },
      futureField: "discarded",
    }));
    const event = await clientInbox.wait((message) => message.type === "event");
    expect(event.seq).toBe(1);
    expect(event.futureField).toBeUndefined();
    expect((event.event as Record<string, unknown>).futureField).toBeUndefined();
  });

  it("keeps a long project root lossless in host status fences", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();
    const longCwd = `D:/project/${"x".repeat(2_000)}`;
    const host = await connect(running.url);
    const hostInbox = new Inbox(host);
    host.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "long-cwd-host", roomId: "long-cwd-room", token: hostToken }));
    await hostInbox.wait((message) => message.type === "welcome");
    host.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, cwd: longCwd, streamId: "long-cwd-stream", sessionId: "long-cwd-session" } }));

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "long-cwd-client", roomId: "long-cwd-room", token: clientToken }));
    const status = await clientInbox.wait((message) => message.type === "host_status" && Array.isArray(message.hosts) &&
      (message.hosts as Array<Record<string, unknown>>).some((item) => item.hostId === "long-cwd-host" && item.cwd === longCwd));
    const info = (status.hosts as Array<Record<string, unknown>>).find((item) => item.hostId === "long-cwd-host");
    expect(info?.cwd).toBe(longCwd);
  });

  it("allows multiple Pi hosts in one room and routes commands to the selected host", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const hostOne = await connect(running.url);
    const hostOneInbox = new Inbox(hostOne);
    hostOne.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "pi-one", roomId: "main", token: hostToken }));
    await hostOneInbox.wait((message) => message.type === "welcome");
    hostOne.send(JSON.stringify({ type: "snapshot", hostId: "spoofed", snapshot: { ...baseSnapshot, streamId: "stream-one", sessionId: "session-one" } }));

    const hostTwo = await connect(running.url);
    const hostTwoInbox = new Inbox(hostTwo);
    hostTwo.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "pi-two", roomId: "main", token: hostToken }));
    await hostTwoInbox.wait((message) => message.type === "welcome");
    // Both runtimes deliberately reuse the stream ID to exercise the session fence.
    hostTwo.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "stream-one", sessionId: "session-two" } }));

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "web-multi", roomId: "main", token: clientToken }));
    await clientInbox.wait((message) => message.type === "welcome");
    const status = await clientInbox.wait((message) => message.type === "host_status");
    expect((status.hosts as unknown[]).length).toBe(2);
    await clientInbox.wait((message) => message.type === "snapshot" && message.hostId === "pi-one");
    await clientInbox.wait((message) => message.type === "snapshot" && message.hostId === "pi-two");

    client.send(JSON.stringify({
      type: "command",
      requestId: "ambiguous-request",
      expectedStreamId: "stream-one",
      payload: { name: "abort" },
    }));
    const ambiguous = await clientInbox.wait((message) => message.type === "command_result" && message.requestId === "ambiguous-request");
    expect(ambiguous.code).toBe("HOST_SELECTION_REQUIRED");

    client.send(JSON.stringify({
      type: "command",
      requestId: "stale-session-request",
      targetHostId: "pi-two",
      expectedStreamId: "stream-one",
      expectedSessionId: "old-session",
      payload: { name: "abort" },
    }));
    const stale = await clientInbox.wait((message) => message.type === "command_result" && message.requestId === "stale-session-request");
    expect(stale.code).toBe("STALE_SESSION");
    expect(stale.hostId).toBe("pi-two");
    const refreshed = await clientInbox.wait((message) => message.type === "snapshot" && message.hostId === "pi-two" &&
      (message.snapshot as Record<string, unknown>).sessionId === "session-two");
    expect((refreshed.snapshot as Record<string, unknown>).streamId).toBe("stream-one");

    client.send(JSON.stringify({
      type: "command",
      requestId: "request-two",
      targetHostId: "pi-two",
      expectedStreamId: "stream-one",
      expectedSessionId: "session-two",
      payload: { name: "prompt", content: "Only host two" },
    }));
    const routed = await hostTwoInbox.wait((message) => message.type === "routed_command");
    expect(routed.targetHostId).toBe("pi-two");
    expect(routed.expectedSessionId).toBe("session-two");
    expect(routed.sourcePeerId).toBe("web-multi");

    // A session replacement fences a command that was already in flight.
    hostTwo.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "stream-one", sessionId: "session-three" } }));
    const staleInFlight = await clientInbox.wait((message) => message.type === "command_result" && message.requestId === "request-two");
    expect(staleInFlight.code).toBe("STALE_SESSION");
    expect(staleInFlight.hostId).toBe("pi-two");

    // Reusing the request ID in the new session must not replay the old result.
    client.send(JSON.stringify({
      type: "command",
      requestId: "request-two",
      targetHostId: "pi-two",
      expectedStreamId: "stream-one",
      expectedSessionId: "session-three",
      payload: { name: "abort" },
    }));
    const rerouted = await hostTwoInbox.wait((message) => message.type === "routed_command");
    expect(rerouted.relayRequestId).not.toBe(routed.relayRequestId);
    hostTwo.send(JSON.stringify({
      type: "host_command_result",
      relayRequestId: rerouted.relayRequestId,
      status: "applied",
      code: null,
      message: null,
    }));
    const reroutedResult = await clientInbox.wait((message) => message.type === "command_result" && message.requestId === "request-two" && message.status === "applied");
    expect(reroutedResult.hostId).toBe("pi-two");

    hostTwo.send(JSON.stringify({
      type: "event",
      streamId: "stream-one",
      sessionId: "session-three",
      seq: 1,
      emittedAt: new Date().toISOString(),
      event: { kind: "session_state", phase: "running", hasPendingMessages: false },
    }));
    const event = await clientInbox.wait((message) => message.type === "event" && message.hostId === "pi-two");
    expect(event.sessionId).toBe("session-three");
  });

  it("fences a replaced host connection and waits for its new snapshot", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const oldHost = await connect(running.url);
    const oldHostInbox = new Inbox(oldHost);
    oldHost.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "replace-me", roomId: "replace-room", token: hostToken }));
    await oldHostInbox.wait((message) => message.type === "welcome");
    oldHost.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "old-stream", sessionId: "old-session" } }));

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "replace-client", roomId: "replace-room", token: clientToken }));
    await clientInbox.wait((message) => message.type === "snapshot");
    client.send(JSON.stringify({
      type: "command",
      requestId: "replaced-request",
      targetHostId: "replace-me",
      expectedStreamId: "old-stream",
      expectedSessionId: "old-session",
      payload: { name: "abort" },
    }));
    const routed = await oldHostInbox.wait((message) => message.type === "routed_command");

    const newHost = await connect(running.url);
    const newHostInbox = new Inbox(newHost);
    newHost.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "replace-me", roomId: "replace-room", token: hostToken }));
    await newHostInbox.wait((message) => message.type === "welcome");
    const replaced = await clientInbox.wait((message) => message.type === "command_result" && message.requestId === "replaced-request");
    expect(replaced.code).toBe("HOST_REPLACED");
    const synchronizing = await clientInbox.wait((message) => message.type === "host_status" &&
      Array.isArray(message.hosts) && (message.hosts as Array<Record<string, unknown>>).some((host) => host.hostId === "replace-me" && host.connected === true && host.ready === false));
    expect(synchronizing.type).toBe("host_status");

    // Events from the replacement socket are rejected until its fresh
    // snapshot establishes the new projection.
    newHost.send(JSON.stringify({
      type: "event",
      streamId: "old-stream",
      sessionId: "old-session",
      seq: 1,
      emittedAt: new Date().toISOString(),
      event: { kind: "session_state", phase: "running", hasPendingMessages: false },
    }));
    const preSnapshotError = await newHostInbox.wait((message) => message.type === "error" && message.code === "SNAPSHOT_REQUIRED");
    expect(preSnapshotError.code).toBe("SNAPSHOT_REQUIRED");

    newHost.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "new-stream", sessionId: "new-session" } }));
    await clientInbox.wait((message) => message.type === "snapshot" && message.hostId === "replace-me" &&
      (message.snapshot as Record<string, unknown>).sessionId === "new-session");
    client.send(JSON.stringify({
      type: "command",
      requestId: "new-request",
      targetHostId: "replace-me",
      expectedStreamId: "new-stream",
      expectedSessionId: "new-session",
      payload: { name: "abort" },
    }));
    const newRouted = await newHostInbox.wait((message) => message.type === "routed_command");
    expect(newRouted.expectedSessionId).toBe("new-session");
    expect(newRouted.relayRequestId).not.toBe(routed.relayRequestId);

    // A late result from the replaced socket cannot complete the new request.
    if (oldHost.readyState === WebSocket.OPEN) {
      oldHost.send(JSON.stringify({
        type: "host_command_result",
        relayRequestId: routed.relayRequestId,
        status: "applied",
        code: null,
        message: null,
      }));
    }
    newHost.send(JSON.stringify({
      type: "host_command_result",
      relayRequestId: newRouted.relayRequestId,
      status: "applied",
      code: null,
      message: null,
    }));
    const result = await clientInbox.wait((message) => message.type === "command_result" && message.requestId === "new-request");
    expect(result.status).toBe("applied");
  });

  it("moves pending result delivery to a reconnecting client", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const host = await connect(running.url);
    const hostInbox = new Inbox(host);
    host.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "handoff-host", roomId: "handoff-room", token: hostToken }));
    await hostInbox.wait((message) => message.type === "welcome");
    host.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "handoff-stream", sessionId: "handoff-session" } }));

    const oldClient = await connect(running.url);
    const oldClientInbox = new Inbox(oldClient);
    oldClient.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "handoff-client", roomId: "handoff-room", token: clientToken }));
    await oldClientInbox.wait((message) => message.type === "snapshot");
    oldClient.send(JSON.stringify({
      type: "command",
      requestId: "handoff-request",
      targetHostId: "handoff-host",
      expectedStreamId: "handoff-stream",
      expectedSessionId: "handoff-session",
      payload: { name: "abort" },
    }));
    const routed = await hostInbox.wait((message) => message.type === "routed_command");
    oldClient.close();

    const newClient = await connect(running.url);
    const newClientInbox = new Inbox(newClient);
    newClient.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "handoff-client", roomId: "handoff-room", token: clientToken }));
    await newClientInbox.wait((message) => message.type === "snapshot");
    newClient.send(JSON.stringify({
      type: "command",
      requestId: "handoff-request",
      targetHostId: "handoff-host",
      expectedStreamId: "handoff-stream",
      expectedSessionId: "handoff-session",
      payload: { name: "abort" },
    }));
    const pending = await newClientInbox.wait((message) => message.type === "command_result" && message.requestId === "handoff-request" && message.code === "REQUEST_PENDING");
    expect(pending.hostId).toBe("handoff-host");

    host.send(JSON.stringify({
      type: "host_command_result",
      relayRequestId: routed.relayRequestId,
      status: "applied",
      code: null,
      message: null,
    }));
    const result = await newClientInbox.wait((message) => message.type === "command_result" && message.requestId === "handoff-request" && message.status === "applied");
    expect(result.hostId).toBe("handoff-host");
  });

  it("keeps the relay's projected snapshot bounded after many events", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const host = await connect(running.url);
    const hostInbox = new Inbox(host);
    host.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "pi-large", roomId: "large-room", token: hostToken }));
    await hostInbox.wait((message) => message.type === "welcome");
    host.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "large-stream", sessionId: "large-session" } }));

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "web-large", roomId: "large-room", token: clientToken }));
    await clientInbox.wait((message) => message.type === "snapshot");

    for (let seq = 1; seq <= 140; seq++) {
      host.send(JSON.stringify({
        type: "event",
        streamId: "large-stream",
        sessionId: "large-session",
        seq,
        emittedAt: new Date().toISOString(),
        event: {
          kind: "message_started",
          message: {
            id: `large-message-${seq}`,
            role: "assistant",
            text: "x".repeat(4_096),
            thinking: "r".repeat(4_096),
            timestamp: seq,
            status: "complete",
            toolName: null,
            toolCallId: null,
          },
        },
      }));
    }
    await clientInbox.wait((message) => message.type === "event" && message.seq === 140);

    const reconnect = await connect(running.url);
    const reconnectInbox = new Inbox(reconnect);
    reconnect.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "web-large-reconnect", roomId: "large-room", token: clientToken }));
    const snapshotMessage = await reconnectInbox.wait((message) => message.type === "snapshot");
    const bytes = Buffer.byteLength(JSON.stringify(snapshotMessage), "utf8");
    expect(bytes).toBeLessThan(MAX_FRAME_BYTES);
    expect(((snapshotMessage.snapshot as Record<string, unknown>).messages as unknown[]).length).toBeLessThanOrEqual(100);
  });

  it("serves cached history after the Pi host disconnects", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const host = await connect(running.url);
    const hostInbox = new Inbox(host);
    host.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "pi-cache", roomId: "cache-room", token: hostToken }));
    await hostInbox.wait((message) => message.type === "welcome");
    host.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "cache-stream", sessionId: "cache-session" } }));

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "web-cache", roomId: "cache-room", token: clientToken }));
    await clientInbox.wait((message) => message.type === "snapshot");
    client.send(JSON.stringify({
      type: "command",
      requestId: "cache-list-1",
      expectedStreamId: "cache-stream",
      payload: { name: "list_sessions" },
    }));
    const routed = await hostInbox.wait((message) => message.type === "routed_command");
    host.send(JSON.stringify({
      type: "host_command_result",
      relayRequestId: routed.relayRequestId,
      status: "applied",
      code: null,
      message: null,
      data: { kind: "sessions", currentSessionId: "cache-session", sessions: [] },
    }));
    await clientInbox.wait((message) => message.type === "command_result" && message.requestId === "cache-list-1");

    host.close();
    const offlineStatus = await clientInbox.wait((message) => message.type === "host_status" && message.connected === false);
    const offlineHost = (offlineStatus.hosts as Array<Record<string, unknown>>).find((item) => item.hostId === "pi-cache");
    expect(offlineHost?.connected).toBe(false);
    expect(offlineHost?.ready).toBe(false);
    client.close();

    const reconnect = await connect(running.url);
    const reconnectInbox = new Inbox(reconnect);
    reconnect.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "web-cache-reconnect", roomId: "cache-room", token: clientToken }));
    await reconnectInbox.wait((message) => message.type === "snapshot");
    reconnect.send(JSON.stringify({
      type: "command",
      requestId: "cache-list-2",
      expectedStreamId: "cache-stream",
      payload: { name: "list_sessions" },
    }));
    const cached = await reconnectInbox.wait((message) => message.type === "command_result" && message.requestId === "cache-list-2");
    expect(cached.status).toBe("applied");
    expect(cached.message).toBe("Served from relay cache");
    expect(cached.data).toEqual({ kind: "sessions", currentSessionId: "cache-session", sessions: [] });
  });

  it("refreshes offline host retention when a cached history result is read", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      offlineHostTtlMs: 250,
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const host = await connect(running.url);
    const hostInbox = new Inbox(host);
    host.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "refresh-host", roomId: "refresh-room", token: hostToken }));
    await hostInbox.wait((message) => message.type === "welcome");
    host.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "refresh-stream", sessionId: "refresh-session" } }));
    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "refresh-client", roomId: "refresh-room", token: clientToken }));
    await clientInbox.wait((message) => message.type === "snapshot");
    client.send(JSON.stringify({ type: "command", requestId: "refresh-seed", targetHostId: "refresh-host", expectedStreamId: "refresh-stream", expectedSessionId: "refresh-session", payload: { name: "list_sessions" } }));
    const routed = await hostInbox.wait((message) => message.type === "routed_command");
    host.send(JSON.stringify({ type: "host_command_result", relayRequestId: routed.relayRequestId, status: "applied", code: null, message: null, data: { kind: "sessions", currentSessionId: "refresh-session", sessions: [] } }));
    await clientInbox.wait((message) => message.type === "command_result" && message.requestId === "refresh-seed");
    host.close();
    await clientInbox.wait((message) => message.type === "host_status" && message.connected === false);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    client.send(JSON.stringify({ type: "command", requestId: "refresh-hit-1", targetHostId: "refresh-host", expectedStreamId: "refresh-stream", expectedSessionId: "refresh-session", payload: { name: "list_sessions" } }));
    const firstHit = await clientInbox.wait((message) => message.type === "command_result" && message.requestId === "refresh-hit-1");
    expect(firstHit.message).toBe("Served from relay cache");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 180));
    client.send(JSON.stringify({ type: "command", requestId: "refresh-hit-2", targetHostId: "refresh-host", expectedStreamId: "refresh-stream", expectedSessionId: "refresh-session", payload: { name: "list_sessions" } }));
    const secondHit = await clientInbox.wait((message) => message.type === "command_result" && message.requestId === "refresh-hit-2");
    expect(secondHit.message).toBe("Served from relay cache");
  });

  it("does not cache history-shaped data returned by a write command", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const host = await connect(running.url);
    const hostInbox = new Inbox(host);
    host.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "poison-host", roomId: "poison-room", token: hostToken }));
    await hostInbox.wait((message) => message.type === "welcome");
    host.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "poison-stream", sessionId: "poison-session" } }));

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "poison-client", roomId: "poison-room", token: clientToken }));
    await clientInbox.wait((message) => message.type === "snapshot");
    client.send(JSON.stringify({
      type: "command", requestId: "poison-write", targetHostId: "poison-host", expectedStreamId: "poison-stream",
      expectedSessionId: "poison-session", payload: { name: "abort" },
    }));
    const routed = await hostInbox.wait((message) => message.type === "routed_command");
    host.send(JSON.stringify({
      type: "host_command_result", relayRequestId: routed.relayRequestId, status: "applied", code: null, message: null,
      data: { kind: "sessions", currentSessionId: "poison-session", sessions: [] },
    }));
    await clientInbox.wait((message) => message.type === "command_result" && message.requestId === "poison-write");
    host.close();
    await clientInbox.wait((message) => message.type === "host_status" && message.connected === false);
    client.send(JSON.stringify({
      type: "command", requestId: "poison-read", targetHostId: "poison-host", expectedStreamId: "poison-stream",
      expectedSessionId: "poison-session", payload: { name: "list_sessions" },
    }));
    const result = await clientInbox.wait((message) => message.type === "command_result" && message.requestId === "poison-read");
    expect(result.code).toBe("HOST_OFFLINE");
    expect(result.status).toBe("rejected");
  });

  it("does not cache a history result under the wrong command kind", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const host = await connect(running.url);
    const hostInbox = new Inbox(host);
    host.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "shape-host", roomId: "shape-room", token: hostToken }));
    await hostInbox.wait((message) => message.type === "welcome");
    host.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "shape-stream", sessionId: "shape-session" } }));

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "shape-client", roomId: "shape-room", token: clientToken }));
    await clientInbox.wait((message) => message.type === "snapshot");
    client.send(JSON.stringify({
      type: "command", requestId: "shape-list", targetHostId: "shape-host", expectedStreamId: "shape-stream",
      expectedSessionId: "shape-session", payload: { name: "list_sessions" },
    }));
    const routed = await hostInbox.wait((message) => message.type === "routed_command");
    host.send(JSON.stringify({
      type: "host_command_result", relayRequestId: routed.relayRequestId, status: "applied", code: null, message: null,
      data: { kind: "session", sessionId: "poisoned-session", messages: [] },
    }));
    const invalid = await clientInbox.wait((message) => message.type === "command_result" && message.requestId === "shape-list");
    expect(invalid.code).toBe("RESULT_INVALID");
    expect(invalid.status).toBe("rejected");
    host.close();
    await clientInbox.wait((message) => message.type === "host_status" && message.connected === false);
    client.send(JSON.stringify({
      type: "command", requestId: "shape-get", targetHostId: "shape-host", expectedStreamId: "shape-stream",
      expectedSessionId: "shape-session", payload: { name: "get_session", sessionId: "poisoned-session" },
    }));
    const result = await clientInbox.wait((message) => message.type === "command_result" && message.requestId === "shape-get");
    expect(result.code).toBe("HOST_OFFLINE");
    expect(result.status).toBe("rejected");
  });

  it("does not replay a synthetic offline result after the same host reconnects", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const oldHost = await connect(running.url);
    const oldHostInbox = new Inbox(oldHost);
    oldHost.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "offline-retry-host", roomId: "offline-retry-room", token: hostToken }));
    await oldHostInbox.wait((message) => message.type === "welcome");
    oldHost.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "offline-retry-stream", sessionId: "offline-retry-session" } }));

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "offline-retry-client", roomId: "offline-retry-room", token: clientToken }));
    await clientInbox.wait((message) => message.type === "snapshot");
    const completedBeforeReconnect = {
      type: "command",
      requestId: "completed-before-reconnect",
      targetHostId: "offline-retry-host",
      expectedStreamId: "offline-retry-stream",
      expectedSessionId: "offline-retry-session",
      payload: { name: "abort" },
    };
    client.send(JSON.stringify(completedBeforeReconnect));
    const completedRouted = await oldHostInbox.wait((message) => message.type === "routed_command");
    oldHost.send(JSON.stringify({ type: "host_command_result", relayRequestId: completedRouted.relayRequestId, status: "applied", code: null, message: null }));
    await clientInbox.wait((message) => message.type === "command_result" && message.requestId === completedBeforeReconnect.requestId && message.status === "applied");

    const command = {
      type: "command",
      requestId: "offline-retry-request",
      targetHostId: "offline-retry-host",
      expectedStreamId: "offline-retry-stream",
      expectedSessionId: "offline-retry-session",
      payload: { name: "abort" },
    };
    client.send(JSON.stringify(command));
    const routed = await oldHostInbox.wait((message) => message.type === "routed_command");
    oldHost.close();
    const offline = await clientInbox.wait((message) => message.type === "command_result" && message.requestId === command.requestId);
    expect(offline.code).toBe("HOST_OFFLINE");

    const newHost = await connect(running.url);
    const newHostInbox = new Inbox(newHost);
    newHost.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "offline-retry-host", roomId: "offline-retry-room", token: hostToken }));
    await newHostInbox.wait((message) => message.type === "welcome");
    newHost.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "offline-retry-stream", sessionId: "offline-retry-session" } }));
    await clientInbox.wait((message) => message.type === "snapshot" && message.hostId === "offline-retry-host");
    client.send(JSON.stringify(command));
    const rerouted = await newHostInbox.wait((message) => message.type === "routed_command");
    expect(rerouted.relayRequestId).not.toBe(routed.relayRequestId);
    newHost.send(JSON.stringify({ type: "host_command_result", relayRequestId: rerouted.relayRequestId, status: "applied", code: null, message: null }));
    const applied = await clientInbox.wait((message) => message.type === "command_result" && message.requestId === command.requestId && message.status === "applied");
    expect(applied.hostId).toBe("offline-retry-host");

    // Results from the old host connection must not be replayed after a
    // reconnect, even when the replacement reports the same session.
    client.send(JSON.stringify(completedBeforeReconnect));
    const reroutedCompleted = await newHostInbox.wait((message) => message.type === "routed_command");
    expect(reroutedCompleted.relayRequestId).not.toBe(completedRouted.relayRequestId);
    newHost.send(JSON.stringify({ type: "host_command_result", relayRequestId: reroutedCompleted.relayRequestId, status: "applied", code: null, message: null }));
    await clientInbox.wait((message) => message.type === "command_result" && message.requestId === completedBeforeReconnect.requestId && message.status === "applied");
  });

  it("fences an in-flight history read when the projected revision changes", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const host = await connect(running.url);
    const hostInbox = new Inbox(host);
    host.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "history-fence-host", roomId: "history-fence-room", token: hostToken }));
    await hostInbox.wait((message) => message.type === "welcome");
    host.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "history-fence-stream", sessionId: "history-fence-session" } }));

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "history-fence-client", roomId: "history-fence-room", token: clientToken }));
    await clientInbox.wait((message) => message.type === "snapshot");
    const command = {
      type: "command",
      requestId: "history-fence-request",
      targetHostId: "history-fence-host",
      expectedStreamId: "history-fence-stream",
      expectedSessionId: "history-fence-session",
      payload: { name: "list_sessions" },
    };
    client.send(JSON.stringify(command));
    const routed = await hostInbox.wait((message) => message.type === "routed_command");
    host.send(JSON.stringify({
      type: "event",
      streamId: "history-fence-stream",
      sessionId: "history-fence-session",
      seq: 1,
      emittedAt: new Date().toISOString(),
      event: {
        kind: "message_started",
        message: { id: "revision-message", role: "assistant", text: "new", thinking: "", timestamp: 1, status: "complete", toolName: null, toolCallId: null },
      },
    }));
    const stale = await clientInbox.wait((message) => message.type === "command_result" && message.requestId === command.requestId);
    expect(stale.code).toBe("STALE_SESSION");
    host.send(JSON.stringify({ type: "host_command_result", relayRequestId: routed.relayRequestId, status: "applied", code: null, message: null, data: { kind: "sessions", currentSessionId: "history-fence-session", sessions: [] } }));

    client.send(JSON.stringify(command));
    const rerouted = await hostInbox.wait((message) => message.type === "routed_command");
    expect(rerouted.relayRequestId).not.toBe(routed.relayRequestId);
  });

  it("invalidates completed rejected history dedupe results when history changes", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const host = await connect(running.url);
    const hostInbox = new Inbox(host);
    host.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "history-reject-host", roomId: "history-reject-room", token: hostToken }));
    await hostInbox.wait((message) => message.type === "welcome");
    host.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "history-reject-stream", sessionId: "history-reject-session" } }));

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "history-reject-client", roomId: "history-reject-room", token: clientToken }));
    await clientInbox.wait((message) => message.type === "snapshot");
    const command = {
      type: "command", requestId: "history-reject-request", targetHostId: "history-reject-host",
      expectedStreamId: "history-reject-stream", expectedSessionId: "history-reject-session",
      payload: { name: "get_session", sessionId: "missing-session" },
    };
    client.send(JSON.stringify(command));
    const firstRouted = await hostInbox.wait((message) => message.type === "routed_command");
    host.send(JSON.stringify({
      type: "host_command_result", relayRequestId: firstRouted.relayRequestId, status: "rejected",
      code: "SESSION_NOT_FOUND", message: "Not found",
    }));
    await clientInbox.wait((message) => message.type === "command_result" && message.requestId === command.requestId);

    client.send(JSON.stringify(command));
    const replay = await clientInbox.wait((message) => message.type === "command_result" && message.requestId === command.requestId);
    expect(replay.code).toBe("SESSION_NOT_FOUND");

    host.send(JSON.stringify({
      type: "event", streamId: "history-reject-stream", sessionId: "history-reject-session", seq: 1,
      emittedAt: new Date().toISOString(), event: { kind: "thinking_changed", level: "low" },
    }));
    await clientInbox.wait((message) => message.type === "event" && message.seq === 1);
    client.send(JSON.stringify(command));
    const rerouted = await hostInbox.wait((message) => message.type === "routed_command" && message.clientRequestId === command.requestId);
    expect(rerouted.relayRequestId).not.toBe(firstRouted.relayRequestId);
  });

  it("rejects an offline host TTL that Node would clamp", () => {
    expect(() => createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      offlineHostTtlMs: 2_147_483_648,
    })).toThrow("offlineHostTtlMs");
  });

  it("expires offline hosts without blocking a replacement host", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      offlineHostTtlMs: 40,
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const oldHost = await connect(running.url);
    const oldHostInbox = new Inbox(oldHost);
    oldHost.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "expiring-host", roomId: "expiry-room", token: hostToken }));
    await oldHostInbox.wait((message) => message.type === "welcome");
    oldHost.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "expiring-stream", sessionId: "expiring-session" } }));

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "expiry-client", roomId: "expiry-room", token: clientToken }));
    await clientInbox.wait((message) => message.type === "snapshot");

    oldHost.close();
    await clientInbox.wait((message) => message.type === "host_status" && message.connected === false);
    const expired = await clientInbox.wait((message) => message.type === "host_status" &&
      Array.isArray(message.hosts) && (message.hosts as unknown[]).length === 0);
    expect(expired.connected).toBe(false);

    const replacement = await connect(running.url);
    const replacementInbox = new Inbox(replacement);
    replacement.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "replacement-host", roomId: "expiry-room", token: hostToken }));
    await replacementInbox.wait((message) => message.type === "welcome");
    replacement.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "replacement-stream", sessionId: "replacement-session" } }));
    const replacementSnapshot = await clientInbox.wait((message) => message.type === "snapshot" && message.hostId === "replacement-host");
    expect((replacementSnapshot.snapshot as Record<string, unknown>).sessionId).toBe("replacement-session");
  });

  it("retains an offline host briefly even when no client is connected", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      offlineHostTtlMs: 500,
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const host = await connect(running.url);
    const hostInbox = new Inbox(host);
    host.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "retained-host", roomId: "retained-room", token: hostToken }));
    await hostInbox.wait((message) => message.type === "welcome");
    host.send(JSON.stringify({ snapshot: baseSnapshot, type: "snapshot" }));

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "retained-client", roomId: "retained-room", token: clientToken }));
    await clientInbox.wait((message) => message.type === "snapshot");
    const clientClosed = new Promise<void>((resolveClosed) => client.once("close", () => resolveClosed()));
    client.close();
    await clientClosed;
    const hostClosed = new Promise<void>((resolveClosed) => host.once("close", () => resolveClosed()));
    host.close();
    await hostClosed;

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    const reconnect = await connect(running.url);
    const reconnectInbox = new Inbox(reconnect);
    reconnect.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "retained-reconnect", roomId: "retained-room", token: clientToken }));
    await reconnectInbox.wait((message) => message.type === "welcome");
    const retainedStatus = await reconnectInbox.wait((message) => message.type === "host_status" &&
      ((message.hosts as Array<Record<string, unknown>> | undefined)?.some((item) => item.hostId === "retained-host") === true));
    expect((retainedStatus.hosts as Array<Record<string, unknown>>).find((item) => item.hostId === "retained-host")?.connected).toBe(false);
    const retainedSnapshot = await reconnectInbox.wait((message) => message.type === "snapshot" && message.hostId === "retained-host");
    expect((retainedSnapshot.snapshot as Record<string, unknown>).sessionId).toBe("session-1");
    const expiredStatus = await reconnectInbox.wait((message) => message.type === "host_status" &&
      Array.isArray(message.hosts) && (message.hosts as unknown[]).length === 0);
    expect(expiredStatus.connected).toBe(false);
  });

  it("evicts an offline host when the room reaches its host limit", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const hostSockets: WebSocket[] = [];
    for (let index = 0; index < 64; index++) {
      const host = await connect(running.url);
      const inbox = new Inbox(host);
      host.send(JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        peerRole: "host",
        peerId: `capacity-host-${index}`,
        roomId: "capacity-room",
        token: hostToken,
      }));
      await inbox.wait((message) => message.type === "welcome");
      host.send(JSON.stringify({ snapshot: {
        ...baseSnapshot,
        sessionName: "🙂".repeat(128),
        cwd: "🙂".repeat(1_024),
      }, type: "snapshot" }));
      hostSockets.push(host);
    }

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "capacity-client", roomId: "capacity-room", token: clientToken }));
    await clientInbox.wait((message) => message.type === "welcome");
    const full = await clientInbox.wait((message) => message.type === "host_status");
    expect((full.hosts as unknown[]).length).toBe(64);
    expect(Buffer.byteLength(JSON.stringify(full), "utf8")).toBeLessThan(MAX_FRAME_BYTES);
    const compactedLongHost = (full.hosts as Array<Record<string, unknown>>).find((host) => host.hostId === "capacity-host-0");
    // Do not publish a misleading prefix when the lossless aggregate status is
    // too large; descriptive fences are dropped for the whole compact status.
    expect(compactedLongHost?.cwd).toBeNull();

    hostSockets[0]?.close();
    await clientInbox.wait((message) => message.type === "host_status" &&
      ((message.hosts as Array<Record<string, unknown>> | undefined)?.some((host) => host.hostId === "capacity-host-0" && host.connected === false) === true));

    const newcomer = await connect(running.url);
    const newcomerInbox = new Inbox(newcomer);
    newcomer.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "capacity-newcomer", roomId: "capacity-room", token: hostToken }));
    await newcomerInbox.wait((message) => message.type === "welcome");
    const afterEviction = await clientInbox.wait((message) => message.type === "host_status" &&
      Array.isArray(message.hosts) && (message.hosts as Array<Record<string, unknown>>).some((host) => host.hostId === "capacity-newcomer"));
    const hostIds = (afterEviction.hosts as Array<Record<string, unknown>>).map((host) => host.hostId);
    expect(hostIds).toHaveLength(64);
    expect(hostIds).toContain("capacity-newcomer");
    expect(hostIds).not.toContain("capacity-host-0");
  });

  it("strips unknown routed command fields before forwarding", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const host = await connect(running.url);
    const hostInbox = new Inbox(host);
    const longHostId = "h".repeat(128);
    host.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: longHostId, roomId: "route-budget", token: hostToken }));
    await hostInbox.wait((message) => message.type === "welcome");
    host.send(JSON.stringify({ type: "snapshot", snapshot: baseSnapshot }));

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    const longPeerId = "c".repeat(128);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: longPeerId, roomId: "route-budget", token: clientToken }));
    await clientInbox.wait((message) => message.type === "snapshot");
    let paddingLength = 261_500;
    const makeCommand = () => ({
      type: "command", requestId: "r".repeat(128), targetHostId: longHostId, expectedStreamId: "stream-1",
      expectedSessionId: "session-1", payload: { name: "prompt", content: "ok", delivery: "followUp", futureField: "x".repeat(paddingLength) },
    });
    while (Buffer.byteLength(JSON.stringify(makeCommand()), "utf8") > MAX_FRAME_BYTES) paddingLength--;
    const command = makeCommand();
    expect(Buffer.byteLength(JSON.stringify(command), "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    client.send(JSON.stringify(command));
    const routed = await hostInbox.wait((message) => message.type === "routed_command");
    expect((routed.payload as Record<string, unknown>).futureField).toBeUndefined();
    expect((routed.payload as Record<string, unknown>).content).toBe("ok");
  });

  it("bounds pending commands per client", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const host = await connect(running.url);
    const hostInbox = new Inbox(host);
    host.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "queue-host", roomId: "queue-room", token: hostToken }));
    await hostInbox.wait((message) => message.type === "welcome");
    host.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "queue-stream", sessionId: "queue-session" } }));

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "queue-client", roomId: "queue-room", token: clientToken }));
    await clientInbox.wait((message) => message.type === "snapshot");
    for (let index = 0; index < 33; index++) {
      client.send(JSON.stringify({
        type: "command",
        requestId: `queue-request-${index}`,
        targetHostId: "queue-host",
        expectedStreamId: "queue-stream",
        expectedSessionId: "queue-session",
        payload: { name: "abort" },
      }));
    }
    const full = await clientInbox.wait((message) => message.type === "command_result" && message.requestId === "queue-request-32");
    expect(full.code).toBe("COMMAND_QUEUE_FULL");
  });

  it("rejects a snapshot that would move one host's event sequence backwards", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const host = await connect(running.url);
    const hostInbox = new Inbox(host);
    host.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "sequence-host", roomId: "sequence-room", token: hostToken }));
    await hostInbox.wait((message) => message.type === "welcome");
    host.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "sequence-stream", sessionId: "sequence-session", lastEventSeq: 2 } }));
    const hostClosed = new Promise<number>((resolveClosed) => host.once("close", (code) => resolveClosed(code)));
    host.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "sequence-stream", sessionId: "sequence-session", lastEventSeq: 1 } }));
    const stale = await hostInbox.wait((message) => message.type === "error" && message.code === "STALE_SNAPSHOT");
    expect(stale.message).toContain("backwards");
    expect(await hostClosed).toBe(1011);

    const reconnect = await connect(running.url);
    const reconnectInbox = new Inbox(reconnect);
    reconnect.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "host", peerId: "sequence-host", roomId: "sequence-room", token: hostToken }));
    await reconnectInbox.wait((message) => message.type === "welcome");
    const reconnectClosed = new Promise<number>((resolveClosed) => reconnect.once("close", (code) => resolveClosed(code)));
    reconnect.send(JSON.stringify({ type: "snapshot", snapshot: { ...baseSnapshot, streamId: "sequence-stream", sessionId: "sequence-session", lastEventSeq: 1 } }));
    const reconnectStale = await reconnectInbox.wait((message) => message.type === "error" && message.code === "STALE_SNAPSHOT");
    expect(reconnectStale.message).toContain("backwards");
    expect(await reconnectClosed).toBe(1011);

    const client = await connect(running.url);
    const clientInbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "sequence-client", roomId: "sequence-room", token: clientToken }));
    const retained = await clientInbox.wait((message) => message.type === "snapshot" && message.hostId === "sequence-host");
    expect((retained.snapshot as Record<string, unknown>).lastEventSeq).toBe(2);
  });

  it("serves security headers and enforces normalized WebSocket origins", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: ["https://allowed.example/"],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const response = await fetch(`${running.url}/icon.svg`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const staticPaths = ["/", "/index.html", "/app.js", "/styles.css", "/manifest.webmanifest", "/icon.svg"];
    for (const path of staticPaths) {
      const staticResponse = await fetch(`${running.url}${path}`);
      expect(staticResponse.status).toBe(200);
      expect(staticResponse.headers.get("cache-control")).toBe("no-store");
    }
    const notFound = await fetch(`${running.url}/not-found`);
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("cache-control")).toBe("no-store");
    expect(notFound.headers.get("content-security-policy")).toContain("connect-src 'self'");
    const method = await fetch(`${running.url}/healthz`, { method: "POST" });
    expect(method.status).toBe(405);
    expect(method.headers.get("cache-control")).toBe("no-store");

    const wsUrl = `${running.url.replace(/^http/, "ws")}/ws`;
    const allowed = new WebSocket(wsUrl, { origin: "https://allowed.example/" });
    sockets.push(allowed);
    await expect(new Promise<void>((resolveOpened, rejectUnexpected) => {
      allowed.once("open", () => resolveOpened());
      allowed.once("error", rejectUnexpected);
    })).resolves.toBeUndefined();

    const foreign = new WebSocket(wsUrl, { origin: "https://evil.example" });
    sockets.push(foreign);
    await expect(new Promise<void>((resolveRejected, rejectUnexpected) => {
      foreign.once("open", () => rejectUnexpected(new Error("Foreign Origin unexpectedly connected")));
      foreign.once("error", () => resolveRejected());
    })).resolves.toBeUndefined();

    const wrongScheme = new WebSocket(wsUrl, { origin: `https://127.0.0.1:${new URL(running.url).port}` });
    sockets.push(wrongScheme);
    await expect(new Promise<void>((resolveRejected, rejectUnexpected) => {
      wrongScheme.once("open", () => rejectUnexpected(new Error("Wrong-scheme Origin unexpectedly connected")));
      wrongScheme.once("error", () => resolveRejected());
    })).resolves.toBeUndefined();
  });

  it("rejects oversized and non-regular static assets", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "pi-cafe-static-"));
    temporaryDirectories.push(webRoot);
    await writeFile(join(webRoot, "app.js"), Buffer.alloc(4 * 1024 * 1024 + 1));
    await mkdir(join(webRoot, "styles.css"));
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      webRoot,
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();

    const oversized = await fetch(`${running.url}/app.js`);
    expect(oversized.status).toBe(503);
    expect(oversized.headers.get("cache-control")).toBe("no-store");
    expect(await oversized.text()).toBe("Web client is not installed");
    const directory = await fetch(`${running.url}/styles.css`);
    expect(directory.status).toBe(503);
    expect(directory.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("requires long credentials when binding outside loopback", () => {
    expect(() => createRelayServer({
      host: "0.0.0.0",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
    })).toThrow("high-entropy tokens");
    expect(() => createRelayServer({
      host: "192.168.1.20",
      port: 0,
      hostToken: "replace-with-a-long-random-host-token",
      clientToken: "replace-with-a-long-random-client-token",
      allowedOrigins: [],
    })).toThrow("high-entropy tokens");
    expect(() => createRelayServer({
      host: "192.168.1.20",
      port: 0,
      hostToken: "replace-with-a-long-random-token",
      clientToken: "independent-high-entropy-client-token",
      allowedOrigins: [],
    })).toThrow("high-entropy tokens");
    expect(() => createRelayServer({
      host: "192.168.1.20",
      port: 0,
      hostToken: "same-high-entropy-token-12345",
      clientToken: "same-high-entropy-token-12345",
      allowedOrigins: [],
    })).toThrow("high-entropy tokens");
    expect(() => createRelayServer({
      host: "192.168.1.20",
      port: 0,
      hostToken: "Case-sensitive-token-12345",
      clientToken: "case-sensitive-token-12345",
      allowedOrigins: [],
    })).toThrow("high-entropy tokens");
    expect(() => createRelayServer({
      host: "192.168.1.20",
      port: 0,
      hostToken: "local-dev-client-token",
      clientToken: "independent-high-entropy-client-token",
      allowedOrigins: [],
    })).toThrow("high-entropy tokens");
    expect(() => createRelayServer({
      host: "192.168.1.20",
      port: 0,
      hostToken: "A".repeat(4_097),
      clientToken: "independent-high-entropy-client-token",
      allowedOrigins: [],
    })).toThrow("too long");
    expect(() => createRelayServer({
      host: "192.168.1.20",
      port: 0,
      hostToken: "LOCAL-DEV-HOST-TOKEN",
      clientToken: "independent-high-entropy-client-token",
      allowedOrigins: [],
    })).toThrow("high-entropy tokens");
    expect(() => createRelayServer({
      host: "192.168.1.20",
      port: 0,
      hostToken: "aaaaaaaaaaaaaaaa",
      clientToken: "v7Q2mN9#pL4zR8!x",
      allowedOrigins: [],
    })).toThrow("high-entropy tokens");
  });

  it("rejects malformed configured browser origins", () => {
    for (const origin of [
      "ftp://example.test",
      "https://user@example.test",
      "https://example.test/path",
      "https://example.test?query=1",
      "https://example.test#fragment",
      "   ",
    ]) {
      expect(() => createRelayServer({
        host: "127.0.0.1",
        port: 0,
        hostToken,
        clientToken,
        allowedOrigins: [origin],
      })).toThrow("valid http(s) origins");
    }
  });

  it("bounds configured browser origins and relay paths", () => {
    expect(() => createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: ["https://example.test/" + "x".repeat(2_048)],
    })).toThrow("allowed origins");
    expect(() => createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: Array.from({ length: 65 }, () => "https://example.test"),
    })).toThrow("allowed origins");
    expect(() => createRelayServer({
      host: "h".repeat(256),
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
    })).toThrow("Relay host is too long");
    expect(() => createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      webRoot: "x".repeat(32_769),
      allowedOrigins: [],
    })).toThrow("Relay webRoot is too long");
  });

  it("rejects surrounding room whitespace and closes the connection", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();
    const client = await connect(running.url);
    const inbox = new Inbox(client);
    const closed = new Promise<number>((resolveClosed) => client.once("close", (code) => resolveClosed(code)));
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "room-space", roomId: " main ", token: clientToken }));
    const error = await inbox.wait((message) => message.type === "error");
    expect(error.code).toBe("INVALID_ROOM");
    expect(await closed).toBe(1008);
  });

  it("rejects a client with the wrong token", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken,
      clientToken,
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    running = await relay.listen();
    const client = await connect(running.url);
    const inbox = new Inbox(client);
    client.send(JSON.stringify({ type: "hello", protocolVersion: 1, peerRole: "client", peerId: "web-1", roomId: "main", token: "wrong" }));
    const error = await inbox.wait((message) => message.type === "error");
    expect(error.code).toBe("UNAUTHORIZED");
  });
});
