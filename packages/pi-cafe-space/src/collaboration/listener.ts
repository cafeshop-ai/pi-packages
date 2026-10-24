import { RoomClient, RoomError, type Message } from './client.js';

export interface ListenerHost {
  isIdle(): boolean;
  deliver(message: Message): void;
  checkpoint(cursor: number, consumed?: boolean): void;
}
/** Receipt means Pi stored the external message, not that a model read it or completed work. */
export class RoomListener {
  cursor: number;
  state: 'listening' | 'waiting-for-idle' | 'awaiting-host-receipt' | 'room-paused' | 'paused' = 'listening';
  error: string | undefined;
  pending: Message | undefined;
  private readonly abort = new AbortController();
  private polling: Promise<number> | undefined;
  private awaitingReceipt = false;
  private dispatchedAt = 0;
  constructor(readonly client: RoomClient, private readonly host: ListenerHost, cursor: number, private deliveredCursor = 0) {
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > 500 || !Number.isInteger(deliveredCursor) || deliveredCursor < 0 || deliveredCursor > cursor) throw new RoomError('INVALID_CURSOR');
    this.cursor = cursor;
  }
  get undispatched(): Message | undefined { return this.awaitingReceipt ? undefined : this.pending; }
  pause() { this.state = 'paused'; this.abort.abort(); }
  acknowledge(sequence: number) {
    if (!this.awaitingReceipt || this.pending?.seq !== sequence) return;
    // Only the host's actual message event acknowledges dispatch, never sendMessage() returning void.
    this.commit(sequence);
    this.deliveredCursor = Math.max(this.deliveredCursor, sequence);
    this.pending = undefined;
    this.awaitingReceipt = false;
    if (this.state !== 'paused') this.state = 'listening';
  }
  consume(sequence: number) {
    if (this.state === 'paused' || this.awaitingReceipt || this.pending?.seq !== sequence) throw new RoomError('NEXT_UNDISPATCHED_MESSAGE_REQUIRED');
    this.commit(sequence, true); this.pending = undefined;
    if (this.state !== 'room-paused') this.state = 'listening';
  }
  private commit(sequence: number, consumed = false) {
    if (sequence <= this.cursor) return;
    try { if (consumed) this.host.checkpoint(sequence, true); else this.host.checkpoint(sequence); this.cursor = sequence; }
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
      if (this.pending && !active.has(this.pending.memberId)) {
        this.error = 'SENDER_REMOVED'; this.pause(); return 5000;
      }
      if (!this.pending) {
        for (const message of snapshot.messages) {
          if (message.seq <= this.cursor) continue;
          if (message.memberId !== me && active.has(message.memberId)) { this.pending = message; break; }
          this.commit(message.seq);
        }
      }
      this.error = undefined;
      // Only the running background listener advertises presence, never a manual read or a reply.
      if (deliver && this.client.supportsPresence) await this.client.ack({ fetched: snapshot.cursor, delivered: this.deliveredCursor, paused: snapshot.aiPaused === true }, this.abort.signal);
      if (this.abort.signal.aborted) return 5000;
      if (snapshot.aiPaused) { this.state = 'room-paused'; return 5000; }
      if (!this.awaitingReceipt) this.state = 'listening';
      if (deliver && this.pending && !this.awaitingReceipt) {
        if (!this.host.isIdle()) { this.state = 'waiting-for-idle'; return 5000; }
        this.awaitingReceipt = true;
        this.state = 'awaiting-host-receipt';
        this.dispatchedAt = Date.now();
        try { this.host.deliver(this.pending); }
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
