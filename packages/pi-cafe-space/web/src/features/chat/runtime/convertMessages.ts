import type { ThreadMessageLike } from '@assistant-ui/react';
import type { JsonValue, SessionSnapshot, ToolExecution, TranscriptMessage } from '../../../../../src/protocol/index';
import { scopeKey, type HostScope } from '../../../state/CollabStore';

export interface ToolView {
  readonly key: string;
  readonly callId: string;
  readonly name: string;
  readonly argsText: string;
  readonly argsValid: boolean;
  readonly output: string;
  readonly hasOutput: boolean;
  readonly status: 'pending' | 'running' | 'complete' | 'error';
  readonly conflict: boolean;
  readonly association: 'attached' | 'missing-parent' | 'ambiguous';
  readonly nestedTools?: readonly ToolView[];
}
type Part = Exclude<ThreadMessageLike['content'], string>[number];
type Owner = { message: TranscriptMessage; row: number; index: number };

// An intentionally smaller display-only JSON bound. Invalid/incomplete args use
// a data part, avoiding assistant-ui's automatic partial parse / {} fallback.
export function parseToolArgs(text: string): Record<string, JsonValue> | undefined {
  if (text.length > 4096) return undefined;
  let nodes = 0;
  const valid = (value: unknown, depth: number): value is JsonValue => {
    if (++nodes > 500 || depth > 6) return false;
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.length <= 100 && value.every(item => valid(item, depth + 1));
    if (typeof value !== 'object') return false;
    const entries = Object.entries(value);
    return entries.length <= 100 && entries.every(([key, item]) => !['__proto__', 'prototype', 'constructor'].includes(key) && valid(item, depth + 1));
  };
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) && valid(value, 0) ? value as Record<string, JsonValue> : undefined;
  } catch { return undefined; }
}
function unique<T>(items: readonly T[], id: (item: T) => string | null): Map<string, T | null> {
  const map = new Map<string, T | null>();
  for (const item of items) {
    const key = id(item);
    if (key) map.set(key, map.has(key) ? null : item);
  }
  return map;
}
function toolView(key: string, callId: string, name: string, argsText: string, association: ToolView['association'], execution?: ToolExecution, result?: TranscriptMessage, incomplete = false, badHint = false): ToolView {
  const failed = execution?.status === 'error' || result?.toolIsError === true || result?.status === 'error';
  const terminalExecution = execution && execution.status !== 'running';
  const conflict = badHint || !!(terminalExecution && result?.toolIsError !== undefined && (execution.status === 'error') !== result.toolIsError);
  return {
    key, callId, name, argsText, argsValid: !incomplete && parseToolArgs(argsText) !== undefined,
    output: result ? result.text : execution?.output ?? '',
    hasOutput: !!result || !!execution && (execution.status !== 'running' || execution.output !== ''),
    status: failed ? 'error' : result ? 'complete' : execution?.status ?? 'pending',
    conflict, association,
  };
}
function toolPart(view: ToolView): Part {
  const args = view.argsValid ? parseToolArgs(view.argsText) : undefined;
  if (args && view.association === 'attached') return {
    type: 'tool-call', toolCallId: view.callId, toolName: view.name, argsText: view.argsText, args,
    ...(view.hasOutput && view.status !== 'running' ? { result: view.output } : {}),
    isError: view.status === 'error', artifact: view,
  };
  return { type: 'data', name: 'pi-tool', data: view };
}

