import { pageEvents, maxBatchMessages, type ControlEvent, type EventMemory } from '../../scripts/listener-events.mjs';
import { RoomError, type Snapshot } from './client.js';

export interface ControlBatch { id: number; events: ControlEvent[] }
export interface ControlState {
  seen: EventMemory; pending: ControlBatch[]; serial: number; goalConsumed: number; goalDelivered: number[];
}
export const newControlState = (): ControlState => ({ seen: {}, pending: [], serial: 0, goalConsumed: 0, goalDelivered: [] });
export const sameControls = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Host receipt is independent of message progress and explicit Goal consumption. */
export function controlReceipt(state: ControlState, batch: ControlBatch, skipped = false): ControlState {
  if (!sameControls(state.pending[0], batch)) throw new RoomError('CONTROL_RECEIPT_MISMATCH');
  return { ...state, pending: state.pending.slice(1), goalDelivered: skipped ? state.goalDelivered : [...new Set([
    ...state.goalDelivered, ...batch.events.flatMap(e => e.type === 'goal' ? [e.revision] : []),
  ])] };
}
export function captureControls(state: ControlState, page: Snapshot, me: string): ControlState {
  const next = structuredClone(state);
  const events = pageEvents(next.seen, page, [], me, next.goalConsumed).filter((e): e is ControlEvent => e.type !== 'msg' && e.type !== 'backlog');
  for (let i = 0; i < events.length; i += maxBatchMessages) {
    if (!Number.isSafeInteger(next.serial + 1)) throw new RoomError('CONTROL_SEQUENCE_EXHAUSTED');
    next.pending.push({ id: ++next.serial, events: events.slice(i, i + maxBatchMessages) });
  }
  return next;
}
