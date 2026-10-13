import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  MAX_EVENT_SEQUENCE,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  applyEvent,
  canonicalCommandPayload,
  canonicalEvent,
  compactTranscriptMessage,
  decodeWireMessage,
  isCommandPayload,
  fitCommandResult,
  hasSufficientTokenEntropy,
  isThinkingLevel,
  type CollabEvent,
  type EventEnvelope,
  type HostCommandResultMessage,
  type JsonValue,
  type RoutedCommandMessage,
  type SessionSnapshot,
  type ToolExecution,
  type TranscriptMessage,
  type TranscriptPart,
} from "../protocol/index.js";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute as isAbsolutePath, relative as relativePath, resolve as resolvePath, sep as pathSeparator } from "node:path";
import { lstat as lstatPath, realpath as realpathPath } from "node:fs/promises";
import WebSocket, { type RawData } from "ws";
import { FileCommandError, listProjectDirectory, readProjectFile, attachProjectFiles } from "./file-commands.js";
import { ConnectionWarningReporter } from "./connection-warning.js";
import { registerCafe } from "./cafe.js";
import { thinkingCapability, applyThinkingLevel } from './thinking-capability.js';
import { ExecutionTracker } from './execution-tracker.js';
import { canonicalExecution, isPromptKind } from '../protocol/execution.js';
import { ensureLocalRelay } from "./local-relay.js";
import { localCredentialFile, readLocalHostToken } from "./local-relay.js";

const DEVELOPMENT_HOST_TOKEN = "local-dev-host-token";
const DEVELOPMENT_CLIENT_TOKEN = "local-dev-client-token";
const DEVELOPMENT_TOKENS = new Set([DEVELOPMENT_HOST_TOKEN, DEVELOPMENT_CLIENT_TOKEN]);
function isDevelopmentToken(value: string): boolean { return DEVELOPMENT_TOKENS.has(value.toLowerCase()); }
const PLACEHOLDER_TOKEN_PATTERN = /^replace-with-(?:(?:a-long-random-)?(?:host|client)|a-long-random|random)-token$/i;
const ROOM_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
function isValidRoomId(value: string): boolean { return value === value.trim() && ROOM_ID_PATTERN.test(value); }
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MAX_RETRY_DELAY_MS = 10_000;
const MAX_RELAY_URL_LENGTH = 8_192;
const MAX_COMMAND_RESULTS = 1_000;
const MAX_COMMAND_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_LOCAL_COMMANDS = 128;
// Keep one slot available for the priority abort path without allowing a
// flood of unique abort IDs to grow activeCommands beyond its bound.
const MAX_LOCAL_NON_ABORT_COMMANDS = MAX_LOCAL_COMMANDS - 1;
const MAX_CONTENT_PARTS = 500;
const MAX_HISTORY_ENTRIES = 10_000;
// SessionManager.open() loads the selected JSONL synchronously. Refuse an
// unexpectedly large file before invoking it so a remote history request
// cannot force an unbounded local parse/allocation.
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_IDS = 2_000;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_TEXT_LENGTH = 32_000;
const MAX_SNAPSHOT_TOOLS = 24;
const MAX_RETAINED_TOOLS = 100;
const SNAPSHOT_FRAME_BUDGET = MAX_FRAME_BYTES - 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function rawDataToString(data: RawData): string {
  const rawData: unknown = data;
  if (typeof rawData === "string") {
    if (rawData.length > MAX_FRAME_BYTES || Buffer.byteLength(rawData, "utf8") > MAX_FRAME_BYTES) throw new Error("Relay message exceeds the frame limit");
    return rawData;
  }
  let buffer: Buffer;
  if (Buffer.isBuffer(rawData)) {
    if (rawData.byteLength > MAX_FRAME_BYTES) throw new Error("Relay message exceeds the frame limit");
    buffer = rawData;
  } else if (Array.isArray(rawData)) {
    let byteLength = 0;
    for (const part of rawData) {
      if (!Buffer.isBuffer(part) || !Number.isSafeInteger(part.byteLength) || part.byteLength < 0) throw new Error("Relay message is not valid binary data");
      byteLength += part.byteLength;
      if (!Number.isSafeInteger(byteLength) || byteLength > MAX_FRAME_BYTES) throw new Error("Relay message exceeds the frame limit");
    }
    buffer = Buffer.concat(rawData as Buffer[]);
  } else {
    const candidate = rawData as { byteLength?: unknown };
    const byteLength = typeof candidate?.byteLength === "number" ? candidate.byteLength : Number.NaN;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_FRAME_BYTES) throw new Error("Relay message exceeds the frame limit");
    try { buffer = Buffer.from(rawData as ArrayBuffer); }
    catch { throw new Error("Relay message is not valid binary data"); }
    if (buffer.byteLength > MAX_FRAME_BYTES) throw new Error("Relay message exceeds the frame limit");
  }
  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    throw new Error("Relay message is not valid UTF-8");
  }
}

const forceCloseTimers = new WeakMap<WebSocket, NodeJS.Timeout>();

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
    else socket.terminate();
  } catch {
    try { socket.terminate(); } catch {}
  }
  // Do not let a peer that ignores the close handshake keep an old extension
  // socket (and its listeners) alive forever. One backstop per socket is
  // sufficient and avoids accumulating timers across repeated errors.
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
      // The timer remains a bounded fallback for a damaged/test socket.
    }
  }
}

// Stable across extension reloads in one Pi process, but different across
// concurrently running Pi processes. The private env handoff also survives a
// module reload that creates a fresh module scope.
const processGlobal = globalThis as typeof globalThis & { __piCafeSpaceProcessInstanceId?: string };
const rawConfiguredProcessInstanceId = process.env.PI_COLLAB_RUNTIME_INSTANCE_ID;
const configuredProcessInstanceId = rawConfiguredProcessInstanceId !== undefined && rawConfiguredProcessInstanceId.length <= 36
  ? rawConfiguredProcessInstanceId.trim() : undefined;
const retainedProcessInstanceId = typeof processGlobal.__piCafeSpaceProcessInstanceId === "string" &&
  processGlobal.__piCafeSpaceProcessInstanceId.length <= 36 ? processGlobal.__piCafeSpaceProcessInstanceId.trim() : undefined;
const PROCESS_INSTANCE_ID = configuredProcessInstanceId || retainedProcessInstanceId || randomUUID();
processGlobal.__piCafeSpaceProcessInstanceId = PROCESS_INSTANCE_ID;
if (process.env.PI_COLLAB_RUNTIME_INSTANCE_ID !== PROCESS_INSTANCE_ID) process.env.PI_COLLAB_RUNTIME_INSTANCE_ID = PROCESS_INSTANCE_ID;

type UnknownRecord = Record<string, unknown>;

