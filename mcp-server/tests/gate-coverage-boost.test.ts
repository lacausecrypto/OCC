/**
 * Coverage-boost tests for gate-manager.ts.
 *
 * Covers uncovered lines 122-145:
 * - cleanupGates: remove all entries for a given executionId prefix
 * - purgeExpiredGates: remove entries older than 1 hour
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  cleanupGates,
  purgeExpiredGates,
  setGateResult,
  getGateResult,
  hasGateResult,
  setGateTimer,
  approveGate,
} from "../src/gate-manager.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── cleanupGates ────────────────────────────────────────────────────────────

describe("cleanupGates", () => {
  it("removes all gate results for a given executionId", () => {
    setGateResult("exec1:step1", "approved");
    setGateResult("exec1:step2", "rejected");
    setGateResult("exec2:step1", "approved");

    cleanupGates("exec1");

    expect(hasGateResult("exec1:step1")).toBe(false);
    expect(hasGateResult("exec1:step2")).toBe(false);
    expect(hasGateResult("exec2:step1")).toBe(true);

    // Cleanup remaining
    cleanupGates("exec2");
  });

  it("clears timers for the given executionId", () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    const timer1 = setTimeout(() => {}, 100000);
    const timer2 = setTimeout(() => {}, 100000);
    setGateTimer("exec-timer:step1", timer1);
    setGateTimer("exec-timer:step2", timer2);
    setGateTimer("other-exec:step1", setTimeout(() => {}, 100000));

    cleanupGates("exec-timer");

    // clearTimeout should have been called for the two timers belonging to exec-timer
    expect(clearTimeoutSpy).toHaveBeenCalled();
    const clearCount = clearTimeoutSpy.mock.calls.length;
    expect(clearCount).toBeGreaterThanOrEqual(2);

    // Cleanup remaining
    cleanupGates("other-exec");
  });

  it("does nothing when no matching entries exist", () => {
    setGateResult("abc:s1", "approved");
    cleanupGates("xyz"); // no match
    expect(hasGateResult("abc:s1")).toBe(true);

    // Cleanup
    cleanupGates("abc");
  });

  it("handles empty state without error", () => {
    expect(() => cleanupGates("nonexistent")).not.toThrow();
  });

  it("removes gate results set via approveGate", () => {
    // approveGate stores results in the same maps
    approveGate("exec-approve", "step1", true);
    expect(getGateResult("exec-approve:step1")).toBe("approved");

    cleanupGates("exec-approve");
    expect(hasGateResult("exec-approve:step1")).toBe(false);
  });
});

// ─── purgeExpiredGates ───────────────────────────────────────────────────────

describe("purgeExpiredGates", () => {
  it("removes gate entries older than 1 hour", () => {
    // Manually set a gate result, then manipulate time
    setGateResult("old-exec:step1", "approved");
    setGateResult("new-exec:step1", "approved");

    // Mock Date.now to simulate 2 hours later
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 2 * 60 * 60 * 1000);

    // Set a "fresh" entry after mocking time
    setGateResult("fresh-exec:step1", "approved");

    purgeExpiredGates();

    // old-exec and new-exec were created at realNow, which is 2h ago -> purged
    expect(hasGateResult("old-exec:step1")).toBe(false);
    expect(hasGateResult("new-exec:step1")).toBe(false);
    // fresh-exec was created at realNow + 2h -> not purged
    expect(hasGateResult("fresh-exec:step1")).toBe(true);

    // Cleanup
    cleanupGates("fresh-exec");
  });

  it("clears timers for expired gate entries", () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    setGateResult("timed-exec:step1", "approved");
    const timer = setTimeout(() => {}, 100000);
    setGateTimer("timed-exec:step1", timer);

    // Move time forward by 2 hours
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 2 * 60 * 60 * 1000);

    purgeExpiredGates();

    expect(hasGateResult("timed-exec:step1")).toBe(false);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("does not remove entries younger than 1 hour", () => {
    setGateResult("recent:step1", "approved");

    // Don't advance time
    purgeExpiredGates();

    expect(hasGateResult("recent:step1")).toBe(true);

    // Cleanup
    cleanupGates("recent");
  });

  it("handles empty state without error", () => {
    expect(() => purgeExpiredGates()).not.toThrow();
  });

  it("handles entries exactly at the 1-hour boundary", () => {
    setGateResult("boundary:step1", "approved");

    // Move time forward by exactly 1 hour (should NOT be purged since condition is < oneHourAgo)
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 60 * 60 * 1000);

    purgeExpiredGates();

    // At exactly 1h boundary, ts == oneHourAgo, so ts < oneHourAgo is false -> NOT purged
    expect(hasGateResult("boundary:step1")).toBe(true);

    // Cleanup
    cleanupGates("boundary");
  });
});
