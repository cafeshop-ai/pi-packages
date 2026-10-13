import { canonicalExecution, isExecutionState, isPromptKind, type ExecutionState, type PromptKind } from './execution.js';
export { canonicalExecution, isExecutionState, isPromptKind, type ExecutionState, type PromptKind } from './execution.js';

export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_TEXT = 64 * 1024;
const MAX_TOOL_OUTPUT = 64 * 1024;
const MAX_APPLIED_MESSAGES = 1_000;
const MAX_APPLIED_TOOLS = 500;
const MAX_HOSTS_PER_ROOM = 64;
export const MAX_EVENT_SEQUENCE = 1_000_000_000;
const MAX_JSON_NODES = 20_000;
const MAX_JSON_KEY_LENGTH = 4_096;
const MAX_JSON_STRING_LENGTH = MAX_FRAME_BYTES;
const UTF8_ENCODER = new TextEncoder();

function safePrefix(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let end = Math.max(0, maxLength);
  // Do not leave a high surrogate without its following low surrogate.
  if (end < value.length && end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return value.slice(0, end);
}

export type PeerRole = "host" | "client";
export type DeliveryMode = "steer" | "followUp";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentPhase = "idle" | "running" | "waiting_local_ui";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ModelRef {
  provider: string;
  id: string;
  /** Declared by the native Pi model, not inferred by the browser. */
  reasoning?: boolean;
  thinkingLevels?: ThinkingLevel[];
}

export type TranscriptPart =
  | { index: number; type: "text" | "thinking"; text: string }
  | { index: number; type: "tool-call"; toolCallId: string; toolName: string; argsText: string };

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  thinking: string;
  timestamp: number;
  status: "streaming" | "complete" | "error";
  toolName: string | null;
  toolCallId: string | null;
  parts?: TranscriptPart[];
  partsTruncated?: boolean;
  toolIsError?: boolean;
}

export interface ToolExecution {
  toolCallId: string;
  toolName: string;
  argsText: string;
  output: string;
  status: "running" | "complete" | "error";
  parentMessageId?: string;
}

export interface SessionSnapshot {
  protocolVersion: typeof PROTOCOL_VERSION;
  streamId: string;
  sessionId: string;
  sessionName: string | null;
  cwd: string;
  activeLeafId: string | null;
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel;
  phase: AgentPhase;
  hasPendingMessages: boolean;
  /** Structured runtime observations; absent on legacy hosts, not an authorization signal. */
  execution?: ExecutionState;
  /** Native Pi lifecycle commands; absent on older extensions. */
  sessionControl?: boolean;
  /** Slash command discovery/execution and bounded project-file references. */
  inputAssist?: boolean;
  messages: TranscriptMessage[];
  historyTruncated: boolean;
  tools: ToolExecution[];
  lastEventSeq: number;
}

export type CollabEvent =
  | { kind: "session_state"; phase: AgentPhase; hasPendingMessages: boolean; execution?: ExecutionState }
  | { kind: "message_started"; message: TranscriptMessage }
  | { kind: "message_delta"; messageId: string; channel: "text" | "thinking"; delta: string; partIndex?: number }
  | { kind: "message_finished"; message: TranscriptMessage }
  | { kind: "tool_started"; tool: ToolExecution }
  | { kind: "tool_updated"; toolCallId: string; output: string }
  | { kind: "tool_finished"; tool: ToolExecution }
  | { kind: "model_changed"; model: ModelRef | null }
  | { kind: "thinking_changed"; level: ThinkingLevel }
  | { kind: "ui_wait"; waiting: boolean; title: string | null; promptKind?: PromptKind }
  | { kind: "notice"; level: "info" | "warning" | "error"; message: string };

export interface EventEnvelope {
  type: "event";
  /** Added by the relay; old hosts may omit it when sending to the relay. */
  hostId?: string;
  streamId: string;
  sessionId: string;
  seq: number;
  emittedAt: string;
  event: CollabEvent;
}

export interface HelloMessage {
  type: "hello";
  protocolVersion: typeof PROTOCOL_VERSION;
  peerRole: PeerRole;
  peerId: string;
  roomId: string;
  token: string;
}

export interface WelcomeMessage {
  type: "welcome";
  protocolVersion: typeof PROTOCOL_VERSION;
  connectionId: string;
  peerRole: PeerRole;
  roomId: string;
  hostConnected: boolean;
}

export interface HostInfo {
  hostId: string;
  connected: boolean;
  /** False while a new host connection is waiting for its first snapshot. Missing means legacy/ready. */
  ready?: boolean;
  streamId: string | null;
  sessionId: string | null;
  sessionName: string | null;
  cwd: string | null;
}

export interface HostStatusMessage {
  type: "host_status";
  /** Aggregate compatibility fields for clients that only support one host. */
  connected: boolean;
  streamId: string | null;
  sessionId: string | null;
  /** The aggregate/primary host, when one is available. */
  hostId?: string | null;
  /** All Pi instances currently known in this room. */
  hosts?: HostInfo[];
}

export interface SnapshotMessage {
  type: "snapshot";
  /** Added by the relay; old hosts may omit it when sending to the relay. */
  hostId?: string;
  snapshot: SessionSnapshot;
}

export type CommandPayload =
  | { name: "prompt"; content: string; delivery?: DeliveryMode; files?: string[] }
  | { name: "list_commands" }
  | { name: "run_command"; command: string }
  | { name: "abort" }
  | { name: "set_thinking"; level: ThinkingLevel }
  | { name: "set_model"; provider: string; modelId: string }
  | { name: "list_dir"; path: string }
  | { name: "read_file"; path: string; offset?: number; limit?: number }
  | { name: "list_sessions" }
  | { name: "get_session"; sessionId: string }
  | { name: "new_session" }
  | { name: "rename_session"; title: string }
  | { name: "resume_session"; sessionId: string };

