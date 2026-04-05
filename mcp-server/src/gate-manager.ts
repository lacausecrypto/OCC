// ─── Gate approval / suspension system ──────────────────────────────────────
// Extracted from executor.ts – manages gate steps (approval, rejection, skip).

import type { ChainExecution } from "./types.js";

// ─── State Maps ─────────────────────────────────────────────────────────────

const pendingApprovals = new Map<string, { resolve: (value: string) => void }>();

// Gate results for suspend/resume pattern (non-blocking gates)
const gateResults = new Map<string, string>(); // executionId:stepId → "approved"|"rejected"|"skipped"
const gateTimers = new Map<string, ReturnType<typeof setTimeout>>(); // executionId:stepId → timeout handle
const gateTimestamps = new Map<string, number>(); // executionId:stepId → creation epoch ms

// ─── GateSuspendError ───────────────────────────────────────────────────────

/** Error thrown to suspend execution at a gate step (frees the worker). */
export class GateSuspendError extends Error {
  constructor(public readonly stepId: string, public readonly executionId: string) {
    super(`Execution suspended at gate "${stepId}"`);
    this.name = "GateSuspendError";
  }
}

// ─── getPendingApprovals ────────────────────────────────────────────────────

export function getPendingApprovals(
  getExecution: (id: string) => ChainExecution | undefined,
): Array<{ executionId: string; stepId: string; chainName: string; prompt: string; startedAt: string }> {
  const results: Array<{ executionId: string; stepId: string; chainName: string; prompt: string; startedAt: string }> = [];
  for (const key of pendingApprovals.keys()) {
    const [executionId, stepId] = key.split(":");
    const execution = getExecution(executionId);
    if (execution) {
      const step = execution.steps[stepId];
      results.push({
        executionId,
        stepId,
        chainName: execution.chainName,
        prompt: step?.output ?? "",
        startedAt: step?.startedAt ?? execution.startedAt,
      });
    }
  }
  return results;
}

// ─── approveGate ────────────────────────────────────────────────────────────

export function approveGate(executionId: string, stepId: string, approved: boolean): boolean {
  const key = `${executionId}:${stepId}`;

  // Clear the timeout timer for this gate
  const timer = gateTimers.get(key);
  if (timer) { clearTimeout(timer); gateTimers.delete(key); }

  // New suspend/resume pattern: store result for when execution resumes
  gateResults.set(key, approved ? "approved" : "rejected");
  gateTimestamps.set(key, Date.now());

  // Legacy Promise-based pattern (backwards compat)
  const pending = pendingApprovals.get(key);
  if (pending) {
    pending.resolve(approved ? "approved" : "rejected");
    pendingApprovals.delete(key);
  }

  return true;
}

// ─── waitForApproval ────────────────────────────────────────────────────────

export function waitForApproval(
  executionId: string,
  stepId: string,
  timeoutHours: number,
  onTimeout: "skip" | "error" | "approve"
): Promise<string> {
  return new Promise((resolve) => {
    const key = `${executionId}:${stepId}`;
    pendingApprovals.set(key, { resolve });

    // Timeout
    setTimeout(() => {
      if (pendingApprovals.has(key)) {
        pendingApprovals.delete(key);
        if (onTimeout === "approve") resolve("approved");
        else if (onTimeout === "skip") resolve("skipped");
        else resolve("rejected");
      }
    }, Math.min(timeoutHours * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000));
  });
}

// ─── Accessor functions for gateResults / gateTimers ────────────────────────

export function getGateResult(key: string): string | undefined {
  return gateResults.get(key);
}

export function deleteGateResult(key: string): void {
  gateResults.delete(key);
}

export function setGateResult(key: string, value: string): void {
  gateResults.set(key, value);
  gateTimestamps.set(key, Date.now());
}

export function hasGateResult(key: string): boolean {
  return gateResults.has(key);
}

export function setGateTimer(key: string, timer: ReturnType<typeof setTimeout>): void {
  gateTimers.set(key, timer);
}

// ─── Cleanup helpers (prevent unbounded Map growth) ────────────────────────

/** Remove all gate entries whose key starts with the given executionId. */
export function cleanupGates(executionId: string): void {
  const prefix = `${executionId}:`;
  for (const key of [...gateResults.keys()]) {
    if (key.startsWith(prefix)) {
      gateResults.delete(key);
      gateTimestamps.delete(key);
    }
  }
  for (const key of [...gateTimers.keys()]) {
    if (key.startsWith(prefix)) {
      clearTimeout(gateTimers.get(key)!);
      gateTimers.delete(key);
    }
  }
}

/** Purge gate entries older than 1 hour. */
export function purgeExpiredGates(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [key, ts] of [...gateTimestamps.entries()]) {
    if (ts < oneHourAgo) {
      gateResults.delete(key);
      gateTimestamps.delete(key);
      const timer = gateTimers.get(key);
      if (timer) { clearTimeout(timer); gateTimers.delete(key); }
    }
  }
}