interface HostConfig {
  credentialsFile: string | null;
  relayUrl: string;
  roomId: string;
  token: string;
  peerId: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandErrorMessage(error: unknown): string {
  try {
    return error instanceof FileCommandError && typeof error.message === "string"
      ? truncate(error.message, 2_048)
      : "The Pi extension could not complete this command";
  } catch {
    return "The Pi extension could not complete this command";
  }
}

function describeError(error: unknown): string {
  try {
    const text = error instanceof Error && typeof error.message === "string" ? error.message : String(error);
    return safePrefix(text, 2_048);
  } catch {
    return "Unknown error";
  }
}

function safePrefix(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let end = Math.max(0, maxLength);
  if (end < value.length && end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return value.slice(0, end);
}

function truncate(value: string, max = MAX_TEXT_LENGTH): string {
  if (value.length <= max) return value;
  const marker = "\n… [truncated]";
  return max <= marker.length ? safePrefix(value, max) : `${safePrefix(value, max - marker.length)}${marker}`;
}

function sameProjectPath(left: string, right: string): boolean {
  try {
    const normalizedLeft = resolvePath(left).replace(/[\\/]+$/, "");
    const normalizedRight = resolvePath(right).replace(/[\\/]+$/, "");
    return process.platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  } catch {
    return false;
  }
}

function currentSessionDirectory(ctx: ExtensionContext): string {
  let sessionDir: unknown;
  try {
    sessionDir = ctx.sessionManager.getSessionDir();
  } catch {
    throw new FileCommandError("SESSION_INVALID", "The requested session metadata is invalid");
  }
  if (typeof sessionDir !== "string" || !sessionDir) {
    throw new FileCommandError("SESSION_INVALID", "The requested session metadata is invalid");
  }
  return sessionDir;
}

async function validateSessionPath(ctx: ExtensionContext, sessionPath: string): Promise<void> {
  const [directory, candidate, linkInfo] = await Promise.all([
    realpathPath(currentSessionDirectory(ctx)),
    realpathPath(sessionPath),
    lstatPath(sessionPath),
  ]).catch(() => {
    throw new FileCommandError("SESSION_INVALID", "The requested session metadata is invalid");
  });
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink() || !Number.isSafeInteger(linkInfo.size) || linkInfo.size > MAX_SESSION_FILE_BYTES) {
    throw new FileCommandError("SESSION_INVALID", "The requested session metadata is invalid");
  }
  const outside = relativePath(directory, candidate);
  if (!outside || outside === ".." || outside.startsWith(`..${pathSeparator}`) || isAbsolutePath(outside)) {
    throw new FileCommandError("SESSION_INVALID", "The requested session metadata is invalid");
  }
}

function boundedIdentifier(value: string, max: number): string {
  if (value.length <= max) return value;
  const suffix = `-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
  return `${safePrefix(value, max - suffix.length)}${suffix}`;
}

interface BoundedText {
  value: string;
  truncated: boolean;
}

function boundedContentText(content: unknown, thinking: boolean): BoundedText {
  if (!thinking && typeof content === "string") {
    return { value: truncate(content), truncated: content.length > MAX_TEXT_LENGTH };
  }
  if (!Array.isArray(content)) return { value: "", truncated: false };
  const chunks: string[] = [];
  let length = 0;
  let wasTruncated = false;
  let partCount = 0;
  for (const part of content) {
    if (++partCount > MAX_CONTENT_PARTS) {
      wasTruncated = true;
      break;
    }
    if (!isRecord(part)) {
      wasTruncated = true;
      continue;
    }
    let piece = "";
    if (thinking) {
      if (part.type === "thinking") {
        if (typeof part.thinking !== "string") wasTruncated = true;
        else piece = part.thinking;
      } else if (part.type === "image") {
        // Image bytes are omitted from the thinking projection. They are also
        // omitted from visible text rather than replaced with a placeholder.
        wasTruncated = true;
      } else if (part.type !== "text" && part.type !== "toolCall") {
        wasTruncated = true;
      }
    } else if (part.type === "text") {
      if (typeof part.text !== "string") wasTruncated = true;
      else piece = part.text;
    } else if (part.type === "image") {
      // A text-only projection cannot preserve image bytes. Omit them and mark
      // the snapshot truncated instead of injecting a fake "[image]" caption.
      wasTruncated = true;
    } else if (part.type === "toolCall") {
      // Tool calls are rendered from the structured tool projection inside the
      // conversation. Do not duplicate them as synthetic assistant text.
    } else if (part.type !== "thinking") {
      wasTruncated = true;
    }
    if (!piece) continue;
    const separator = chunks.length ? "\n" : "";
    const remaining = MAX_TEXT_LENGTH - length - separator.length;
    if (remaining <= 0) {
      wasTruncated = true;
      break;
    }
    const boundedPiece = piece.length > remaining ? safePrefix(piece, remaining) : piece;
    chunks.push(separator + boundedPiece);
    length += separator.length + boundedPiece.length;
    if (boundedPiece.length < piece.length) {
      wasTruncated = true;
      break;
    }
  }
  return { value: chunks.join(""), truncated: wasTruncated };
}

function messageProjectionWasTruncated(message: unknown): boolean {
  if (!isRecord(message)) return true;
  const content = message.content;
  if (typeof content !== "string" && !Array.isArray(content)) return true;
  const text = boundedContentText(content, false);
  const thinking = boundedContentText(content, true);
  let contentWasDropped = false;
  if (Array.isArray(content)) {
    if (content.length > MAX_CONTENT_PARTS) contentWasDropped = true;
    const visibleParts = Math.min(content.length, MAX_CONTENT_PARTS);
    for (let partIndex = 0; partIndex < visibleParts; partIndex++) {
      const part = content[partIndex];
      if (!isRecord(part)) {
        contentWasDropped = true;
        continue;
      }
      switch (part.type) {
        case "text":
          if (typeof part.text !== "string") contentWasDropped = true;
          break;
        case "thinking":
          if (typeof part.thinking !== "string") contentWasDropped = true;
          break;
        case "image":
          // Images are omitted from the text-only projection, so even a valid
          // image means source content was dropped. Validate known fields
          // before marking that omission so malformed provider objects cannot
          // look complete.
          contentWasDropped = true;
          if (typeof part.data !== "string" || typeof part.mimeType !== "string" ||
              !part.data || !part.mimeType || part.data.length > 4 * 1024 * 1024 || part.mimeType.length > 128) {
            contentWasDropped = true;
          }
          break;
        case "toolCall":
          // Assistant parts now retain actual call identity/arguments. Other
          // roles still cannot represent a tool call in the text projection.
          if (message.role !== "assistant") contentWasDropped = true;
          if (typeof part.id !== "string" || typeof part.name !== "string" || !part.id || !part.name ||
              part.name.length > 256 || part.id.length > 256 ||
              !isRecord(part.arguments)) contentWasDropped = true;
          break;
        default:
          // Unknown future content cannot be rendered faithfully by this
          // projection; expose the omission through historyTruncated.
          contentWasDropped = true;
          break;
      }
    }
  }
  return text.truncated || thinking.truncated || contentWasDropped ||
    typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp) ||
    (message.toolName !== undefined && typeof message.toolName !== "string") ||
    (message.toolCallId !== undefined && typeof message.toolCallId !== "string") ||
    (message.role === "toolResult" && (typeof message.toolName !== "string" || !message.toolName ||
      typeof message.toolCallId !== "string" || !message.toolCallId)) ||
    (typeof message.toolName === "string" && message.toolName.length > 256) ||
    (typeof message.toolCallId === "string" && message.toolCallId.length > 256);
}

function safeJsonWithStatus(value: unknown, max = 32_000): BoundedText {
  const seen = new WeakSet<object>();
  let wasTruncated = false;
  let nodes = 0;
  let projectedChars = 0;
  const bound = (current: unknown, depth: number): unknown => {
    if (++nodes > 2_000) {
      wasTruncated = true;
      return "[nodes limited]";
    }
    if (depth > 6) {
      wasTruncated = true;
      return "[depth limited]";
    }
    if (typeof current === "bigint") {
      wasTruncated = true;
      return `${current}n`;
    }
    if (typeof current === "string") {
      const bounded = truncate(current, 4_096);
      wasTruncated ||= bounded.length !== current.length;
      projectedChars += bounded.length;
      if (projectedChars > 256 * 1024) {
        wasTruncated = true;
        return "[text limited]";
      }
      return bounded;
    }
    if (current === null) return current;
    if (typeof current === "number" && !Number.isFinite(current)) {
      wasTruncated = true;
      return "[non-finite number]";
    }
    if (current === undefined || typeof current === "function" || typeof current === "symbol") {
      wasTruncated = true;
      return `[${typeof current}]`;
    }
    if (typeof current !== "object") return current;
    if (seen.has(current)) {
      wasTruncated = true;
      return "[Circular]";
    }
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        const bounded: unknown[] = [];
        const visibleLength = Math.min(current.length, 100);
        for (let index = 0; index < visibleLength; index++) {
          if (!(index in current)) wasTruncated = true;
          bounded.push(bound(current[index], depth + 1));
        }
        if (current.length > 100) {
          bounded.push("[items truncated]");
          wasTruncated = true;
        }
        return bounded;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        wasTruncated = true;
        return "[object omitted]";
      }
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const record = current as Record<string, unknown>;
      const keys = Object.keys(record);
      if (Object.getOwnPropertySymbols(record).length > 0) wasTruncated = true;
      for (const key of keys.slice(0, 100)) {
        const boundedKey = truncate(key, 256);
        wasTruncated ||= boundedKey.length !== key.length;
        projectedChars += boundedKey.length;
        if (projectedChars > 256 * 1024) {
          wasTruncated = true;
          break;
        }
        output[boundedKey] = bound(record[key], depth + 1);
      }
      if (keys.length > 100 || projectedChars > 256 * 1024) {
        output["…"] = "[properties truncated]";
        wasTruncated = true;
      }
      return output;
    } catch {
      wasTruncated = true;
      return "[unserializable]";
    }
  };
  try {
    const encoded = JSON.stringify(bound(value, 0));
    const source = encoded ?? "[unserializable]";
    const bounded = truncate(source, max);
    wasTruncated ||= bounded.length !== source.length;
    return { value: bounded, truncated: wasTruncated };
  } catch {
    return { value: "[unserializable]", truncated: true };
  }
}

function modelRef(model: unknown): SessionSnapshot["model"] {
  if (!isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string" || !model.provider || !model.id) return null;
  return { provider: boundedIdentifier(model.provider, 128), id: boundedIdentifier(model.id, 256), ...thinkingCapability(model) };
}

function roleForMessage(role: unknown): TranscriptMessage["role"] | null {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "toolResult") return "tool";
  return null;
}

function projectParts(content: unknown[]): Pick<TranscriptMessage, "parts" | "partsTruncated"> {
  const parts: TranscriptPart[] = [];
  let incomplete = content.length > MAX_CONTENT_PARTS;
  let bytes = 2;
  for (let index = 0; index < Math.min(content.length, MAX_CONTENT_PARTS); index++) {
    const source = content[index];
    if (!isRecord(source)) { incomplete = true; continue; }
    let part: TranscriptPart;
    if (source.type === "text" || source.type === "thinking") {
      const raw = source.type === "text" ? source.text : source.thinking;
      if (typeof raw !== "string") { incomplete = true; continue; }
      const text = truncate(raw, 65_536);
      incomplete ||= text !== raw;
      part = { index, type: source.type, text };
    } else if (source.type === "toolCall") {
      if (typeof source.id !== "string" || !source.id || source.id.length > 256 ||
          typeof source.name !== "string" || !source.name || source.name.length > 256) {
        incomplete = true; continue;
      }
      const args = safeJsonWithStatus(source.arguments, 4_096);
      incomplete ||= args.truncated || !isRecord(source.arguments);
      part = { index, type: "tool-call", toolCallId: source.id, toolName: source.name, argsText: args.value };
    } else { incomplete = true; continue; }
    bytes += Buffer.byteLength(JSON.stringify(part), "utf8") + 1;
    if (bytes > SNAPSHOT_FRAME_BUDGET - 1_024) return { partsTruncated: true };
    parts.push(part);
  }
  return { parts, ...(incomplete ? { partsTruncated: true } : {}) };
}

// Rebuilt only from the bounded retained projection. Duplicate occurrences,
// including two within one message, are deliberately ambiguous. One host owns
// this index; stream/session/cwd transitions replace rather than merge it.
export function buildToolParentIndex(messages: readonly TranscriptMessage[]): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  for (const message of messages.slice(-100)) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts?.slice(0, MAX_CONTENT_PARTS) ?? []) {
      if (part.type !== "tool-call") continue;
      parents.set(part.toolCallId, parents.has(part.toolCallId) ? null : message.id);
    }
  }
  return parents;
}

export function messageProjection(message: unknown, id: string, status: TranscriptMessage["status"]): TranscriptMessage | null {
  if (!isRecord(message)) return null;
  const role = roleForMessage(message.role);
  if (!role) return null;
  const content = message.content;
  if ((role === "assistant" || role === "tool") && !Array.isArray(content)) return null;
  if (role === "user" && typeof content !== "string" && !Array.isArray(content)) return null;
  let toolCallRecord: UnknownRecord | undefined;
  if (Array.isArray(content)) {
    const visibleParts = Math.min(content.length, MAX_CONTENT_PARTS);
    for (let index = 0; index < visibleParts; index++) {
      const part = content[index];
      if (isRecord(part) && part.type === "toolCall") {
        toolCallRecord = part;
        break;
      }
    }
  }
  const timestamp = typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : Date.now();
  const projectedText = boundedContentText(content, false);
  const projectedThinking = boundedContentText(content, true);
  return {
    id: id ? boundedIdentifier(id, 128) : `m-${randomUUID()}`,
    role,
    text: projectedText.value,
    thinking: projectedThinking.value,
    timestamp,
    status: (role === "tool" && message.isError === true) || (role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) ? "error" : status,
    ...(role === "assistant" ? projectParts(content as unknown[]) : {}),
    ...(role === "tool" && typeof message.isError === "boolean" ? { toolIsError: message.isError } : {}),
    ...((role === "tool" && (typeof message.isError !== "boolean" || typeof message.toolCallId !== "string" || !message.toolCallId || message.toolCallId.length > 256)) || projectedText.truncated || projectedThinking.truncated ? { partsTruncated: true } : {}),
    toolName: typeof message.toolName === "string" && message.toolName
      ? truncate(message.toolName, 256)
      : typeof toolCallRecord?.name === "string" && toolCallRecord.name ? truncate(toolCallRecord.name, 256) : null,
    toolCallId: typeof message.toolCallId === "string" && message.toolCallId
      ? message.toolCallId.length <= 256 ? message.toolCallId : null
      : typeof toolCallRecord?.id === "string" && toolCallRecord.id && toolCallRecord.id.length <= 256 ? toolCallRecord.id : null,
  };
}

export function historicalMessages(entries: readonly unknown[], maxMessages = 100): { messages: TranscriptMessage[]; truncated: boolean } {
  if (!Array.isArray(entries)) return { messages: [], truncated: true };
  const messages: TranscriptMessage[] = [];
  let messageCount = 0;
  const firstEntry = Math.max(0, entries.length - MAX_HISTORY_ENTRIES);
  // SessionManager already returns the active branch in order. Process only a
  // bounded tail so a damaged/very old session cannot make every reconnect
  // spend unbounded CPU projecting data that will never fit the snapshot.
  let omittedByCompaction = firstEntry > 0;
  for (let entryIndex = firstEntry; entryIndex < entries.length; entryIndex++) {
    try {
      const entry = entries[entryIndex];
      if (!isRecord(entry)) {
        omittedByCompaction = true;
        continue;
      }
      if (entry.type === "compaction") omittedByCompaction = true;
      if (entry.type !== "message") continue;
      const validEntryId = typeof entry.id === "string" && !!entry.id && entry.id.length <= 128;
      const entryId = validEntryId ? entry.id as string : `m-${randomUUID()}`;
      const projection = messageProjection(entry.message, entryId, "complete");
      if (!validEntryId || projection?.partsTruncated || messageProjectionWasTruncated(entry.message)) omittedByCompaction = true;
      if (!projection) {
        omittedByCompaction = true;
        continue;
      }
      messageCount++;
      messages.push(projection);
      // Keep projection memory bounded even when a session branch is very long.
      if (messages.length > maxMessages) messages.shift();
    } catch {
      // A malformed provider object must not make history unavailable. Omit
      // only the damaged projection and expose the truncation marker.
      omittedByCompaction = true;
    }
  }
  let selected = [...messages];
  let truncated = omittedByCompaction || messageCount > selected.length;
  const frameBudget = MAX_FRAME_BYTES - 16 * 1024;
  const selectedSize = (): number => Buffer.byteLength(JSON.stringify(selected), "utf8");
  if (selectedSize() > frameBudget) {
    truncated = true;
    selected = selected.map((message) => {
      const text = truncate(message.text, 8_192);
      const thinking = truncate(message.thinking, 8_192);
      truncated ||= text.length !== message.text.length || thinking.length !== message.thinking.length;
      return compactTranscriptMessage(message, text, thinking, true);
    });
  }
  while (selected.length > 1 && selectedSize() > frameBudget) {
    selected = selected.slice(1);
    truncated = true;
  }
  if (selectedSize() > frameBudget) {
    selected = selected.map((message) => compactTranscriptMessage(message, truncate(message.text, 1_024), truncate(message.thinking, 1_024), true));
    truncated = true;
  }
  while (selected.length > 1 && selectedSize() > frameBudget) {
    selected = selected.slice(1);
    truncated = true;
  }
  return { messages: selected, truncated };
}

export function transcriptMessageJson(message: TranscriptMessage): JsonValue {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    thinking: message.thinking,
    timestamp: message.timestamp,
    status: message.status,
    toolName: message.toolName,
    toolCallId: message.toolCallId,
    ...(message.parts === undefined ? {} : { parts: message.parts.map(part => ({ ...part })) }),
    ...(message.partsTruncated === undefined ? {} : { partsTruncated: message.partsTruncated }),
    ...(message.toolIsError === undefined ? {} : { toolIsError: message.toolIsError }),
  };
}

function snapshotCwd(cwd: string): string {
  // Keep the wire fence and the post-await context check on the same bounded
  // representation even on platforms that permit unusually long paths. A
  // plain prefix would let two long project roots compare equal; retain a
  // collision-resistant digest suffix so the bounded fence remains distinct.
  const maxLength = 16_384;
  if (cwd.length <= maxLength) return cwd;
  const digest = createHash("sha256").update(cwd).digest("hex");
  const marker = `\n… [cwd truncated; sha256=${digest}]`;
  return `${safePrefix(cwd, maxLength - marker.length)}${marker}`;
}

function safeIsoDate(value: unknown): string | null {
  try {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
    return value.toISOString();
  } catch {
    return null;
  }
}

function wireSessionId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256) {
    throw new FileCommandError("SESSION_INVALID", "The requested session metadata is invalid");
  }
  return value;
}

function historicalSnapshot(pi: ExtensionAPI, ctx: ExtensionContext, streamId: string, lastEventSeq: number): SessionSnapshot {
  const historical = historicalMessages(ctx.sessionManager.getBranch());
  const sessionName = pi.getSessionName();
  const activeLeafId = ctx.sessionManager.getLeafId();
  const currentThinkingLevel = pi.getThinkingLevel();
  const rawModel = ctx.model;
  const projectedModel = modelRef(rawModel);
  const idle = ctx.isIdle();
  const hasPendingMessages = ctx.hasPendingMessages();
  const projectedSessionName = typeof sessionName === "string" && sessionName ? truncate(sessionName, 256) : null;
  const projectedLeafId = typeof activeLeafId === "string" && activeLeafId ? boundedIdentifier(activeLeafId, 128) : null;
  let metadataTruncated =
    (sessionName !== undefined && typeof sessionName !== "string") ||
    (typeof sessionName === "string" && projectedSessionName !== sessionName) ||
    (activeLeafId !== null && activeLeafId !== undefined && (typeof activeLeafId !== "string" || !activeLeafId)) ||
    (typeof activeLeafId === "string" && projectedLeafId !== activeLeafId) ||
    !isThinkingLevel(currentThinkingLevel) || typeof idle !== "boolean" || typeof hasPendingMessages !== "boolean";
  if (rawModel !== null && rawModel !== undefined) {
    metadataTruncated ||= !isRecord(rawModel) || typeof rawModel.provider !== "string" || typeof rawModel.id !== "string" ||
      !rawModel.provider || !rawModel.id || projectedModel === null || projectedModel.provider !== rawModel.provider || projectedModel.id !== rawModel.id;
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    streamId,
    sessionId: wireSessionId(ctx.sessionManager.getSessionId()),
    sessionName: projectedSessionName,
    cwd: snapshotCwd(ctx.cwd),
    activeLeafId: projectedLeafId,
    model: projectedModel,
    thinkingLevel: isThinkingLevel(currentThinkingLevel) ? currentThinkingLevel : "off",
    phase: idle === true ? "idle" : "running",
    hasPendingMessages: hasPendingMessages === true,
    sessionControl: true,
    inputAssist: typeof pi.getCommands === 'function',
    messages: historical.messages,
    historyTruncated: historical.truncated || metadataTruncated,
    tools: [],
    lastEventSeq,
  };
}

function snapshotFrameSize(snapshot: SessionSnapshot): number {
  return Buffer.byteLength(JSON.stringify({ type: "snapshot", snapshot }), "utf8");
}

export function compactSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  let messageTextTruncated = false;
  let messages = (snapshot.messages.length > 100 ? snapshot.messages.slice(-100) : [...snapshot.messages]).map((message) => {
    const text = truncate(message.text, MAX_TEXT_LENGTH);
    const thinking = truncate(message.thinking, MAX_TEXT_LENGTH);
    messageTextTruncated ||= message.partsTruncated === true || text.length !== message.text.length || thinking.length !== message.thinking.length;
    return compactTranscriptMessage(message, text, thinking);
  });
  let toolTextTruncated = false;
  let tools = snapshot.tools.slice(-MAX_SNAPSHOT_TOOLS).map((tool) => {
    const argsText = truncate(tool.argsText, 4_096);
    const output = truncate(tool.output, 8_192);
    toolTextTruncated ||= argsText.length !== tool.argsText.length || output.length !== tool.output.length;
    return { toolCallId: tool.toolCallId, toolName: tool.toolName, argsText, output, status: tool.status, ...(tool.parentMessageId === undefined ? {} : { parentMessageId: tool.parentMessageId }) };
  });
  let historyTruncated = snapshot.historyTruncated === true || messages.length < snapshot.messages.length || snapshot.tools.length > MAX_SNAPSHOT_TOOLS || messageTextTruncated || toolTextTruncated;
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
    ...(snapshot.execution===undefined?{}:{execution:canonicalExecution(snapshot.execution)}),
    ...(snapshot.sessionControl === undefined ? {} : { sessionControl: snapshot.sessionControl }),
    ...(snapshot.inputAssist === undefined ? {} : { inputAssist: snapshot.inputAssist }),
    messages,
    historyTruncated,
    tools,
    lastEventSeq: snapshot.lastEventSeq,
  });

  while (messages.length > 1 && snapshotFrameSize(makeSnapshot()) > SNAPSHOT_FRAME_BUDGET) {
    messages = messages.slice(1);
    historyTruncated = true;
  }
  while (tools.length > 0 && snapshotFrameSize(makeSnapshot()) > SNAPSHOT_FRAME_BUDGET) {
    tools = tools.slice(1);
    historyTruncated = true;
  }
  if (snapshotFrameSize(makeSnapshot()) > SNAPSHOT_FRAME_BUDGET) {
    historyTruncated = true;
    messages = messages.map((message) => compactTranscriptMessage(message, truncate(message.text, 4_096), truncate(message.thinking, 4_096), true));
    tools = tools.map((tool) => ({
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      argsText: truncate(tool.argsText, 1_024),
      output: truncate(tool.output, 2_048),
      status: tool.status,
      ...(tool.parentMessageId === undefined ? {} : { parentMessageId: tool.parentMessageId }),
    }));
  }
  while (messages.length > 1 && snapshotFrameSize(makeSnapshot()) > SNAPSHOT_FRAME_BUDGET) {
    messages = messages.slice(1);
    historyTruncated = true;
  }
  while (tools.length > 0 && snapshotFrameSize(makeSnapshot()) > SNAPSHOT_FRAME_BUDGET) {
    tools = tools.slice(1);
    historyTruncated = true;
  }
  if (snapshotFrameSize(makeSnapshot()) > SNAPSHOT_FRAME_BUDGET) {
    const latest = messages.at(-1);
    messages = latest ? [compactTranscriptMessage(latest, truncate(latest.text, 1_024), truncate(latest.thinking, 1_024), true)] : [];
    tools = [];
    historyTruncated = true;
  }
  if (snapshotFrameSize(makeSnapshot()) > SNAPSHOT_FRAME_BUDGET) {
    messages = [];
    tools = [];
    historyTruncated = true;
  }
  const compacted = makeSnapshot();
  return snapshotFrameSize(compacted) <= SNAPSHOT_FRAME_BUDGET ? compacted : {
    ...makeSnapshot(),
    messages: [],
    historyTruncated: true,
    tools: [],
  };
}

function hasUrlUserInfo(value: string): boolean {
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(value.trim())?.[1];
  return authority?.includes("@") === true;
}

function hasUrlFragment(value: string): boolean {
  return value.trim().includes("#");
}

function normalizeRelayUrl(value: string): string {
  if (value.length > MAX_RELAY_URL_LENGTH) throw new Error("Relay URL is too long");
  if (hasUrlUserInfo(value) || hasUrlFragment(value)) throw new Error("Relay URL must not contain credentials or a fragment");
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error("Relay URL must not contain credentials or a fragment");
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Relay URL must use ws:// or wss://");
  if (url.search) throw new Error("Relay URL must not contain a query string");
  if (url.port === "0") throw new Error("Relay URL must use a valid TCP port");
  if (!url.pathname || url.pathname === "/") url.pathname = "/ws";
  return url.toString();
}

function isLoopbackRelay(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

function configuration(pi: ExtensionAPI): HostConfig {
  const flagRelay = pi.getFlag("collab-relay");
  const flagRoom = pi.getFlag("collab-room");
  if (typeof flagRelay === "string" && flagRelay.length > MAX_RELAY_URL_LENGTH) throw new Error("Relay URL is too long");
  if (typeof flagRoom === "string" && flagRoom.length > 64) throw new Error("PI_COLLAB_ROOM is too long");
  const rawConfiguredRelay = process.env.PI_COLLAB_RELAY_URL;
  if (rawConfiguredRelay !== undefined && rawConfiguredRelay.length > MAX_RELAY_URL_LENGTH) throw new Error("Relay URL is too long");
  const configuredRelay = rawConfiguredRelay?.trim();
  const relayUrl = normalizeRelayUrl(
    typeof flagRelay === "string" && flagRelay.trim() ? flagRelay.trim() : configuredRelay || "ws://127.0.0.1:37891/ws",
  );
  const rawConfiguredToken = process.env.PI_COLLAB_HOST_TOKEN;
  if (rawConfiguredToken !== undefined && rawConfiguredToken.length > 4_096) throw new Error("PI_COLLAB_HOST_TOKEN is too long");
  const configuredToken = rawConfiguredToken?.trim();
  const token = configuredToken || (isLoopbackRelay(relayUrl) ? DEVELOPMENT_HOST_TOKEN : "");
  if (!token) throw new Error("PI_COLLAB_HOST_TOKEN is required for a non-loopback relay");
  if (token.length > 4_096) throw new Error("PI_COLLAB_HOST_TOKEN is too long");
  if (!isLoopbackRelay(relayUrl) && (isDevelopmentToken(token) || PLACEHOLDER_TOKEN_PATTERN.test(token) || !hasSufficientTokenEntropy(token))) {
    throw new Error("Explicit high-entropy PI_COLLAB_HOST_TOKEN (at least 16 characters) is required outside loopback mode");
  }
  const configuredRoom = process.env.PI_COLLAB_ROOM;
  const roomId = typeof flagRoom === "string" ? flagRoom : configuredRoom ?? "main";
  if (roomId.length > 64 || !isValidRoomId(roomId)) throw new Error("PI_COLLAB_ROOM must use letters, numbers, underscore, or hyphen");
  const rawConfiguredPeerId = process.env.PI_COLLAB_PEER_ID;
  if (rawConfiguredPeerId !== undefined && rawConfiguredPeerId.length > 128) throw new Error("PI_COLLAB_PEER_ID is too long");
  const configuredPeerId = rawConfiguredPeerId?.trim();
  const peerId = configuredPeerId || `pi-host-${process.pid}-${PROCESS_INSTANCE_ID}-${roomId}`;
  if (peerId.length > 128) throw new Error("PI_COLLAB_PEER_ID is too long");
  return { relayUrl, roomId, token, peerId, credentialsFile: !configuredToken || configuredToken === DEVELOPMENT_HOST_TOKEN ? localCredentialFile(relayUrl) : null };
}

class PiCollabHost {
  private socket: WebSocket | null = null;
  private stopped = false;
  private welcomed = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay = 500;
  private readonly connectionWarningReporter = new ConnectionWarningReporter(
    (message) => this.notify("warning", `Café Space: connection unavailable; retrying automatically. /cafe status · ${message}`),
    () => this.notify("info", "Café Space: connection is stable again."),
  );
  private commandTail: Promise<void> = Promise.resolve();
  private readonly execution = new ExecutionTracker(randomUUID);
  private nativeIdleTimer: NodeJS.Timeout | null = null;
  private clearNativeIdleTimer(): void { if(this.nativeIdleTimer)clearTimeout(this.nativeIdleTimer);this.nativeIdleTimer=null; }
  private currentContext: ExtensionContext;
  private snapshot: SessionSnapshot;
  private sequence = 0;
  private activeAssistantId: string | null = null;
  private snapshotReady = false;
  private setupPending = false;
  private setupNotified = false;
  private messageIds = new Map<string, string>();
  private messageObjectIds = new WeakMap<object, string>();
  private tools = new Map<string, ToolExecution>();
  private commandResults = new Map<string, HostCommandResultMessage>();
  private commandResultBytes = 0;
  private activeCommands = new Set<string>();
  private sessionCommand: { command: RoutedCommandMessage; token: string; started: boolean; reason?: 'new' | 'resume'; resolve: () => void; timer: NodeJS.Timeout } | null = null;
  /** Set whenever a source event or projection had to discard visible data. */
  private projectionTruncated = false;

  constructor(private readonly pi: ExtensionAPI, ctx: ExtensionContext, private readonly config: HostConfig) {
    this.currentContext = ctx;
    this.snapshot = historicalSnapshot(pi, ctx, randomUUID(), 0);
    this.execution.reset(this.snapshot.phase==='idle');
    this.snapshot.execution=this.execution.snapshot();
    this.projectionTruncated = this.snapshot.historyTruncated;
  }

  private adoptContext(ctx: ExtensionContext): boolean {
    try {
      // ExtensionRunner invalidates every getter on contexts from the old
      // lifecycle. Probe both the project root and session manager before
      // allowing a late callback to replace the context used by commands or
      // status notifications.
      void ctx.cwd;
      void ctx.sessionManager.getSessionId();
    } catch {
      return false;
    }
    this.currentContext = ctx;
    return true;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(reason?: string): void {
    // Pi accepts the switch only after its cancellable before-switch hooks.
    // Acknowledge handoff before shutdown closes this old host connection;
    // the replacement extension owns the new snapshot, not this old context.
    if (this.sessionCommand) {
      const accepted = this.sessionCommand.started && this.sessionCommand.reason === reason;
      this.finishSessionCommand(accepted ? 'dispatched' : 'rejected', accepted ? null : 'HOST_REPLACED', accepted ? 'Pi accepted the session switch; waiting for its new snapshot' : 'Pi lifecycle interrupted the command');
    }
    this.stopped = true;
    this.clearNativeIdleTimer();
    this.welcomed = false;
    this.snapshotReady = false;
    // Stopping is an explicit new lifecycle. A normal close/error path must
    // not reset this throttle, or every failed exponential-backoff retry could
    // emit another warning immediately.
    this.connectionWarningReporter.onExplicitStop();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) closeSocket(socket, 1000, "Pi Cafe Space stopped");
    this.setStatus("disconnected", true);
  }

  status(): string {
    if (this.stopped) return "disabled";
    if (this.welcomed) return `connected (${this.config.roomId})`;
    if (this.setupPending) return 'setup required';
    if (this.socket) return "connecting";
    return "reconnecting";
  }

  private setStatus(value: string, force = false): void {
    if (this.stopped && !force) return;
    try {
      if (this.currentContext.hasUI) this.currentContext.ui.setStatus("pi-collab", `café space: ${value}${this.currentContext.mode === 'tui' ? ' · /cafe 分享' : ''}`);
    } catch {
      // Pi may invalidate an extension context during shutdown/reload.
    }
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    if (this.config.credentialsFile) {
      try {
        const token = readLocalHostToken(this.config.credentialsFile, this.config.relayUrl);
        if (token) { this.config.token = token; this.setupPending = false; }
        else if (this.setupPending) { this.setStatus('setup required'); this.scheduleReconnect(); return; }
      } catch {
        this.setStatus('configuration error');
        this.reportConnectionWarning('Café Space credentials are invalid or not private; no fallback connection was attempted.');
        this.scheduleReconnect(); return;
      }
    }
    this.setStatus("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.config.relayUrl, { maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
    } catch (error) {
      this.reportConnectionWarning(`relay connection could not be created: ${describeError(error)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.once("open", () => {
      if (this.socket !== socket || this.stopped) {
        closeSocket(socket, 1000, "Stale Pi Cafe Space socket");
        return;
      }
      this.welcomed = false;
      try {
        socket.send(JSON.stringify({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          peerRole: "host",
          peerId: this.config.peerId,
          roomId: this.config.roomId,
          token: this.config.token,
        }));
      } catch {
        closeSocket(socket, 1011, "Unable to send Pi Cafe Space hello");
        return;
      }
      this.setStatus("authenticating");
    });
    socket.once('unexpected-response', (_request, response) => {
      if (this.socket !== socket || this.stopped) { response.destroy(); return; }
      this.socket = null; this.welcomed = false; this.snapshotReady = false;
      this.setupPending = response.statusCode === 423 && this.config.credentialsFile !== null;
      response.destroy(); socket.terminate();
      if (this.setupPending) {
        this.connectionWarningReporter.onExplicitStop();
        this.setStatus('setup required');
        if (!this.setupNotified) {
          this.setupNotified = true;
          const page = new URL(this.config.relayUrl); page.protocol = 'http:'; page.pathname = '/';
          this.notify('info', this.currentContext.mode === 'tui' ? '首次使用 Café Space：输入 /cafe，选择「打开首次设置网页」。保存后会自动连接。' : `首次使用 Café Space：请打开 ${page.href} 设置访问令牌。保存后会自动连接。`);
        }
      } else { this.setStatus('reconnecting'); this.reportConnectionWarning('relay connection: HTTP handshake rejected'); }
      this.scheduleReconnect();
    });
    socket.on("message", (data, isBinary) => {
      if (this.socket !== socket || this.stopped) return;
      if (isBinary) {
        this.notify("error", "relay sent an unsupported binary frame");
        closeSocket(socket, 1003, "Binary frames are not supported");
        return;
      }
      try {
        const message = decodeWireMessage(rawDataToString(data));
        this.handleRelayMessage(message as unknown as Record<string, unknown>);
      } catch (error) {
        this.notify("error", `relay message error: ${describeError(error)}`);
        if (this.socket === socket) closeSocket(socket, 1008, "Invalid relay message");
      }
    });
    socket.on("error", (error) => {
      if (this.socket === socket) {
        this.reportConnectionWarning(`relay connection: ${describeError(error)}`);
        // Enter the retry state without depending on ws to emit a later close.
        // The close listener is fenced by socket identity and will ignore this
        // retired transport if it eventually fires.
        this.socket = null;
        this.welcomed = false;
        this.snapshotReady = false;
        closeSocket(socket, 1011, "Relay connection error");
        this.setStatus("reconnecting");
        this.scheduleReconnect();
      }
    });
    socket.once("close", (code) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.welcomed = false;
      this.snapshotReady = false;
      if (!this.stopped) {
        // Some transports report only a close (without an error event). Treat
        // that as the same failure episode; the throttle suppresses a duplicate
        // warning when ws emitted both error and close.
        this.reportConnectionWarning(`relay connection closed (${code})`);
      }
      this.setStatus(this.stopped ? "disconnected" : "reconnecting");
      this.scheduleReconnect();
    });
  }

