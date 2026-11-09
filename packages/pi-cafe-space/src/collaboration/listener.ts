import { RoomClient, RoomError, type Message, type Snapshot } from './client.js';
import { maxBatchMessages } from '../../scripts/listener-events.mjs';
import { captureControls, controlReceipt, newControlState, sameControls, type ControlBatch, type ControlState } from './controls.js';

export interface ListenerHost {
  isIdle(): boolean;
  deliver(messages: readonly Message[], backlog?: boolean): void;
  checkpoint(cursor: number, consumed?: boolean, messages?: readonly number[]): void;
  deliverControls?(batch: ControlBatch): void;
  checkpointControls?(state: ControlState): void;
}
/** Receipt means Pi stored the external message, not that a model read it or completed work. */
export class RoomListener {
  cursor: number;
  state: 'listening' | 'waiting-for-idle' | 'awaiting-host-receipt' | 'room-paused' | 'paused' = 'listening';
  error: string | undefined;
  names: Record<string, string> = {};
  private queued: Message[] = [];
  private readonly abort = new AbortController();
  private polling: Promise<number> | undefined;
  private awaitingReceipt = false;
  private dispatchedAt = 0;
  private summaryPending = false;
  private controlPending: number | undefined;
  constructor(readonly client: RoomClient, private readonly host: ListenerHost, cursor: number, private deliveredCursor = 0, private backlogThrough = 0, private controls = newControlState(), private unconsumedDelivered: number[] = []) {
    if (unconsumedDelivered.some((seq, i) => !Number.isSafeInteger(seq) || seq < 1 || seq > cursor || (i > 0 && seq <= unconsumedDelivered[i - 1]!))) throw new RoomError('INVALID_CURSOR');
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(deliveredCursor) || deliveredCursor < 0 || deliveredCursor > cursor || !Number.isSafeInteger(backlogThrough) || backlogThrough < 0) throw new RoomError('INVALID_CURSOR');
    if (!!host.deliverControls !== !!host.checkpointControls) throw new RoomError('CONTROL_CHECKPOINT_REQUIRED');
    this.cursor = cursor;
  }
  get controlState(): ControlState { return structuredClone(this.controls); }
  captureControls(page: Snapshot) {
    if (this.host.deliverControls) this.saveControls(captureControls(this.controls, page, this.client.membership.memberId));
  }
  private saveControls(next: ControlState) {
    if (sameControls(next, this.controls)) return;
    try { this.host.checkpointControls?.(next); this.controls = next; }
    catch { this.error = 'CHECKPOINT_FAILED'; this.pause(); throw new RoomError('CHECKPOINT_FAILED'); }
  }
  acknowledgeControls(batch: ControlBatch) {
    if (this.controlPending !== batch.id) return;
    this.saveControls(controlReceipt(this.controls, batch));
    this.controlPending = undefined; this.awaitingReceipt = false;
    if (this.state !== 'paused') this.state = 'listening';
  }
  consumeGoal(revision: number) {
    if (!this.controls.goalDelivered.includes(revision)) throw new RoomError('DELIVERED_GOAL_REQUIRED');
    this.saveControls({ ...this.controls, goalConsumed: Math.max(this.controls.goalConsumed, revision) });
  }
  get delivered(): number { return this.deliveredCursor; }
  get pendingConsumptionBatch(): readonly number[] { return [...this.unconsumedDelivered.slice(0, maxBatchMessages), ...this.undispatchedBatch.map(m => m.seq)].slice(0, maxBatchMessages); }
  get pending(): Message | undefined { return this.queued[0]; }
  get undispatched(): Message | undefined { return this.undispatchedBatch[0]; }
  get undispatchedBatch(): readonly Message[] { return this.awaitingReceipt ? [] : this.queued.slice(0, maxBatchMessages); }
  pause() { this.state = 'paused'; this.abort.abort(); }
  acknowledge(sequence: number) {
    if (!this.awaitingReceipt || this.controlPending !== undefined || this.queued.at(-1)?.seq !== sequence) return;
    // Only the host's actual message event acknowledges dispatch, never sendMessage() returning void.
    if (this.summaryPending) this.backlogThrough = Math.max(this.backlogThrough, sequence);
    else {
      this.commit(sequence);
      this.deliveredCursor = Math.max(this.deliveredCursor, sequence);
      this.unconsumedDelivered.push(...this.queued.map(m => m.seq));
      this.queued = [];
    }
    this.summaryPending = false;
    this.awaitingReceipt = false;
    if (this.state !== 'paused') this.state = 'listening';
  }
  consume(sequence: number, through = false) {
    const pending = this.pendingConsumptionBatch, index = pending.indexOf(sequence);
    if (this.state === 'paused' || index < 0 || (!through && index !== 0)) throw new RoomError('NEXT_UNDISPATCHED_MESSAGE_REQUIRED');
    this.commit(sequence, true, through ? pending.slice(0, index + 1) : undefined);
    this.unconsumedDelivered = this.unconsumedDelivered.filter(seq => seq > sequence);
    this.queued = this.queued.filter(m => m.seq > sequence);
    if (this.state !== 'room-paused' && !this.awaitingReceipt) this.state = 'listening';
  }
  private commit(sequence: number, consumed = false, messages?: readonly number[]) {
    if (sequence <= this.cursor && !consumed) return;
    try {
      if (messages) this.host.checkpoint(sequence, true, messages);
      else if (consumed) this.host.checkpoint(sequence, true);
      else this.host.checkpoint(sequence);
      this.cursor = Math.max(this.cursor, sequence);
    }
    catch { this.error = 'CHECKPOINT_FAILED'; this.pause(); throw new RoomError('CHECKPOINT_FAILED'); }
  }
  poll(deliver = true): Promise<number> {
    if (this.state === 'paused') return Promise.resolve(5000);
    // Manual reads join the same in-flight fetch, never advance a separate cursor.
    return this.polling ??= this.readPending(deliver).finally(() => { this.polling = undefined; });
  }
  private async readPending(deliver: boolean): Promise<number> {
    try {
      if (this.awaitingReceipt && Date.now() - this.dispatchedAt >= 20000) { this.error = 'HOST_DELIVERY_UNKNOWN'; this.pause(); return 5000; }
      const snapshot = await this.client.read(this.cursor, this.abort.signal);
      if (this.abort.signal.aborted) return 5000;
      const active = new Set(snapshot.members.filter(m => !m.removed).map(m => m.id));
      const me = this.client.membership.memberId;
      this.names = Object.fromEntries(snapshot.members.map(m => [m.id, m.name]));
      if (this.queued.some(m => !active.has(m.memberId))) {
        this.error = 'SENDER_REMOVED'; this.pause(); return 5000;
      }
      if (!this.awaitingReceipt) {
        this.queued = [];
        for (const message of snapshot.messages) {
          if (message.seq <= this.cursor) continue;
          if (message.memberId !== me && active.has(message.memberId)) this.queued.push(message);
          else if (!this.queued.length) this.commit(message.seq);
        }
      }
      this.captureControls(snapshot);
      this.error = undefined;
      // Only the running background listener advertises presence, never a manual read or a reply.
      if (deliver && this.client.supportsPresence) await this.client.ack({ fetched: snapshot.cursor, delivered: this.deliveredCursor, paused: snapshot.aiPaused === true }, this.abort.signal);
      if (this.abort.signal.aborted) return 5000;
      if (snapshot.aiPaused) { this.state = 'room-paused'; return 5000; }
      if (!this.awaitingReceipt) this.state = 'listening';
      const controls = this.controls.pending[0];
      if (deliver && controls && !this.awaitingReceipt && this.host.deliverControls) {
        if (!this.host.isIdle()) { this.state = 'waiting-for-idle'; return 5000; }
        this.controlPending = controls.id; this.awaitingReceipt = true;
        this.state = 'awaiting-host-receipt'; this.dispatchedAt = Date.now();
        try { this.host.deliverControls(structuredClone(controls)); }
        catch { this.error = 'HOST_DELIVERY_UNKNOWN'; this.pause(); }
        return 5000;
      }
      if (deliver && this.pending && !this.awaitingReceipt) {
        const backlog = this.queued.length > maxBatchMessages;
        if (backlog && this.pending.seq <= this.backlogThrough) return 5000;
        if (!this.host.isIdle()) { this.state = 'waiting-for-idle'; return 5000; }
        this.summaryPending = backlog;
        this.awaitingReceipt = true;
        this.state = 'awaiting-host-receipt';
        this.dispatchedAt = Date.now();
        try { if (backlog) this.host.deliver(this.queued, true); else this.host.deliver(this.queued); }
        catch { this.error = 'HOST_DELIVERY_UNKNOWN'; this.pause(); }
      }
      return 5000;
    } catch (error) {
      if (this.abort.signal.aborted) return 5000;
      this.error = error instanceof RoomError ? error.code : 'LISTENER_FAILED';
      if (error instanceof RoomError && error.retryable) return error.retryAfterMs;
      this.pause(); return 5000;
    }
  }
}