export interface ClientCommandMessage {
  type: "command";
  requestId: string;
  expectedStreamId: string;
  /** Optional legacy fence; new clients should send it with expectedStreamId. */
  expectedSessionId?: string;
  /** Optional project-root fence for commands that may outlive a context change. */
  expectedCwd?: string;
  /** Selects one Pi instance when a room contains more than one host. */
  targetHostId?: string;
  payload: CommandPayload;
}

export interface RoutedCommandMessage {
  type: "routed_command";
  relayRequestId: string;
  clientRequestId: string;
  sourcePeerId: string;
  expectedStreamId: string;
  expectedSessionId?: string;
  expectedCwd?: string;
  targetHostId?: string;
  payload: CommandPayload;
}

export type CommandStatus = "dispatched" | "applied" | "rejected";

export interface HostCommandResultMessage {
  type: "host_command_result";
  relayRequestId: string;
  status: CommandStatus;
  code: string | null;
  message: string | null;
  data?: JsonValue;
}

export interface CommandResultMessage {
  type: "command_result";
  /** Added by the relay so late results cannot be shown under another host. */
  hostId?: string;
  requestId: string;
  status: CommandStatus;
  code: string | null;
  message: string | null;
  data?: JsonValue;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

function encodedSize(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? UTF8_ENCODER.encode(serialized).byteLength : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Rebuild an arbitrary JSON result payload without retaining peer-owned object identity or prototypes. */
interface JsonNormalizationBudget {
  remaining: number;
  stringBytes: number;
}

function canonicalJsonValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  budget: JsonNormalizationBudget = { remaining: MAX_JSON_NODES, stringBytes: 0 },
): JsonValue | undefined {
  if (budget.remaining-- <= 0) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_LENGTH) return undefined;
    const bytes = UTF8_ENCODER.encode(value).byteLength;
    budget.stringBytes += bytes;
    return budget.stringBytes <= MAX_FRAME_BYTES ? value : undefined;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (depth > 8 || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 500) return undefined;
      const normalized: JsonValue[] = [];
      for (const item of value) {
        const next = canonicalJsonValue(item, depth + 1, seen, budget);
        if (next === undefined) return undefined;
        normalized.push(next);
      }
      return normalized;
    }
    // Result data is a JSON value, not an arbitrary class instance. Without
    // this check Date/Map/Set/Buffer-like objects could be silently converted
    // to an empty object and reported as an applied result.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Object.keys(value);
    if (keys.length > 500) return undefined;
    const normalized: { [key: string]: JsonValue } = {};
    for (const key of keys) {
      if (key.length > MAX_JSON_KEY_LENGTH) return undefined;
      budget.stringBytes += UTF8_ENCODER.encode(key).byteLength;
      if (budget.stringBytes > MAX_FRAME_BYTES) return undefined;
      const next = canonicalJsonValue((value as Record<string, unknown>)[key], depth + 1, seen, budget);
      if (next === undefined) return undefined;
      // defineProperty treats even the special __proto__ key as data rather
      // than invoking a prototype setter.
      Object.defineProperty(normalized, key, { value: next, enumerable: true, writable: true, configurable: true });
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

/**
 * Keep a command result deliverable after an envelope (for example hostId)
 * is added by the relay. Commands should normally return well below this
 * budget; an explicit rejection is safer than silently dropping a result.
 */
export function fitCommandResult<T extends HostCommandResultMessage | CommandResultMessage>(result: T): T {
  // Rebuild the envelope instead of spreading a value received from an
  // untrusted peer. Validators intentionally tolerate unknown future fields,
  // but those fields must not defeat the outbound frame budget.
  let resultType: "host_command_result" | "command_result" = "command_result";
  let statusValue: unknown;
  let codeValue: unknown;
  let messageValue: unknown;
  let relayRequestIdValue: unknown;
  let requestIdValue: unknown;
  let hostIdValue: unknown;
  let rawData: unknown;
  let hasData = false;
  let readFailed = false;
  try {
    resultType = result.type === "host_command_result" ? "host_command_result" : "command_result";
    statusValue = result.status;
    codeValue = result.code;
    messageValue = result.message;
    const record = result as unknown as Record<string, unknown>;
    relayRequestIdValue = record.relayRequestId;
    requestIdValue = record.requestId;
    hostIdValue = record.hostId;
    if (record.data !== undefined) {
      hasData = true;
      rawData = record.data;
    }
  } catch {
    // A provider or extension can hand us a proxy/getter that throws. Return a
    // bounded rejection rather than allowing that object to escape the relay.
    readFailed = true;
  }
  const status = statusValue === "dispatched" || statusValue === "applied" || statusValue === "rejected"
    ? statusValue : "rejected";
  const code = typeof codeValue === "string" ? safePrefix(codeValue, 128) : null;
  const message = typeof messageValue === "string" ? safePrefix(messageValue, 2_048) : null;
  const relayRequestId = resultType === "host_command_result" && typeof relayRequestIdValue === "string"
    ? safePrefix(relayRequestIdValue, 128) : "";
  const requestId = resultType === "command_result" && typeof requestIdValue === "string"
    ? safePrefix(requestIdValue, 128) : "";
  let normalizedData: JsonValue | undefined;
  let invalidData = readFailed;
  if (hasData && !readFailed) {
    try {
      normalizedData = canonicalJsonValue(rawData);
      invalidData = normalizedData === undefined;
    } catch {
      invalidData = true;
    }
  }
  const dataField = normalizedData === undefined ? {} : { data: normalizedData };
  const normalized = resultType === "host_command_result"
    ? {
        type: "host_command_result" as const,
        relayRequestId,
        status,
        code,
        message,
        ...dataField,
      }
    : {
        type: "command_result" as const,
        ...(typeof hostIdValue === "string" ? { hostId: safePrefix(hostIdValue, 128) } : {}),
        requestId,
        status,
        code,
        message,
        ...dataField,
      };
  if (!invalidData && encodedSize(normalized) <= MAX_FRAME_BYTES - 1_024) return normalized as T;
  // A cyclic, non-JSON, or over-wide/deep result is not safe to forward.
  // Treat it like an oversized result rather than silently dropping the data
  // while claiming that the command was applied.
  if (normalized.type === "host_command_result") {
    return {
      type: "host_command_result",
      relayRequestId: safePrefix(normalized.relayRequestId, 128),
      status: "rejected",
      code: "RESULT_TOO_LARGE",
      message: "The command result exceeded the relay frame limit",
    } as T;
  }
  return {
    type: "command_result",
    ...(normalized.hostId ? { hostId: safePrefix(normalized.hostId, 128) } : {}),
    requestId: safePrefix(normalized.requestId, 128),
    status: "rejected",
    code: "RESULT_TOO_LARGE",
    message: "The command result exceeded the relay frame limit",
  } as T;
}

export type WireMessage =
  | HelloMessage
  | WelcomeMessage
  | HostStatusMessage
  | SnapshotMessage
  | EventEnvelope
  | ClientCommandMessage
  | RoutedCommandMessage
  | HostCommandResultMessage
  | CommandResultMessage
  | ErrorMessage;

export class ProtocolDecodeError extends Error {
  readonly code = "INVALID_MESSAGE";

  constructor(message: string) {
    super(message);
    this.name = "ProtocolDecodeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  try {
    return canonicalJsonValue(value) !== undefined;
  } catch {
    return false;
  }
}

function isString(value: unknown, maxLength = 16_384): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isNullableString(value: unknown, maxLength = 16_384): value is string | null {
  return value === null || (typeof value === "string" && value.length <= maxLength);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" ||
    value === "high" || value === "xhigh" || value === "max";
}

export function isPeerRole(value: unknown): value is PeerRole {
  return value === "host" || value === "client";
}

/**
 * Reject the most obvious low-complexity values before a token is used on a
 * non-loopback relay. A string alone cannot prove how it was generated, so
 * this deliberately conservative check is only a minimum bar: callers still
 * require explicit, distinct, non-default tokens and should generate them
 * with a cryptographically secure random source.
 */
export function hasSufficientTokenEntropy(value: string): boolean {
  if (typeof value !== "string" || value.length > 4_096) return false;
  const characters = [...value];
  if (characters.length < 16) return false;
  const distinctCharacters = new Set(characters).size;
  // A high Shannon score from only a handful of repeated symbols is still
  // easy to guess (for example five copies of six different letters).
  if (distinctCharacters < 8) return false;

  // Reject a short repeated unit (for example passwordpassword or abcabc...).
  for (let period = 1; period <= Math.min(8, Math.floor(characters.length / 2)); period++) {
    let repeated = true;
    for (let index = period; index < characters.length; index++) {
      if (characters[index] !== characters[index % period]) {
        repeated = false;
        break;
      }
    }
    if (repeated) return false;
  }

  // Reject plainly sequential ASCII strings, which have many distinct
  // characters but are still predictable credentials.
  if (characters.every((character) => character.length === 1 && character.charCodeAt(0) <= 0x7f)) {
    const first = characters[0]?.charCodeAt(0);
    const second = characters[1]?.charCodeAt(0);
    const step = first !== undefined && second !== undefined ? second - first : 0;
    if ((step === 1 || step === -1) && characters.every((character, index) => index === 0 || character.charCodeAt(0) - characters[index - 1]!.charCodeAt(0) === step)) {
      return false;
    }
  }

  const counts = new Map<string, number>();
  for (const character of characters) counts.set(character, (counts.get(character) ?? 0) + 1);
  const length = characters.length;
  if ([...counts.values()].some((count) => count * 4 > length)) return false;
  const entropy = [...counts.values()].reduce((total, count) => {
    const probability = count / length;
    return total - probability * Math.log2(probability);
  }, 0);
  // Require roughly 64 bits of estimated character entropy as well as the
  // per-character score. This still permits a genuinely random 16-character
  // token, while rejecting low-alphabet grouped strings that merely pass a
  // distribution-only threshold.
  return entropy >= 3.0 && entropy * length >= 64;
}

function isModelRef(value: unknown): value is ModelRef | null {
  return value === null || (isRecord(value) && isString(value.provider, 128) && isString(value.id, 256) &&
    (value.reasoning === undefined || typeof value.reasoning === 'boolean') &&
    (value.thinkingLevels === undefined || Array.isArray(value.thinkingLevels) && value.thinkingLevels.length > 0 && value.thinkingLevels.length <= 7 && value.thinkingLevels.every(isThinkingLevel) && new Set(value.thinkingLevels).size === value.thinkingLevels.length && (value.reasoning !== false || value.thinkingLevels.every(level => level === 'off'))));
}

function isHostInfo(value: unknown): value is HostInfo {
  return isRecord(value) && isString(value.hostId, 128) && typeof value.connected === "boolean" &&
    (value.ready === undefined || typeof value.ready === "boolean") && isNullableString(value.streamId, 128) && isNullableString(value.sessionId, 256) &&
    isNullableString(value.sessionName, 256) && isNullableString(value.cwd, 16_384);
}

function isTranscriptParts(value: unknown): value is TranscriptPart[] {
  if (!Array.isArray(value) || value.length > 500) return false;
  let previous = -1;
  for (const part of value) {
    if (!isRecord(part) || !isNonNegativeInteger(part.index) || part.index > 499 || part.index <= previous) return false;
    previous = part.index;
    if (part.type === "text" || part.type === "thinking") {
      if (typeof part.text !== "string" || part.text.length > MAX_TRANSCRIPT_TEXT) return false;
    } else if (part.type === "tool-call") {
      if (!isString(part.toolCallId, 256) || !isString(part.toolName, 256) || typeof part.argsText !== "string" || part.argsText.length > 4096) return false;
    } else return false;
  }
  return true;
}

function messageExtras(message: TranscriptMessage): Pick<TranscriptMessage, "parts" | "partsTruncated" | "toolIsError"> {
  return {
    ...(message.parts === undefined ? {} : { parts: message.parts.map((part): TranscriptPart => part.type === "tool-call"
      ? { index: part.index, type: part.type, toolCallId: part.toolCallId, toolName: part.toolName, argsText: part.argsText }
      : { index: part.index, type: part.type, text: part.text }) }),
    ...(message.partsTruncated === undefined ? {} : { partsTruncated: message.partsTruncated }),
    ...(message.toolIsError === undefined ? {} : { toolIsError: message.toolIsError }),
  };
}

// Shared compaction boundary: retain optional evidence when faithful, otherwise
// omit the complete parts array rather than presenting partial structure as full.
export function compactTranscriptMessage(message: TranscriptMessage, text = message.text, thinking = message.thinking, dropParts = false): TranscriptMessage {
  const result: TranscriptMessage = {
    id: message.id, role: message.role, text, thinking, timestamp: message.timestamp,
    status: message.status, toolName: message.toolName, toolCallId: message.toolCallId,
    ...messageExtras(message),
  };
  if (result.parts !== undefined && (dropParts || text !== message.text || thinking !== message.thinking)) {
    delete result.parts;
    result.partsTruncated = true;
  }
  return result;
}

function toolExtras(tool: ToolExecution): Pick<ToolExecution, "parentMessageId"> {
  return tool.parentMessageId === undefined ? {} : { parentMessageId: tool.parentMessageId };
}

function isTranscriptMessage(value: unknown): value is TranscriptMessage {
  if (!isRecord(value)) return false;
  return isString(value.id, 128) &&
    (value.role === "user" || value.role === "assistant" || value.role === "tool" || value.role === "system") &&
    typeof value.text === "string" && value.text.length <= MAX_TRANSCRIPT_TEXT && typeof value.thinking === "string" && value.thinking.length <= MAX_TRANSCRIPT_TEXT &&
    typeof value.timestamp === "number" && Number.isFinite(value.timestamp) &&
    (value.status === "streaming" || value.status === "complete" || value.status === "error") &&
    isNullableString(value.toolName, 256) && isNullableString(value.toolCallId, 256) &&
    (value.parts === undefined || (value.role === "assistant" && isTranscriptParts(value.parts))) &&
    (value.partsTruncated === undefined || typeof value.partsTruncated === "boolean") &&
    (value.toolIsError === undefined || (value.role === "tool" && typeof value.toolIsError === "boolean"));
}

function isToolExecution(value: unknown): value is ToolExecution {
  if (!isRecord(value)) return false;
  return isString(value.toolCallId, 256) && isString(value.toolName, 256) &&
    typeof value.argsText === "string" && value.argsText.length <= 64 * 1024 && typeof value.output === "string" && value.output.length <= 64 * 1024 &&
    (value.status === "running" || value.status === "complete" || value.status === "error") &&
    (value.parentMessageId === undefined || isString(value.parentMessageId, 128));
}

export function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (!isRecord(value)) return false;
  return value.protocolVersion === PROTOCOL_VERSION && isString(value.streamId, 128) &&
    isString(value.sessionId, 256) && isNullableString(value.sessionName, 256) &&
    typeof value.cwd === "string" && value.cwd.length <= 16_384 && isNullableString(value.activeLeafId, 128) &&
    isModelRef(value.model) && isThinkingLevel(value.thinkingLevel) &&
    (value.phase === "idle" || value.phase === "running" || value.phase === "waiting_local_ui") &&
    (value.sessionControl === undefined || typeof value.sessionControl === "boolean") &&
    (value.inputAssist === undefined || typeof value.inputAssist === "boolean") &&
    (value.execution === undefined || isExecutionState(value.execution)) &&
    typeof value.hasPendingMessages === "boolean" && Array.isArray(value.messages) && value.messages.length <= 1_000 &&
    value.messages.every(isTranscriptMessage) && (value.historyTruncated === undefined || typeof value.historyTruncated === "boolean") && Array.isArray(value.tools) && value.tools.length <= 500 &&
    value.tools.every(isToolExecution) && isNonNegativeInteger(value.lastEventSeq) && value.lastEventSeq <= MAX_EVENT_SEQUENCE;
}