  private reportConnectionWarning(message: string): void {
    this.connectionWarningReporter.reportTransient(message);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(MAX_RETRY_DELAY_MS, this.retryDelay * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref();
  }

  private handleRelayMessage(message: Record<string, unknown>): void {
    if (this.stopped) return;
    if (message.type === "welcome") {
      if (message.protocolVersion !== PROTOCOL_VERSION || message.peerRole !== "host" ||
          message.roomId !== this.config.roomId || typeof message.connectionId !== "string" ||
          !message.connectionId || typeof message.hostConnected !== "boolean") {
        this.notify("error", "relay returned an invalid host handshake");
        if (this.socket) closeSocket(this.socket, 1008, "Invalid relay handshake");
        return;
      }
      this.welcomed = true;
      this.retryDelay = 500;
      // Socket status updates immediately; only notifications wait for a
      // stable recovery. A welcome must not clear the warning cooldown.
      this.connectionWarningReporter.onAuthenticatedWelcome();
      this.setStatus("connected");
      this.snapshotReady = this.sendSnapshot();
      if (!this.snapshotReady && this.socket) closeSocket(this.socket, 1011, "Unable to send Pi Cafe Space snapshot");
      return;
    }
    if (message.type === "routed_command") {
      if (!isRecord(message.payload) || typeof message.relayRequestId !== "string" || !message.relayRequestId || message.relayRequestId.length > 128 ||
        typeof message.expectedStreamId !== "string" || !message.expectedStreamId || message.expectedStreamId.length > 128 ||
        typeof message.clientRequestId !== "string" || !message.clientRequestId || message.clientRequestId.length > 128 ||
        typeof message.sourcePeerId !== "string" || !message.sourcePeerId || message.sourcePeerId.length > 128 ||
        (message.expectedSessionId !== undefined && (typeof message.expectedSessionId !== "string" || !message.expectedSessionId || message.expectedSessionId.length > 256)) ||
        (message.expectedCwd !== undefined && (typeof message.expectedCwd !== "string" || !message.expectedCwd || message.expectedCwd.length > 16_384)) ||
        (message.targetHostId !== undefined && (typeof message.targetHostId !== "string" || !message.targetHostId || message.targetHostId.length > 128 || message.targetHostId !== this.config.peerId))) return;
      let payload: RoutedCommandMessage["payload"];
      try {
        if (!isCommandPayload(message.payload)) return;
        payload = canonicalCommandPayload(message.payload);
      } catch {
        return;
      }
      const command = { ...message, payload } as unknown as RoutedCommandMessage;
      const previous = this.commandResults.get(command.relayRequestId);
      if (previous) {
        this.send(previous);
        return;
      }
      if (this.activeCommands.has(command.relayRequestId)) return;
      // The relay bounds its own pending map, but a slow Extension API call can
      // outlive the relay timeout. Bound the extension-side serial queue too,
      // otherwise timed-out requests could accumulate indefinitely in a Pi
      // process. Abort remains a priority path below.
      const commandLimit = command.payload.name === "abort" ? MAX_LOCAL_COMMANDS : MAX_LOCAL_NON_ABORT_COMMANDS;
      if (this.activeCommands.size >= commandLimit) {
        this.sendCommandResult(command.relayRequestId, "rejected", "COMMAND_QUEUE_FULL", "Too many Pi commands are already waiting");
        return;
      }
      this.activeCommands.add(command.relayRequestId);
      const runCommand = async (): Promise<void> => {
        try {
          await this.executeCommand(command);
        } catch (error: unknown) {
          try {
            this.sendCommandResult(command.relayRequestId, "rejected", "COMMAND_ERROR", commandErrorMessage(error));
          } catch {
            // A closing socket or invalidated lifecycle must not poison the
            // command queue with an unhandled rejection.
          }
        } finally {
          this.activeCommands.delete(command.relayRequestId);
        }
      };
      // Abort must remain responsive even if a queued history/model command is
      // waiting on a slow filesystem or provider operation.
      if (command.payload.name === "abort") void runCommand();
      else this.commandTail = this.commandTail.then(runCommand, runCommand);
      return;
    }
    if (message.type === "error" && typeof message.message === "string") {
      // Relay protocol errors commonly precede a forced close (for example an
      // invalid token). Route them through the same warning episode as socket
      // failures so reconnect retries cannot turn one outage into a warning
      // storm.
      this.reportConnectionWarning(`relay: ${message.message}`);
    }
  }

  private send(message: object): boolean {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    let encoded: string;
    try {
      const serialized = JSON.stringify(message);
      if (typeof serialized !== "string") throw new Error("Message is not serializable");
      encoded = serialized;
    } catch (error) {
      this.notify("error", `Pi Cafe Space message is not serializable: ${describeError(error)}`);
      return false;
    }
    if (Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES) {
      this.notify("error", "Pi Cafe Space message exceeds relay frame limit");
      return false;
    }
    if (socket.bufferedAmount + Buffer.byteLength(encoded, "utf8") > MAX_BUFFERED_BYTES) {
      if (this.socket === socket) closeSocket(socket, 1013, "Pi Cafe Space relay is too slow");
      return false;
    }
    try {
      socket.send(encoded);
      return true;
    } catch {
      if (this.socket === socket) closeSocket(socket, 1011, "Unable to send Pi Cafe Space message");
      return false;
    }
  }

  private markProjectionTruncated(): void {
    this.projectionTruncated = true;
    this.snapshot.historyTruncated = true;
  }

  /** Recover from a malformed Pi event without allowing it to escape the hook. */
  recoverFromCallbackFailure(): void {
    if (this.stopped) return;
    this.activeAssistantId = null;
    try { this.execution.uncertain(this.currentContext.isIdle()); } catch { this.execution.reset(); }
    this.markProjectionTruncated();
    this.refreshSnapshot();
  }

  private sendSnapshot(): boolean {
    if (this.projectionTruncated) this.snapshot.historyTruncated = true;
    this.snapshot = compactSnapshot(this.snapshot);
    this.projectionTruncated ||= this.snapshot.historyTruncated;
    const sent = this.send({ type: "snapshot", snapshot: this.snapshot });
    if (!sent && this.welcomed && this.socket) closeSocket(this.socket, 1011, "Unable to send Pi Cafe Space snapshot");
    return sent;
  }

  private notify(level: "info" | "warning" | "error", message: string): void {
    if (this.stopped) return;
    let boundedMessage: string;
    try {
      boundedMessage = truncate(typeof message === "string" ? message : String(message), 2_048);
    } catch {
      boundedMessage = "Pi Cafe Space notification unavailable";
    }
    try {
      if (this.currentContext.hasUI) this.currentContext.ui.notify(boundedMessage, level === "warning" ? "warning" : level);
    } catch {
      // Pi may invalidate an extension context during shutdown/reload.
    }
  }

  private resultBytes(result: HostCommandResultMessage): number {
    try { return Buffer.byteLength(JSON.stringify(result), "utf8"); } catch { return MAX_COMMAND_RESULT_BYTES; }
  }

  private rememberCommandResult(result: HostCommandResultMessage): void {
    const previous = this.commandResults.get(result.relayRequestId);
    if (previous) this.commandResultBytes -= this.resultBytes(previous);
    this.commandResults.set(result.relayRequestId, result);
    this.commandResultBytes += this.resultBytes(result);
    while (this.commandResults.size > MAX_COMMAND_RESULTS || this.commandResultBytes > MAX_COMMAND_RESULT_BYTES) {
      const first = this.commandResults.keys().next().value as string | undefined;
      if (!first) break;
      const firstResult = this.commandResults.get(first);
      if (firstResult) this.commandResultBytes -= this.resultBytes(firstResult);
      this.commandResults.delete(first);
    }
  }

  private sendCommandResult(
    relayRequestId: string,
    status: HostCommandResultMessage["status"],
    code: string | null,
    message: string | null,
    data?: JsonValue,
  ): void {
    if (this.stopped) return;
    let result: HostCommandResultMessage = { type: "host_command_result", relayRequestId, status, code, message };
    if (data !== undefined) result.data = data;
    result = fitCommandResult(result);
    this.rememberCommandResult(result);
    this.send(result);
  }

  private async listSessions(ctx: ExtensionContext): Promise<JsonValue> {
    const sessions = await SessionManager.list(ctx.cwd, currentSessionDirectory(ctx));
    if (!Array.isArray(sessions)) {
      throw new FileCommandError("SESSION_INVALID", "The requested session metadata is invalid");
    }
    const currentSessionId = wireSessionId(ctx.sessionManager.getSessionId());
    const projected = [] as Array<{
      sessionId: string;
      name: string | null;
      cwd: string | null;
      created: string;
      modified: string;
      messageCount: number;
      firstMessage: string;
    }>;
    let omitted = sessions.length > 100;
    // SessionManager returns this list newest-first. Project only the bounded
    // visible prefix and discard malformed metadata rather than allowing one
    // damaged JSONL entry to abort the whole history response.
    for (const session of sessions.slice(0, 100)) {
      try {
        if (typeof session.id !== "string" || !session.id || session.id.length > 256) {
          omitted = true;
          continue;
        }
        const created = safeIsoDate(session.created);
        const modified = safeIsoDate(session.modified);
        if (!created || !modified) {
          omitted = true;
          continue;
        }
        const name = typeof session.name === "string" && session.name ? truncate(session.name, 256) : null;
        if (session.name !== undefined && typeof session.name !== "string") omitted = true;
        const sessionCwd = session.cwd;
        if (typeof sessionCwd !== "string" || (sessionCwd && !sameProjectPath(sessionCwd, ctx.cwd))) {
          omitted = true;
          continue;
        }
        const cwd = truncate(sessionCwd || ctx.cwd, 1_024);
        const firstMessage = typeof session.firstMessage === "string" ? truncate(session.firstMessage, 500) : "";
        if (session.firstMessage !== undefined && typeof session.firstMessage !== "string") omitted = true;
        const messageCount = Number.isSafeInteger(session.messageCount) && session.messageCount >= 0 ? session.messageCount : 0;
        if (name !== (typeof session.name === "string" && session.name ? session.name : null) ||
            cwd !== (sessionCwd || ctx.cwd) ||
            (typeof session.firstMessage === "string" && firstMessage !== session.firstMessage) ||
            messageCount !== session.messageCount) omitted = true;
        projected.push({
          sessionId: session.id,
          name,
          cwd,
          created,
          modified,
          messageCount,
          firstMessage,
        });
      } catch {
        // Session metadata is local input. Skip one damaged entry rather than
        // making the complete bounded history list unavailable.
        omitted = true;
      }
    }
    let visible = projected;
    const frameBudget = MAX_FRAME_BYTES - 16 * 1024;
    const makeData = () => ({
      kind: "sessions" as const,
      currentSessionId,
      sessions: visible,
      historyTruncated: omitted,
    });
    const size = () => Buffer.byteLength(JSON.stringify(makeData()), "utf8");
    if (size() > frameBudget) {
      visible = visible.map((session) => ({
        ...session,
        name: session.name ? truncate(session.name, 64) : null,
        cwd: session.cwd ? truncate(session.cwd, 256) : null,
        firstMessage: truncate(session.firstMessage, 160),
      }));
      omitted = true;
    }
    while (visible.length > 1 && size() > frameBudget) {
      visible = visible.slice(0, -1);
      omitted = true;
    }
    if (size() > frameBudget) {
      visible = [];
      omitted = true;
    }
    return makeData();
  }

  private async resolveHistoricalSession(ctx: ExtensionContext, sessionId: string) {
    let sessions: Awaited<ReturnType<typeof SessionManager.list>>;
    try {
      sessions = await SessionManager.list(ctx.cwd, currentSessionDirectory(ctx));
    } catch {
      throw new FileCommandError("SESSION_INVALID", "The requested session metadata is invalid");
    }
    // Do not scan an unbounded session index for a remote request. The public
    // history surface is intentionally capped at MAX_HISTORY_ENTRIES.
    let info: (typeof sessions)[number] | undefined;
    try {
      info = sessions.slice(0, MAX_HISTORY_ENTRIES).find((session) => session.id === sessionId);
    } catch {
      throw new FileCommandError("SESSION_INVALID", "The requested session metadata is invalid");
    }
    if (!info) throw new FileCommandError("SESSION_NOT_FOUND", "The requested session was not found in this project");
    let infoId: unknown;
    let infoPath: unknown;
    try {
      infoId = info.id;
      infoPath = info.path;
    } catch {
      throw new FileCommandError("SESSION_INVALID", "The requested session metadata is invalid");
    }
    if (typeof infoId !== "string" || !infoId || infoId.length > 256 || infoId !== sessionId ||
        typeof infoPath !== "string" || !infoPath || infoPath.length > 32_768) {
      throw new FileCommandError("SESSION_INVALID", "The requested session metadata is invalid");
    }
    let manager: SessionManager;
    try {
      await validateSessionPath(ctx, infoPath);
      const infoCwd = info.cwd;
      if (typeof infoCwd !== "string" || (infoCwd && !sameProjectPath(infoCwd, ctx.cwd))) {
        throw new Error("Session project mismatch");
      }
      manager = SessionManager.open(infoPath);
      // The opaque ID selected by the client must identify the file that was
      // actually opened. A damaged/stale session index must not cause a
      // response from a different session to be labelled with the requested ID.
      if (manager.getSessionId() !== sessionId) {
        throw new Error("Session ID mismatch");
      }
      const openedCwd = manager.getCwd();
      if (typeof openedCwd !== "string" ||
          (openedCwd && !sameProjectPath(openedCwd, ctx.cwd)) ||
          (infoCwd && openedCwd && !sameProjectPath(openedCwd, infoCwd))) {
        throw new Error("Opened session project mismatch");
      }
    } catch {
      throw new FileCommandError("SESSION_INVALID", "The requested session metadata is invalid");
    }
    return { info, manager, infoId, path: infoPath };
  }

  private async getHistoricalSession(ctx: ExtensionContext, sessionId: string): Promise<JsonValue> {
    const { info, manager, infoId } = await this.resolveHistoricalSession(ctx, sessionId);
    let entries: readonly unknown[];
    try {
      const branch = manager.getBranch();
      if (!Array.isArray(branch)) throw new Error("Session branch is invalid");
      entries = branch;
    } catch {
      throw new FileCommandError("SESSION_INVALID", "The requested session metadata is invalid");
    }
    let model: SessionSnapshot["model"] = null;
    let thinkingLevel: SessionSnapshot["thinkingLevel"] = "off";
    let metadataTruncated = false;
    const firstEntry = Math.max(0, entries.length - MAX_HISTORY_ENTRIES);
    for (let entryIndex = firstEntry; entryIndex < entries.length; entryIndex++) {
      try {
        const entry = entries[entryIndex];
        if (!isRecord(entry)) {
          metadataTruncated = true;
          continue;
        }
        if (entry.type === "model_change") {
          if (typeof entry.provider !== "string" || typeof entry.modelId !== "string" ||
              !entry.provider || !entry.modelId || entry.provider.length > 128 || entry.modelId.length > 256) {
            metadataTruncated = true;
          } else {
            const entryModel = modelRef({ provider: entry.provider, id: entry.modelId });
            if (entryModel) model = entryModel;
            else metadataTruncated = true;
          }
        }
        if (entry.type === "thinking_level_change") {
          if (entry.thinkingLevel === "off" || entry.thinkingLevel === "minimal" || entry.thinkingLevel === "low" ||
              entry.thinkingLevel === "medium" || entry.thinkingLevel === "high" || entry.thinkingLevel === "xhigh" || entry.thinkingLevel === "max") {
            thinkingLevel = entry.thinkingLevel;
          } else {
            metadataTruncated = true;
          }
        }
      } catch {
        metadataTruncated = true;
      }
    }
    const historical = historicalMessages(entries);
    let historicalLeafId: unknown;
    try {
      historicalLeafId = manager.getLeafId();
    } catch {
      throw new FileCommandError("SESSION_INVALID", "The requested session metadata is invalid");
    }
    let modifiedValue: unknown;
    let nameValue: unknown;
    let cwdValue: unknown;
    try {
      modifiedValue = info.modified;
      nameValue = info.name;
      cwdValue = info.cwd;
    } catch {
      throw new FileCommandError("SESSION_INVALID", "The requested session metadata is invalid");
    }
    const modified = safeIsoDate(modifiedValue);
    if (!modified) throw new FileCommandError("SESSION_INVALID", "The requested session metadata is invalid");
    if (nameValue !== undefined && typeof nameValue !== "string") metadataTruncated = true;
    if (cwdValue !== undefined && typeof cwdValue !== "string") metadataTruncated = true;
    const name = typeof nameValue === "string" && nameValue ? truncate(nameValue, 256) : null;
    const cwd = typeof cwdValue === "string" ? truncate(cwdValue || ctx.cwd, 1_024) : snapshotCwd(ctx.cwd);
    metadataTruncated ||= (typeof nameValue === "string" && name !== nameValue) ||
      (typeof cwdValue === "string" && cwd !== (cwdValue || ctx.cwd));
    if (historicalLeafId !== null && (typeof historicalLeafId !== "string" || !historicalLeafId)) metadataTruncated = true;
    return {
      kind: "session",
      sessionId: infoId,
      name,
      cwd,
      activeLeafId: typeof historicalLeafId === "string" && historicalLeafId ? boundedIdentifier(historicalLeafId, 128) : null,
      model: model ? { provider: model.provider, id: model.id } : null,
      thinkingLevel,
      messages: historical.messages.map(transcriptMessageJson),
      historyTruncated: historical.truncated || metadataTruncated,
      modified,
    };
  }

  private commandStaleCode(command: RoutedCommandMessage): "STALE_STREAM" | "STALE_SESSION" | null {
    if (command.expectedStreamId !== this.snapshot.streamId) return "STALE_STREAM";
    if (command.expectedSessionId !== undefined && command.expectedSessionId !== this.snapshot.sessionId) return "STALE_SESSION";
    if (command.expectedCwd !== undefined && command.expectedCwd !== this.snapshot.cwd) return "STALE_SESSION";
    return null;
  }

  private commandContextChanged(ctx: ExtensionContext, sessionId: string, cwd: string): boolean {
    // The runner creates a fresh context wrapper for each event. Compare the
    // guarded values rather than object identity; stale wrappers throw once
    // their lifecycle has been replaced.
    try {
      return snapshotCwd(ctx.cwd) !== cwd || ctx.sessionManager.getSessionId() !== sessionId;
    } catch {
      return true;
    }
  }

  private rejectIfCommandStale(command: RoutedCommandMessage, ctx?: ExtensionContext, sessionId?: string, cwd?: string): boolean {
    const code = this.commandStaleCode(command);
    const contextChanged = ctx !== undefined && sessionId !== undefined && cwd !== undefined && this.commandContextChanged(ctx, sessionId, cwd);
    if (!code && !contextChanged) return false;
    this.sendCommandResult(command.relayRequestId, "rejected", code ?? "STALE_SESSION", contextChanged ? "The active Pi context changed" : "The active Pi session changed");
    return true;
  }

  private finishSessionCommand(status: 'applied' | 'dispatched' | 'rejected', code: string | null, message: string | null): void {
    const pending = this.sessionCommand;
    if (!pending) return;
    this.sessionCommand = null;
    clearTimeout(pending.timer);
    if (!this.stopped) this.sendCommandResult(pending.command.relayRequestId, status, code, message);
    pending.resolve();
  }

  // Only this single-use in-memory token can enter the native command context.
  // Neither a session path nor user-supplied text is expanded as a Pi command.
  async runSessionCommand(token: string, ctx: ExtensionCommandContext): Promise<void> {
    const pending = this.sessionCommand;
    if (!pending || pending.token !== token || pending.started || this.stopped) return;
    pending.started = true;
    clearTimeout(pending.timer);
    const { command } = pending;
    const sessionId = command.expectedSessionId!;
    const cwd = command.expectedCwd!;
    const check = () => {
      if (this.stopped || this.commandStaleCode(command) || this.commandContextChanged(ctx, sessionId, cwd)) throw new FileCommandError('STALE_SESSION', 'The active Pi session changed');
      if (!ctx.isIdle() || ctx.hasPendingMessages() || this.snapshot.phase !== 'idle') throw new FileCommandError('SESSION_BUSY', 'Wait for Pi to finish before changing sessions');
    };
    try {
      check();
      const payload = command.payload;
      let result: { cancelled: boolean };
      if (payload.name === 'resume_session') {
        if (payload.sessionId === sessionId) {
          this.finishSessionCommand('applied', null, null);
          return;
        }
        const target = await this.resolveHistoricalSession(ctx, payload.sessionId);
        if (!target.manager.getCwd() || !sameProjectPath(target.manager.getCwd(), cwd)) throw new FileCommandError('SESSION_INVALID', 'The session must belong to the current project');
        check();
        pending.reason = 'resume';
        result = await ctx.switchSession(target.path);
      } else if (payload.name === 'new_session') {
        pending.reason = 'new';
        result = await ctx.newSession();
      } else {
        throw new FileCommandError('INVALID_COMMAND', 'Unsupported session command');
      }
      // Successful replacement invalidates ctx/pi and starts a new extension.
      // Never read either here. The shutdown hook already acknowledged handoff.
      if (result.cancelled) this.finishSessionCommand('rejected', 'SESSION_CANCELLED', 'Pi cancelled the session switch');
      else if (this.sessionCommand === pending) this.finishSessionCommand('dispatched', null, 'Pi accepted the session switch');
    } catch (error) {
      this.finishSessionCommand('rejected', error instanceof FileCommandError ? error.code : 'COMMAND_ERROR', commandErrorMessage(error));
    }
  }

  private dispatchSessionCommand(command: RoutedCommandMessage): Promise<void> {
    return new Promise(resolve => {
      const token = randomUUID();
      const timer = setTimeout(() => this.finishSessionCommand('rejected', 'SESSION_CONTROL_UNAVAILABLE', 'Pi did not enter its command context'), 5_000);
      timer.unref();
      this.sessionCommand = { command, token, started: false, resolve, timer };
      try { this.pi.sendUserMessage(`/collab-session-control ${token}`, { expandPromptTemplates: true }); }
      catch (error) { this.finishSessionCommand('rejected', 'COMMAND_ERROR', commandErrorMessage(error)); }
    });
  }

  private inputCommands() {
    const names = new Set<string>();
    const available = this.pi.getCommands().filter(c => {
      if (names.has(c.name) || c.name === 'cafe' || /^collab(?:-|$)/.test(c.name) || !/^[^\s/\\\u0000-\u001f\u007f]{1,128}$/u.test(c.name)) return false;
      // Pi lists extensions before templates/skills: preserve native precedence.
      names.add(c.name); return true;
    });
    return { kind: 'commands' as const, truncated: available.length > 200, commands: available.slice(0, 200).map(c => ({ name: c.name, description: truncate(c.description ?? '', 160), source: c.source })) };
  }

  private async executeCommand(command: RoutedCommandMessage): Promise<void> {
    if (this.stopped) return;
    if (this.rejectIfCommandStale(command)) return;
    if (!this.snapshotReady) {
      this.sendCommandResult(command.relayRequestId, "rejected", "HOST_NOT_READY", "The Pi Cafe Space host is synchronizing its session");
      return;
    }
    const ctx = this.currentContext;
    const commandSessionId = this.snapshot.sessionId;
    const commandCwd = command.expectedCwd ?? snapshotCwd(ctx.cwd);
    const payload = command.payload;
    if (this.stopped) {
      this.sendCommandResult(command.relayRequestId, "rejected", "HOST_STOPPING", "The Pi Cafe Space host is stopping");
      return;
    }
    // The relay fence is necessary but not sufficient: a session/project
    // change can occur after a command was routed and before a queued command
    // reaches this point. Check the live ExtensionContext before any
    // synchronous operation as well as after awaited work below.
    if (this.rejectIfCommandStale(command, ctx, commandSessionId, commandCwd)) return;
    try {
      if (process.env.PI_COLLAB_MANAGED === '1' && ['new_session', 'resume_session'].includes(payload.name)) throw new FileCommandError('MANAGED_SESSION_FIXED', 'Open an independent managed session from the sidebar; this process keeps its own session');
      if (['list_commands', 'run_command'].includes(payload.name) || payload.name === 'prompt' && payload.files !== undefined) {
        if (!this.snapshot.inputAssist) throw new FileCommandError('INPUT_ASSIST_UNAVAILABLE', 'Reload Pi to enable commands and file references');
        if (command.expectedSessionId === undefined || command.expectedCwd === undefined) throw new FileCommandError('STALE_SESSION', 'Input actions require session and project fences');
      }
      if (['new_session', 'rename_session', 'resume_session', 'run_command'].includes(payload.name)) {
        if (command.expectedSessionId === undefined || command.expectedCwd === undefined) throw new FileCommandError('STALE_SESSION', 'Session controls require session and project fences');
        if (!ctx.isIdle() || ctx.hasPendingMessages() || this.snapshot.phase !== 'idle') throw new FileCommandError('SESSION_BUSY', 'Wait for Pi to finish before changing sessions');
      }
      switch (payload.name) {
        case 'list_commands':
          this.sendCommandResult(command.relayRequestId, 'applied', null, null, this.inputCommands());
          return;
        case 'run_command': {
          const parsed = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(payload.command.trim());
          if (!parsed || !this.inputCommands().commands.some(c => c.name === parsed[1])) throw new FileCommandError('COMMAND_UNAVAILABLE', 'This command is not available remotely; use the command list or the local Pi terminal');
          // Native Pi owns dispatch, argument parsing and skill/template expansion.
          // Unknown names never fall through as an ordinary model prompt.
          this.pi.sendUserMessage(`/${parsed[1]}${parsed[2] ? ' ' + parsed[2] : ''}`, { expandPromptTemplates: true });
          if (this.stopped || this.rejectIfCommandStale(command, ctx, commandSessionId, commandCwd)) return;
          this.sendCommandResult(command.relayRequestId, 'dispatched', null, 'Command dispatched to Pi; local UI may require attention');
          return;
        }
        case 'new_session':
        case 'resume_session':
          await this.dispatchSessionCommand(command);
          return;
        case 'rename_session':
          this.pi.setSessionName(payload.title.trim());
          if (this.stopped || this.rejectIfCommandStale(command, ctx, commandSessionId, commandCwd)) return;
          this.sendCommandResult(command.relayRequestId, 'applied', null, null);
          return;
        case "prompt": {
          if (!ctx.isIdle() && !payload.delivery) {
            this.sendCommandResult(command.relayRequestId, "rejected", "DELIVERY_REQUIRED", "Choose steer or followUp while Pi is running");
            return;
          }
          const content = payload.files?.length ? await attachProjectFiles(ctx.cwd, payload.content, payload.files) : payload.content;
          if (this.stopped || this.rejectIfCommandStale(command, ctx, commandSessionId, commandCwd)) return;
          if (!ctx.isIdle() && !payload.delivery) throw new FileCommandError('DELIVERY_REQUIRED', 'Pi started working while files were being read');
          if (payload.delivery) {
            this.pi.sendUserMessage(content, { deliverAs: payload.delivery });
          } else {
            this.pi.sendUserMessage(content);
          }
          if (this.stopped || this.rejectIfCommandStale(command, ctx, commandSessionId, commandCwd)) return;
          this.sendCommandResult(command.relayRequestId, "dispatched", null, "Prompt dispatched to Pi");
          return;
        }
        case "abort":
          ctx.abort();
          if (this.stopped || this.rejectIfCommandStale(command, ctx, commandSessionId, commandCwd)) return;
          this.sendCommandResult(command.relayRequestId, "dispatched", null, "Abort dispatched to Pi");
          return;
        case "set_thinking": {
          const applied = applyThinkingLevel(this.pi, ctx.model, payload.level);
          if (this.stopped || this.rejectIfCommandStale(command, ctx, commandSessionId, commandCwd)) return;
          // A native setter may clamp silently and emit no event. Read back
          // the effective value, synchronize it, and never claim false success.
          if (applied.actual !== null) this.onThinkingChanged(applied.actual, ctx);
          this.sendCommandResult(command.relayRequestId, applied.code ? 'rejected' : 'applied', applied.code, applied.code ? 'The native Pi model did not accept this thinking level' : null);
          return;
        }
        case "set_model": {
          const model = ctx.modelRegistry.find(payload.provider, payload.modelId);
          if (!model) {
            this.sendCommandResult(command.relayRequestId, "rejected", "MODEL_NOT_FOUND", "Model is not available in this Pi session");
            return;
          }
          const success = await this.pi.setModel(model);
          if (this.stopped || this.rejectIfCommandStale(command, ctx, commandSessionId, commandCwd)) return;
          this.sendCommandResult(command.relayRequestId, success ? "applied" : "rejected", success ? null : "MODEL_AUTH", success ? null : "No usable authentication for this model");
          return;
        }
        case "list_dir": {
          const data = await listProjectDirectory(ctx.cwd, payload.path);
          if (this.stopped || this.rejectIfCommandStale(command, ctx, commandSessionId, commandCwd)) return;
          this.sendCommandResult(command.relayRequestId, "applied", null, null, data);
          return;
        }
        case "read_file": {
          const data = await readProjectFile(ctx.cwd, payload.path, payload.offset, payload.limit);
          if (this.stopped || this.rejectIfCommandStale(command, ctx, commandSessionId, commandCwd)) return;
          this.sendCommandResult(command.relayRequestId, "applied", null, null, data);
          return;
        }
        case "list_sessions": {
          const data = await this.listSessions(ctx);
          if (this.stopped || this.rejectIfCommandStale(command, ctx, commandSessionId, commandCwd)) return;
          this.sendCommandResult(command.relayRequestId, "applied", null, null, data);
          return;
        }
        case "get_session": {
          const data = await this.getHistoricalSession(ctx, payload.sessionId);
          if (this.stopped || this.rejectIfCommandStale(command, ctx, commandSessionId, commandCwd)) return;
          this.sendCommandResult(command.relayRequestId, "applied", null, null, data);
          return;
        }
        default:
          this.sendCommandResult(command.relayRequestId, "rejected", "INVALID_COMMAND", "The Pi Cafe Space command is not supported");
          return;
      }
    } catch (error) {
      if (this.stopped || this.rejectIfCommandStale(command, ctx, commandSessionId, commandCwd)) return;
      const code = error instanceof FileCommandError ? error.code : "COMMAND_ERROR";
      this.sendCommandResult(command.relayRequestId, "rejected", code, commandErrorMessage(error));
    }
  }

  private emit(event: CollabEvent): void {
    let envelope: EventEnvelope;
    try {
      if (this.sequence >= MAX_EVENT_SEQUENCE) {
        // Keep sequence arithmetic bounded for exceptionally long-lived Pi
        // processes. A fresh stream snapshot preserves the current live
        // projection, then the triggering event starts at sequence one.
        this.sequence = 0;
        this.snapshot = compactSnapshot({ ...this.snapshot, streamId: randomUUID(), lastEventSeq: 0 });
        this.commandResults.clear();
        this.commandResultBytes = 0;
        this.snapshotReady = false;
        if (this.welcomed) {
          this.snapshotReady = this.sendSnapshot();
          if (!this.snapshotReady) return;
        }
      }
      const canonical = canonicalEvent(event);
      envelope = {
        type: "event",
        streamId: this.snapshot.streamId,
        sessionId: this.snapshot.sessionId,
        seq: this.sequence + 1,
        emittedAt: new Date().toISOString(),
        event: canonical,
      };
      this.sequence = envelope.seq;
    } catch {
      // A malformed provider/tool projection must not escape an event hook and
      // destabilize Pi. Rebuild the bounded baseline and let the next event
      // continue from the last valid sequence.
      this.markProjectionTruncated();
      this.refreshSnapshot();
      return;
    }
    try {
      this.snapshot = compactSnapshot(applyEvent(this.snapshot, envelope));
      if (this.projectionTruncated) this.snapshot.historyTruncated = true;
    } catch {
      try {
        this.snapshot = historicalSnapshot(this.pi, this.currentContext, this.snapshot.streamId, envelope.seq - 1);
        this.snapshot = compactSnapshot(applyEvent(this.snapshot, envelope));
        if (this.projectionTruncated) this.snapshot.historyTruncated = true;
      } catch {
        // A session replacement/reload can invalidate the event context between
        // the two projections. Roll back the reserved sequence number and
        // publish a fresh baseline if possible; otherwise the next event would
        // create an artificial sequence gap at the relay.
        this.sequence = envelope.seq - 1;
        this.snapshotReady = false;
        if (this.welcomed && this.socket) this.snapshotReady = this.sendSnapshot();
        return;
      }
    }
    if (!this.welcomed || !this.snapshotReady) return;
    if (!this.send(envelope) && this.welcomed && this.socket) {
      // If an unusually multibyte event or a transient send failure was not
      // accepted, repair the relay projection with the compacted snapshot
      // instead of leaving the event sequence permanently ahead.
      this.snapshotReady = this.sendSnapshot();
    }
  }

  private refreshSnapshot(preserveLiveProjection = false, rotateStream = false): void {
    if (this.stopped) return;
    try {
      const previous = this.snapshot;
      const previousTruncated = previous.historyTruncated || this.projectionTruncated;
      const nextStreamId = rotateStream ? randomUUID() : previous.streamId;
      const nextSequence = rotateStream ? 0 : this.sequence;
      const refreshed = historicalSnapshot(this.pi, this.currentContext, nextStreamId, nextSequence);
      refreshed.execution=this.execution.snapshot();
      if (!rotateStream && previousTruncated) refreshed.historyTruncated = true;
      if (preserveLiveProjection && !rotateStream && refreshed.sessionId === previous.sessionId) {
        // A session rename changes metadata only. Keep an in-flight assistant
        // message and tool projection instead of replacing it with the last
        // persisted branch state.
        refreshed.messages = previous.messages;
        refreshed.phase = previous.phase;
        refreshed.hasPendingMessages = previous.hasPendingMessages;
        refreshed.historyTruncated = previousTruncated;
      }
      refreshed.tools = [...this.tools.values()];
      this.snapshot = refreshed;
      if (rotateStream) this.sequence = 0;
      this.projectionTruncated = refreshed.historyTruncated;
      if (this.welcomed) this.snapshotReady = this.sendSnapshot();
    } catch {
      // The Pi runner invalidates old contexts during replacement/reload. Do
      // not leave the relay command-ready against the previous projection;
      // close this socket so the connector can establish a fresh lifecycle.
      this.snapshotReady = false;
      const socket = this.socket;
      if (socket) closeSocket(socket, 1011, "Unable to refresh Pi Cafe Space snapshot");
    }
  }

  private messageId(message: unknown): string {
    if (isRecord(message)) {
      const objectId = this.messageObjectIds.get(message);
      if (objectId) return objectId;
      const role = typeof message.role === "string" ? safePrefix(message.role, 64) : "unknown";
      const timestamp = typeof message.timestamp === "number" ? message.timestamp : 0;
      const toolCallId = typeof message.toolCallId === "string" ? boundedIdentifier(message.toolCallId, 256) : "";
      const baseKey = `${role}:${timestamp}:${toolCallId}`;
      // Object identity only deduplicates the same object. Installed Pi emits
      // different assistant objects across streaming, so that lifecycle uses
      // activeAssistantId instead. Timestamps never join distinct messages.
      let key = baseKey;
      let suffix = 0;
      while (this.messageIds.has(key)) key = `${baseKey}:${++suffix}`;
      const id = `m-${randomUUID()}`;
      this.messageObjectIds.set(message, id);
      this.messageIds.set(key, id);
      while (this.messageIds.size > MAX_MESSAGE_IDS) {
        const first = this.messageIds.keys().next().value as string | undefined;
        if (!first) break;
        this.messageIds.delete(first);
      }
      return id;
    }
    return `m-${randomUUID()}`;
  }

  onMessageStart(message: unknown, ctx: ExtensionContext): void {
    try {
      if (!this.adoptContext(ctx)) return;
      const role = isRecord(message) ? message.role : undefined;
      if (role !== "assistant" && role !== "user" && role !== "toolResult") {
        this.recoverFromCallbackFailure();
        return;
      }
      const id = this.messageId(message);
      const status: TranscriptMessage["status"] = role === "assistant" ? "streaming" : "complete";
      const projection = messageProjection(message, id, status);
      if (!projection) {
        this.recoverFromCallbackFailure();
        return;
      }
      if (projection.partsTruncated || messageProjectionWasTruncated(message)) this.markProjectionTruncated();
      if (role === "assistant") { this.activeAssistantId = id; this.execution.assistantStarted(); }
      this.emit({ kind: "message_started", message: role === "assistant" ? { ...projection, text: "", thinking: "", parts: [] } : projection });
    } catch {
      this.recoverFromCallbackFailure();
    }
  }

  onMessageUpdate(message: unknown, assistantMessageEvent: unknown, ctx: ExtensionContext): void {
    try {
      if (!this.adoptContext(ctx)) return;
      if (!isRecord(message) || message.role !== "assistant") {
        this.recoverFromCallbackFailure();
        return;
      }
      const event = isRecord(assistantMessageEvent) ? assistantMessageEvent : undefined;
      if (!event || typeof event.type !== "string") {
        this.recoverFromCallbackFailure();
        return;
      }
      if (event.type !== "text_delta" && event.type !== "thinking_delta") {
        // Start/end/tool-call stream markers are represented by the final
        // message and tool-execution callbacks; they do not carry text that
        // this projection needs to append.
        if (event.type === "start" || event.type === "text_start" || event.type === "text_end" ||
            event.type === "thinking_start" || event.type === "thinking_end" || event.type === "toolcall_start" ||
            event.type === "toolcall_delta" || event.type === "toolcall_end" || event.type === "done" || event.type === "error") return;
        this.recoverFromCallbackFailure();
        return;
      }
      if (typeof event.delta !== "string") {
        this.recoverFromCallbackFailure();
        return;
      }
      if (event.delta.length > MAX_TEXT_LENGTH) this.markProjectionTruncated();
      const mappedId = isRecord(message) ? this.messageObjectIds.get(message) : undefined;
      const id = this.activeAssistantId ?? mappedId ?? this.messageId(message);
      this.messageObjectIds.set(message, id);
      if (!this.snapshot.messages.some((item) => item.id === id)) {
        const projection = messageProjection(message, id, "streaming");
        if (projection) {
          if (projection.partsTruncated || messageProjectionWasTruncated(message)) this.markProjectionTruncated();
          this.emit({ kind: "message_started", message: { ...projection, text: "", thinking: "", parts: [] } });
        } else {
          this.recoverFromCallbackFailure();
          return;
        }
        this.activeAssistantId = id;
      }
      const channel = event.type === "text_delta" ? "text" : "thinking";
      const index = event.contentIndex;
      const indexed = typeof index === "number" && Number.isInteger(index) && index >= 0 && index < MAX_CONTENT_PARTS &&
        Array.isArray(message.content) && isRecord(message.content[index]) && message.content[index].type === channel && event.delta.length <= MAX_TEXT_LENGTH;
      if (!indexed) this.markProjectionTruncated();
      this.emit({ kind: "message_delta", messageId: id, channel, delta: truncate(event.delta), ...(indexed ? { partIndex: index } : {}) });
    } catch {
      this.recoverFromCallbackFailure();
    }
  }

  onMessageEnd(message: unknown, ctx: ExtensionContext): void {
    let assistant = false;
    try {
      if (!this.adoptContext(ctx)) return;
      const role = isRecord(message) ? message.role : undefined;
      if (role !== "assistant" && role !== "user" && role !== "toolResult") {
        this.recoverFromCallbackFailure();
        return;
      }
      assistant = role === "assistant";
      const mappedId = isRecord(message) ? this.messageObjectIds.get(message) : undefined;
      const id = role === "assistant" ? this.activeAssistantId ?? mappedId ?? this.messageId(message) : this.messageId(message);
      if (isRecord(message)) this.messageObjectIds.set(message, id);
      const stopReason = isRecord(message) ? message.stopReason : undefined;
      if (stopReason !== undefined && typeof stopReason !== "string") {
        this.recoverFromCallbackFailure();
        return;
      }
      const knownStopReason = stopReason === undefined || stopReason === "pending" || stopReason === "stop" ||
        stopReason === "length" || stopReason === "toolUse" || stopReason === "error" || stopReason === "aborted" || stopReason === "deferred";
      if (!knownStopReason) this.markProjectionTruncated();
      if (assistant) this.execution.assistantEnded(stopReason);
      const error = stopReason === "error" || stopReason === "aborted";
      const projection = messageProjection(message, id, error ? "error" : "complete");
      if (projection) {
        if (projection.partsTruncated || messageProjectionWasTruncated(message)) this.markProjectionTruncated();
        this.emit({ kind: "message_finished", message: projection });
      } else {
        this.recoverFromCallbackFailure();
      }
    } catch {
      this.recoverFromCallbackFailure();
    }
    if (assistant) this.activeAssistantId = null;
  }

  private retainTool(tool: ToolExecution): void {
    this.tools.set(tool.toolCallId, tool);
    while (this.tools.size > MAX_RETAINED_TOOLS) {
      const first = this.tools.keys().next().value as string | undefined;
      if (!first) break;
      this.tools.delete(first);
    }
  }

  private toolParent(toolCallId: string): Pick<ToolExecution, "parentMessageId"> {
    // Derived afresh from retained messages: eviction/reconnect/context changes
    // cannot leave a stale parent hint. Upper bound is 100 x 500 occurrences.
    const parent = buildToolParentIndex(this.snapshot.messages).get(toolCallId);
    return parent ? { parentMessageId: parent } : {};
  }

  onToolStart(toolCallId: string, toolName: string, args: unknown, ctx: ExtensionContext): void {
    try {
      if (!this.adoptContext(ctx)) return;
      if (typeof toolCallId !== "string" || typeof toolName !== "string" || !toolCallId || !toolName || toolCallId.length > 256) {
        this.recoverFromCallbackFailure();
        return;
      }
      const boundedToolCallId = boundedIdentifier(toolCallId, 256);
      const boundedToolName = truncate(toolName, 256);
      const argsText = safeJsonWithStatus(args);
      if (toolCallId.length > 256 || toolName.length > 256 || argsText.truncated) this.markProjectionTruncated();
      const tool: ToolExecution = { toolCallId: boundedToolCallId, toolName: boundedToolName, argsText: argsText.value, output: "", status: "running", ...this.toolParent(toolCallId) };
      this.retainTool(tool);
      this.emit({ kind: "tool_started", tool });
    } catch {
      this.recoverFromCallbackFailure();
    }
  }

  onToolUpdate(toolCallId: string, partialResult: unknown, ctx: ExtensionContext): void {
    try {
      if (!this.adoptContext(ctx)) return;
      if (typeof toolCallId !== "string" || !toolCallId || toolCallId.length > 256) {
        this.recoverFromCallbackFailure();
        return;
      }
      const boundedToolCallId = boundedIdentifier(toolCallId, 256);
      let outputSource = partialResult;
      if (isRecord(partialResult)) {
        try { outputSource = partialResult.content; } catch {
          this.recoverFromCallbackFailure();
          return;
        }
      }
      const outputText = boundedContentText(outputSource, false);
      if (toolCallId.length > 256 || outputText.truncated) this.markProjectionTruncated();
      const output = outputText.value;
      const existing = this.tools.get(boundedToolCallId);
      if (existing) this.retainTool({ ...existing, output });
      this.emit({ kind: "tool_updated", toolCallId: boundedToolCallId, output });
    } catch {
      this.recoverFromCallbackFailure();
    }
  }

  onToolEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean, ctx: ExtensionContext): void {
    try {
      if (!this.adoptContext(ctx)) return;
      if (typeof toolCallId !== "string" || typeof toolName !== "string" || typeof isError !== "boolean" || !toolCallId || !toolName || toolCallId.length > 256) {
        this.recoverFromCallbackFailure();
        return;
      }
      const boundedToolCallId = boundedIdentifier(toolCallId, 256);
      const boundedToolName = truncate(toolName, 256);
      let outputSource = result;
      if (isRecord(result)) {
        try { outputSource = result.content; } catch {
          this.recoverFromCallbackFailure();
          return;
        }
      }
      const outputText = boundedContentText(outputSource, false);
      if (toolCallId.length > 256 || toolName.length > 256 || outputText.truncated) this.markProjectionTruncated();
      const existing = this.tools.get(boundedToolCallId) ?? { toolCallId: boundedToolCallId, toolName: boundedToolName, argsText: "", output: "", status: "running" as const };
      const tool: ToolExecution = { ...existing, toolName: boundedToolName, output: outputText.value, status: isError ? "error" : "complete" };
      delete tool.parentMessageId;
      Object.assign(tool, this.toolParent(toolCallId));
      this.retainTool(tool);
      this.emit({ kind: "tool_finished", tool });
    } catch {
      this.recoverFromCallbackFailure();
    }
  }

