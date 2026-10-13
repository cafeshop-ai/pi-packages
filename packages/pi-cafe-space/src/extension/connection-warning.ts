export const CONNECTION_WARNING_INTERVAL_MS = 120_000;
export const CONNECTION_WARNING_GRACE_MS = 10_000;
export const CONNECTION_RECOVERY_STABLE_MS = 60_000;

/**
 * Limits repeated connection-failure notifications without changing the
 * connector's retry/backoff behavior or its status-bar state.
 */
export class ConnectionWarningThrottle {
  private lastWarningAt: number | null = null;

  allow(now = Date.now()): boolean {
    if (!Number.isFinite(now)) return false;
    if (this.lastWarningAt !== null) {
      const elapsed = now - this.lastWarningAt;
      if (elapsed >= 0 && elapsed < CONNECTION_WARNING_INTERVAL_MS) return false;
      // A wall-clock correction must not suppress warnings until the old
      // timestamp eventually catches up. Start one fresh bounded window at
      // the corrected time instead.
    }
    this.lastWarningAt = now;
    return true;
  }

  reset(): void {
    this.lastWarningAt = null;
  }
}

/**
 * Owns the warning lifecycle separately from socket status/reconnect state.
 * Failed construction, error, and close transitions all share one window;
 * short reconnects never reset the notification budget. Status stays immediate;
 * only notifications are delayed, and recovery requires a stable connection.
 */
export class ConnectionWarningReporter {
  private readonly throttle = new ConnectionWarningThrottle();

  private pending: ReturnType<typeof setTimeout> | null = null;
  private pendingMessage: string | null = null;
  private warned = false;
  private recovery: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly notify: (message: string) => void,
    private readonly recovered?: () => void,
  ) {}

  // Retry errors update the detail but do not postpone the original deadline.
  // The owner cancels this pending warning on authenticated welcome or stop.
  reportTransient(message: string): void {
    if (this.recovery !== null) clearTimeout(this.recovery);
    this.recovery = null;
    this.pendingMessage = message;
    if (this.warned || this.pending !== null) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      const detail = this.pendingMessage;
      this.pendingMessage = null;
      if (detail !== null) this.report(detail);
    }, CONNECTION_WARNING_GRACE_MS);
    this.pending.unref?.();
  }

  report(message: string, now = Date.now()): boolean {
    if (this.recovery !== null) clearTimeout(this.recovery);
    this.recovery = null;
    if (this.warned || !this.throttle.allow(now)) return false;
    this.warned = true;
    try {
      this.notify(message);
    } catch {
      // A notification sink may belong to an invalidated Pi UI context. The
      // throttle state must still advance so a failing sink cannot be spammed.
    }
    return true;
  }

  reset(): void {
    if (this.recovery !== null) clearTimeout(this.recovery);
    this.recovery = null;
    if (this.pending !== null) clearTimeout(this.pending);
    this.pending = null;
    this.pendingMessage = null;
    this.warned = false;
    this.throttle.reset();
  }

  onAuthenticatedWelcome(): void {
    if (this.pending !== null) clearTimeout(this.pending);
    this.pending = null; this.pendingMessage = null;
    if (!this.warned || this.recovery !== null) return;
    this.recovery = setTimeout(() => {
      this.recovery = null;
      if (!this.warned) return;
      this.warned = false;
      try { this.recovered?.(); } catch { /* the old UI may already be disposed */ }
    }, CONNECTION_RECOVERY_STABLE_MS);
    this.recovery.unref?.();
  }

  onExplicitStop(): void {
    this.reset();
  }
}