export function isCommandPayload(value: unknown): value is CommandPayload {
  if (!isRecord(value)) return false;
  if (value.name === "prompt") {
    return isString(value.content, 64 * 1024) &&
      (value.delivery === undefined || value.delivery === "steer" || value.delivery === "followUp") &&
      (value.files === undefined || Array.isArray(value.files) && value.files.length <= 8 && value.files.every(path => isString(path, 4096)));
  }
  if (value.name === "list_commands") return true;
  if (value.name === "run_command") return isString(value.command, 65536) && value.command.startsWith('/') && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.command);
  if (value.name === "abort") return true;
  if (value.name === "set_thinking") return isThinkingLevel(value.level);
  if (value.name === "set_model") return isString(value.provider, 128) && isString(value.modelId, 256);
  if (value.name === "list_dir") return typeof value.path === "string" && value.path.length <= 4_096;
  if (value.name === "read_file") {
    return typeof value.path === "string" && value.path.length <= 4_096 &&
      (value.offset === undefined || (isNonNegativeInteger(value.offset) && value.offset <= 100_000_000)) &&
      (value.limit === undefined || (isNonNegativeInteger(value.limit) && value.limit > 0 && value.limit <= 256 * 1024));
  }
  if (value.name === "list_sessions") return true;
  if (value.name === "get_session" || value.name === "resume_session") return isString(value.sessionId, 256);
  if (value.name === "new_session") return true;
  if (value.name === "rename_session") return isString(value.title, 256) && value.title.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value.title);
  return false;
}