  onAgentState(phase: SessionSnapshot["phase"], ctx: ExtensionContext): void {
    try {
      if (!this.adoptContext(ctx)) return;
      if (phase !== "idle" && phase !== "running" && phase !== "waiting_local_ui") {
        this.recoverFromCallbackFailure();
        return;
      }
      const hasPendingMessages = ctx.hasPendingMessages();
      if (typeof hasPendingMessages !== "boolean") {
        this.recoverFromCallbackFailure();
        return;
      }
      this.clearNativeIdleTimer();
      if (phase==='running') this.execution.begin();
      else this.execution.uncertain(phase==='idle');
      this.emit({ kind: "session_state", phase, hasPendingMessages, execution:this.execution.snapshot() });
    } catch {
      this.recoverFromCallbackFailure();
    }
  }

  private publishExecution(phase: SessionSnapshot['phase']): void {
    const hasPendingMessages=this.currentContext.hasPendingMessages();
    if (typeof hasPendingMessages!=='boolean') throw Error('Invalid native queue state');
    this.emit({kind:'session_state',phase,hasPendingMessages,execution:this.execution.snapshot()});
  }

  onBeforeSettle(outcome: unknown, ctx: ExtensionContext): void {
    if (this.adoptContext(ctx)) this.execution.beforeSettle(outcome);
  }

