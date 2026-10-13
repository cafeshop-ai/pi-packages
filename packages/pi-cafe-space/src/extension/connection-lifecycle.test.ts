import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerPiCollabExtension from "./index.js";
import { createRelayServer, type RunningRelayServer } from "../relay/server.js";

type Handler = (...args: any[]) => unknown;

const activeSockets: WebSocket[] = [];
let activeRelays: RunningRelayServer[] = [];
let activeShutdown: (() => unknown) | null = null;
let restoreEnvironment: (() => void) | null = null;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  activeSockets.push(socket);
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      socket.off("open", onOpen);
      reject(error);
    };
    const onOpen = (): void => {
      socket.off("error", onError);
      // Keep an error listener for the remainder of the test so an unexpected
      // transport failure is contained by the cleanup path rather than
      // becoming an uncaught EventEmitter error.
      socket.on("error", () => {});
      resolve(socket);
    };
    socket.on("error", () => {});
    socket.once("error", onError);
    socket.once("open", onOpen);
  });
}

function waitForMessage(socket: WebSocket, predicate: (message: Record<string, unknown>) => boolean, timeout = 5_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for Pi Cafe Space lifecycle message"));
    }, timeout);
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

function setEnvironment(values: Record<string, string | undefined>): void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  restoreEnvironment = () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    restoreEnvironment = null;
  };
}

afterEach(async () => {
  try { await activeShutdown?.(); } catch {}
  activeShutdown = null;
  for (const socket of activeSockets) {
    try { socket.close(); } catch {}
  }
  activeSockets.length = 0;
  for (const relay of activeRelays) {
    try { await relay.close(); } catch {}
  }
  activeRelays = [];
  restoreEnvironment?.();
});