function isCollabEvent(value: unknown): value is CollabEvent {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "session_state":
      return (value.phase === "idle" || value.phase === "running" || value.phase === "waiting_local_ui") &&
        typeof value.hasPendingMessages === "boolean" && (value.execution === undefined || isExecutionState(value.execution));
    case "message_started":
    case "message_finished":
      return isTranscriptMessage(value.message);
    case "message_delta":
      return isString(value.messageId, 128) && (value.channel === "text" || value.channel === "thinking") &&
        typeof value.delta === "string" && value.delta.length <= MAX_TRANSCRIPT_TEXT &&
        (value.partIndex === undefined || (isNonNegativeInteger(value.partIndex) && value.partIndex <= 499));
    case "tool_started":
    case "tool_finished":
      return isToolExecution(value.tool);
    case "tool_updated":
      return isString(value.toolCallId, 256) && typeof value.output === "string" && value.output.length <= MAX_TOOL_OUTPUT;
    case "model_changed":
      return isModelRef(value.model);
    case "thinking_changed":
      return isThinkingLevel(value.level);
    case "ui_wait":
      return typeof value.waiting === "boolean" && isNullableString(value.title, 512) && (value.promptKind === undefined || isPromptKind(value.promptKind));
    case "notice":
      return (value.level === "info" || value.level === "warning" || value.level === "error") &&
        isString(value.message, 16_384);
    default:
      return false;
  }
}