  onSettled(aborted: unknown, ctx: ExtensionContext): void {
    if (!this.adoptContext(ctx)) return;
    this.clearNativeIdleTimer();
    this.execution.settled(aborted);
    this.publishExecution('idle');
  }

  onCompactionStart(reason: unknown, ctx: ExtensionContext): void {
    if (!this.adoptContext(ctx)) return;
    this.execution.compactionStart(reason);
    this.publishExecution('running');
  }

  onCompactionEnd(ctx: ExtensionContext, reason?: unknown): void {
    if (!this.adoptContext(ctx)) return;
    this.execution.compactionEnd(ctx.isIdle());
    this.onSessionChanged(ctx,true,true);
    this.publishExecution(ctx.isIdle()?'idle':'running');
    // Native successful manual compaction clears its busy flag AFTER emitting
    // session_compact. Observe the post-callback context; never force it idle.
    if(reason==='manual'&&!ctx.isIdle()){
      this.clearNativeIdleTimer();const streamId=this.snapshot.streamId,runId=this.execution.snapshot().runId;
      const reconcile=(remaining:number)=>{
        this.nativeIdleTimer=null;
        if(this.stopped||this.snapshot.streamId!==streamId||this.execution.snapshot().runId!==runId)return;
        try{if(ctx.isIdle()){this.execution.compactionEnd(true);this.publishExecution('idle');return;}}catch{return;}
        if(remaining>0){this.nativeIdleTimer=setTimeout(()=>reconcile(remaining-1),100);this.nativeIdleTimer.unref();}
      };
      this.nativeIdleTimer=setTimeout(()=>reconcile(19),0);this.nativeIdleTimer.unref();
    }
  }

