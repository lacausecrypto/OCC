/**
 * Tests for the SQLite persistence layer (storage.ts).
 *
 * Covers:
 * - Init / schema creation
 * - Execution CRUD (save, load, list)
 * - Step checkpointing (upsert, per-step persistence)
 * - Time-travel (execution timeline)
 * - Chain stats (success rate, tokens, duration)
 * - Edge cases (missing execution, empty DB, concurrent saves)
 * - Cleanup (close, re-init)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanupTmpDir } from "./_test-utils.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  initStorage,
  closeStorage,
  saveExecution,
  checkpointStep,
  loadExecution,
  listExecutions,
  getExecutionTimeline,
  getChainStats,
} from "../src/storage.js";
import type { ChainExecution, StepResult } from "../src/types.js";

let tmpDir: string;
let originalDb: string | undefined;
let originalChainsDir: string | undefined;

function makeExecution(overrides: Partial<ChainExecution> = {}): ChainExecution {
  return {
    id: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    chainName: "test-chain",
    status: "running",
    input: { topic: "test" },
    steps: {},
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeStep(overrides: Partial<StepResult> = {}): StepResult {
  return {
    stepId: "step1",
    status: "done",
    output: "test output",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1234,
    inputTokens: 500,
    outputTokens: 1500,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-storage-test-"));
  originalDb = process.env.OCC_DB;
  originalChainsDir = process.env.CHAINS_DIR;
  process.env.OCC_DB = path.join(tmpDir, "test.db");
  delete process.env.CHAINS_DIR;
  initStorage();
});

afterEach(async () => {
  closeStorage();
  if (originalDb !== undefined) process.env.OCC_DB = originalDb;
  else delete process.env.OCC_DB;
  if (originalChainsDir !== undefined) process.env.CHAINS_DIR = originalChainsDir;
  await cleanupTmpDir(tmpDir);
});

// ─── Schema & Init ──────────────────────────────────────────────────────────

describe("Storage initialization", () => {
  it("creates the database file", () => {
    expect(fs.existsSync(path.join(tmpDir, "test.db"))).toBe(true);
  });

  it("can re-init without error (idempotent)", () => {
    expect(() => initStorage()).not.toThrow();
  });

  it("marks orphaned running executions as error on init", () => {
    const exec = makeExecution({ status: "running" });
    saveExecution(exec);

    // Re-init (simulates server restart)
    closeStorage();
    initStorage();

    const loaded = loadExecution(exec.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("error");
    expect(loaded!.error).toContain("Interrupted");
  });
});

// ─── Execution CRUD ─────────────────────────────────────────────────────────

describe("Execution CRUD", () => {
  it("saves and loads an execution", () => {
    const exec = makeExecution({ status: "done", result: "hello world" });
    saveExecution(exec);

    const loaded = loadExecution(exec.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(exec.id);
    expect(loaded!.chainName).toBe("test-chain");
    expect(loaded!.status).toBe("done");
    expect(loaded!.result).toBe("hello world");
    expect(loaded!.input).toEqual({ topic: "test" });
  });

  it("updates an existing execution", () => {
    const exec = makeExecution({ status: "running" });
    saveExecution(exec);

    exec.status = "done";
    exec.result = "finished";
    exec.finishedAt = new Date().toISOString();
    exec.durationMs = 5000;
    saveExecution(exec);

    const loaded = loadExecution(exec.id);
    expect(loaded!.status).toBe("done");
    expect(loaded!.result).toBe("finished");
    expect(loaded!.durationMs).toBe(5000);
  });

  it("returns null for missing execution", () => {
    expect(loadExecution("nonexistent")).toBeNull();
  });

  it("lists executions sorted by date DESC", () => {
    const exec1 = makeExecution({ startedAt: "2026-01-01T00:00:00Z" });
    const exec2 = makeExecution({ startedAt: "2026-01-02T00:00:00Z" });
    const exec3 = makeExecution({ startedAt: "2026-01-03T00:00:00Z" });
    saveExecution(exec1);
    saveExecution(exec2);
    saveExecution(exec3);

    const all = listExecutions(10, 0);
    expect(all.length).toBe(3);
    expect(all[0].id).toBe(exec3.id); // Most recent first
    expect(all[2].id).toBe(exec1.id);
  });

  it("respects limit and offset", () => {
    for (let i = 0; i < 10; i++) {
      saveExecution(makeExecution({ startedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
    }

    const page1 = listExecutions(3, 0);
    expect(page1.length).toBe(3);

    const page2 = listExecutions(3, 3);
    expect(page2.length).toBe(3);

    // No overlap
    const ids1 = new Set(page1.map((e) => e.id));
    for (const e of page2) {
      expect(ids1.has(e.id)).toBe(false);
    }
  });

  it("handles execution with error status", () => {
    const exec = makeExecution({ status: "error", error: "Something broke" });
    saveExecution(exec);

    const loaded = loadExecution(exec.id);
    expect(loaded!.status).toBe("error");
    expect(loaded!.error).toBe("Something broke");
  });

  it("preserves complex input JSON", () => {
    const exec = makeExecution({
      input: { topic: "AI", depth: "deep", tags: "a,b,c" },
    });
    saveExecution(exec);

    const loaded = loadExecution(exec.id);
    expect(loaded!.input).toEqual({ topic: "AI", depth: "deep", tags: "a,b,c" });
  });
});

// ─── Step Checkpointing ─────────────────────────────────────────────────────

describe("Step checkpointing", () => {
  it("checkpoints a step and loads it with execution", () => {
    const exec = makeExecution();
    saveExecution(exec);

    checkpointStep(exec.id, makeStep({ stepId: "analyze", output: "analysis result" }));

    const loaded = loadExecution(exec.id);
    expect(loaded!.steps).toHaveProperty("analyze");
    expect(loaded!.steps.analyze.status).toBe("done");
    expect(loaded!.steps.analyze.output).toBe("analysis result");
    expect(loaded!.steps.analyze.durationMs).toBe(1234);
    expect(loaded!.steps.analyze.inputTokens).toBe(500);
    expect(loaded!.steps.analyze.outputTokens).toBe(1500);
  });

  it("upserts: updates existing step checkpoint", () => {
    const exec = makeExecution();
    saveExecution(exec);

    // First checkpoint: running
    checkpointStep(exec.id, makeStep({ stepId: "s1", status: "running", output: undefined }));

    // Second checkpoint: done with output
    checkpointStep(exec.id, makeStep({ stepId: "s1", status: "done", output: "final output", durationMs: 9999 }));

    const loaded = loadExecution(exec.id);
    expect(loaded!.steps.s1.status).toBe("done");
    expect(loaded!.steps.s1.output).toBe("final output");
    expect(loaded!.steps.s1.durationMs).toBe(9999);
  });

  it("checkpoints multiple steps independently", () => {
    const exec = makeExecution();
    saveExecution(exec);

    checkpointStep(exec.id, makeStep({ stepId: "s1", output: "out1" }));
    checkpointStep(exec.id, makeStep({ stepId: "s2", output: "out2" }));
    checkpointStep(exec.id, makeStep({ stepId: "s3", status: "error", error: "failed" }));

    const loaded = loadExecution(exec.id);
    expect(Object.keys(loaded!.steps).length).toBe(3);
    expect(loaded!.steps.s1.output).toBe("out1");
    expect(loaded!.steps.s2.output).toBe("out2");
    expect(loaded!.steps.s3.status).toBe("error");
    expect(loaded!.steps.s3.error).toBe("failed");
  });

  it("handles null/undefined fields gracefully", () => {
    const exec = makeExecution();
    saveExecution(exec);

    checkpointStep(exec.id, {
      stepId: "minimal",
      status: "pending",
    });

    const loaded = loadExecution(exec.id);
    expect(loaded!.steps.minimal.status).toBe("pending");
    expect(loaded!.steps.minimal.output).toBeUndefined();
    expect(loaded!.steps.minimal.error).toBeUndefined();
    expect(loaded!.steps.minimal.durationMs).toBeUndefined();
  });

  it("survives simulated crash (checkpoint persists after close+reinit)", () => {
    const exec = makeExecution({ status: "running" });
    saveExecution(exec);
    checkpointStep(exec.id, makeStep({ stepId: "s1", status: "done", output: "survived" }));
    checkpointStep(exec.id, makeStep({ stepId: "s2", status: "running" }));

    // Simulate crash: close and reopen
    closeStorage();
    initStorage();

    // Execution marked as error (orphan recovery), but steps preserved
    const loaded = loadExecution(exec.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.steps.s1.status).toBe("done");
    expect(loaded!.steps.s1.output).toBe("survived");
    expect(loaded!.steps.s2).toBeDefined(); // Step 2 preserved
  });
});

// ─── Time-Travel Timeline ───────────────────────────────────────────────────

describe("Execution timeline (time-travel)", () => {
  it("returns step checkpoint history", () => {
    const exec = makeExecution();
    saveExecution(exec);

    checkpointStep(exec.id, makeStep({ stepId: "s1", status: "done", durationMs: 100 }));
    checkpointStep(exec.id, makeStep({ stepId: "s2", status: "done", durationMs: 200 }));

    const timeline = getExecutionTimeline(exec.id);
    expect(timeline.length).toBe(2);
    expect(timeline[0].stepId).toBe("s1");
    expect(timeline[0].status).toBe("done");
    expect(timeline[0].checkpointAt).toBeDefined();
    expect(timeline[1].stepId).toBe("s2");
  });

  it("returns empty array for missing execution", () => {
    const timeline = getExecutionTimeline("nonexistent");
    expect(timeline).toEqual([]);
  });

  it("includes token counts in timeline", () => {
    const exec = makeExecution();
    saveExecution(exec);
    checkpointStep(exec.id, makeStep({ stepId: "s1", inputTokens: 300, outputTokens: 900 }));

    const timeline = getExecutionTimeline(exec.id);
    expect(timeline[0].inputTokens).toBe(300);
    expect(timeline[0].outputTokens).toBe(900);
  });
});

// ─── Chain Stats ────────────────────────────────────────────────────────────

describe("Chain stats", () => {
  it("returns stats for a chain with multiple executions", () => {
    // 3 successful, 1 failed
    saveExecution(makeExecution({ chainName: "my-chain", status: "done", durationMs: 1000 }));
    saveExecution(makeExecution({ chainName: "my-chain", status: "done", durationMs: 2000 }));
    saveExecution(makeExecution({ chainName: "my-chain", status: "done", durationMs: 3000 }));
    saveExecution(makeExecution({ chainName: "my-chain", status: "error", durationMs: 500 }));

    const stats = getChainStats("my-chain");
    expect(stats.totalRuns).toBe(4);
    expect(stats.successRate).toBe(75); // 3/4 = 75%
    expect(stats.avgDurationMs).toBeGreaterThan(0);
  });

  it("returns zeros for unknown chain", () => {
    const stats = getChainStats("nonexistent");
    expect(stats.totalRuns).toBe(0);
    expect(stats.successRate).toBe(0);
    expect(stats.avgDurationMs).toBe(0);
    expect(stats.totalTokens.input).toBe(0);
    expect(stats.totalTokens.output).toBe(0);
  });

  it("aggregates token counts across steps", () => {
    const exec = makeExecution({ chainName: "token-chain", status: "done" });
    saveExecution(exec);
    checkpointStep(exec.id, makeStep({ stepId: "s1", inputTokens: 100, outputTokens: 200 }));
    checkpointStep(exec.id, makeStep({ stepId: "s2", inputTokens: 300, outputTokens: 400 }));

    const stats = getChainStats("token-chain");
    expect(stats.totalTokens.input).toBe(400); // 100 + 300
    expect(stats.totalTokens.output).toBe(600); // 200 + 400
  });

  it("does not mix chains in stats", () => {
    saveExecution(makeExecution({ chainName: "chain-a", status: "done" }));
    saveExecution(makeExecution({ chainName: "chain-b", status: "done" }));
    saveExecution(makeExecution({ chainName: "chain-b", status: "error" }));

    expect(getChainStats("chain-a").totalRuns).toBe(1);
    expect(getChainStats("chain-b").totalRuns).toBe(2);
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("handles large output in step checkpoint", () => {
    const exec = makeExecution();
    saveExecution(exec);

    const largeOutput = "x".repeat(100_000);
    checkpointStep(exec.id, makeStep({ stepId: "big", output: largeOutput }));

    const loaded = loadExecution(exec.id);
    expect(loaded!.steps.big.output!.length).toBe(100_000);
  });

  it("handles special characters in output", () => {
    const exec = makeExecution();
    saveExecution(exec);

    checkpointStep(exec.id, makeStep({
      stepId: "special",
      output: `He said "hello" & it's <fine>! 🎉 \n\t newline`,
    }));

    const loaded = loadExecution(exec.id);
    expect(loaded!.steps.special.output).toContain(`"hello"`);
    expect(loaded!.steps.special.output).toContain("🎉");
  });

  it("handles rapid sequential saves without corruption", () => {
    const exec = makeExecution();
    saveExecution(exec);

    for (let i = 0; i < 50; i++) {
      checkpointStep(exec.id, makeStep({ stepId: `step-${i}`, output: `out-${i}` }));
    }

    const loaded = loadExecution(exec.id);
    expect(Object.keys(loaded!.steps).length).toBe(50);
    expect(loaded!.steps["step-49"].output).toBe("out-49");
  });
});