export function decodeWireMessage(raw: string): WireMessage {
  if (typeof raw !== "string" || raw.length > MAX_FRAME_BYTES) {
    throw new ProtocolDecodeError("Message exceeds the relay frame limit");
  }
  const rawFrameSize = UTF8_ENCODER.encode(raw).byteLength;
  if (rawFrameSize > MAX_FRAME_BYTES) {
    throw new ProtocolDecodeError("Message exceeds the relay frame limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProtocolDecodeError("Message is not valid JSON");
  }
  if (!isRecord(value) || !isString(value.type, 64)) {
    throw new ProtocolDecodeError("Message must be an object with a type");
  }

  let valid = false;
  switch (value.type) {
    case "hello":
      valid = value.protocolVersion === PROTOCOL_VERSION && isPeerRole(value.peerRole) &&
        isString(value.peerId, 128) && isString(value.roomId, 128) && isString(value.token, 4096);
      break;
    case "welcome":
      valid = value.protocolVersion === PROTOCOL_VERSION && isString(value.connectionId, 128) &&
        isPeerRole(value.peerRole) && isString(value.roomId, 128) && typeof value.hostConnected === "boolean";
      break;
    case "host_status":
      valid = typeof value.connected === "boolean" && isNullableString(value.streamId, 128) &&
        isNullableString(value.sessionId, 256) &&
        (value.hostId === undefined || isNullableString(value.hostId, 128)) &&
        (value.hosts === undefined || (Array.isArray(value.hosts) && value.hosts.length <= MAX_HOSTS_PER_ROOM && value.hosts.every(isHostInfo)));
      break;
    case "snapshot":
      valid = (value.hostId === undefined || isString(value.hostId, 128)) && isSessionSnapshot(value.snapshot);
      break;
    case "event":
      valid = (value.hostId === undefined || isString(value.hostId, 128)) &&
        isString(value.streamId, 128) && isString(value.sessionId, 256) &&
        isNonNegativeInteger(value.seq) && value.seq <= MAX_EVENT_SEQUENCE && isString(value.emittedAt, 64) && isCollabEvent(value.event);
      break;
    case "command":
      valid = isString(value.requestId, 128) && isString(value.expectedStreamId, 128) &&
        (value.expectedSessionId === undefined || isString(value.expectedSessionId, 256)) &&
        (value.expectedCwd === undefined || isString(value.expectedCwd, 16_384)) &&
        (value.targetHostId === undefined || isString(value.targetHostId, 128)) && isCommandPayload(value.payload);
      break;
    case "routed_command":
      valid = isString(value.relayRequestId, 128) && isString(value.clientRequestId, 128) &&
        isString(value.sourcePeerId, 128) && isString(value.expectedStreamId, 128) &&
        (value.expectedSessionId === undefined || isString(value.expectedSessionId, 256)) &&
        (value.expectedCwd === undefined || isString(value.expectedCwd, 16_384)) &&
        (value.targetHostId === undefined || isString(value.targetHostId, 128)) &&
        isCommandPayload(value.payload);
      break;
    case "host_command_result":
      valid = isString(value.relayRequestId, 128) &&
        (value.status === "dispatched" || value.status === "applied" || value.status === "rejected") &&
        isNullableString(value.code, 128) && isNullableString(value.message, 2048) &&
        (value.data === undefined || isJsonValue(value.data));
      break;
    case "command_result":
      valid = (value.hostId === undefined || isString(value.hostId, 128)) && isString(value.requestId, 128) &&
        (value.status === "dispatched" || value.status === "applied" || value.status === "rejected") &&
        isNullableString(value.code, 128) && isNullableString(value.message, 2048) &&
        (value.data === undefined || isJsonValue(value.data));
      break;
    case "error":
      valid = isString(value.code, 128) && isString(value.message, 2048);
      break;
  }

  if (!valid) throw new ProtocolDecodeError(`Invalid ${value.type} message`);
  return canonicalWireMessage(value);
}

function upsertMessage(messages: TranscriptMessage[], message: TranscriptMessage): TranscriptMessage[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index === -1) return messages.length >= MAX_APPLIED_MESSAGES
    ? [...messages.slice(-(MAX_APPLIED_MESSAGES - 1)), message]
    : [...messages, message];
  const next = [...messages];
  next[index] = message;
  return next;
}

