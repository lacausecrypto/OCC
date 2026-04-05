/**
 * Extended scheduler tests: edge cases, input handling, and boundary conditions.
 *
 * Supplements the existing scheduler.test.ts with:
 * - Edge cases: very long labels, special characters in input
 * - Multiple rapid operations
 * - Concurrent schedule creation
 * - Update with multiple fields
 * - Delete + recreate workflow
 * - Large input maps
 * - Schedule ID format validation
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock executeChain so scheduled runs never actually call an LLM
vi.mock("../src/executor.js", () => ({
  executeChain: vi.fn().mockResolvedValue(undefined),
}));

// Mock loadChain so we don't need real chain files on disk
vi.mock("../src/loader.js", () => ({
  loadChain: vi.fn().mockReturnValue({
    name: "mock-chain",
    steps: [{ id: "s1", prompt: "p", output_var: "out", depends_on: [], tools: [] }],
    output: "out",
    inputs: [],
  }),
}));

import {
  initScheduler,
  createSchedule,
  getSchedules,
  getSchedule,
  deleteSchedule,
  toggleSchedule,
  updateSchedule,
} from "../src/scheduler.js";

let tmpDir: string;
let tmpFile: string;
let origSchedulesFile: string | undefined;
let origChainsDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-scheduler-ext-"));
  tmpFile = path.join(tmpDir, "schedules.json");
  origSchedulesFile = process.env.SCHEDULES_FILE;
  origChainsDir = process.env.CHAINS_DIR;
  process.env.SCHEDULES_FILE = tmpFile;
  process.env.CHAINS_DIR = tmpDir;
  initScheduler();
});

afterEach(() => {
  if (origSchedulesFile === undefined) delete process.env.SCHEDULES_FILE;
  else process.env.SCHEDULES_FILE = origSchedulesFile;
  if (origChainsDir === undefined) delete process.env.CHAINS_DIR;
  else process.env.CHAINS_DIR = origChainsDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    label: "test-schedule",
    chainName: "test-chain",
    input: {},
    cron: "0 0 * * *",
    enabled: true,
    ...overrides,
  } as Parameters<typeof createSchedule>[0];
}

// ─── Edge cases ────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("handles very long label", () => {
    const longLabel = "a".repeat(1000);
    const s = createSchedule(makeSchedule({ label: longLabel }));
    expect(s.label).toBe(longLabel);
    expect(getSchedule(s.id)!.label).toBe(longLabel);
  });

  it("handles empty input map", () => {
    const s = createSchedule(makeSchedule({ input: {} }));
    expect(s.input).toEqual({});
  });

  it("handles large input map", () => {
    const input: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      input[`key_${i}`] = `value_${i}_${"x".repeat(100)}`;
    }
    const s = createSchedule(makeSchedule({ input }));
    expect(Object.keys(s.input)).toHaveLength(50);
  });

  it("handles special characters in input values", () => {
    const input = {
      query: 'SELECT * FROM users WHERE name = "test"',
      html: '<script>alert("xss")</script>',
      newlines: "line1\nline2\nline3",
      unicode: "Hello \u00e9\u00e8\u00ea\u00eb",
    };
    const s = createSchedule(makeSchedule({ input }));
    expect(s.input).toEqual(input);
    // Verify persistence
    initScheduler();
    const loaded = getSchedule(s.id);
    expect(loaded!.input).toEqual(input);
  });

  it("handles unicode in label", () => {
    const s = createSchedule(makeSchedule({ label: "\u00c9valuation quotidienne" }));
    expect(s.label).toBe("\u00c9valuation quotidienne");
  });
});

// ─── Schedule ID format ────────────────────────────────────────────────────

describe("Schedule ID format", () => {
  it("starts with sched_ prefix", () => {
    const s = createSchedule(makeSchedule());
    expect(s.id).toMatch(/^sched_/);
  });

  it("each ID is unique", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const s = createSchedule(makeSchedule({ label: `sched-${i}` }));
      ids.add(s.id);
    }
    expect(ids.size).toBe(20);
  });

  it("IDs are strings", () => {
    const s = createSchedule(makeSchedule());
    expect(typeof s.id).toBe("string");
    expect(s.id.length).toBeGreaterThan(6); // "sched_" + at least some chars
  });
});

// ─── Multiple rapid operations ─────────────────────────────────────────────

describe("Multiple rapid operations", () => {
  it("creates many schedules rapidly", () => {
    for (let i = 0; i < 20; i++) {
      createSchedule(makeSchedule({ label: `rapid-${i}` }));
    }
    expect(getSchedules()).toHaveLength(20);
  });

  it("creates and deletes in rapid succession", () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(createSchedule(makeSchedule({ label: `del-${i}` })).id);
    }
    for (const id of ids) {
      deleteSchedule(id);
    }
    expect(getSchedules()).toHaveLength(0);
  });

  it("toggles the same schedule many times", () => {
    const s = createSchedule(makeSchedule({ enabled: true }));
    for (let i = 0; i < 10; i++) {
      toggleSchedule(s.id);
    }
    // 10 toggles: true -> false -> true -> ... -> true (even number of toggles = back to start = true)
    expect(getSchedule(s.id)!.enabled).toBe(true);
  });

  it("odd number of toggles flips the state", () => {
    const s = createSchedule(makeSchedule({ enabled: true }));
    for (let i = 0; i < 7; i++) {
      toggleSchedule(s.id);
    }
    expect(getSchedule(s.id)!.enabled).toBe(false);
  });
});

// ─── Update with multiple fields ───────────────────────────────────────────

describe("Update with multiple fields", () => {
  it("patches multiple fields at once", () => {
    const s = createSchedule(makeSchedule({ label: "old", cron: "0 0 * * *", enabled: true }));
    const updated = updateSchedule(s.id, { label: "new", cron: "*/30 * * * *", enabled: false });
    expect(updated).not.toBeNull();
    expect(updated!.label).toBe("new");
    expect(updated!.cron).toBe("*/30 * * * *");
    expect(updated!.enabled).toBe(false);
  });

  it("update persists to disk", () => {
    const s = createSchedule(makeSchedule({ label: "persist-test" }));
    updateSchedule(s.id, { label: "updated-persist" });
    // Reload from disk
    initScheduler();
    const loaded = getSchedule(s.id);
    expect(loaded!.label).toBe("updated-persist");
  });

  it("update does not affect chainName", () => {
    const s = createSchedule(makeSchedule({ chainName: "original-chain" }));
    updateSchedule(s.id, { label: "changed" });
    expect(getSchedule(s.id)!.chainName).toBe("original-chain");
  });
});