describe("Pi Cafe Space connection lifecycle", () => {
  it("throttles real socket failures across brief authenticated reconnects", async () => {
    const firstRelay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken: "host-token",
      clientToken: "client-token",
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    const firstRunning = await firstRelay.listen();
    activeRelays.push(firstRunning);
    const firstPort = new URL(firstRunning.url).port;
    setEnvironment({
      PI_COLLAB_ENABLED: "1",
      PI_COLLAB_RELAY_URL: `ws://127.0.0.1:${firstPort}/ws`,
      PI_COLLAB_ROOM: "warning-lifecycle",
      PI_COLLAB_HOST_TOKEN: "host-token",
      PI_COLLAB_CLIENT_TOKEN: undefined,
      PI_COLLAB_PEER_ID: "warning-lifecycle-host",
    });

    const notifications: Array<{ message: string; level: string }> = [];
    const statuses: string[] = [];
    const handlers = new Map<string, Handler>();
    const pi = {
      registerFlag() {},
      getFlag(name: string) { return name === "collab" ? true : undefined; },
      on(name: string, handler: Handler) { handlers.set(name, handler); },
      registerCommand() {},
      getSessionName() { return null; },
      getThinkingLevel() { return "off"; },
      sendUserMessage() {},
      setThinkingLevel() {},
      setModel: async () => true,
    } as unknown as ExtensionAPI;
    const context = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort() {},
      model: null,
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => "warning-session",
        getLeafId: () => null,
      },
      ui: {
        setStatus(_key: string, text: string) { statuses.push(text); },
        notify(message: string, level: string) { notifications.push({ message, level }); },
      },
    } as unknown as ExtensionContext;
    registerPiCollabExtension(pi);
    activeShutdown = () => handlers.get("session_shutdown")?.();
    await handlers.get("session_start")?.({}, context);

    const firstClient = await openSocket(`${firstRunning.url.replace(/^http/, "ws")}/ws`);
    firstClient.send(JSON.stringify({
      type: "hello", protocolVersion: 1, peerRole: "client", peerId: "warning-lifecycle-client",
      roomId: "warning-lifecycle", token: "client-token",
    }));
    await waitForMessage(firstClient, (message) => message.type === "snapshot");
    expect(statuses).toContain('café space: connected');

    // A malformed Pi callback must be contained and advertised as an
    // incomplete projection rather than escaping the event hook or silently
    // looking complete.
    const recoveredSnapshot = waitForMessage(firstClient, (message) => message.type === "snapshot" &&
      (message.snapshot as Record<string, unknown> | undefined)?.historyTruncated === true);
    expect(() => handlers.get("message_start")?.({ message: null }, context)).not.toThrow();
    await recoveredSnapshot;

    // Closing the real relay exercises the ws error/close path. Several
    // exponential-backoff connection attempts follow while the port is down,
    // but they must remain one user-facing warning episode.
    firstClient.close();
    await firstRunning.close();
    await wait(10_300);
    const connectionWarningsAfterFirstFailure = notifications.filter((item) => item.level === "warning" && item.message.startsWith("Café Space: connection unavailable"));
    expect(connectionWarningsAfterFirstFailure).toHaveLength(1);

    const secondRelay = createRelayServer({
      host: "127.0.0.1",
      port: Number(firstPort),
      hostToken: "host-token",
      clientToken: "client-token",
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    const secondRunning = await secondRelay.listen();
    activeRelays.push(secondRunning);
    const secondClient = await openSocket(`${secondRunning.url.replace(/^http/, "ws")}/ws`);
    secondClient.send(JSON.stringify({
      type: "hello", protocolVersion: 1, peerRole: "client", peerId: "warning-lifecycle-client-2",
      roomId: "warning-lifecycle", token: "client-token",
    }));
    await waitForMessage(secondClient, (message) => message.type === "snapshot", 12_000);

    // A brief welcome must not reset the warning cooldown or report recovery.
    secondClient.close();
    await secondRunning.close();
    await wait(10_300);
    expect(notifications.filter(item => item.level === 'info' && item.message.includes('connection is stable again'))).toHaveLength(0);
    const connectionWarningsAfterSecondFailure = notifications.filter((item) => item.level === "warning" && item.message.startsWith("Café Space: connection unavailable"));
    expect(connectionWarningsAfterSecondFailure).toHaveLength(1);

    await handlers.get("session_shutdown")?.();
    await wait(100);
    expect(notifications.filter((item) => item.level === "warning" && item.message.startsWith("Café Space: connection unavailable"))).toHaveLength(1);
    expect(statuses).toContain('café space: disconnected');
    expect(statuses.every(value => value.startsWith('café space: '))).toBe(true);
  }, 45_000);

  it("omits image bytes and tool-call placeholders from the visible text projection", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      hostToken: "host-token",
      clientToken: "client-token",
      allowedOrigins: [],
      logger: { info() {}, warn() {}, error() {} },
    });
    const running = await relay.listen();
    activeRelays.push(running);
    const port = new URL(running.url).port;
    setEnvironment({
      PI_COLLAB_ENABLED: "1",
      PI_COLLAB_RELAY_URL: `ws://127.0.0.1:${port}/ws`,
      PI_COLLAB_ROOM: "image-projection",
      PI_COLLAB_HOST_TOKEN: "host-token",
      PI_COLLAB_CLIENT_TOKEN: undefined,
      PI_COLLAB_PEER_ID: "image-projection-host",
    });

    const handlers = new Map<string, Handler>();
    const pi = {
      registerFlag() {},
      getFlag(name: string) { return name === "collab" ? true : undefined; },
      on(name: string, handler: Handler) { handlers.set(name, handler); },
      registerCommand() {},
      getSessionName() { return null; },
      getThinkingLevel() { return "off"; },
      sendUserMessage() {},
      setThinkingLevel() {},
      setModel: async () => true,
    } as unknown as ExtensionAPI;
    const context = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort() {},
      model: null,
      sessionManager: {
        getBranch: () => [{
          type: "message",
          id: "m-image",
          message: {
            role: "user",
            content: [
              { type: "text", text: "see this" },
              { type: "image", data: "aaaa", mimeType: "image/png" },
              { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
            ],
            timestamp: 1,
          },
        }],
        getSessionId: () => "image-session",
        getLeafId: () => null,
      },
      ui: {
        setStatus() {},
        notify() {},
      },
    } as unknown as ExtensionContext;
    registerPiCollabExtension(pi);
    activeShutdown = () => handlers.get("session_shutdown")?.();
    await handlers.get("session_start")?.({}, context);

    const client = await openSocket(`${running.url.replace(/^http/, "ws")}/ws`);
    client.send(JSON.stringify({
      type: "hello", protocolVersion: 1, peerRole: "client", peerId: "image-projection-client",
      roomId: "image-projection", token: "client-token",
    }));
    const snapshotMessage = await waitForMessage(client, (message) => message.type === "snapshot");
    const snapshot = snapshotMessage.snapshot as {
      historyTruncated?: boolean;
      messages?: Array<{ text?: string }>;
    };
    expect(snapshot.historyTruncated).toBe(true);
    expect(snapshot.messages?.[0]?.text).toBe("see this");
    expect(snapshot.messages?.[0]?.text).not.toContain("[image]");
    expect(snapshot.messages?.[0]?.text).not.toContain("[tool call:");

    await handlers.get("session_shutdown")?.();
  }, 45_000);
});