function upsertTool(tools: ToolExecution[], tool: ToolExecution): ToolExecution[] {
  const index = tools.findIndex((item) => item.toolCallId === tool.toolCallId);
  if (index === -1) return tools.length >= MAX_APPLIED_TOOLS
    ? [...tools.slice(-(MAX_APPLIED_TOOLS - 1)), tool]
    : [...tools, tool];
  const next = [...tools];
  next[index] = tool;
  return next;
}

function appendBounded(value: string, delta: string, maxLength: number): string {
  if (value.length >= maxLength) return safePrefix(value, maxLength);
  return safePrefix(`${value}${delta}`, maxLength);
}

function boundedTranscriptMessage(message: TranscriptMessage): { value: TranscriptMessage; truncated: boolean } {
  const text = safePrefix(message.text, MAX_TRANSCRIPT_TEXT);
  const thinking = safePrefix(message.thinking, MAX_TRANSCRIPT_TEXT);
  return {
    value: compactTranscriptMessage(message, text, thinking),
    truncated: message.partsTruncated === true || text.length !== message.text.length || thinking.length !== message.thinking.length,
  };
}

function boundedToolExecution(tool: ToolExecution): { value: ToolExecution; truncated: boolean } {
  const argsText = safePrefix(tool.argsText, MAX_TOOL_OUTPUT);
  const output = safePrefix(tool.output, MAX_TOOL_OUTPUT);
  return {
    value: {
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      argsText,
      output,
      status: tool.status,
      ...toolExtras(tool),
    },
    truncated: argsText.length !== tool.argsText.length || output.length !== tool.output.length,
  };
}

function canonicalModel(model: ModelRef | null): ModelRef | null {
  return model ? { provider: model.provider, id: model.id, ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}), ...(model.thinkingLevels !== undefined ? { thinkingLevels: [...model.thinkingLevels] } : {}) } : null;
}

export function canonicalCommandPayload(payload: CommandPayload): CommandPayload {
  switch (payload.name) {
    case "prompt":
      return {
        name: "prompt",
        content: payload.content,
        ...(payload.delivery === undefined ? {} : { delivery: payload.delivery }),
        ...(payload.files === undefined ? {} : { files: [...payload.files] }),
      };
    case "list_commands":
      return { name: "list_commands" };
    case "run_command":
      return { name: "run_command", command: payload.command };
    case "abort":
      return { name: "abort" };
    case "set_thinking":
      return { name: "set_thinking", level: payload.level };
    case "set_model":
      return { name: "set_model", provider: payload.provider, modelId: payload.modelId };
    case "list_dir":
      return { name: "list_dir", path: payload.path };
    case "read_file":
      return {
        name: "read_file",
        path: payload.path,
        ...(payload.offset === undefined ? {} : { offset: payload.offset }),
        ...(payload.limit === undefined ? {} : { limit: payload.limit }),
      };
    case "list_sessions":
      return { name: "list_sessions" };
    case "get_session":
      return { name: "get_session", sessionId: payload.sessionId };
    case "new_session":
      return { name: "new_session" };
    case "rename_session":
      return { name: "rename_session", title: payload.title };
    case "resume_session":
      return { name: "resume_session", sessionId: payload.sessionId };
    default:
      throw new ProtocolDecodeError("Invalid command payload");
  }
}

export function canonicalEvent(event: CollabEvent): CollabEvent {
  switch (event.kind) {
    case "session_state":
      return { kind: "session_state", phase: event.phase, hasPendingMessages: event.hasPendingMessages, ...(event.execution === undefined ? {} : {execution: canonicalExecution(event.execution)}) };
    case "message_started":
    case "message_finished":
      return {
        kind: event.kind,
        message: {
          id: event.message.id,
          role: event.message.role,
          text: event.message.text,
          thinking: event.message.thinking,
          timestamp: event.message.timestamp,
          status: event.message.status,
          toolName: event.message.toolName,
          toolCallId: event.message.toolCallId,
          ...messageExtras(event.message),
        },
      };
    case "message_delta":
      return {
        kind: "message_delta",
        messageId: event.messageId,
        channel: event.channel,
        delta: event.delta,
        ...(event.partIndex === undefined ? {} : { partIndex: event.partIndex }),
      };
    case "tool_started":
    case "tool_finished":
      return {
        kind: event.kind,
        tool: {
          toolCallId: event.tool.toolCallId,
          toolName: event.tool.toolName,
          argsText: event.tool.argsText,
          output: event.tool.output,
          status: event.tool.status,
          ...toolExtras(event.tool),
        },
      };
    case "tool_updated":
      return { kind: "tool_updated", toolCallId: event.toolCallId, output: event.output };
    case "model_changed":
      return { kind: "model_changed", model: canonicalModel(event.model) };
    case "thinking_changed":
      return { kind: "thinking_changed", level: event.level };
    case "ui_wait":
      return { kind: "ui_wait", waiting: event.waiting, title: event.title === null ? null : safePrefix(event.title, 512), ...(event.promptKind === undefined ? {} : {promptKind:event.promptKind}) };
    case "notice":
      return { kind: "notice", level: event.level, message: safePrefix(event.message, 16_384) };
    default:
      throw new ProtocolDecodeError("Invalid collaboration event");
  }
}

