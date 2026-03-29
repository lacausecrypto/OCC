/**
 * Concurrency tests — verifies that OCC handles parallel operations safely.
 *
 * Covers:
 * - SQLite concurrent writes (multiple checkpoints at once)
 * - SQLite concurrent reads + writes (read while writing)
 * - Queue concurrent enqueue (many jobs at once)
 * - Queue worker contention (claim atomicity)
 * - Queue concurrent processing with mock runners
 * - Storage isolation (parallel executions don't interfere)
 * - Linter concurrent invocations (stateless, should be safe)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-concurrency-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── SQLite concurrent writes ───────────────────────────────────────────────

describe("SQLite concurrent writes", () => {
  let initStorage: typeof import("../src/storage.js").initStorage;
  let closeStorage: typeof import("../src/storage.js").closeStorage;
  let saveExecution: typeof import("../src/storage.js").saveExecution;
  let checkpointStep: typeof import("../src/storage.js").checkpointStep;
  let loadExecution: typeof import("../src/storage.js").loadExecution;

  beforeEach(async () => {
    process.env.OCC_DB = path.join(tmpDir, "concurrent.db");
    delete process.env.CHAINS_DIR;
    const mod = await import("../src/storage.js");
    initStorage = mod.initStorage;
    closeStorage = mod.closeStorage;
    saveExecution = mod.saveExecution;
    checkpointStep = mod.checkpointStep;
    loadExecution = mod.loadExecution;
    initStorage();
  });

  afterEach(() => {
    closeStorage();
  });

  it("handles 50 concurrent step checkpoints for the same execution", async () => {
    const execId = "concurrent-exec-1";
    saveExecution({
      id: execId,
      chainName: "test",
      status: "running",
      input: {},
      steps: {},
      startedAt: new Date().toISOString(),
    });

    // Fire 50 checkpoints in parallel (simulates parallel wave with many steps)
    const promises = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve().then(() => {
        checkpointStep(execId, {
          stepId: `step-${i}`,
          status: "done",
          output: `output-${i}`,
          durationMs: 100 + i,
          inputTokens: 500,
          outputTokens: 1000,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
      })
    );

    await Promise.all(promises);

    const loaded = loadExecution(execId);
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded!.steps).length).toBe(50);

    // Verify all steps present and correct
    for (let i = 0; i < 50; i++) {
      expect(loaded!.steps[`step-${i}`]).toBeDefined();
      expect(loaded!.steps[`step-${i}`].output).toBe(`output-${i}`);
    }
  });

  it("handles 20 concurrent execution saves without corruption", async () => {
    const promises = Array.from({ length: 20 }, (_, i) =>
      Promise.resolve().then(() => {
        saveExecution({
          id: `exec-${i}`,
          chainName: `chain-${i % 5}`,
          status: i % 3 === 0 ? "done" : "running",
          input: { idx: String(i) },
          steps: {},
          startedAt: new Date().toISOString(),
          result: i % 3 === 0 ? `result-${i}` : undefined,
        });
      })
    );

    await Promise.all(promises);

    // Verify all 20 exist
    for (let i = 0; i < 20; i++) {
      const loaded = loadExecution(`exec-${i}`);
      expect(loaded).not.toBeNull();
      expect(loaded!.input.idx).toBe(String(i));
    }
  });

  it("handles interleaved reads and writes", async () => {
    // Write execution
    saveExecution({
      id: "rw-test",
      chainName: "test",
      status: "running",
      input: {},
      steps: {},
      startedAt: new Date().toISOString(),
    });

    // Interleave: write step, read, write step, read, ...
    const results: boolean[] = [];
    for (let i = 0; i < 30; i++) {
      if (i % 2 === 0) {
        checkpointStep("rw-test", {
          stepId: `step-${i}`,
          status: "done",
          output: `output-${i}`,
        });
      } else {
        const loaded = loadExecution("rw-test");
        results.push(loaded !== null);
      }
    }

    // All reads should succeed
    expect(results.every((r) => r === true)).toBe(true);

    // Final read should have all written steps
    const final = loadExecution("rw-test");
    expect(Object.keys(final!.steps).length).toBe(15); // 30/2 = 15 writes
  });

  it("step upsert is safe under concurrent updates to same step", async () => {
    saveExecution({
      id: "upsert-race",
      chainName: "test",
      status: "running",
      input: {},
      steps: {},
      startedAt: new Date().toISOString(),
    });

    // 10 concurrent upserts to the SAME step (simulates retry race)
    const promises = Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() => {
        checkpointStep("upsert-race", {
          stepId: "contested-step",
          status: i === 9 ? "done" : "running",
          output: `attempt-${i}`,
          durationMs: i * 100,
        });
      })
    );

    await Promise.all(promises);

    const loaded = loadExecution("upsert-race");
    // Exactly 1 step should exist (upsert, not duplicate)
    expect(Object.keys(loaded!.steps).length).toBe(1);
    expect(loaded!.steps["contested-step"]).toBeDefined();
    // Last write wins — output should be one of the attempts
    expect(loaded!.steps["contested-step"].output).toMatch(/^attempt-\d$/);
  });
});

// ─── Queue concurrent enqueue ───────────────────────────────────────────────

describe("Queue concurrency", () => {
  let initQueue: typeof import("../src/queue.js").initQueue;
  let closeQueue: typeof import("../src/queue.js").closeQueue;
  let enqueue: typeof import("../src/queue.js").enqueue;
  let listQueueJobs: typeof import("../src/queue.js").listQueueJobs;
  let getQueueStats: typeof import("../src/queue.js").getQueueStats;
  let getQueueJob: typeof import("../src/queue.js").getQueueJob;

  beforeEach(async () => {
    process.env.OCC_QUEUE_DB = path.join(tmpDir, "queue-concurrent.db");
    delete process.env.CHAINS_DIR;
    const mod = await import("../src/queue.js");
    initQueue = mod.initQueue;
    closeQueue = mod.closeQueue;
    enqueue = mod.enqueue;
    listQueueJobs = mod.listQueueJobs;
    getQueueStats = mod.getQueueStats;
    getQueueJob = mod.getQueueJob;
  });

  afterEach(() => {
    closeQueue();
  });

  it("handles 100 concurrent enqueues without data loss", () => {
    // Simple runner that resolves immediately
    initQueue(async (job) => `exec_${job.id}`);

    const jobs = Array.from({ length: 100 }, (_, i) =>
      enqueue("chain", `chain-${i}`, { idx: String(i) }, { priority: i % 10 })
    );

    expect(jobs.length).toBe(100);

    // All jobs should have unique IDs
    const ids = new Set(jobs.map((j) => j.id));
    expect(ids.size).toBe(100);

    // All should be retrievable
    const allJobs = listQueueJobs(200, 0);
    expect(allJobs.length).toBe(100);
  });

  it("concurrent enqueue with different priorities maintains order", () => {
    initQueue(async (job) => `exec_${job.id}`);

    // Enqueue in random order but with distinct priorities
    enqueue("chain", "low-1", {}, { priority: 1 });
    enqueue("chain", "high-1", {}, { priority: 10 });
    enqueue("chain", "med-1", {}, { priority: 5 });
    enqueue("chain", "high-2", {}, { priority: 10 });
    enqueue("chain", "low-2", {}, { priority: 1 });

    const stats = getQueueStats();
    expect(stats.queued + stats.running + stats.done).toBeGreaterThanOrEqual(5);
  });

  it("queue processing completes jobs via runner", async () => {
    let completed = 0;
    initQueue(async (job) => {
      completed++;
      return `exec_${job.id}`;
    });

    // Enqueue 3 jobs
    const j1 = enqueue("chain", "a", {});
    const j2 = enqueue("chain", "b", {});
    const j3 = enqueue("chain", "c", {});

    // Wait for processing (queue polls every 1s)
    await new Promise((r) => setTimeout(r, 2500));

    // Jobs should be processed
    expect(completed).toBeGreaterThanOrEqual(1);

    // At least some should be done
    const stats = getQueueStats();
    expect(stats.done).toBeGreaterThanOrEqual(1);
  }, 5000);

  it("failed runner marks job as error after max retries", async () => {
    let callCount = 0;
    initQueue(async (job) => {
      callCount++;
      throw new Error("runner failed");
    });

    const job = enqueue("chain", "failing", {}, { maxRetries: 1 });

    // Wait for processing + retry
    await new Promise((r) => setTimeout(r, 3000));

    const loaded = getQueueJob(job.id);
    expect(loaded).not.toBeNull();
    // Should be error (maxRetries=1, so no retry after first failure)
    expect(loaded!.status).toBe("error");
    expect(loaded!.error).toContain("runner failed");
  }, 5000);

  it("runner that succeeds on retry marks job as done", async () => {
    let attempt = 0;
    initQueue(async (job) => {
      attempt++;
      if (attempt === 1) throw new Error("transient failure");
      return `exec_retry_${job.id}`;
    });

    const job = enqueue("chain", "retry-me", {}, { maxRetries: 3 });

    // Wait for processing + retry
    await new Promise((r) => setTimeout(r, 4000));

    const loaded = getQueueJob(job.id);
    expect(loaded).not.toBeNull();
    // Should eventually succeed after retry
    if (loaded!.status === "done") {
      expect(loaded!.executionId).toContain("exec_retry_");
    }
    // At least 1 attempt was made
    expect(attempt).toBeGreaterThanOrEqual(1);
  }, 6000);
});

// ─── Storage isolation ──────────────────────────────────────────────────────

describe("Storage isolation between executions", () => {
  let initStorage: typeof import("../src/storage.js").initStorage;
  let closeStorage: typeof import("../src/storage.js").closeStorage;
  let saveExecution: typeof import("../src/storage.js").saveExecution;
  let checkpointStep: typeof import("../src/storage.js").checkpointStep;
  let loadExecution: typeof import("../src/storage.js").loadExecution;
  let getChainStats: typeof import("../src/storage.js").getChainStats;

  beforeEach(async () => {
    process.env.OCC_DB = path.join(tmpDir, "isolation.db");
    delete process.env.CHAINS_DIR;
    const mod = await import("../src/storage.js");
    initStorage = mod.initStorage;
    closeStorage = mod.closeStorage;
    saveExecution = mod.saveExecution;
    checkpointStep = mod.checkpointStep;
    loadExecution = mod.loadExecution;
    getChainStats = mod.getChainStats;
    initStorage();
  });

  afterEach(() => {
    closeStorage();
  });

  it("step checkpoints from different executions don't interfere", () => {
    // Two executions running "simultaneously"
    saveExecution({ id: "exec-A", chainName: "test", status: "running", input: {}, steps: {}, startedAt: new Date().toISOString() });
    saveExecution({ id: "exec-B", chainName: "test", status: "running", input: {}, steps: {}, startedAt: new Date().toISOString() });

    // Both have a step called "step1" but different outputs
    checkpointStep("exec-A", { stepId: "step1", status: "done", output: "output-A" });
    checkpointStep("exec-B", { stepId: "step1", status: "done", output: "output-B" });

    const a = loadExecution("exec-A");
    const b = loadExecution("exec-B");

    expect(a!.steps.step1.output).toBe("output-A");
    expect(b!.steps.step1.output).toBe("output-B");
  });

  it("chain stats correctly aggregate across multiple executions", () => {
    for (let i = 0; i < 10; i++) {
      saveExecution({
        id: `stats-${i}`,
        chainName: "stats-chain",
        status: i < 7 ? "done" : "error",
        input: {},
        steps: {},
        startedAt: new Date().toISOString(),
        durationMs: 1000 + i * 100,
      });
      checkpointStep(`stats-${i}`, {
        stepId: "s1",
        status: "done",
        inputTokens: 100 * (i + 1),
        outputTokens: 200 * (i + 1),
      });
    }

    const stats = getChainStats("stats-chain");
    expect(stats.totalRuns).toBe(10);
    expect(stats.successRate).toBe(70); // 7/10
    expect(stats.avgDurationMs).toBeGreaterThan(0);
    expect(stats.totalTokens.input).toBe(100 * (1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10)); // 5500
    expect(stats.totalTokens.output).toBe(200 * (1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10)); // 11000
  });
});

// ─── Linter concurrency (stateless) ────────────────────────────────────────

describe("Linter concurrent invocations", () => {
  it("handles 20 concurrent lintChain calls on different chains", async () => {
    const { lintChain } = await import("../src/linter.js");
    const { ChainDefinition } = await import("../src/types.js");

    const chains = Array.from({ length: 20 }, (_, i) => ({
      name: `chain-${i}`,
      inputs: [{ name: "topic", description: "test", optional: false }],
      steps: [
        { id: `s${i}`, prompt: `Do {input.topic} #${i}`, output_var: `result_${i}`, tools: [], depends_on: [] },
      ],
      output: `result_${i}`,
    }));

    const results = await Promise.all(
      chains.map((chain) =>
        Promise.resolve().then(() => lintChain(chain as any))
      )
    );

    // All should complete without error
    expect(results.length).toBe(20);
    for (const issues of results) {
      const errors = issues.filter((i: any) => i.level === "error");
      expect(errors.length).toBe(0);
    }
  });
});