/** Pure read-only projection: no name/time inference, side effects, or runtime state. */
export function convertMessages(snapshot: Pick<SessionSnapshot, 'messages' | 'tools'>, scope: HostScope): ThreadMessageLike[] {
  const scopeId = scopeKey(scope);
  const key = (...items: (string | number)[]) => JSON.stringify([scopeId, ...items]);
  const occurrences = new Map<string, number>();
  const messageOccurrences = snapshot.messages.map(message => {
    const occurrence = occurrences.get(message.id) ?? 0;
    occurrences.set(message.id, occurrence + 1);
    return occurrence;
  });
  const owners = new Map<string, Owner | null>();
  snapshot.messages.forEach((message, row) => {
    if (message.role !== 'assistant') return;
    const calls = message.parts === undefined
      ? message.toolCallId ? [{ index: -1, toolCallId: message.toolCallId }] : []
      : message.parts.filter(part => part.type === 'tool-call');
    for (const call of calls) owners.set(call.toolCallId, owners.has(call.toolCallId) ? null : { message, row, index: call.index });
  });
  const results = unique(snapshot.messages.filter(m => m.role === 'tool'), m => m.toolCallId);
  const executions = unique(snapshot.tools, tool => tool.toolCallId);
  const foldedResults = new Set<TranscriptMessage>();
  const foldedExecutions = new Set<ToolExecution>();
  const rows = new Map<number, Part[]>();
  const nested = new Map<string, ToolView[]>();
  for (const execution of snapshot.tools) {
    if (owners.has(execution.toolCallId) || executions.get(execution.toolCallId) !== execution || results.get(execution.toolCallId) === null) continue;
    // Pi NestedToolCallRunner uses <callerId>/<positive integer>, not a name/time heuristic.
    // shortcut: only codemode parents are recognized without parentToolCallId on the wire; extend the protocol for other nesting tools.
    let parentId = execution.toolCallId;
    while (/\/[1-9]\d*$/.test(parentId)) {
      const separator = parentId.lastIndexOf('/');
      if (!Number.isSafeInteger(Number(parentId.slice(separator + 1)))) break;
      parentId = parentId.slice(0, separator);
      if (!owners.has(parentId)) continue;
      const parent = owners.get(parentId);
      const part = parent?.message.parts?.find(part => part.index === parent.index);
      const name = part?.type === 'tool-call' ? part.toolName : parent?.message.toolName;
      if (!parent || name !== 'codemode' || execution.parentMessageId && execution.parentMessageId !== parent.message.id) break;
      const result = results.get(execution.toolCallId) ?? undefined;
      const children = nested.get(parentId) ?? [];
      children.push(toolView(key('nested', parentId, execution.toolCallId), execution.toolCallId, execution.toolName, execution.argsText, 'attached', execution, result));
      nested.set(parentId, children);
      foldedExecutions.add(execution);
      if (result) foldedResults.add(result);
      break;
    }
  }
  snapshot.messages.forEach((message, row) => {
    if (message.role !== 'assistant') return;
    const call = (index: number, callId: string, name: string, rawArgs?: string): Part => {
      const owner = owners.get(callId);
      const attached = owner?.row === row && owner.index === index;
      const execution = attached ? executions.get(callId) ?? undefined : undefined;
      const result = attached ? results.get(callId) ?? undefined : undefined;
      if (result) foldedResults.add(result);
      if (execution) foldedExecutions.add(execution);
      const view = toolView(key('message', message.id, messageOccurrences[row]!, 'call', callId, index), callId, name,
        rawArgs ?? execution?.argsText ?? '', attached ? 'attached' : 'ambiguous', execution, result,
        message.partsTruncated === true, !!execution?.parentMessageId && execution.parentMessageId !== message.id);
      return toolPart(attached && nested.has(callId) ? { ...view, nestedTools: nested.get(callId)! } : view);
    };
    if (message.parts !== undefined) {
      rows.set(row, message.parts.map(part => part.type === 'tool-call'
        ? call(part.index, part.toolCallId, part.toolName, part.argsText)
        : { type: part.type === 'thinking' ? 'reasoning' : 'text', text: part.text, providerMetadata: { pi: { index: part.index } } }));
    } else {
      const parts: Part[] = [];
      if (message.thinking) parts.push({ type: 'reasoning', text: message.thinking, providerMetadata: { pi: { index: -1 } } });
      if (message.text) parts.push({ type: 'text', text: message.text });
      if (message.toolCallId) parts.push(call(-1, message.toolCallId, message.toolName ?? executions.get(message.toolCallId)?.toolName ?? 'tool'));
      rows.set(row, parts);
    }
  });
  const output: ThreadMessageLike[] = [];
  snapshot.messages.forEach((message, row) => {
    if (foldedResults.has(message)) return;
    const id = key('message', message.id, messageOccurrences[row]!);
    const metadata = { custom: { sourceId: message.id, sourceRole: message.role, incomplete: message.partsTruncated === true, projectionOnly: false } };
    if (message.role === 'tool') {
      const callId = message.toolCallId ?? '';
      const execution = executions.get(callId) ?? undefined;
      if (execution) foldedExecutions.add(execution);
      const view = toolView(key('result', message.id, messageOccurrences[row]!), callId, message.toolName ?? execution?.toolName ?? 'tool', execution?.argsText ?? '', owners.has(callId) ? 'ambiguous' : 'missing-parent', execution, message);
      output.push({ id, role: 'assistant', content: [{ type: 'data', name: 'pi-tool', data: view }], metadata, status: { type: 'complete', reason: 'unknown' } });
    } else if (message.role === 'assistant') {
      output.push({ id, role: 'assistant', content: rows.get(row) ?? [], metadata, status: message.status === 'streaming' ? { type: 'running' } : message.status === 'error' ? { type: 'incomplete', reason: 'error' } : { type: 'complete', reason: 'stop' } });
    } else {
      output.push({ id, role: message.role, content: [{ type: 'text', text: message.text }], metadata });
    }
  });
  const toolOccurrences = new Map<string, number>();
  snapshot.tools.forEach(execution => {
    const occurrence = toolOccurrences.get(execution.toolCallId) ?? 0;
    toolOccurrences.set(execution.toolCallId, occurrence + 1);
    if (foldedExecutions.has(execution) || results.has(execution.toolCallId)) return;
    const view = toolView(key('execution', execution.toolCallId, occurrence), execution.toolCallId, execution.toolName, execution.argsText, owners.has(execution.toolCallId) || executions.get(execution.toolCallId) === null ? 'ambiguous' : 'missing-parent', execution);
    output.push({ id: key('execution', execution.toolCallId, occurrence), role: 'assistant', content: [{ type: 'data', name: 'pi-tool', data: view }], metadata: { custom: { sourceRole: 'tool', projectionOnly: true, incomplete: false } }, status: { type: 'complete', reason: 'unknown' } });
  });
  return output;
}
