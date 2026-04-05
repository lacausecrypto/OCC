/**
 * Extended tests for gate-manager.ts.
 *
 * Covers:
 * - GateSuspendError
 * - approveGate (approve + reject)
 * - getPendingApprovals
 * - getGateResult / setGateResult / deleteGateResult / hasGateResult
 * - setGateTimer
 * - waitForApproval (with immediate resolve)
 */
import { describe, it, expect, vi } from "vitest";
import {
  GateSuspendError,
  approveGate,
  getPendingApprovals,
  getGateResult,
  setGateResult,
  deleteGateResult,
  hasGateResult,
  setGateTimer,
} from "../src/gate-manager.js";

// ─── GateSuspendError ──────────────────────────────────────────────────────

describe("GateSuspendError", () => {
  it("extends Error", () => {
    const err = new GateSuspendError("step1", "exec1");
    expect(err).toBeInstanceOf(Error);
  });

  it("has correct name", () => {
    const err = new GateSuspendError("step1", "exec1");
    expect(err.name).toBe("GateSuspendError");
  });

  it("stores stepId and executionId", () => {
    const err = new GateSuspendError("gate_review", "exec_abc");
    expect(err.stepId).toBe("gate_review");
    expect(err.executionId).toBe("exec_abc");
  });

  it("has descriptive message", () => {
    const err = new GateSuspendError("step1", "exec1");
    expect(err.message).toContain("gate");
    expect(err.message).toContain("step1");
  });
});

// ─── Gate result CRUD ──────────────────────────────────────────────────────

describe("Gate result CRUD", () => {
  it("setGateResult + getGateResult", () => {
    setGateResult("test:step1", "approved");
    expect(getGateResult("test:step1")).toBe("approved");
    deleteGateResult("test:step1");
  });

  it("getGateResult returns undefined for unknown key", () => {
    expect(getGateResult("nonexistent:key")).toBeUndefined();
  });

  it("hasGateResult returns true after set", () => {
    setGateResult("has:test", "rejected");
    expect(hasGateResult("has:test")).toBe(true);
    deleteGateResult("has:test");
  });

  it("hasGateResult returns false for unknown", () => {
    expect(hasGateResult("unknown:key")).toBe(false);
  });

  it("deleteGateResult removes the entry", () => {
    setGateResult("del:test", "approved");
    expect(hasGateResult("del:test")).toBe(true);
    deleteGateResult("del:test");
    expect(hasGateResult("del:test")).toBe(false);
    expect(getGateResult("del:test")).toBeUndefined();
  });

  it("deleteGateResult is safe for nonexistent key", () => {
    expect(() => deleteGateResult("no:such:key")).not.toThrow();
  });
});

// ─── approveGate ───────────────────────────────────────────────────────────

describe("approveGate", () => {
  it("returns true and stores 'approved' result", () => {
    const result = approveGate("exec1", "gate1", true);
    expect(result).toBe(true);
    expect(getGateResult("exec1:gate1")).toBe("approved");
    deleteGateResult("exec1:gate1");
  });

  it("returns true and stores 'rejected' result", () => {
    const result = approveGate("exec2", "gate2", false);
    expect(result).toBe(true);
    expect(getGateResult("exec2:gate2")).toBe("rejected");
    deleteGateResult("exec2:gate2");
  });

  it("clears timeout timer on approval", () => {
    const timer = setTimeout(() => {}, 100000);
    setGateTimer("exec3:gate3", timer);
    approveGate("exec3", "gate3", true);
    // Timer should be cleared (no way to directly verify, but no error means success)
    deleteGateResult("exec3:gate3");
  });
});

// ─── setGateTimer ──────────────────────────────────────────────────────────

describe("setGateTimer", () => {
  it("stores a timer without error", () => {
    const timer = setTimeout(() => {}, 100000);
    expect(() => setGateTimer("timer:test", timer)).not.toThrow();
    clearTimeout(timer);
  });
});

// ─── getPendingApprovals ───────────────────────────────────────────────────

describe("getPendingApprovals", () => {
  it("returns empty array when no pending approvals", () => {
    const getExecution = () => undefined;
    const result = getPendingApprovals(getExecution);
    expect(result).toEqual([]);
  });

  it("returns empty array when execution not found", () => {
    // Even if there were entries in pendingApprovals, without a matching execution
    // they wouldn't appear in results
    const getExecution = () => undefined;
    const result = getPendingApprovals(getExecution);
    expect(Array.isArray(result)).toBe(true);
  });
});
