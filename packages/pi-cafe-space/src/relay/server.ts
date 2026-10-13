import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  applyEvent,
  canonicalCommandPayload,
  canonicalEvent,
  canonicalExecution,
  compactTranscriptMessage,
  decodeWireMessage,
  fitCommandResult,
  hasSufficientTokenEntropy,
  type ClientCommandMessage,
  type CommandResultMessage,
  type ErrorMessage,
  type EventEnvelope,
  type HelloMessage,
  type HostCommandResultMessage,
  type HostInfo,
  type HostStatusMessage,
  type PeerRole,
  type RoutedCommandMessage,
  type SessionSnapshot,
  type SnapshotMessage,
  type ToolExecution,
  type WelcomeMessage,
} from "../protocol/index.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { type Duplex } from "node:stream";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer, type RawData } from "ws";

const MAX_BUFFERED_BYTES = 1024 * 1024;
const DEVELOPMENT_HOST_TOKEN = "local-dev-host-token";
const DEVELOPMENT_CLIENT_TOKEN = "local-dev-client-token";
const DEVELOPMENT_TOKENS = new Set([DEVELOPMENT_HOST_TOKEN, DEVELOPMENT_CLIENT_TOKEN]);
function isDevelopmentToken(value: string): boolean { return DEVELOPMENT_TOKENS.has(value.toLowerCase()); }
const PLACEHOLDER_TOKEN_PATTERN = /^replace-with-(?:(?:a-long-random-)?(?:host|client)|a-long-random|random)-token$/i;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const SNAPSHOT_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_CACHED_HISTORIES = 20;
const MAX_CACHED_RESULTS = 1_000;
const MAX_CACHED_RESULT_BYTES = 8 * 1024 * 1024;
const HISTORY_CACHE_TTL_MS = 30 * 60_000;
const OFFLINE_HOST_TTL_MS = 30 * 60_000;
// Node clamps setTimeout delays above this signed 32-bit maximum to roughly
// one millisecond. Reject such configuration rather than evicting early.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const ROOM_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
function isValidRoomId(value: string): boolean { return value === value.trim() && ROOM_ID_PATTERN.test(value); }
const MAX_SNAPSHOT_MESSAGES = 100;
const MAX_SNAPSHOT_TOOLS = 24;
const MAX_HOSTS_PER_ROOM = 64;
const MAX_CLIENTS_PER_ROOM = 256;
const MAX_ROOMS = 256;
const MAX_CONNECTIONS = 512;
const MAX_ALLOWED_ORIGINS = 64;
const MAX_ALLOWED_ORIGIN_LENGTH = 2_048;
const MAX_WEB_ROOT_LENGTH = 32_768;
const MAX_STATIC_FILE_BYTES = 4 * 1024 * 1024;
const POSIX_NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const STATIC_OPEN_FLAGS = process.platform === "win32" ? "r" : constants.O_RDONLY | POSIX_NOFOLLOW;
// Handshakes are unauthenticated until the first hello frame. Keep their
// population bounded and reserve capacity so idle unauthenticated sockets
// cannot consume the entire relay before real peers authenticate.
const MAX_UNAUTHENTICATED_CONNECTIONS = 128;
const MAX_UNAUTHENTICATED_PER_ADDRESS = 32;
const MAX_PENDING_COMMANDS_PER_HOST = 128;
const MAX_PENDING_COMMANDS_PER_CLIENT = 32;
const SNAPSHOT_FRAME_BUDGET = MAX_FRAME_BYTES - 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function safePrefix(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let end = Math.max(0, maxLength);
  if (end < value.length && end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return value.slice(0, end);
}

export interface RelayServerOptions {
  host: string;
  port: number;
  hostToken: string;
  clientToken: string;
  allowedOrigins?: string[];
  webRoot?: string;
  /** Primarily useful for deterministic integration tests; defaults to 30 minutes. */
  offlineHostTtlMs?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

interface Connection {
  socket: WebSocket;
  connectionId: string;
  role: PeerRole | null;
  peerId: string | null;
  roomId: string | null;
  alive: boolean;
  /** Captured before authentication so handshake admission can be bounded. */
  remoteAddress: string;
  hostState: HostState | null;
  handshakeTimer: NodeJS.Timeout;
}

interface PendingCommand {
  roomId: string;
  hostId: string;
  peerId: string;
  /** Fence delivery to the browser connection that issued the command. */
  clientConnectionId: string;
  /** Fence a host result to the socket that received the routed command. */
  hostConnectionId: string;
  requestId: string;
  dedupeKey: string;
  /** History reads are fenced to the projection revision seen at dispatch. */
  historyRevision: string | null;
  historyKind: "list" | "get" | null;
  historySessionId: string | null;
  timer: NodeJS.Timeout;
}

/** State for one independent Pi runtime inside a room. */
interface HostState {
  hostId: string;
  connection: Connection | null;
  /** A host is not command-ready until its current connection sends a snapshot. */
  ready: boolean;
  snapshot: SessionSnapshot | null;
  /** Detects branch/compaction projection changes that keep the same session ID. */
  historyRevision: string | null;
  snapshotWarningSent: boolean;
  pending: Map<string, PendingCommand>;
  pendingByKey: Map<string, string>;
  results: Map<string, CommandResultMessage>;
  /** Dedupe keys for every history result, including rejected/no-data results. */
  historyResultKeys: Set<string>;
  resultBytes: number;
  cachedSessionList: CommandResultMessage | null;
  cachedSessions: Map<string, CommandResultMessage>;
  historyCacheTimer: NodeJS.Timeout | null;
  offlineTimer: NodeJS.Timeout | null;
  snapshotTimer: NodeJS.Timeout | null;
}

interface Room {
  id: string;
  hosts: Map<string, HostState>;
  clients: Map<string, Connection>;
}

export interface RunningRelayServer {
  url: string;
  close(): Promise<void>;
}

export interface RelayServer {
  listen(): Promise<RunningRelayServer>;
}

function hashToken(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function tokenMatches(actual: string, expected: string): boolean {
  return timingSafeEqual(hashToken(actual), hashToken(expected));
}

function rawDataToString(data: RawData): string {
  const rawData: unknown = data;
  if (typeof rawData === "string") {
    if (rawData.length > MAX_FRAME_BYTES || Buffer.byteLength(rawData, "utf8") > MAX_FRAME_BYTES) throw new Error("Message exceeds the relay frame limit");
    return rawData;
  }
  let buffer: Buffer;
  if (Buffer.isBuffer(rawData)) {
    if (rawData.byteLength > MAX_FRAME_BYTES) throw new Error("Message exceeds the relay frame limit");
    buffer = rawData;
  } else if (Array.isArray(rawData)) {
    let byteLength = 0;
    for (const part of rawData) {
      if (!Buffer.isBuffer(part) || !Number.isSafeInteger(part.byteLength) || part.byteLength < 0) throw new Error("Message is not valid binary data");
      byteLength += part.byteLength;
      if (!Number.isSafeInteger(byteLength) || byteLength > MAX_FRAME_BYTES) throw new Error("Message exceeds the relay frame limit");
    }
    buffer = Buffer.concat(rawData as Buffer[]);
  } else {
    const candidate = rawData as { byteLength?: unknown };
    const byteLength = typeof candidate?.byteLength === "number" ? candidate.byteLength : Number.NaN;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_FRAME_BYTES) throw new Error("Message exceeds the relay frame limit");
    try { buffer = Buffer.from(rawData as ArrayBuffer); }
    catch { throw new Error("Message is not valid binary data"); }
    if (buffer.byteLength > MAX_FRAME_BYTES) throw new Error("Message exceeds the relay frame limit");
  }
  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    throw new Error("Message is not valid UTF-8");
  }
}

function truncateSnapshotText(value: string, max: number): string {
  if (value.length <= max) return value;
  const marker = "\n… [truncated]";
  return max <= marker.length ? safePrefix(value, max) : `${safePrefix(value, max - marker.length)}${marker}`;
}

function describeError(error: unknown): string {
  let text: string;
  try {
    text = error instanceof Error && typeof error.message === "string" ? error.message : String(error);
  } catch {
    text = "Unknown relay error";
  }
  return truncateSnapshotText(text, 2_048);
}

export function compactRelaySnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  let messageTextTruncated = false;
  let messages = snapshot.messages.slice(-MAX_SNAPSHOT_MESSAGES).map((message) => {
    const text = truncateSnapshotText(message.text, 8_192);
    const thinking = truncateSnapshotText(message.thinking, 8_192);
    messageTextTruncated ||= message.partsTruncated === true || text.length !== message.text.length || thinking.length !== message.thinking.length;
    return compactTranscriptMessage(message, text, thinking);
  });
  let toolTextTruncated = false;
  let tools: ToolExecution[] = snapshot.tools.slice(-MAX_SNAPSHOT_TOOLS).map((tool) => {
    const argsText = truncateSnapshotText(tool.argsText, 2_048);
    const output = truncateSnapshotText(tool.output, 4_096);
    toolTextTruncated ||= argsText.length !== tool.argsText.length || output.length !== tool.output.length;
    return {
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      argsText,
      output,
      status: tool.status,
      ...(tool.parentMessageId === undefined ? {} : { parentMessageId: tool.parentMessageId }),
    };
  });
  let historyTruncated = snapshot.historyTruncated === true || messages.length < snapshot.messages.length || tools.length < snapshot.tools.length || messageTextTruncated || toolTextTruncated;
  const makeSnapshot = (): SessionSnapshot => ({
    protocolVersion: PROTOCOL_VERSION,
    streamId: snapshot.streamId,
    sessionId: snapshot.sessionId,
    sessionName: snapshot.sessionName,
    cwd: snapshot.cwd,
    activeLeafId: snapshot.activeLeafId,
    model: snapshot.model ? { provider: snapshot.model.provider, id: snapshot.model.id, ...(snapshot.model.reasoning===undefined?{}:{reasoning:snapshot.model.reasoning}), ...(snapshot.model.thinkingLevels===undefined?{}:{thinkingLevels:[...snapshot.model.thinkingLevels]}) } : null,
    thinkingLevel: snapshot.thinkingLevel,
    phase: snapshot.phase,
    hasPendingMessages: snapshot.hasPendingMessages,
    ...(snapshot.execution === undefined ? {} : {execution:canonicalExecution(snapshot.execution)}),
    ...(snapshot.sessionControl === undefined ? {} : { sessionControl: snapshot.sessionControl }),
    ...(snapshot.inputAssist === undefined ? {} : { inputAssist: snapshot.inputAssist }),
    messages,
    historyTruncated,
    tools,
    lastEventSeq: snapshot.lastEventSeq,
  });
  const size = (): number => Buffer.byteLength(JSON.stringify({ type: "snapshot", snapshot: makeSnapshot() }), "utf8");
  while (messages.length > 1 && size() > SNAPSHOT_FRAME_BUDGET) {
    messages = messages.slice(1);
    historyTruncated = true;
  }
  while (tools.length > 0 && size() > SNAPSHOT_FRAME_BUDGET) {
    tools = tools.slice(1);
    historyTruncated = true;
  }
  if (size() > SNAPSHOT_FRAME_BUDGET) {
    messages = messages.length ? [messages[messages.length - 1]!] : [];
    tools = [];
    historyTruncated = true;
  }
  if (size() > SNAPSHOT_FRAME_BUDGET) {
    messages = messages.map(message => compactTranscriptMessage(message, message.text, message.thinking, true));
    historyTruncated = true;
  }
  const compacted = makeSnapshot();
  return size() <= SNAPSHOT_FRAME_BUDGET ? compacted : {
    ...compacted,
    messages: [],
    tools: [],
    historyTruncated: true,
  };
}