function canonicalWireMessage(value: Record<string, unknown>): WireMessage {
  switch (value.type) {
    case "hello":
      return {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        peerRole: value.peerRole as PeerRole,
        peerId: value.peerId as string,
        roomId: value.roomId as string,
        token: value.token as string,
      };
    case "welcome":
      return {
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        connectionId: value.connectionId as string,
        peerRole: value.peerRole as PeerRole,
        roomId: value.roomId as string,
        hostConnected: value.hostConnected as boolean,
      };
    case "host_status": {
      const hosts = Array.isArray(value.hosts) ? value.hosts.map((host) => {
        const info = host as HostInfo;
        return {
          hostId: info.hostId,
          connected: info.connected,
          ...(info.ready === undefined ? {} : { ready: info.ready }),
          streamId: info.streamId,
          sessionId: info.sessionId,
          sessionName: info.sessionName,
          cwd: info.cwd,
        };
      }) : undefined;
      return {
        type: "host_status",
        connected: value.connected as boolean,
        streamId: value.streamId as string | null,
        sessionId: value.sessionId as string | null,
        ...(value.hostId === undefined ? {} : { hostId: value.hostId as string | null }),
        ...(hosts === undefined ? {} : { hosts }),
      };
    }
    case "snapshot": {
      const snapshot = value.snapshot as SessionSnapshot;
      return {
        type: "snapshot",
        ...(value.hostId === undefined ? {} : { hostId: value.hostId as string }),
        snapshot: canonicalSnapshot(snapshot, snapshot.messages, snapshot.tools, snapshot.historyTruncated === true, snapshot.lastEventSeq),
      };
    }
    case "event":
      return {
        type: "event",
        ...(value.hostId === undefined ? {} : { hostId: value.hostId as string }),
        streamId: value.streamId as string,
        sessionId: value.sessionId as string,
        seq: value.seq as number,
        emittedAt: value.emittedAt as string,
        event: canonicalEvent(value.event as CollabEvent),
      };
    case "command":
      return {
        type: "command",
        requestId: value.requestId as string,
        expectedStreamId: value.expectedStreamId as string,
        ...(value.expectedSessionId === undefined ? {} : { expectedSessionId: value.expectedSessionId as string }),
        ...(value.expectedCwd === undefined ? {} : { expectedCwd: value.expectedCwd as string }),
        ...(value.targetHostId === undefined ? {} : { targetHostId: value.targetHostId as string }),
        payload: canonicalCommandPayload(value.payload as CommandPayload),
      };
    case "routed_command":
      return {
        type: "routed_command",
        relayRequestId: value.relayRequestId as string,
        clientRequestId: value.clientRequestId as string,
        sourcePeerId: value.sourcePeerId as string,
        expectedStreamId: value.expectedStreamId as string,
        ...(value.expectedSessionId === undefined ? {} : { expectedSessionId: value.expectedSessionId as string }),
        ...(value.expectedCwd === undefined ? {} : { expectedCwd: value.expectedCwd as string }),
        ...(value.targetHostId === undefined ? {} : { targetHostId: value.targetHostId as string }),
        payload: canonicalCommandPayload(value.payload as CommandPayload),
      };
    case "host_command_result": {
      const data = value.data === undefined ? undefined : canonicalJsonValue(value.data);
      return {
        type: "host_command_result",
        relayRequestId: value.relayRequestId as string,
        status: value.status as CommandStatus,
        code: value.code as string | null,
        message: value.message as string | null,
        ...(data === undefined ? {} : { data }),
      };
    }
    case "command_result": {
      const data = value.data === undefined ? undefined : canonicalJsonValue(value.data);
      return {
        type: "command_result",
        ...(value.hostId === undefined ? {} : { hostId: value.hostId as string }),
        requestId: value.requestId as string,
        status: value.status as CommandStatus,
        code: value.code as string | null,
        message: value.message as string | null,
        ...(data === undefined ? {} : { data }),
      };
    }
    case "error":
      return {
        type: "error",
        code: value.code as string,
        message: value.message as string,
      };
    default:
      throw new ProtocolDecodeError("Invalid relay message");
  }
}

function canonicalSnapshot(
  snapshot: SessionSnapshot,
  messages: TranscriptMessage[] = snapshot.messages,
  tools: ToolExecution[] = snapshot.tools,
  historyTruncated = snapshot.historyTruncated === true,
  lastEventSeq = snapshot.lastEventSeq,
): SessionSnapshot {
  let normalizedHistoryTruncated = historyTruncated;
  const normalizedMessages = messages.map((message) => {
    const text = safePrefix(message.text, MAX_TRANSCRIPT_TEXT);
    const thinking = safePrefix(message.thinking, MAX_TRANSCRIPT_TEXT);
    normalizedHistoryTruncated ||= message.partsTruncated === true || text.length !== message.text.length || thinking.length !== message.thinking.length;
    return compactTranscriptMessage(message, text, thinking);
  });
  const normalizedTools = tools.map((tool) => {
    const argsText = safePrefix(tool.argsText, MAX_TOOL_OUTPUT);
    const output = safePrefix(tool.output, MAX_TOOL_OUTPUT);
    normalizedHistoryTruncated ||= argsText.length !== tool.argsText.length || output.length !== tool.output.length;
    return {
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      argsText,
      output,
      status: tool.status,
      ...toolExtras(tool),
    };
  });
  return {
    protocolVersion: PROTOCOL_VERSION,
    streamId: snapshot.streamId,
    sessionId: snapshot.sessionId,
    sessionName: snapshot.sessionName,
    cwd: snapshot.cwd,
    activeLeafId: snapshot.activeLeafId,
    model: canonicalModel(snapshot.model),
    thinkingLevel: snapshot.thinkingLevel,
    phase: snapshot.phase,
    hasPendingMessages: snapshot.hasPendingMessages,
    ...(snapshot.execution === undefined ? {} : {execution:canonicalExecution(snapshot.execution)}),
    messages: normalizedMessages,
    historyTruncated: normalizedHistoryTruncated,
    tools: normalizedTools,
    ...(snapshot.sessionControl === undefined ? {} : { sessionControl: snapshot.sessionControl }),
    ...(snapshot.inputAssist === undefined ? {} : { inputAssist: snapshot.inputAssist }),
    lastEventSeq,
  };
}

