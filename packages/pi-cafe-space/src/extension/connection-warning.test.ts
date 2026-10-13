import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECTION_WARNING_GRACE_MS, CONNECTION_WARNING_INTERVAL_MS, CONNECTION_RECOVERY_STABLE_MS, ConnectionWarningReporter, ConnectionWarningThrottle } from "./connection-warning.js";

afterEach(() => { vi.useRealTimers(); });

describe('delayed connection notifications', () => {
  it('does not warn when the authenticated connection recovers during the grace period', () => {
    vi.useFakeTimers(); const warn=vi.fn(), restored=vi.fn(); const reporter=new ConnectionWarningReporter(warn,restored);
    reporter.reportTransient('temporary failure'); vi.advanceTimersByTime(CONNECTION_WARNING_GRACE_MS-1);
    expect(warn).not.toHaveBeenCalled(); reporter.onAuthenticatedWelcome(); vi.advanceTimersByTime(60_000);
    expect(warn).not.toHaveBeenCalled(); expect(restored).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('reports a persistent failure once, without resetting the deadline on every retry', () => {
    vi.useFakeTimers(); const warn=vi.fn(), restored=vi.fn(); const reporter=new ConnectionWarningReporter(warn,restored);
    reporter.reportTransient('first error'); vi.advanceTimersByTime(2000); reporter.reportTransient('latest error');
    vi.advanceTimersByTime(CONNECTION_WARNING_GRACE_MS-2000); expect(warn).toHaveBeenCalledExactlyOnceWith('latest error');
    reporter.reportTransient('another error'); vi.advanceTimersByTime(CONNECTION_WARNING_GRACE_MS); expect(warn).toHaveBeenCalledTimes(1);
    reporter.onAuthenticatedWelcome(); reporter.onAuthenticatedWelcome(); expect(restored).not.toHaveBeenCalled(); vi.advanceTimersByTime(CONNECTION_RECOVERY_STABLE_MS); expect(restored).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000); expect(warn).toHaveBeenCalledTimes(1);
  });
  it('cancels on explicit stop without announcing recovery, then permits a new episode', () => {
    vi.useFakeTimers(); const warn=vi.fn(), restored=vi.fn(); const reporter=new ConnectionWarningReporter(warn,restored);
    reporter.reportTransient('stale lifecycle'); reporter.onExplicitStop(); vi.advanceTimersByTime(CONNECTION_WARNING_GRACE_MS);
    expect(warn).not.toHaveBeenCalled(); expect(restored).not.toHaveBeenCalled();
    reporter.reportTransient('new lifecycle'); vi.advanceTimersByTime(CONNECTION_WARNING_GRACE_MS); expect(warn).toHaveBeenCalledExactlyOnceWith('new lifecycle');
    reporter.onExplicitStop(); reporter.onAuthenticatedWelcome(); expect(restored).not.toHaveBeenCalled();
  });
});

describe("connection warning throttle", () => {
  it("allows the first warning, suppresses repeats during the interval, and resets", () => {
    const throttle = new ConnectionWarningThrottle();
    const first = 10_000;

    expect(throttle.allow(first)).toBe(true);
    expect(throttle.allow(first + 1)).toBe(false);
    expect(throttle.allow(first + CONNECTION_WARNING_INTERVAL_MS - 1)).toBe(false);
    expect(throttle.allow(first + CONNECTION_WARNING_INTERVAL_MS)).toBe(true);

    throttle.reset();
    expect(throttle.allow(first + 2)).toBe(true);
  });

  it("keeps one warning window across failed retry attempts", () => {
    const throttle = new ConnectionWarningThrottle();
    const first = 50_000;

    expect(throttle.allow(first)).toBe(true);
    // A disconnect/retry does not call reset(); all failures in this episode
    // remain suppressed until the interval has elapsed.
    expect(throttle.allow(first + 500)).toBe(false);
    expect(throttle.allow(first + 9_999)).toBe(false);
    expect(throttle.allow(first + CONNECTION_WARNING_INTERVAL_MS - 1)).toBe(false);
    expect(throttle.allow(first + CONNECTION_WARNING_INTERVAL_MS)).toBe(true);
  });

  it("does not disable throttling when the clock value is invalid", () => {
    const throttle = new ConnectionWarningThrottle();

    expect(throttle.allow(Number.NaN)).toBe(false);
    expect(throttle.allow(20_000)).toBe(true);
    expect(throttle.allow(Number.POSITIVE_INFINITY)).toBe(false);
    expect(throttle.allow(20_001)).toBe(false);
  });

  it("starts a bounded warning window after the wall clock moves backwards", () => {
    const throttle = new ConnectionWarningThrottle();

    expect(throttle.allow(100_000)).toBe(true);
    expect(throttle.allow(10_000)).toBe(true);
    expect(throttle.allow(10_001)).toBe(false);
    expect(throttle.allow(10_000 + CONNECTION_WARNING_INTERVAL_MS)).toBe(true);
  });

  it("covers construction, error, close, retry, stop, and welcome lifecycle paths", () => {
    const warnings: string[] = [];
    const reporter = new ConnectionWarningReporter((message) => warnings.push(message));
    const first = 100_000;

    // The three user-visible failure paths share one warning window. Repeated
    // exponential-backoff retries do not reset it.
    expect(reporter.report("relay connection could not be created: ECONNREFUSED", first)).toBe(true);
    expect(reporter.report("relay connection: ECONNREFUSED", first + 500)).toBe(false);
    expect(reporter.report("relay connection closed (1006)", first + 1_500)).toBe(false);
    expect(reporter.report("relay connection could not be created: ECONNREFUSED", first + 9_500)).toBe(false);
    expect(warnings).toEqual(["relay connection could not be created: ECONNREFUSED"]);

    // A welcome cancels transient warnings but must not reset the cooldown.
    reporter.onAuthenticatedWelcome();
    expect(reporter.report("relay connection closed (1006)", first + 10_000)).toBe(false);
    // Failed retries still remain in that same episode.
    expect(reporter.report("relay connection: ECONNREFUSED", first + 10_001)).toBe(false);

    // Explicit stop also starts a fresh lifecycle; a failed close before it
    // must not have reset the window on its own.
    reporter.onExplicitStop();
    expect(reporter.report("relay connection: ECONNREFUSED", first + 20_000)).toBe(true);
    expect(reporter.report("relay connection closed (1006)", first + 20_001)).toBe(false);
    reporter.onExplicitStop();
    expect(reporter.report("relay connection could not be created: ECONNREFUSED", first + 20_002)).toBe(true);

    expect(warnings).toHaveLength(3);
  });
});