function contentType(pathname: string): string {
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  return "text/html; charset=utf-8";
}

const forceCloseTimers = new WeakMap<WebSocket, NodeJS.Timeout>();

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
    else socket.terminate();
  } catch {
    try { socket.terminate(); } catch {}
  }
  // A peer can ignore a close handshake indefinitely. Keep the graceful close
  // code/reason for normal clients, but make every rejection/shutdown path
  // eventually release the socket without relying on the peer to cooperate.
  // One backstop per socket is enough; repeated protocol errors must not create
  // an unbounded timer list while the socket is closing.
  if (socket.readyState !== WebSocket.CLOSED && !forceCloseTimers.has(socket)) {
    let forceCloseTimer: NodeJS.Timeout;
    forceCloseTimer = setTimeout(() => {
      forceCloseTimers.delete(socket);
      if (socket.readyState !== WebSocket.CLOSED) {
        try { socket.terminate(); } catch {}
      }
    }, 1_000);
    forceCloseTimer.unref();
    forceCloseTimers.set(socket, forceCloseTimer);
    try {
      socket.once("close", () => {
        const current = forceCloseTimers.get(socket);
        if (current === forceCloseTimer) {
          clearTimeout(current);
          forceCloseTimers.delete(socket);
        }
      });
    } catch {
      // The timer remains a safe bounded backstop if a test/damaged socket does
      // not support listener registration.
    }
  }
}

function frameSize(message: object): number {
  try { return Buffer.byteLength(JSON.stringify(message), "utf8"); } catch { return Number.POSITIVE_INFINITY; }
}

function snapshotHistoryRevision(snapshot: SessionSnapshot): string {
  try {
    return createHash("sha256").update(JSON.stringify({
      streamId: snapshot.streamId,
      sessionId: snapshot.sessionId,
      sessionName: snapshot.sessionName,
      cwd: snapshot.cwd,
      activeLeafId: snapshot.activeLeafId,
      model: snapshot.model,
      thinkingLevel: snapshot.thinkingLevel,
      messages: snapshot.messages,
      tools: snapshot.tools,
      historyTruncated: snapshot.historyTruncated,
    })).digest("hex");
  } catch {
    // A decoded snapshot is JSON-safe; retain a unique revision if an
    // unexpected serialization failure ever occurs so caches are not reused.
    return randomUUID();
  }
}

function safeSend(connection: Connection, message: object): boolean {
  if (connection.socket.readyState !== WebSocket.OPEN) return false;
  let encoded: string;
  try {
    const serialized = JSON.stringify(message);
    if (typeof serialized !== "string") throw new Error("Message is not serializable");
    encoded = serialized;
  } catch {
    closeSocket(connection.socket, 1011, "Message is not serializable");
    return false;
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES) {
    closeSocket(connection.socket, 1009, "Message is too large");
    return false;
  }
  if (connection.socket.bufferedAmount + Buffer.byteLength(encoded, "utf8") > MAX_BUFFERED_BYTES) {
    closeSocket(connection.socket, 1013, "Client is too slow");
    return false;
  }
  try {
    connection.socket.send(encoded);
    return true;
  } catch {
    closeSocket(connection.socket, 1011, "Unable to send message");
    return false;
  }
}

function sendError(connection: Connection, code: string, message: string): void {
  const payload: ErrorMessage = {
    type: "error",
    code: truncateSnapshotText(typeof code === "string" && code ? code : "RELAY_ERROR", 128),
    message: typeof message === "string" ? truncateSnapshotText(message, 2_048) : describeError(message),
  };
  safeSend(connection, payload);
}

function hostInfo(state: HostState): HostInfo {
  const snapshot = state.snapshot;
  const connected = state.connection?.socket.readyState === WebSocket.OPEN;
  return {
    hostId: state.hostId,
    connected,
    ready: connected && state.ready,
    streamId: snapshot?.streamId ?? null,
    sessionId: snapshot?.sessionId ?? null,
    sessionName: snapshot?.sessionName ? truncateSnapshotText(snapshot.sessionName, 240) : null,
    // The browser uses cwd as a context fence. Preserve the extension's
    // bounded, collision-resistant representation here; if a room's
    // aggregate status would exceed the frame budget, roomHostStatus() drops
    // descriptive metadata rather than publishing a misleading prefix.
    cwd: snapshot?.cwd ?? null,
  };
}

function roomHostStatus(room: Room): HostStatusMessage {
  const states = [...room.hosts.values()].sort((left, right) => {
    const rank = (state: HostState): number => {
      const connected = state.connection?.socket.readyState === WebSocket.OPEN;
      return connected && state.ready && state.snapshot ? 0 : connected ? 1 : 2;
    };
    const rankDifference = rank(left) - rank(right);
    if (rankDifference !== 0) return rankDifference;
    return left.hostId < right.hostId ? -1 : left.hostId > right.hostId ? 1 : 0;
  });
  const hosts = states.slice(0, MAX_HOSTS_PER_ROOM).map(hostInfo);
  const primary = hosts.find((host) => host.connected && host.ready && host.streamId !== null) ??
    hosts.find((host) => host.connected) ?? hosts[0];
  const status: HostStatusMessage = {
    type: "host_status",
    connected: hosts.some((host) => host.connected),
    hostId: primary?.hostId ?? null,
    streamId: primary?.streamId ?? null,
    sessionId: primary?.sessionId ?? null,
    hosts,
  };
  if (frameSize(status) <= MAX_FRAME_BYTES - 1_024) return status;

  // Host IDs are routing identities and must remain intact. If a legacy or
  // untrusted snapshot uses multibyte metadata to make the rich status too
  // large, drop only descriptive/session fields before considering the status
  // unusable. The bounded IDs and booleans keep this fallback well below the
  // wire limit while preserving host selection.
  const compactHosts: HostInfo[] = hosts.map((host) => ({
    hostId: host.hostId,
    connected: host.connected,
    ...(host.ready === undefined ? {} : { ready: host.ready }),
    streamId: null,
    sessionId: null,
    sessionName: null,
    cwd: null,
  }));
  const compact: HostStatusMessage = {
    type: "host_status",
    connected: status.connected,
    hostId: status.hostId ?? null,
    streamId: null,
    sessionId: null,
    hosts: compactHosts,
  };
  return frameSize(compact) <= MAX_FRAME_BYTES ? compact : {
    type: "host_status",
    connected: status.connected,
    hostId: status.hostId ?? null,
    streamId: null,
    sessionId: null,
    hosts: compactHosts.slice(0, 1),
  };
}

function normalizeConfiguredOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ALLOWED_ORIGIN_LENGTH || trimmed.includes("?") || trimmed.includes("#")) return null;
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password ||
        parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin === "null") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function isAllowedOrigin(request: IncomingMessage, allowedOrigins: Set<string>): boolean {
  const origin = request.headers.origin;
  if (!origin || typeof origin !== "string") return true;
  const normalizedOrigin = normalizeConfiguredOrigin(origin);
  if (!normalizedOrigin) return false;
  if (allowedOrigins.has(normalizedOrigin)) return true;
  try {
    const requestHost = request.headers.host;
    if (typeof requestHost !== "string" || !requestHost) return false;
    // Direct relay listeners are HTTP. If TLS is terminated by a trusted
    // reverse proxy, configure its public HTTPS origin explicitly rather than
    // trusting an unverified forwarded-protocol header.
    const requestProtocol = (request.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted ? "https:" : "http:";
    const requestOrigin = new URL(`${requestProtocol}//${requestHost}`).origin;
    const parsed = new URL(normalizedOrigin);
    return parsed.origin.toLowerCase() === requestOrigin.toLowerCase();
  } catch {
    return false;
  }
}

export function createRelayServer(options: RelayServerOptions): RelayServer {
  if (!options || typeof options !== "object") throw new Error("Relay options must be an object");
  if (typeof options.host !== "string") throw new Error("Relay host must be a string");
  if (typeof options.hostToken !== "string" || typeof options.clientToken !== "string") {
    throw new Error("Relay host and client tokens must be strings");
  }
  if (options.allowedOrigins !== undefined && !Array.isArray(options.allowedOrigins)) {
    throw new Error("Relay allowed origins must be an array");
  }
  if (options.webRoot !== undefined && typeof options.webRoot !== "string") {
    throw new Error("Relay webRoot must be a string");
  }
  if (options.host.length > 255) throw new Error("Relay host is too long");
  if (options.hostToken.length > 4_096 || options.clientToken.length > 4_096) {
    throw new Error("Relay host and client tokens are too long");
  }
  if (options.webRoot !== undefined && options.webRoot.length > MAX_WEB_ROOT_LENGTH) {
    throw new Error("Relay webRoot is too long");
  }
  const logger = options.logger ?? console;
  const logInfo = (message: string): void => { try { logger.info(message); } catch {} };
  const logWarn = (message: string): void => { try { logger.warn(message); } catch {} };
  const logError = (message: string, error?: unknown): void => { try { logger.error(message, error); } catch {} };
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const bundledWebRoot = resolve(moduleDir, "public");
  const workspaceWebRoot = resolve(moduleDir, "../../web/public");
  const defaultWebRoot = existsSync(bundledWebRoot) ? bundledWebRoot : workspaceWebRoot;
  const webRoot = resolve(options.webRoot ?? defaultWebRoot);
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error("Relay port must be a valid TCP port");
  }
  const bindHost = options.host.trim().replace(/^\[|\]$/g, "");
  if (!bindHost) throw new Error("Relay host must not be empty");
  const hostToken = options.hostToken.trim();
  const clientToken = options.clientToken.trim();
  if (!hostToken || !clientToken) throw new Error("Relay host and client tokens must not be empty");
  const isLoopbackHost = ["127.0.0.1", "localhost", "::1"].includes(bindHost.toLowerCase());
  if (!isLoopbackHost && (hostToken.toLowerCase() === clientToken.toLowerCase() || isDevelopmentToken(hostToken) || isDevelopmentToken(clientToken) ||
      PLACEHOLDER_TOKEN_PATTERN.test(hostToken) || PLACEHOLDER_TOKEN_PATTERN.test(clientToken) ||
      !hasSufficientTokenEntropy(hostToken) || !hasSufficientTokenEntropy(clientToken))) {
    throw new Error("Explicit high-entropy tokens (at least 16 characters) are required outside loopback mode");
  }
  const configuredOrigins = options.allowedOrigins ?? [];
  if (configuredOrigins.length > MAX_ALLOWED_ORIGINS || configuredOrigins.some((origin) => typeof origin !== "string" || origin.length > MAX_ALLOWED_ORIGIN_LENGTH)) {
    throw new Error(`Relay allowed origins must contain at most ${MAX_ALLOWED_ORIGINS} entries of ${MAX_ALLOWED_ORIGIN_LENGTH} characters or fewer`);
  }
  const normalizedOrigins: string[] = [];
  for (const origin of configuredOrigins) {
    if (!origin.trim()) throw new Error("Relay allowed origins must be valid http(s) origins");
    const normalized = normalizeConfiguredOrigin(origin);
    if (!normalized) throw new Error("Relay allowed origins must be valid http(s) origins");
    normalizedOrigins.push(normalized);
  }
  const allowedOrigins = new Set(normalizedOrigins);
  const offlineHostTtlMs = options.offlineHostTtlMs ?? OFFLINE_HOST_TTL_MS;
  if (!Number.isSafeInteger(offlineHostTtlMs) || offlineHostTtlMs < 0 || offlineHostTtlMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`offlineHostTtlMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS} milliseconds`);
  }
  const rooms = new Map<string, Room>();
  const connections = new Set<Connection>();
  let closing = false;
  let closePromise: Promise<void> | null = null;
  let failedListenCleanupPromise: Promise<void> | null = null;
  let listenInProgress = false;
  let listenStarted = false;

  function getRoom(roomId: string): Room {
    const existing = rooms.get(roomId);
    if (existing) return existing;
    const room: Room = {
      id: roomId,
      hosts: new Map(),
      clients: new Map(),
    };
    rooms.set(roomId, room);
    return room;
  }

  function broadcastClients(room: Room, message: object): void {
    for (const client of room.clients.values()) safeSend(client, message);
  }

  function createHostState(hostId: string): HostState {
    return {
      hostId,
      connection: null,
      ready: false,
      snapshot: null,
      historyRevision: null,
      snapshotWarningSent: false,
      pending: new Map(),
      pendingByKey: new Map(),
      results: new Map(),
      historyResultKeys: new Set(),
      resultBytes: 0,
      cachedSessionList: null,
      cachedSessions: new Map(),
      historyCacheTimer: null,
      offlineTimer: null,
      snapshotTimer: null,
    };
  }

  function resultBytes(result: CommandResultMessage): number {
    try { return Buffer.byteLength(JSON.stringify(result), "utf8"); } catch { return MAX_CACHED_RESULT_BYTES; }
  }

  function clearResults(host: HostState): void {
    host.results.clear();
    host.historyResultKeys.clear();
    host.resultBytes = 0;
  }

  function clearHistoryResults(host: HostState): void {
    for (const key of host.historyResultKeys) {
      const result = host.results.get(key);
      if (result) host.resultBytes -= resultBytes(result);
      host.results.delete(key);
    }
    host.historyResultKeys.clear();
    if (host.resultBytes < 0) host.resultBytes = 0;
  }

  function rememberResult(host: HostState, key: string, result: CommandResultMessage, historyResult = false): void {
    const previous = host.results.get(key);
    if (previous) host.resultBytes -= resultBytes(previous);
    if (historyResult) host.historyResultKeys.add(key);
    else host.historyResultKeys.delete(key);
    host.results.set(key, result);
    host.resultBytes += resultBytes(result);
    while (host.results.size > MAX_CACHED_RESULTS || host.resultBytes > MAX_CACHED_RESULT_BYTES) {
      const first = host.results.keys().next().value as string | undefined;
      if (!first) break;
      const firstResult = host.results.get(first);
      if (firstResult) host.resultBytes -= resultBytes(firstResult);
      host.results.delete(first);
      host.historyResultKeys.delete(first);
    }
  }

  function clearHistoryCache(host: HostState): void {
    if (host.historyCacheTimer) clearTimeout(host.historyCacheTimer);
    host.historyCacheTimer = null;
    host.cachedSessionList = null;
    host.cachedSessions.clear();
  }

  function clearOfflineHostExpiry(host: HostState): void {
    if (host.offlineTimer) clearTimeout(host.offlineTimer);
    host.offlineTimer = null;
  }

  function clearSnapshotTimeout(host: HostState): void {
    if (host.snapshotTimer) clearTimeout(host.snapshotTimer);
    host.snapshotTimer = null;
  }

  function scheduleSnapshotTimeout(room: Room, host: HostState, connection: Connection): void {
    clearSnapshotTimeout(host);
    let snapshotTimer: NodeJS.Timeout;
    snapshotTimer = setTimeout(() => {
      if (host.snapshotTimer !== snapshotTimer || host.connection !== connection || host.ready ||
          closing || rooms.get(room.id) !== room) return;
      host.snapshotTimer = null;
      closeSocket(connection.socket, 1008, "Snapshot required");
    }, SNAPSHOT_TIMEOUT_MS);
    host.snapshotTimer = snapshotTimer;
  }

  function discardHostState(room: Room, host: HostState): void {
    if (room.hosts.get(host.hostId) !== host) return;
    room.hosts.delete(host.hostId);
    clearHistoryCache(host);
    clearOfflineHostExpiry(host);
    clearSnapshotTimeout(host);
  }

  function evictOfflineHostsForCapacity(room: Room): void {
    for (const [hostId, host] of room.hosts) {
      if (room.hosts.size < MAX_HOSTS_PER_ROOM) return;
      // Keep open hosts and any defensive pending state. A closing/failed
      // socket is already offline for capacity purposes and can be discarded.
      if (host.connection?.socket.readyState === WebSocket.OPEN || host.pending.size > 0) continue;
      const staleConnection = host.connection;
      host.connection = null;
      host.ready = false;
      if (staleConnection) {
        closeSocket(staleConnection.socket, 1000, "Evicted offline host state");
      }
      room.hosts.delete(hostId);
      clearHistoryCache(host);
      clearOfflineHostExpiry(host);
      clearSnapshotTimeout(host);
    }
  }

  function scheduleOfflineHostExpiry(room: Room, host: HostState): void {
    clearOfflineHostExpiry(host);
    let offlineTimer: NodeJS.Timeout;
    offlineTimer = setTimeout(() => {
      if (host.offlineTimer !== offlineTimer) return;
      host.offlineTimer = null;
      if (closing || host.connection || rooms.get(room.id) !== room) return;
      // A normal disconnect completes pending commands immediately. Keep this
      // defensive expiry path bounded as well if a close/result race ever
      // leaves one behind: the offline host must not occupy room capacity
      // indefinitely.
      for (const relayRequestId of [...host.pending.keys()]) {
        completeCommand(room, host, relayRequestId, {
          type: "host_command_result",
          relayRequestId,
          status: "rejected",
          code: "HOST_EXPIRED",
          message: "The offline Pi host was retained past its expiry time",
        });
      }
      if (host.connection || rooms.get(room.id) !== room) return;
      discardHostState(room, host);
      broadcastClients(room, roomHostStatus(room));
      maybeDeleteRoom(room);
    }, offlineHostTtlMs);
    host.offlineTimer = offlineTimer;
    offlineTimer.unref();
  }

  function scheduleHistoryCacheExpiry(room: Room, host: HostState): void {
    if (host.historyCacheTimer) clearTimeout(host.historyCacheTimer);
    let historyCacheTimer: NodeJS.Timeout;
    historyCacheTimer = setTimeout(() => {
      if (host.historyCacheTimer !== historyCacheTimer) return;
      host.historyCacheTimer = null;
      if (closing || rooms.get(room.id) !== room) return;
      clearHistoryCache(host);
      maybeDeleteRoom(room);
    }, HISTORY_CACHE_TTL_MS);
    host.historyCacheTimer = historyCacheTimer;
    historyCacheTimer.unref();
  }

  function copyCommandResult(result: CommandResultMessage, requestId: string, message: string | null): CommandResultMessage {
    const copy: CommandResultMessage = {
      type: "command_result",
      requestId,
      status: result.status,
      code: result.code,
      message,
    };
    if (result.hostId !== undefined) copy.hostId = result.hostId;
    if (result.data !== undefined) copy.data = result.data;
    return fitCommandResult(copy);
  }

  function cacheHistoryResult(room: Room, host: HostState, result: CommandResultMessage, historyKind: "list" | "get"): void {
    if (result.status !== "applied" || !result.data || typeof result.data !== "object" || Array.isArray(result.data)) return;
    const data = result.data as Record<string, unknown>;
    const cached = copyCommandResult(result, "", result.message);
    if (historyKind === "list") {
      if (data.kind !== "sessions") return;
      host.cachedSessionList = cached;
      scheduleHistoryCacheExpiry(room, host);
      return;
    }
    if (data.kind !== "session" || typeof data.sessionId !== "string") return;
    host.cachedSessions.set(data.sessionId, cached);
    while (host.cachedSessions.size > MAX_CACHED_HISTORIES) {
      const first = host.cachedSessions.keys().next().value as string | undefined;
      if (!first) break;
      host.cachedSessions.delete(first);
    }
    scheduleHistoryCacheExpiry(room, host);
  }

  function cachedHistoryResult(host: HostState, command: ClientCommandMessage): CommandResultMessage | null {
    let cached: CommandResultMessage | null = null;
    if (command.payload.name === "list_sessions") cached = host.cachedSessionList;
    else if (command.payload.name === "get_session") cached = host.cachedSessions.get(command.payload.sessionId) ?? null;
    if (!cached) return null;
    return copyCommandResult(cached, command.requestId, "Served from relay cache");
  }

  function maybeDeleteRoom(room: Room): void {
    if (rooms.get(room.id) !== room) return;
    if (room.clients.size > 0) return;
    if ([...room.hosts.values()].some((host) => host.connection !== null || host.pending.size > 0 || host.snapshot !== null || host.cachedSessionList !== null || host.cachedSessions.size > 0 || host.offlineTimer !== null || host.snapshotTimer !== null)) return;
    for (const host of room.hosts.values()) {
      clearHistoryCache(host);
      clearOfflineHostExpiry(host);
    }
    rooms.delete(room.id);
  }

  function removeConnection(connection: Connection): void {
    connections.delete(connection);
    clearTimeout(connection.handshakeTimer);
    if (!connection.roomId || !connection.role || !connection.peerId) return;
    const room = rooms.get(connection.roomId);
    if (!room) return;
    if (connection.role === "host" && connection.hostState && connection.hostState.connection === connection) {
      const host = connection.hostState;
      clearSnapshotTimeout(host);
      host.connection = null;
      host.ready = false;
      host.snapshotWarningSent = false;
      for (const relayRequestId of [...host.pending.keys()]) {
        completeCommand(room, host, relayRequestId, {
          type: "host_command_result",
          relayRequestId,
          status: "rejected",
          code: "HOST_OFFLINE",
          message: "The Pi host disconnected before acknowledging the command",
        });
      }
      if (!closing) {
        broadcastClients(room, roomHostStatus(room));
        scheduleOfflineHostExpiry(room, host);
      }
    } else if (connection.role === "client" && room.clients.get(connection.peerId) === connection) {
      room.clients.delete(connection.peerId);
    }
    if (!closing) maybeDeleteRoom(room);
  }

  function completeCommand(
    room: Room,
    host: HostState,
    relayRequestId: string,
    result: HostCommandResultMessage,
    expectedTimer?: NodeJS.Timeout,
    expectedHostConnectionId?: string,
  ): void {
    // A timeout/close callback can run after its room or host was evicted.
    // Never let that stale callback mutate a replacement state object.
    if (rooms.get(room.id) !== room || room.hosts.get(host.hostId) !== host) return;
    const pending = host.pending.get(relayRequestId);
    if (!pending || (expectedTimer !== undefined && pending.timer !== expectedTimer) ||
        (expectedHostConnectionId !== undefined && pending.hostConnectionId !== expectedHostConnectionId)) return;
    clearTimeout(pending.timer);
    host.pending.delete(relayRequestId);
    if (host.pendingByKey.get(pending.dedupeKey) === relayRequestId) host.pendingByKey.delete(pending.dedupeKey);
    const historyProjectionStale = pending.historyKind !== null && pending.historyRevision !== host.historyRevision;
    const historyResultInvalid = pending.historyKind !== null && result.status === "applied" && (() => {
      const data = result.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) return true;
      const record = data as Record<string, unknown>;
      return pending.historyKind === "list"
        ? record.kind !== "sessions"
        : record.kind !== "session" || record.sessionId !== pending.historySessionId;
    })();
    const effectiveResult: HostCommandResultMessage = historyProjectionStale ? {
      type: "host_command_result",
      relayRequestId,
      status: "rejected",
      code: "STALE_SESSION",
      message: "The Pi session projection changed before the history command completed",
    } : historyResultInvalid ? {
      type: "host_command_result",
      relayRequestId,
      status: "rejected",
      code: "RESULT_INVALID",
      message: "The Pi host returned an invalid history result",
    } : result;
    let clientResult: CommandResultMessage = {
      type: "command_result",
      hostId: host.hostId,
      requestId: pending.requestId,
      status: effectiveResult.status,
      code: effectiveResult.code,
      message: effectiveResult.message,
    };
    if (effectiveResult.data !== undefined) clientResult.data = effectiveResult.data;
    clientResult = fitCommandResult(clientResult);
    // A revision-fenced rejection is a notification, not a durable dedupe
    // result: the browser must be able to retry the same request ID against
    // the new projection after it resynchronizes.
    if (!historyProjectionStale) {
      // Only history commands may populate the offline history cache. A
      // malformed or buggy host result from a write command must not poison a
      // later read-only request with data that was never requested as history.
      if (pending.historyKind !== null) cacheHistoryResult(room, host, clientResult, pending.historyKind);
      rememberResult(host, pending.dedupeKey, clientResult, pending.historyKind !== null);
    }
    const client = room.clients.get(pending.peerId);
    if (client && client.connectionId === pending.clientConnectionId) safeSend(client, clientResult);
  }

  function rejectStaleHistoryCommands(room: Room, host: HostState): void {
    for (const [relayRequestId, pending] of [...host.pending]) {
      if (pending.historyKind === null) continue;
      completeCommand(room, host, relayRequestId, {
        type: "host_command_result",
        relayRequestId,
        status: "rejected",
        code: "STALE_SESSION",
        message: "The Pi session projection changed before the history command completed",
      });
    }
  }

  function findHost(room: Room, command: ClientCommandMessage): HostState | null {
    if (command.targetHostId) return room.hosts.get(command.targetHostId) ?? null;
    const streamMatches = [...room.hosts.values()].filter((host) => host.snapshot?.streamId === command.expectedStreamId);
    const exactMatches = command.expectedSessionId === undefined ? streamMatches :
      streamMatches.filter((host) => host.snapshot?.sessionId === command.expectedSessionId);
    if (exactMatches.length === 1) return exactMatches[0]!;
    // If a legacy client supplied a stale session fence, still identify the
    // unique stream owner so the caller receives STALE_SESSION instead of the
    // misleading HOST_OFFLINE response. Multiple owners remain ambiguous.
    return command.expectedSessionId !== undefined && streamMatches.length === 1 ? streamMatches[0]! : null;
  }

  function routeCommand(connection: Connection, room: Room, command: ClientCommandMessage): void {
    // Encode the tuple rather than joining with a delimiter: peer/request IDs
    // are allowed to contain colons and must not collide in the dedupe map.
    const dedupeKey = JSON.stringify([connection.peerId, command.requestId]);
    let host: HostState | null = null;
    const dedupeMatches: HostState[] = [];
    if (!command.targetHostId) {
      for (const candidate of room.hosts.values()) {
        if (candidate.results.has(dedupeKey) || candidate.pendingByKey.has(dedupeKey)) dedupeMatches.push(candidate);
      }
      // Dedupe identity is stronger than a legacy stream-only hint. Never
      // select a different host merely because it happens to match the fence.
      if (dedupeMatches.length === 1) host = dedupeMatches[0]!;
    }
    if (!host && dedupeMatches.length <= 1) host = findHost(room, command);
    if (!host) {
      const activeHostCount = [...room.hosts.values()].filter((candidate) => candidate.connection?.socket.readyState === WebSocket.OPEN).length;
      const matchingStreamHostCount = command.targetHostId ? 0 : [...room.hosts.values()].filter((candidate) =>
        candidate.snapshot?.streamId === command.expectedStreamId,
      ).length;
      const code = command.targetHostId ? "HOST_NOT_FOUND" : dedupeMatches.length > 1 || matchingStreamHostCount > 1 || activeHostCount > 1
        ? "HOST_SELECTION_REQUIRED" : "HOST_OFFLINE";
      const message = code === "HOST_SELECTION_REQUIRED"
        ? "More than one Pi host matches this command; select a host before sending a command"
        : code === "HOST_NOT_FOUND" ? "The selected Pi host is not available" : "The Pi host is not connected";
      const unavailableResult: CommandResultMessage = { type: "command_result", requestId: command.requestId, status: "rejected", code, message };
      if (command.targetHostId) unavailableResult.hostId = command.targetHostId;
      safeSend(connection, unavailableResult);
      return;
    }

    const snapshot = host.snapshot;
    const hostConnection = host.connection;
    const connected = hostConnection?.socket.readyState === WebSocket.OPEN;
    // A replacement connection must not use the retained old snapshot for
    // dedupe, cache, or fence decisions until its fresh snapshot arrives.
    if (hostConnection && (!host.ready || !snapshot)) {
      safeSend(connection, {
        type: "command_result",
        hostId: host.hostId,
        requestId: command.requestId,
        status: "rejected",
        code: "HOST_NOT_READY",
        message: "The selected Pi host is reconnecting and has not sent its current snapshot yet",
      } satisfies CommandResultMessage);
      return;
    }

    const streamStale = snapshot !== null && command.expectedStreamId !== snapshot.streamId;
    const sessionStale = snapshot !== null && command.expectedSessionId !== undefined && command.expectedSessionId !== snapshot.sessionId;
    const cwdStale = snapshot !== null && command.expectedCwd !== undefined && command.expectedCwd !== snapshot.cwd;
    if (streamStale || sessionStale || cwdStale) {
      safeSend(connection, {
        type: "command_result",
        hostId: host.hostId,
        requestId: command.requestId,
        status: "rejected",
        code: sessionStale || cwdStale ? "STALE_SESSION" : "STALE_STREAM",
        message: cwdStale ? "The selected Pi project changed; refresh and retry" : "The selected Pi session changed; refresh and retry",
      } satisfies CommandResultMessage);
      if (snapshot) {
        safeSend(connection, { type: "snapshot", hostId: host.hostId, snapshot: compactRelaySnapshot(snapshot) } satisfies SnapshotMessage);
      }
      return;
    }

    const previous = host.results.get(dedupeKey);
    if (previous) {
      // Reconstruct and re-fit cached results rather than replaying an object
      // that may contain opaque data retained from an older protocol peer.
      safeSend(connection, copyCommandResult(previous, command.requestId, previous.message));
      return;
    }
    const pendingRelayRequestId = host.pendingByKey.get(dedupeKey);
    if (pendingRelayRequestId) {
      const pending = host.pending.get(pendingRelayRequestId);
      // A browser reconnect may retry the same request ID. Move result delivery
      // to the new authenticated connection instead of leaving it attached to
      // the socket that has already gone away.
      if (pending) pending.clientConnectionId = connection.connectionId;
      const pendingResult: CommandResultMessage = {
        type: "command_result",
        hostId: host.hostId,
        requestId: command.requestId,
        status: "dispatched",
        code: "REQUEST_PENDING",
        message: "This request is already pending",
      };
      safeSend(connection, pendingResult);
      return;
    }

    const cached = cachedHistoryResult(host, command);
    if (cached && !connected) {
      // Treat a cache hit as activity too; both the history cache and its
      // retained offline host use inactivity windows rather than a fixed time
      // since creation. This keeps a deliberately read-only offline session
      // available while it is actively being inspected, without unbounding
      // state that receives no reads.
      scheduleHistoryCacheExpiry(room, host);
      scheduleOfflineHostExpiry(room, host);
      safeSend(connection, cached);
      return;
    }
    if (!hostConnection || hostConnection.socket.readyState !== WebSocket.OPEN) {
      safeSend(connection, {
        type: "command_result",
        hostId: host.hostId,
        requestId: command.requestId,
        status: "rejected",
        code: "HOST_OFFLINE",
        message: "The selected Pi host is not connected",
      } satisfies CommandResultMessage);
      return;
    }
    if (!host.ready || !snapshot) {
      safeSend(connection, {
        type: "command_result",
        hostId: host.hostId,
        requestId: command.requestId,
        status: "rejected",
        code: "HOST_NOT_READY",
        message: "The selected Pi host is reconnecting and has not sent its current snapshot yet",
      } satisfies CommandResultMessage);
      return;
    }
    if (['list_commands', 'run_command'].includes(command.payload.name) || command.payload.name === 'prompt' && command.payload.files !== undefined) {
      const code = snapshot.inputAssist !== true ? 'INPUT_ASSIST_UNAVAILABLE'
        : command.expectedSessionId === undefined || command.expectedCwd === undefined ? 'STALE_SESSION'
        : command.payload.name === 'run_command' && (snapshot.phase !== 'idle' || snapshot.hasPendingMessages) ? 'SESSION_BUSY' : null;
      if (code) {
        safeSend(connection, { type: 'command_result', hostId: host.hostId, requestId: command.requestId, status: 'rejected', code, message: code } satisfies CommandResultMessage);
        return;
      }
    }
    if (['new_session', 'rename_session', 'resume_session'].includes(command.payload.name)) {
      const code = snapshot.sessionControl !== true ? 'SESSION_CONTROL_UNAVAILABLE'
        : command.expectedSessionId === undefined || command.expectedCwd === undefined ? 'STALE_SESSION'
        : snapshot.phase !== 'idle' || snapshot.hasPendingMessages ? 'SESSION_BUSY' : null;
      if (code) {
        safeSend(connection, { type: 'command_result', hostId: host.hostId, requestId: command.requestId, status: 'rejected', code, message: code } satisfies CommandResultMessage);
        return;
      }
    }
    const clientPendingCount = [...host.pending.values()].filter((pending) => pending.peerId === connection.peerId).length;
    if (host.pending.size >= MAX_PENDING_COMMANDS_PER_HOST || clientPendingCount >= MAX_PENDING_COMMANDS_PER_CLIENT) {
      safeSend(connection, {
        type: "command_result",
        hostId: host.hostId,
        requestId: command.requestId,
        status: "rejected",
        code: "COMMAND_QUEUE_FULL",
        message: "Too many commands are already waiting for this Pi host",
      } satisfies CommandResultMessage);
      return;
    }

    const relayRequestId = randomUUID();
    const historyKind = command.payload.name === "list_sessions" ? "list" : command.payload.name === "get_session" ? "get" : null;
    const historySessionId = command.payload.name === "get_session" ? command.payload.sessionId : null;
    const pendingHistoryRevision = host.historyRevision;
    const routed: RoutedCommandMessage = {
      type: "routed_command",
      relayRequestId,
      clientRequestId: command.requestId,
      sourcePeerId: connection.peerId ?? "unknown",
      expectedStreamId: command.expectedStreamId,
      targetHostId: host.hostId,
      payload: canonicalCommandPayload(command.payload),
    };
    if (command.expectedSessionId !== undefined) routed.expectedSessionId = command.expectedSessionId;
    if (command.expectedCwd !== undefined) routed.expectedCwd = command.expectedCwd;
    if (frameSize(routed) > MAX_FRAME_BYTES) {
      safeSend(connection, {
        type: "command_result",
        hostId: host.hostId,
        requestId: command.requestId,
        status: "rejected",
        code: "COMMAND_TOO_LARGE",
        message: "The command exceeded the relay frame limit after routing",
      } satisfies CommandResultMessage);
      return;
    }
    let timer: NodeJS.Timeout;
    timer = setTimeout(() => {
      completeCommand(room, host, relayRequestId, {
        type: "host_command_result",
        relayRequestId,
        status: "rejected",
        code: "HOST_TIMEOUT",
        message: "The Pi host did not acknowledge the command",
      }, timer);
    }, COMMAND_TIMEOUT_MS);
    host.pending.set(relayRequestId, {
      roomId: room.id,
      hostId: host.hostId,
      peerId: connection.peerId ?? "unknown",
      clientConnectionId: connection.connectionId,
      hostConnectionId: hostConnection.connectionId,
      requestId: command.requestId,
      dedupeKey,
      historyRevision: pendingHistoryRevision,
      historyKind,
      historySessionId,
      timer,
    });
    host.pendingByKey.set(dedupeKey, relayRequestId);
    if (!safeSend(hostConnection, routed)) {
      completeCommand(room, host, relayRequestId, {
        type: "host_command_result",
        relayRequestId,
        status: "rejected",
        code: "HOST_OFFLINE",
        message: "The Pi host could not receive the command",
      });
    }
  }

  function handleHostMessage(connection: Connection, room: Room, message: ReturnType<typeof decodeWireMessage>): void {
    const host = connection.hostState;
    if (!host || host.connection !== connection) {
      sendError(connection, "STALE_HOST", "This host connection is no longer active");
      closeSocket(connection.socket, 1008, "Stale host connection");
      return;
    }
    if (message.type === "snapshot") {
      const nextSnapshot = compactRelaySnapshot(message.snapshot);
      const previousSnapshot = host.snapshot;
      const nextHistoryRevision = snapshotHistoryRevision(nextSnapshot);
      const historyRevisionChanged = previousSnapshot !== null && host.historyRevision !== nextHistoryRevision;
      // The retained offline projection is still authoritative for sequence
      // monotonicity, even while a replacement socket is waiting to become
      // ready. A reconnect must not silently roll the same stream backwards.
      if (previousSnapshot && previousSnapshot.streamId === nextSnapshot.streamId &&
          previousSnapshot.sessionId === nextSnapshot.sessionId && nextSnapshot.lastEventSeq < previousSnapshot.lastEventSeq) {
        sendError(connection, "STALE_SNAPSHOT", "The snapshot event sequence moved backwards");
        closeSocket(connection.socket, 1011, "Snapshot event sequence moved backwards");
        return;
      }
      const identityChanged = previousSnapshot !== null &&
        (previousSnapshot.streamId !== nextSnapshot.streamId || previousSnapshot.sessionId !== nextSnapshot.sessionId || previousSnapshot.cwd !== nextSnapshot.cwd);
      if (identityChanged) {
        const code = previousSnapshot!.streamId !== nextSnapshot.streamId ? "STALE_STREAM" : "STALE_SESSION";
        // Results and history details are scoped to the active Pi session and
        // project root. Do not let a request ID reused after /new, /resume, or
        // a project-context change receive old data.
        for (const relayRequestId of [...host.pending.keys()]) {
          completeCommand(room, host, relayRequestId, {
            type: "host_command_result",
            relayRequestId,
            status: "rejected",
            code,
            message: "The Pi session changed before the command completed",
          });
        }
        clearResults(host);
        clearHistoryCache(host);
      } else if (historyRevisionChanged) {
        // Branch navigation, compaction, or a rename can change history while
        // preserving the opaque session ID and project root. Those snapshots
        // must invalidate cached history/results too and fence in-flight reads.
        host.historyRevision = nextHistoryRevision;
        clearResults(host);
        clearHistoryCache(host);
        rejectStaleHistoryCommands(room, host);
      }
      clearOfflineHostExpiry(host);
      clearSnapshotTimeout(host);
      host.snapshot = nextSnapshot;
      host.historyRevision = nextHistoryRevision;
      host.ready = true;
      host.snapshotWarningSent = false;
      broadcastClients(room, { type: "snapshot", hostId: host.hostId, snapshot: host.snapshot } satisfies SnapshotMessage);
      broadcastClients(room, roomHostStatus(room));
      return;
    }
    if (message.type === "event") {
      // A replacement connection must establish its own snapshot before its
      // events can touch the retained projection from the previous socket.
      if (!host.snapshot || !host.ready) {
        if (!host.snapshotWarningSent) {
          sendError(connection, "SNAPSHOT_REQUIRED", "Send a snapshot before events");
          host.snapshotWarningSent = true;
        }
        return;
      }
      try {
        const previousHistoryRevision = host.historyRevision;
        host.snapshot = compactRelaySnapshot(applyEvent(host.snapshot, message));
        host.historyRevision = snapshotHistoryRevision(host.snapshot);
        // Only projection-changing events invalidate history reads. A pure
        // session-state/heartbeat update must not manufacture a durable stale
        // result for an otherwise valid pending history request.
        if (previousHistoryRevision !== host.historyRevision) {
          clearHistoryCache(host);
          clearHistoryResults(host);
          rejectStaleHistoryCommands(room, host);
        }
      } catch (error) {
        clearHistoryCache(host);
        clearResults(host);
        host.ready = false;
        host.snapshotWarningSent = false;
        sendError(connection, "EVENT_SEQUENCE", describeError(error));
        // A host that has diverged cannot repair an event stream in place;
        // force its connector to reconnect and send a fresh snapshot. Gate
        // commands immediately, before the asynchronous close callback runs.
        broadcastClients(room, roomHostStatus(room));
        closeSocket(connection.socket, 1011, "Event stream is out of sync");
        return;
      }
      const outboundEvent: EventEnvelope = {
        type: "event",
        hostId: host.hostId,
        streamId: message.streamId,
        sessionId: message.sessionId,
        seq: message.seq,
        emittedAt: message.emittedAt,
        event: canonicalEvent(message.event),
      };
      // A legacy host may fill the incoming frame with multibyte deltas. The
      // relay-added hostId can then push the event over the wire budget. Send
      // the compacted projection instead of closing every client connection.
      if (frameSize(outboundEvent) > MAX_FRAME_BYTES) {
        broadcastClients(room, { type: "snapshot", hostId: host.hostId, snapshot: host.snapshot! } satisfies SnapshotMessage);
      } else {
        broadcastClients(room, outboundEvent);
      }
      return;
    }
    if (message.type === "host_command_result") {
      completeCommand(room, host, message.relayRequestId, message, undefined, connection.connectionId);
      return;
    }
    sendError(connection, "ROLE_VIOLATION", `Host cannot send ${message.type}`);
  }

  function handleClientMessage(connection: Connection, room: Room, message: ReturnType<typeof decodeWireMessage>): void {
    if (message.type === "command") {
      routeCommand(connection, room, message);
      return;
    }
    sendError(connection, "ROLE_VIOLATION", `Client cannot send ${message.type}`);
  }

  function handleHello(connection: Connection, hello: HelloMessage): void {
    if (!isValidRoomId(hello.roomId)) {
      sendError(connection, "INVALID_ROOM", "Room ID must use letters, numbers, underscore, or hyphen");
      closeSocket(connection.socket, 1008, "Invalid room");
      return;
    }
    const expectedToken = hello.peerRole === "host" ? hostToken : clientToken;
    if (!tokenMatches(hello.token, expectedToken)) {
      sendError(connection, "UNAUTHORIZED", "Invalid credentials");
      closeSocket(connection.socket, 1008, "Unauthorized");
      return;
    }

    const existingRoom = rooms.get(hello.roomId);
    if (!existingRoom && rooms.size >= MAX_ROOMS) {
      sendError(connection, "ROOM_LIMIT", "The relay has reached its room limit");
      closeSocket(connection.socket, 1008, "Room limit reached");
      return;
    }
    const room = existingRoom ?? getRoom(hello.roomId);
    if (hello.peerRole === "client" && !room.clients.has(hello.peerId) && room.clients.size >= MAX_CLIENTS_PER_ROOM) {
      if (!existingRoom) rooms.delete(room.id);
      sendError(connection, "CLIENT_LIMIT", "This room has reached its browser client limit");
      closeSocket(connection.socket, 1008, "Client limit reached");
      return;
    }
    clearTimeout(connection.handshakeTimer);
    connection.role = hello.peerRole;
    connection.peerId = hello.peerId;
    connection.roomId = hello.roomId;
    if (hello.peerRole === "host") {
      let host = room.hosts.get(hello.peerId);
      const sameHostReconnect = host !== undefined;
      if (!host) {
        const hostCountBeforeEviction = room.hosts.size;
        evictOfflineHostsForCapacity(room);
        if (room.hosts.size < hostCountBeforeEviction) broadcastClients(room, roomHostStatus(room));
        if (room.hosts.size >= MAX_HOSTS_PER_ROOM) {
          sendError(connection, "HOST_LIMIT", "This room has reached its Pi host limit");
          closeSocket(connection.socket, 1008, "Host limit reached");
          return;
        }
        host = createHostState(hello.peerId);
        room.hosts.set(hello.peerId, host);
      }
      if (host.connection && host.connection !== connection) {
        for (const relayRequestId of [...host.pending.keys()]) {
          completeCommand(room, host, relayRequestId, {
            type: "host_command_result",
            relayRequestId,
            status: "rejected",
            code: "HOST_REPLACED",
            message: "The Pi host connection was replaced before acknowledging the command",
          });
        }
        // Do not replay results produced by the replaced connection to a new
        // connection that happens to reuse a request ID.
        clearResults(host);
        const previousConnection = host.connection;
        host.connection = null;
        closeSocket(previousConnection.socket, 1000, "Replaced by host reconnect");
      }
      clearOfflineHostExpiry(host);
      clearSnapshotTimeout(host);
      // A new socket must establish a fresh snapshot before any retained
      // projection or result can be trusted. Do not replay a result produced
      // on the prior connection (even if the new process reports the same
      // session ID); otherwise a reused request ID could receive stale data or
      // incorrectly suppress a command that needs to be routed again.
      clearHistoryCache(host);
      clearResults(host);
      host.connection = connection;
      host.ready = false;
      scheduleSnapshotTimeout(room, host, connection);
      host.snapshotWarningSent = false;
      connection.hostState = host;
      // A reconnect from the same Pi runtime keeps its retained projection for
      // sequence fencing, but history caches are rebuilt after its fresh
      // snapshot. A new peer gets an independent state even when it uses the
      // same room.
      if (!sameHostReconnect) {
        host.snapshot = null;
        clearHistoryCache(host);
      }
    } else {
      const previous = room.clients.get(hello.peerId);
      if (previous && previous !== connection) closeSocket(previous.socket, 1000, "Replaced by reconnect");
      room.clients.set(hello.peerId, connection);
    }

    const welcome: WelcomeMessage = {
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      connectionId: connection.connectionId,
      peerRole: hello.peerRole,
      roomId: room.id,
      hostConnected: [...room.hosts.values()].some((host) => host.connection?.socket.readyState === WebSocket.OPEN),
    };
    safeSend(connection, welcome);

    if (hello.peerRole === "host") {
      broadcastClients(room, roomHostStatus(room));
    } else {
      safeSend(connection, roomHostStatus(room));
      for (const host of room.hosts.values()) {
        // Do not expose a stale snapshot while a replacement connection is still synchronizing.
        if (host.snapshot && (!host.connection || host.ready)) {
          safeSend(connection, { type: "snapshot", hostId: host.hostId, snapshot: host.snapshot } satisfies SnapshotMessage);
        }
      }
    }
  }

  function handleSocketMessage(connection: Connection, data: RawData, isBinary: boolean): void {
    if (closing || connection.socket.readyState !== WebSocket.OPEN) return;
    if (isBinary) {
      sendError(connection, "BINARY_UNSUPPORTED", "Only JSON text frames are supported");
      closeSocket(connection.socket, 1003, "Binary frames are not supported");
      return;
    }
    let message: ReturnType<typeof decodeWireMessage>;
    try {
      message = decodeWireMessage(rawDataToString(data));
    } catch (error) {
      const text = describeError(error);
      sendError(connection, "INVALID_MESSAGE", text);
      closeSocket(connection.socket, 1008, connection.role ? "Invalid relay message" : "Invalid hello message");
      return;
    }

    if (!connection.role) {
      if (message.type !== "hello") {
        sendError(connection, "HELLO_REQUIRED", "The first message must be hello");
        closeSocket(connection.socket, 1008, "Hello required");
        return;
      }
      handleHello(connection, message);
      return;
    }

    if (!connection.roomId) return;
    const room = rooms.get(connection.roomId);
    if (!room) return;
    if (connection.role === "host" && (!connection.hostState || connection.hostState.connection !== connection || !connection.peerId || room.hosts.get(connection.peerId) !== connection.hostState)) {
      sendError(connection, "STALE_HOST", "This host connection is no longer active");
      closeSocket(connection.socket, 1008, "Stale host connection");
      return;
    }
    if (connection.role === "client" && connection.peerId && room.clients.get(connection.peerId) !== connection) {
      sendError(connection, "STALE_CLIENT", "This client connection is no longer active");
      closeSocket(connection.socket, 1008, "Stale client connection");
      return;
    }
    if (connection.role === "host") handleHostMessage(connection, room, message);
    else handleClientMessage(connection, room, message);
  }

  const staticFiles = new Map<string, string>([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/app.js", "app.js"],
    ["/styles.css", "styles.css"],
    ["/manifest.webmanifest", "manifest.webmanifest"],
    ["/icon.svg", "icon.svg"],
  ]);

  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Set security and cache headers before any early error path as well as
    // successful static/API responses. Error pages must not be cached as a
    // stale representation of the relay's current policy.
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    if (closing) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
      response.end("Relay is shutting down");
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Bad request");
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      // Consume a rejected request body so a keep-alive connection cannot hold
      // unread attacker-controlled bytes after the 405 response.
      try { request.resume(); } catch {}
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const endBody = (body?: string | Buffer): void => {
      response.end(request.method === "HEAD" ? undefined : body);
    };
    if (url.pathname === "/healthz") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      endBody(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION }));
      return;
    }
    if (url.pathname === "/api/config") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      endBody(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, wsPath: "/ws", defaultRoom: "main" }));
      return;
    }

    const relativePath = staticFiles.get(url.pathname);
    if (!relativePath) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      endBody("Not found");
      return;
    }
    try {
      const assetPath = resolve(webRoot, relativePath);
      const linkInfo = await lstat(assetPath);
      if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new Error("Static asset is not a regular file");
      // Do not serve a package asset through a symlink/junction or another
      // canonical-path indirection. The path is fixed by staticFiles, but the
      // configured web root and local filesystem remain untrusted inputs.
      const canonicalRoot = await realpath(webRoot);
      const canonicalAssetPath = await realpath(assetPath);
      const expectedCanonicalPath = resolve(canonicalRoot, relativePath);
      const samePath = process.platform === "win32"
        ? canonicalAssetPath.toLowerCase() === expectedCanonicalPath.toLowerCase()
        : canonicalAssetPath === expectedCanonicalPath;
      if (!samePath) throw new Error("Static asset path indirection is not allowed");
      const fileHandle = await open(assetPath, STATIC_OPEN_FLAGS);
      let body: Buffer;
      try {
        const info = await fileHandle.stat();
        if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_STATIC_FILE_BYTES) {
          throw new Error("Static asset is unavailable or too large");
        }
        body = Buffer.alloc(info.size);
        let bytesRead = 0;
        while (bytesRead < body.length) {
          const result = await fileHandle.read(body, bytesRead, body.length - bytesRead, bytesRead);
          if (result.bytesRead <= 0) break;
          bytesRead += result.bytesRead;
        }
        body = body.subarray(0, bytesRead);
      } finally {
        try { await fileHandle.close(); } catch {}
      }
      response.writeHead(200, {
        "Content-Type": contentType(relativePath),
        "Cache-Control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      endBody("Web client is not installed");
    }
  }

  const httpServer: Server = createServer((request, response) => {
    void handleHttp(request, response).catch((error) => {
      logError("HTTP request failed", error);
      try {
        if (!response.headersSent && !response.destroyed) response.writeHead(500, { "Cache-Control": "no-store" });
        if (!response.writableEnded && !response.destroyed) response.end();
      } catch {
        // The client may have disconnected between the failed handler and the
        // fallback response. There is no socket left to repair in that case.
      }
    });
  });
  httpServer.maxConnections = MAX_CONNECTIONS;
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 30_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.on("error", (error) => {
    logError(`HTTP server error: ${describeError(error)}`);
    // An error after a successful bind can leave an HTTP listener in a
    // partially usable state. Tear down the whole relay rather than retaining
    // authenticated sockets against a broken listener; startup errors are
    // handled by listen()'s own rejection path below.
    if (listenStarted && !closing) {
      void cleanupFailedListen().catch((cleanupError) => logError("HTTP listener cleanup failed", cleanupError));
    }
  });
  httpServer.on("clientError", (_error, socket) => {
    try { socket.destroy(); } catch {}
  });
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  webSocketServer.on("error", (error) => logWarn(`WebSocket server error: ${describeError(error)}`));

  function rejectUpgrade(socket: Duplex, response: string): void {
    try { socket.write(response); } catch {}
    try { socket.destroy(); } catch {}
  }

  httpServer.on("upgrade", (request, socket, head) => {
    if (closing) {
      rejectUpgrade(socket, "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    } catch {
      rejectUpgrade(socket, "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    if (url.pathname !== "/ws" || !isAllowedOrigin(request, allowedOrigins)) {
      rejectUpgrade(socket, "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    try {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    } catch (error) {
      logWarn(`WebSocket upgrade failed: ${describeError(error)}`);
      try { socket.destroy(); } catch {}
    }
  });

  webSocketServer.on("connection", (socket, request) => {
    if (closing) {
      closeSocket(socket, 1001, "Server shutting down");
      return;
    }
    const remoteAddress = request.socket.remoteAddress ?? "unknown";
    const unauthenticatedConnections = [...connections].filter((connection) => connection.role === null).length;
    const unauthenticatedFromAddress = [...connections].filter((connection) =>
      connection.role === null && connection.remoteAddress === remoteAddress,
    ).length;
    if (connections.size >= MAX_CONNECTIONS ||
        unauthenticatedConnections >= MAX_UNAUTHENTICATED_CONNECTIONS ||
        unauthenticatedFromAddress >= MAX_UNAUTHENTICATED_PER_ADDRESS) {
      closeSocket(socket, 1013, "Relay connection capacity reached");
      return;
    }
    const connection: Connection = {
      socket,
      connectionId: randomUUID(),
      role: null,
      peerId: null,
      roomId: null,
      alive: true,
      remoteAddress,
      hostState: null,
      handshakeTimer: setTimeout(() => closeSocket(socket, 1008, "Handshake timeout"), HANDSHAKE_TIMEOUT_MS),
    };
    connections.add(connection);
    socket.on("pong", () => { connection.alive = true; });
    socket.on("message", (data, isBinary) => {
      try {
        handleSocketMessage(connection, data, isBinary);
      } catch (error) {
        logError(`WebSocket message handling failed: ${describeError(error)}`);
        sendError(connection, "INTERNAL_ERROR", "The relay could not process this message");
        closeSocket(socket, 1011, "Internal relay error");
      }
    });
    socket.on("close", () => removeConnection(connection));
    socket.on("error", (error) => logWarn(`WebSocket ${connection.connectionId} error: ${describeError(error)}`));
  });

  // Do not allocate a repeating timer for a RelayServer object that is never
  // listened to. This keeps validation/factory failures and abandoned server
  // objects from retaining process resources indefinitely.
  let heartbeat: NodeJS.Timeout | null = null;
  function startHeartbeat(): void {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
      for (const connection of connections) {
        if (connection.socket.readyState !== WebSocket.OPEN) continue;
        if (!connection.alive) {
          try { connection.socket.terminate(); } catch {}
          continue;
        }
        connection.alive = false;
        try { connection.socket.ping(); } catch {}
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
  }
  function stopHeartbeat(): void {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = null;
  }

  function cleanupFailedListen(): Promise<void> {
    if (failedListenCleanupPromise) return failedListenCleanupPromise;
    failedListenCleanupPromise = (async () => {
      stopHeartbeat();
      closing = true;
      for (const room of rooms.values()) for (const host of room.hosts.values()) {
        clearHistoryCache(host);
        clearOfflineHostExpiry(host);
        clearSnapshotTimeout(host);
        for (const pending of host.pending.values()) clearTimeout(pending.timer);
        host.pending.clear();
        host.pendingByKey.clear();
      }
      for (const connection of connections) {
        clearTimeout(connection.handshakeTimer);
        try { connection.socket.terminate(); } catch {}
      }
      try { httpServer.closeAllConnections(); } catch {}
      if (httpServer.listening) {
        await new Promise<void>((resolveClose) => {
          try { httpServer.close(() => resolveClose()); } catch { resolveClose(); }
        });
      }
      rooms.clear();
      connections.clear();
    })();
    return failedListenCleanupPromise;
  }

  return {
    async listen(): Promise<RunningRelayServer> {
      if (closing) throw new Error("Relay is closed");
      if (listenStarted) throw new Error("Relay is already listening");
      if (listenInProgress) throw new Error("Relay listen is already in progress");
      listenInProgress = true;
      try {
        let listenErrorHandler: ((error: Error) => void) | null = null;
        try {
        await new Promise<void>((resolveListen, reject) => {
          listenErrorHandler = (error: Error): void => {
            if (listenErrorHandler) httpServer.off("error", listenErrorHandler);
            reject(error);
          };
          httpServer.on("error", listenErrorHandler);
          startHeartbeat();
          httpServer.listen(options.port, bindHost, () => {
            // Mark the listener active before resolving the startup promise so
            // an error emitted in the callback/logging window takes the same
            // full cleanup path as any later listener failure.
            listenStarted = true;
            if (listenErrorHandler) httpServer.off("error", listenErrorHandler);
            listenErrorHandler = null;
            resolveListen();
          });
        });
      } catch (error) {
        // The heartbeat is created before listen() so one server object can
        // still be cleaned up safely after a bind failure. Do not leave an
        // active timer, listener, or half-open socket set behind a rejected
        // startup promise.
        if (listenErrorHandler) httpServer.off("error", listenErrorHandler);
        await cleanupFailedListen();
        throw error;
      }
      const rawAddress = httpServer.address();
      if (!rawAddress || typeof rawAddress === "string") {
        await cleanupFailedListen();
        throw new Error("Relay did not expose a TCP listener address");
      }
      const address = rawAddress as AddressInfo;
      const displayHost = address.address === "::" || address.address === "0.0.0.0" ? "127.0.0.1" : address.address;
      const urlHost = displayHost.includes(":") && !displayHost.startsWith("[") ? `[${displayHost}]` : displayHost;
      const url = `http://${urlHost}:${address.port}`;
      const wildcardBinding = address.address === "::" || address.address === "0.0.0.0";
      logInfo(wildcardBinding
        ? `Pi Cafe Space relay listening on ${url} (wildcard bind; use this computer's LAN address for other devices)`
        : `Pi Cafe Space relay listening on ${url}`);
        return {
        url,
        close(): Promise<void> {
          if (closePromise) return closePromise;
          closing = true;
          stopHeartbeat();
          for (const connection of connections) clearTimeout(connection.handshakeTimer);
          for (const room of rooms.values()) for (const host of room.hosts.values()) {
            clearHistoryCache(host);
            clearOfflineHostExpiry(host);
            clearSnapshotTimeout(host);
            for (const pending of host.pending.values()) clearTimeout(pending.timer);
            host.pending.clear();
            host.pendingByKey.clear();
          }
          for (const connection of connections) closeSocket(connection.socket, 1001, "Server shutting down");
          try { httpServer.closeIdleConnections(); } catch {}
          try { httpServer.closeAllConnections(); } catch {}
          const forceCloseTimer = setTimeout(() => {
            for (const connection of connections) {
              if (connection.socket.readyState !== WebSocket.CLOSED) {
                try { connection.socket.terminate(); } catch {}
              }
            }
            try { httpServer.closeAllConnections(); } catch {}
          }, 2_000);
          forceCloseTimer.unref();
          closePromise = (async () => {
            try {
              try {
                await new Promise<void>((resolveClose, rejectClose) => {
                  try {
                    webSocketServer.close((error?: Error) => error ? rejectClose(error) : resolveClose());
                  } catch (error) {
                    rejectClose(error);
                  }
                });
              } catch (error) {
                logWarn(`WebSocket relay shutdown failed: ${describeError(error)}`);
              }
              if (httpServer.listening) {
                try {
                  await new Promise<void>((resolveClose, rejectClose) => {
                    try {
                      httpServer.close((error) => error ? rejectClose(error) : resolveClose());
                    } catch (error) {
                      rejectClose(error);
                    }
                  });
                } catch (error) {
                  logWarn(`HTTP relay shutdown failed: ${describeError(error)}`);
                }
              }
            } finally {
              clearTimeout(forceCloseTimer);
              rooms.clear();
              connections.clear();
            }
          })();
          return closePromise;
        },
      };
      } catch (error) {
        // Binding can succeed before a later startup step (for example a
        // logger callback) throws. Reuse the same idempotent cleanup path so
        // a rejected listen never leaves a live HTTP server behind.
        await cleanupFailedListen();
        throw error;
      } finally {
        listenInProgress = false;
      }
    },
  };
}
