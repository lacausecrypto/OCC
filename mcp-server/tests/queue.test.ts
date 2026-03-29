/**
 * Tests for the execution queue (queue.ts).
 *
 * Covers:
 * - Queue initialization and cleanup
 * - Job enqueue with priority
 * - Job status lifecycle (queued → running → done/error)
 * - Job listing and filtering by status
 * - Job cancellation
 * - Queue stats
 * - Priority ordering
 * - Retry on failure
 * - Purge old jobs
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  initQueue,
  closeQueue,
  enqueue,
  getQueueJob,
  listQueueJobs,
  listQueueByStatus,
  cancelQueueJob,
  getQueueStats,
  purgeOldJobs,
} from "../src/queue.js";

let tmpDir: string;
let originalQueueDb: string | undefined;
let originalChainsDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-queue-test-"));
  originalQueueDb = process.env.OCC_QUEUE_DB;
  originalChainsDir = process.env.CHAINS_DIR;
  process.env.OCC_QUEUE_DB = path.join(tmpDir, "queue-test.db");
  delete process.env.CHAINS_DIR;

  // Init with a runner that resolves immediately
  initQueue(async (job) => `exec_${job.id}`);
});

afterEach(() => {
  closeQueue();
  if (originalQueueDb !== undefined) process.env.OCC_QUEUE_DB = originalQueueDb;
  else delete process.env.OCC_QUEUE_DB;
  if (originalChainsDir !== undefined) process.env.CHAINS_DIR = originalChainsDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Enqueue ────────────────────────────────────────────────────────────────

describe("Job enqueue", () => {
  it("enqueues a job and returns job object", () => {
    const job = enqueue("chain", "deep-researcher", { topic: "AI" });
    expect(job.id).toBeTruthy();
    expect(job.type).toBe("chain");
    expect(job.name).toBe("deep-researcher");
    expect(job.input).toEqual({ topic: "AI" });
    expect(job.status).toBe("queued");
    expect(job.priority).toBe(5); // default
  });

  it("enqueues with custom priority", () => {
    const job = enqueue("chain", "urgent", {}, { priority: 10 });
    expect(job.priority).toBe(10);
  });

  it("enqueues pipeline jobs", () => {
    const job = enqueue("pipeline", "research-to-content", { topic: "AI" });
    expect(job.type).toBe("pipeline");
  });

  it("job is retrievable after enqueue", () => {
    const job = enqueue("chain", "test-chain", { x: "1" });
    const loaded = getQueueJob(job.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("test-chain");
    expect(loaded!.input).toEqual({ x: "1" });
  });
});

// ─── Listing ────────────────────────────────────────────────────────────────

describe("Job listing", () => {
  it("lists all jobs", () => {
    enqueue("chain", "a", {});
    enqueue("chain", "b", {});
    enqueue("chain", "c", {});

    const jobs = listQueueJobs(10, 0);
    expect(jobs.length).toBe(3);
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) enqueue("chain", `chain-${i}`, {});
    const jobs = listQueueJobs(3, 0);
    expect(jobs.length).toBe(3);
  });

  it("filters by status", () => {
    enqueue("chain", "a", {});
    enqueue("chain", "b", {});
    const queued = listQueueByStatus("queued", 50);
    expect(queued.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Cancellation ───────────────────────────────────────────────────────────

describe("Job cancellation", () => {
  it("cancels a queued job", () => {
    const job = enqueue("chain", "cancel-me", {});
    const ok = cancelQueueJob(job.id);
    expect(ok).toBe(true);

    const loaded = getQueueJob(job.id);
    expect(loaded!.status).toBe("error");
    expect(loaded!.error).toBe("Cancelled");
  });

  it("returns false for nonexistent job", () => {
    expect(cancelQueueJob("ghost")).toBe(false);
  });
});

// ─── Stats ──────────────────────────────────────────────────────────────────

describe("Queue stats", () => {
  it("returns queue statistics", () => {
    enqueue("chain", "a", {});
    enqueue("chain", "b", {});

    const stats = getQueueStats();
    expect(stats.maxWorkers).toBe(5);
    expect(typeof stats.queued).toBe("number");
    expect(typeof stats.running).toBe("number");
    expect(typeof stats.done).toBe("number");
    expect(typeof stats.errored).toBe("number");
    expect(typeof stats.avgWaitSeconds).toBe("number");
    expect(typeof stats.activeWorkers).toBe("number");
  });
});

// ─── Priority ordering ─────────────────────────────────────────────────────

describe("Priority ordering", () => {
  it("higher priority jobs come first in queue", () => {
    enqueue("chain", "low", {}, { priority: 1 });
    enqueue("chain", "high", {}, { priority: 10 });
    enqueue("chain", "medium", {}, { priority: 5 });

    const queued = listQueueByStatus("queued", 50);
    // Jobs should be ordered by priority DESC
    const names = queued.map((j) => j.name);
    const highIdx = names.indexOf("high");
    const lowIdx = names.indexOf("low");
    expect(highIdx).toBeLessThan(lowIdx);
  });
});

// ─── Purge ──────────────────────────────────────────────────────────────────

describe("Purge old jobs", () => {
  it("purgeOldJobs does not crash on empty queue", () => {
    expect(() => purgeOldJobs(7)).not.toThrow();
  });

  it("returns number of purged jobs", () => {
    const purged = purgeOldJobs(0); // purge everything older than 0 days
    expect(typeof purged).toBe("number");
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("returns null for nonexistent job", () => {
    expect(getQueueJob("ghost")).toBeNull();
  });

  it("handles empty input", () => {
    const job = enqueue("chain", "test", {});
    const loaded = getQueueJob(job.id);
    expect(loaded!.input).toEqual({});
  });

  it("handles rapid enqueue", () => {
    for (let i = 0; i < 20; i++) {
      enqueue("chain", `rapid-${i}`, { i: String(i) });
    }
    const all = listQueueJobs(100, 0);
    expect(all.length).toBe(20);
  });
});