// ─── Delete + recreate workflow ────────────────────────────────────────────

describe("Delete and recreate", () => {
  it("can recreate a schedule after deleting it", () => {
    const s1 = createSchedule(makeSchedule({ label: "ephemeral" }));
    const id1 = s1.id;
    deleteSchedule(id1);
    expect(getSchedule(id1)).toBeUndefined();

    const s2 = createSchedule(makeSchedule({ label: "ephemeral" }));
    expect(s2.id).not.toBe(id1); // New ID
    expect(getSchedules()).toHaveLength(1);
  });

  it("deleted schedule is gone after reload", () => {
    const s = createSchedule(makeSchedule({ label: "gone" }));
    deleteSchedule(s.id);
    initScheduler();
    expect(getSchedule(s.id)).toBeUndefined();
    expect(getSchedules()).toHaveLength(0);
  });
});

// ─── Cron expression edge cases ────────────────────────────────────────────

describe("Cron expression edge cases", () => {
  it("accepts every-minute expression", () => {
    const s = createSchedule(makeSchedule({ cron: "* * * * *" }));
    expect(s.cron).toBe("* * * * *");
  });

  it("accepts complex cron with ranges and lists", () => {
    const s = createSchedule(makeSchedule({ cron: "0,30 9-17 * * 1-5" }));
    expect(s.cron).toBe("0,30 9-17 * * 1-5");
  });

  it("accepts cron with step values", () => {
    const s = createSchedule(makeSchedule({ cron: "*/15 */2 * * *" }));
    expect(s.cron).toBe("*/15 */2 * * *");
  });

  it("stores even unusual cron expressions", () => {
    const s = createSchedule(makeSchedule({ cron: "59 23 31 12 *" }));
    expect(s.cron).toBe("59 23 31 12 *");
  });
});

// ─── getSchedule edge cases ────────────────────────────────────────────────

describe("getSchedule edge cases", () => {
  it("returns undefined for empty string id", () => {
    expect(getSchedule("")).toBeUndefined();
  });

  it("returns undefined for id with wrong prefix", () => {
    expect(getSchedule("exec_12345")).toBeUndefined();
  });
});

// ─── Persistence with multiple operations ──────────────────────────────────

describe("Persistence integrity", () => {
  it("survives create + update + toggle cycle", () => {
    const s = createSchedule(makeSchedule({ label: "cycle", enabled: true }));
    updateSchedule(s.id, { label: "cycled" });
    toggleSchedule(s.id);

    // Reload from disk
    initScheduler();

    const loaded = getSchedule(s.id);
    expect(loaded).toBeDefined();
    expect(loaded!.label).toBe("cycled");
    expect(loaded!.enabled).toBe(false);
  });

  it("handles concurrent creates and deletes", () => {
    const s1 = createSchedule(makeSchedule({ label: "keep" }));
    const s2 = createSchedule(makeSchedule({ label: "remove" }));
    const s3 = createSchedule(makeSchedule({ label: "keep-too" }));

    deleteSchedule(s2.id);

    // Reload
    initScheduler();

    const list = getSchedules();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.label).sort()).toEqual(["keep", "keep-too"]);
  });
});

// ─── createdAt field ───────────────────────────────────────────────────────

describe("createdAt field", () => {
  it("is a valid ISO date string", () => {
    const s = createSchedule(makeSchedule());
    expect(new Date(s.createdAt).getTime()).not.toBeNaN();
  });

  it("is set at creation time (within 5 seconds)", () => {
    const before = Date.now();
    const s = createSchedule(makeSchedule());
    const after = Date.now();
    const created = new Date(s.createdAt).getTime();
    expect(created).toBeGreaterThanOrEqual(before - 1000);
    expect(created).toBeLessThanOrEqual(after + 1000);
  });

  it("is preserved after update", () => {
    const s = createSchedule(makeSchedule());
    const originalCreatedAt = s.createdAt;
    updateSchedule(s.id, { label: "changed" });
    expect(getSchedule(s.id)!.createdAt).toBe(originalCreatedAt);
  });
});