  onUiWait(waiting: boolean, title: string | null, ctx: ExtensionContext, promptKind?: unknown): void {
    try {
      if (!this.adoptContext(ctx)) return;
      if (typeof waiting !== "boolean" || (title !== null && typeof title !== "string")) {
        this.recoverFromCallbackFailure();
        return;
      }
      const safeTitle = title ? truncate(title, 512) : null;
      this.clearNativeIdleTimer();
      this.execution.wait(waiting,promptKind,ctx.isIdle());
      this.emit({ kind: "ui_wait", waiting, title: safeTitle, ...(isPromptKind(promptKind)?{promptKind}:{}) });
      // A command-level dialog can close without any agent turn/settled event.
      // Restore native authority instead of leaving an idle Pi shown as running.
      if (!waiting) this.publishExecution(this.execution.snapshot().activity==='waiting'?'waiting_local_ui':ctx.isIdle()?'idle':'running');
    } catch {
      this.recoverFromCallbackFailure();
    }
  }

  onModelChanged(model: unknown, ctx: ExtensionContext): void {
    try {
      if (!this.adoptContext(ctx)) return;
      const projected = modelRef(model);
      if (!isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string" || !projected) {
        this.recoverFromCallbackFailure();
        return;
      }
      if (projected.provider !== model.provider || projected.id !== model.id) this.markProjectionTruncated();
      this.emit({ kind: "model_changed", model: projected });
    } catch {
      this.recoverFromCallbackFailure();
    }
  }

