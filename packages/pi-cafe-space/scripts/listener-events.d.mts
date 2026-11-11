import type { Snapshot, Message } from '../src/collaboration/client.js';
export const listenerProtocol: string;
export const maxBatchMessages: number;
export type ControlEvent =
  | { type: 'task'; task: number; change: 'created' | 'updated' | 'deleted'; title: string; status?: string; assignee?: string; was?: string; reassigned?: boolean; result?: number }
  | { type: 'goal'; revision: number; goal?: number; status?: string; title?: string; deleted?: boolean }
  | { type: 'pause'; paused: boolean }
  | { type: 'member'; change: 'joined' | 'left'; member: string; kind?: string }
  | { type: 'waiting'; change: 'started' | 'ended'; member: string; waitingFor?: string; detail?: string; ref?: number };
export type ListenerEvent = ControlEvent
  | { type: 'msg'; seq: number; from: string; to?: string; replyTo?: number; text: string; truncated?: boolean; sentAt?: string }
  | { type: 'backlog'; from: number; to: number; count: number };
export interface EventMemory {
  names?: Record<string, string>; members?: Record<string, boolean>; tasks?: Record<string, string>; taskTitles?: Record<string, string>;
  goalShown?: number; paused?: boolean; waits?: Record<string, string>;
}
export function pageEvents(seen: EventMemory, page: Partial<Snapshot>, fresh: readonly Message[], me: string, goalConsumed?: number): ListenerEvent[];
export function formatEvent(
  event: ListenerEvent,
  names?: Record<string, string>,
  me?: string,
): string;
