/**
 * Tests for gate-manager.ts timeout and approval resolution.
 *
 * Covers:
 * - waitForApproval with timeout (approve, skip, error/reject)
 * - waitForApproval with immediate resolution via approveGate
 * - getPendingApprovals with mock execution data
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  waitForApproval,
  approveGate,
  getPendingApprovals,
  deleteGateResult,
} from "../src/gate-manager.js";

afterEach(() => {
  // Clean up any lingering gate results
  deleteGateResult("timeout-test:gate1");
  deleteGateResult("test-exec:gate1");
  deleteGateResult("approve-test:gate1");
  deleteGateResult("reject-test:gate1");
});

// ─── waitForApproval ─────────────────────────────────────────────────────────

describe("waitForApproval", () => {
  it("resolves to 'approved' when approveGate(true) is called", async () => {
    const promise = waitForApproval("approve-test", "gate1", 24, "error");
    // Approve after a small delay
    setTimeout(() => approveGate("approve-test", "gate1", true), 10);
    const result = await promise;
    expect(result).toBe("approved");
  });

  it("resolves to 'rejected' when approveGate(false) is called", async () => {
    const promise = waitForApproval("reject-test", "gate1", 24, "error");
    setTimeout(() => approveGate("reject-test", "gate1", false), 10);
    const result = await promise;
    expect(result).toBe("rejected");
  });

  it("on_timeout 'approve' resolves to approved after timeout", async () => {
    // Use a very short timeout (in hours, so 0.0001 hours ~ 360ms)
    const result = await waitForApproval("timeout-test", "gate1", 0.0001, "approve");
    expect(result).toBe("approved");
  }, 10000);

  it("on_timeout 'skip' resolves to skipped after timeout", async () => {
    const result = await waitForApproval("timeout-test", "gate1", 0.0001, "skip");
    expect(result).toBe("skipped");
  }, 10000);

  it("on_timeout 'error' resolves to rejected after timeout", async () => {
    const result = await waitForApproval("timeout-test", "gate1", 0.0001, "error");
    expect(result).toBe("rejected");
  }, 10000);
});

// ─── getPendingApprovals with mock data ──────────────────────────────────────

describe("getPendingApprovals with execution data", () => {
  it("returns pending entries with execution context", async () => {
    // Start a waitForApproval to populate pendingApprovals
    const promise = waitForApproval("test-exec", "gate1", 1, "error");

    const mockExecution = {
      id: "test-exec",
      chainName: "review-chain",
      status: "running" as const,
      input: {},
      steps: {
        gate1: {
          stepId: "gate1",
          status: "running" as const,
          output: "Please approve this",
          startedAt: "2026-01-01T00:00:00Z",
        },
      },
      startedAt: "2026-01-01T00:00:00Z",
    };

    const getExecution = (id: string) => {
      if (id === "test-exec") return mockExecution as any;
      return undefined;
    };

    const approvals = getPendingApprovals(getExecution);
    expect(approvals.length).toBeGreaterThanOrEqual(1);

    const found = approvals.find((a) => a.executionId === "test-exec");
    expect(found).toBeDefined();
    if (found) {
      expect(found.stepId).toBe("gate1");
      expect(found.chainName).toBe("review-chain");
      expect(found.prompt).toBe("Please approve this");
    }

    // Clean up: approve to resolve the promise
    approveGate("test-exec", "gate1", true);
    await promise;
  });

  it("skips entries where execution is not found", async () => {
    // Start a waitForApproval
    const promise = waitForApproval("missing-exec", "gate1", 1, "error");

    const getExecution = () => undefined;
    const approvals = getPendingApprovals(getExecution);

    // The entry exists in pendingApprovals but execution is not found, so it's not in results
    const found = approvals.find((a) => a.executionId === "missing-exec");
    expect(found).toBeUndefined();

    // Clean up
    approveGate("missing-exec", "gate1", true);
    await promise;
  });
});