  onThinkingChanged(level: string, ctx: ExtensionContext): void {
    try {
      if (!this.adoptContext(ctx)) return;
      if (level === "off" || level === "minimal" || level === "low" || level === "medium" || level === "high" || level === "xhigh" || level === "max") {
        if (this.snapshot.thinkingLevel !== level) this.emit({ kind: "thinking_changed", level });
      } else {
        this.recoverFromCallbackFailure();
      }
    } catch {
      this.recoverFromCallbackFailure();
    }
  }

  onSessionChanged(ctx: ExtensionContext, resetProjection = true, preserveExecution = false): void {
    try {
      if (!this.adoptContext(ctx)) return;
      const previousSessionId = this.snapshot.sessionId;
      const previousCwd = this.snapshot.cwd;
      const nextSessionId = ctx.sessionManager.getSessionId();
      const nextCwd = snapshotCwd(ctx.cwd);
      if (typeof nextSessionId !== "string" || !nextSessionId || nextSessionId.length > 256) {
        this.recoverFromCallbackFailure();
        return;
      }
      const sessionChanged = nextSessionId !== previousSessionId;
      const cwdChanged = nextCwd !== previousCwd;
      if (sessionChanged || cwdChanged || resetProjection && !preserveExecution) { this.clearNativeIdleTimer(); this.execution.reset(ctx.isIdle()); }
      // Rebuild projection state for branch/compaction changes, session changes,
      // or project-root changes. A simple session rename must not erase a
      // currently streaming assistant/tool, but a new project must not retain
      // visible state from the old project.
      if (resetProjection || sessionChanged || cwdChanged) {
        this.activeAssistantId = null;
        this.messageIds.clear();
        this.messageObjectIds = new WeakMap();
        this.tools.clear();
        this.projectionTruncated = false;
      }
      // Clear command dedupe results whenever the opaque session or project
      // context changes; a request ID must never replay data across either fence.
      if (resetProjection || sessionChanged || cwdChanged) {
        this.commandResults.clear();
        this.commandResultBytes = 0;
      }
      const rotateStream = resetProjection || sessionChanged || cwdChanged;
      this.refreshSnapshot(!rotateStream && nextSessionId === previousSessionId, rotateStream);
    } catch {
      this.recoverFromCallbackFailure();
    }
  }
}