export function applyEvent(snapshot: SessionSnapshot, envelope: EventEnvelope): SessionSnapshot {
  if (snapshot.streamId !== envelope.streamId || snapshot.sessionId !== envelope.sessionId) {
    throw new Error("Event does not belong to this snapshot");
  }
  if (envelope.seq !== snapshot.lastEventSeq + 1) {
    throw new Error(`Event sequence gap: expected ${snapshot.lastEventSeq + 1}, received ${envelope.seq}`);
  }

  const next = canonicalSnapshot(snapshot, snapshot.messages, snapshot.tools, snapshot.historyTruncated === true, envelope.seq);
  const event = canonicalEvent(envelope.event);
  switch (event.kind) {
    case "session_state": {
      // Missing metadata is an older host, not permission to retain a newer stale result.
      delete next.execution;
      return { ...next, phase: event.phase, hasPendingMessages: event.hasPendingMessages, ...(event.execution === undefined ? {} : {execution:canonicalExecution(event.execution)}) };
    }
    case "message_started":
    case "message_finished": {
      const bounded = boundedTranscriptMessage(event.message);
      const existed = next.messages.some((item) => item.id === bounded.value.id);
      const wasAtCapacity = next.messages.length >= MAX_APPLIED_MESSAGES;
      const messages = upsertMessage(next.messages, bounded.value);
      return {
        ...next,
        messages,
        historyTruncated: next.historyTruncated || bounded.truncated || (!existed && wasAtCapacity),
      };
    }
    case "message_delta": {
      const message = next.messages.find((item) => item.id === event.messageId);
      if (!message) return { ...next, historyTruncated: next.historyTruncated || event.delta.length > 0 };
      const updated: TranscriptMessage = event.channel === "text"
        ? { ...message, text: appendBounded(message.text, event.delta, MAX_TRANSCRIPT_TEXT) }
        : { ...message, thinking: appendBounded(message.thinking, event.delta, MAX_TRANSCRIPT_TEXT) };
      const previousLength = event.channel === "text" ? message.text.length : message.thinking.length;
      if (event.partIndex !== undefined || message.parts !== undefined) {
        if (event.partIndex === undefined || message.parts === undefined || message.role !== "assistant") {
          delete updated.parts;
          updated.partsTruncated = true;
        } else {
          const existing = message.parts.find(part => part.index === event.partIndex);
          if (existing && existing.type !== event.channel) throw new Error("Message part type conflicts with delta channel");
          const text = existing?.text ?? "";
          if (text.length + event.delta.length > MAX_TRANSCRIPT_TEXT) {
            delete updated.parts;
            updated.partsTruncated = true;
          } else {
            const part: TranscriptPart = { index: event.partIndex, type: event.channel, text: text + event.delta };
            updated.parts = [...message.parts.filter(item => item.index !== event.partIndex), part].sort((a, b) => a.index - b.index);
          }
        }
      }
      return {
        ...next,
        messages: upsertMessage(next.messages, updated),
        historyTruncated: next.historyTruncated || updated.partsTruncated === true || previousLength + event.delta.length > MAX_TRANSCRIPT_TEXT,
      };
    }
    case "tool_started":
    case "tool_finished": {
      const bounded = boundedToolExecution(event.tool);
      const existed = next.tools.some((item) => item.toolCallId === bounded.value.toolCallId);
      const wasAtCapacity = next.tools.length >= MAX_APPLIED_TOOLS;
      const tools = upsertTool(next.tools, bounded.value);
      return {
        ...next,
        tools,
        historyTruncated: next.historyTruncated || bounded.truncated || (!existed && wasAtCapacity),
      };
    }
    case "tool_updated": {
      const tool = next.tools.find((item) => item.toolCallId === event.toolCallId);
      return tool
        ? {
            ...next,
            tools: upsertTool(next.tools, {
              toolCallId: tool.toolCallId,
              toolName: tool.toolName,
              argsText: tool.argsText,
              output: safePrefix(event.output, MAX_TOOL_OUTPUT),
              status: tool.status,
              ...toolExtras(tool),
            }),
            historyTruncated: next.historyTruncated || event.output.length > MAX_TOOL_OUTPUT,
          }
        : { ...next, historyTruncated: true };
    }
    case "model_changed":
      return { ...next, model: canonicalModel(event.model) };
    case "thinking_changed":
      return { ...next, thinkingLevel: event.level };
    case "ui_wait": {
      if (next.execution) next.execution = {version:1,runId:next.execution.runId,activity:event.waiting?'waiting':'working',outcome:'none',...(event.waiting && event.promptKind ? {waitKind:event.promptKind}: {})};
      return { ...next, phase: event.waiting ? "waiting_local_ui" : "running" };
    }
    case "notice":
      return next;
  }
}