function autoEnabled(pi: ExtensionAPI): boolean {
  const rawEnvironment = process.env.PI_COLLAB_ENABLED;
  if (rawEnvironment !== undefined && rawEnvironment.length > 64) return false;
  const environment = (rawEnvironment ?? "").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(environment)) return false;
  if (["1", "true", "yes", "on"].includes(environment)) return true;
  try { return pi.getFlag("collab") !== false; } catch { return false; }
}

export default function registerPiCollabExtension(pi: ExtensionAPI): void {
  pi.registerFlag("collab", { type: "boolean", description: "Connect this Pi session to the Pi Cafe Space relay", default: true });
  pi.registerFlag("collab-relay", { type: "string", description: "Pi Cafe Space relay WebSocket URL" });
  pi.registerFlag("collab-room", { type: "string", description: "Pi Cafe Space room ID" });

  let host: PiCollabHost | null = null;
  let startPromise: Promise<void> | null = null;
  let lifecycleGeneration = 0;

  const start = (ctx: ExtensionContext): Promise<void> => {
    if (host) return Promise.resolve();
    if (startPromise) return startPromise;
    const generation = lifecycleGeneration;
    const pending = (async () => {
      try {
        const config = configuration(pi);
        const relayStatus = await ensureLocalRelay({ relayUrl: config.relayUrl, hostToken: config.token });
        if (generation !== lifecycleGeneration) return;
        // The health/startup helper is advisory. A failed HTTP probe does not
        // prove the actual WebSocket connection is unavailable. The host owns
        // the live status and delayed failure/recovery notifications.
        const nextHost = new PiCollabHost(pi, ctx, config);
        try {
          nextHost.start();
          host = nextHost;
        } catch (error) {
          nextHost.stop();
          throw error;
        }
        if (ctx.hasUI && relayStatus === "started") ctx.ui.notify("Café Space relay started automatically", "info");
      } catch (error) {
        if (generation !== lifecycleGeneration) return;
        try {
          if (ctx.hasUI) ctx.ui.notify(`Pi Cafe Space: ${truncate(describeError(error), 2_048)}`, "error");
        } catch {
          // Pi may invalidate the context while startup is in flight.
        }
      }
    })();
    startPromise = pending;
    void pending.then(
      () => { if (startPromise === pending) startPromise = null; },
      () => { if (startPromise === pending) startPromise = null; },
    );
    return pending;
  };

  const cafe = registerCafe(pi, {
    config: () => configuration(pi),
    status: () => host?.status() ?? 'disabled',
    modelsRefreshed: ctx => { if (ctx.model) host?.onModelChanged(ctx.model, ctx); host?.onThinkingChanged(pi.getThinkingLevel(), ctx); },
    connect: start,
    disconnect: () => { lifecycleGeneration++; startPromise = null; host?.stop(); host = null; },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (autoEnabled(pi)) await start(ctx);
    cafe.onStart(ctx);
  });

  pi.on("session_shutdown", (event) => {
    cafe.stop();
    lifecycleGeneration++;
    startPromise = null;
    host?.stop(event?.reason);
    host = null;
  });

  // Fail closed if a Pi runtime does not dispatch expanded extension commands:
  // the internal bridge text must never fall through into a model turn.
  pi.on('input', (event) => {
    if (event.source === 'extension' && event.text.startsWith('/collab-session-control ')) return { action: 'handled' };
  });

  pi.registerCommand('collab-session-control', {
    description: 'Internal single-use bridge for Café session controls',
    handler: async (token, ctx) => { await host?.runSessionCommand(token, ctx); },
  });

  pi.registerCommand("collab-connect", {
    description: "Connect the current Pi session to Pi Cafe Space",
    handler: async (_args, ctx) => {
      await start(ctx);
    },
  });

  pi.registerCommand("collab-disconnect", {
    description: "Disconnect the current Pi session from Pi Cafe Space",
    handler: async (_args, ctx) => {
      lifecycleGeneration++;
      startPromise = null;
      host?.stop();
      host = null;
      try { ctx.ui.notify("Pi Cafe Space disconnected", "info"); } catch {
        // The command can race session shutdown and an invalidated UI context.
      }
    },
  });

  pi.registerCommand("collab-status", {
    description: "Show Pi Cafe Space connection status",
    handler: async (_args, ctx) => {
      try { ctx.ui.notify(`Pi Cafe Space: ${host?.status() ?? "disabled"}`, "info"); } catch {
        // The status command is best effort during Pi shutdown/reload.
      }
    },
  });

  // Keep event payload access inside a final exception boundary. Pi normally
  // supplies plain decoded objects, but an extension/provider can still hand
  // us a malformed object or a getter that throws; no such payload should
  // escape an Extension API event hook.
  const invokeHost = (callback: (current: PiCollabHost) => void): void => {
    const current = host;
    if (!current) return;
    try {
      callback(current);
    } catch {
      try { current.recoverFromCallbackFailure(); } catch {}
    }
  };
  pi.on("message_start", (event, ctx) => invokeHost((current) => current.onMessageStart(event.message, ctx)));
  pi.on("message_update", (event, ctx) => invokeHost((current) => current.onMessageUpdate(event.message, event.assistantMessageEvent, ctx)));
  pi.on("message_end", (event, ctx) => invokeHost((current) => current.onMessageEnd(event.message, ctx)));
  pi.on("tool_execution_start", (event, ctx) => invokeHost((current) => current.onToolStart(event.toolCallId, event.toolName, event.args, ctx)));
  pi.on("tool_execution_update", (event, ctx) => invokeHost((current) => current.onToolUpdate(event.toolCallId, event.partialResult, ctx)));
  pi.on("tool_execution_end", (event, ctx) => invokeHost((current) => current.onToolEnd(event.toolCallId, event.toolName, event.result, event.isError, ctx)));
  pi.on("agent_start", (_event, ctx) => invokeHost((current) => current.onAgentState("running", ctx)));
  pi.on("agent_before_settle", (event, ctx) => invokeHost((current) => current.onBeforeSettle(event.outcome, ctx)));
  pi.on("agent_settled", (event, ctx) => invokeHost((current) => current.onSettled(event.aborted, ctx)));
  pi.on("ui_prompt_start", (event, ctx) => invokeHost((current) => current.onUiWait(true, event.title ?? null, ctx, event.kind)));
  pi.on("ui_prompt_end", (event, ctx) => invokeHost((current) => current.onUiWait(false, event.title ?? null, ctx, event.kind)));
  pi.on("model_select", (event, ctx) => invokeHost((current) => current.onModelChanged(event.model, ctx)));
  pi.on("thinking_level_select", (event, ctx) => invokeHost((current) => current.onThinkingChanged(event.level, ctx)));
  pi.on("session_tree", (_event, ctx) => invokeHost((current) => current.onSessionChanged(ctx, true)));
  pi.on("session_before_compact", (event, ctx) => invokeHost((current) => current.onCompactionStart(event.reason, ctx)));
  pi.on("session_compact", (event, ctx) => invokeHost((current) => current.onCompactionEnd(ctx,event.reason)));
  pi.on("session_compact_failed", (event, ctx) => invokeHost((current) => current.onCompactionEnd(ctx,event.reason)));
  pi.on("session_info_changed", (_event, ctx) => invokeHost((current) => current.onSessionChanged(ctx, false)));
}
