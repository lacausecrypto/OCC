/**
 * Scheduler cron tests — focused on cron matching, next-run computation,
 * concurrent execution guard, create/update validation, and atomic file write.
 *
 * Supplements scheduler.test.ts and scheduler-extended.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanupTmpDirSync } from "./_test-utils.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock executeChain so scheduled runs never call an LLM
vi.mock("../src/executor.js", () => ({
  executeChain: vi.fn().mockResolvedValue(undefined),
}));

// Mock loadChain so we don't need chain files
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-sched-cron-"));
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
  cleanupTmpDirSync(tmpDir);
});

function makeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    label: "cron-test",
    chainName: "test-chain",
    input: {},
    cron: "0 0 * * *",
    enabled: true,
    ...overrides,
  } as Parameters<typeof createSchedule>[0];
}

// ── matchesCron via nextRunAt behavior ──────────────────────────────────────
// We test matchesCron indirectly through getSchedule().nextRunAt since matchesCron
// is not exported directly. A schedule with a matching cron should compute nextRunAt.

describe("matchesCron — wildcard (every-minute)", () => {
  it("every-minute cron always has a next run within 1 minute", () => {
    const s = createSchedule(makeSchedule({ cron: "* * * * *", enabled: true }));
    const fetched = getSchedule(s.id);
    expect(fetched!.nextRunAt).toBeDefined();
    const nextRun = new Date(fetched!.nextRunAt!);
    const now = new Date();
    const diffMs = nextRun.getTime() - now.getTime();
    // Should be within 60 seconds from now
    expect(diffMs).toBeLessThanOrEqual(61000);
    expect(diffMs).toBeGreaterThan(0);
  });
});

describe("matchesCron — exact field values", () => {
  it("exact minute and hour matches correctly", () => {
    // Use current hour + next minute to ensure a match
    const now = new Date();
    const nextMin = (now.getMinutes() + 1) % 60;
    const hour = now.getHours();
    const cronExpr = `${nextMin} ${hour} * * *`;
    const s = createSchedule(makeSchedule({ cron: cronExpr, enabled: true }));
    const fetched = getSchedule(s.id);
    expect(fetched!.nextRunAt).toBeDefined();
    const nextRun = new Date(fetched!.nextRunAt!);
    expect(nextRun.getMinutes()).toBe(nextMin);
    expect(nextRun.getHours()).toBe(hour);
  });

  it("exact day-of-month matching", () => {
    // Use tomorrow's date to guarantee a match within 48h scan
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const day = tomorrow.getDate();
    const s = createSchedule(makeSchedule({ cron: `0 0 ${day} * *`, enabled: true }));
    const fetched = getSchedule(s.id);
    expect(fetched!.nextRunAt).toBeDefined();
    const nextRun = new Date(fetched!.nextRunAt!);
    expect(nextRun.getDate()).toBe(day);
    expect(nextRun.getMinutes()).toBe(0);
    expect(nextRun.getHours()).toBe(0);
  });
});

describe("matchesCron — range expressions", () => {
  it("hour range 9-17 matches business hours", () => {
    const s = createSchedule(makeSchedule({ cron: "0 9-17 * * *", enabled: true }));
    const fetched = getSchedule(s.id);
    expect(fetched!.nextRunAt).toBeDefined();
    const nextRun = new Date(fetched!.nextRunAt!);
    expect(nextRun.getHours()).toBeGreaterThanOrEqual(9);
    expect(nextRun.getHours()).toBeLessThanOrEqual(17);
    expect(nextRun.getMinutes()).toBe(0);
  });

  it("weekday range 1-5 excludes weekends", () => {
    const s = createSchedule(makeSchedule({ cron: "0 12 * * 1-5", enabled: true }));
    const fetched = getSchedule(s.id);
    expect(fetched!.nextRunAt).toBeDefined();
    const nextRun = new Date(fetched!.nextRunAt!);
    // 0=Sun, 6=Sat
    expect(nextRun.getDay()).toBeGreaterThanOrEqual(1);
    expect(nextRun.getDay()).toBeLessThanOrEqual(5);
  });
});

describe("matchesCron — step expressions", () => {
  it("*/15 minute step matches 0, 15, 30, or 45", () => {
    const s = createSchedule(makeSchedule({ cron: "*/15 * * * *", enabled: true }));
    const fetched = getSchedule(s.id);
    expect(fetched!.nextRunAt).toBeDefined();
    const nextRun = new Date(fetched!.nextRunAt!);
    expect([0, 15, 30, 45]).toContain(nextRun.getMinutes());
  });

  it("*/2 hour step matches even hours", () => {
    const s = createSchedule(makeSchedule({ cron: "0 */2 * * *", enabled: true }));
    const fetched = getSchedule(s.id);
    expect(fetched!.nextRunAt).toBeDefined();
    const nextRun = new Date(fetched!.nextRunAt!);
    expect(nextRun.getHours() % 2).toBe(0);
  });
});

describe("matchesCron — comma-separated values", () => {
  it("comma-separated minutes 0,30 match on the half-hour", () => {
    const s = createSchedule(makeSchedule({ cron: "0,30 * * * *", enabled: true }));
    const fetched = getSchedule(s.id);
    expect(fetched!.nextRunAt).toBeDefined();
    const nextRun = new Date(fetched!.nextRunAt!);
    expect([0, 30]).toContain(nextRun.getMinutes());
  });

  it("comma-separated hours 9,12,18", () => {
    const s = createSchedule(makeSchedule({ cron: "0 9,12,18 * * *", enabled: true }));
    const fetched = getSchedule(s.id);
    expect(fetched!.nextRunAt).toBeDefined();
    const nextRun = new Date(fetched!.nextRunAt!);
    expect([9, 12, 18]).toContain(nextRun.getHours());
  });
});

// ── nextRunDate — various cron expressions ──────────────────────────────────

describe("nextRunDate", () => {
  it("returns undefined for disabled schedule", () => {
    const s = createSchedule(makeSchedule({ enabled: false }));
    const fetched = getSchedule(s.id);
    expect(fetched!.nextRunAt).toBeUndefined();
  });

  it("returns undefined for invalid cron expression", () => {
    const s = createSchedule(makeSchedule({ cron: "invalid cron", enabled: true }));
    const fetched = getSchedule(s.id);
    expect(fetched!.nextRunAt).toBeUndefined();
  });

  it("returns a future date for valid cron", () => {
    const s = createSchedule(makeSchedule({ cron: "0 0 * * *", enabled: true }));
    const fetched = getSchedule(s.id);
    expect(fetched!.nextRunAt).toBeDefined();
    const nextRun = new Date(fetched!.nextRunAt!);
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());
  });

  it("nextRunAt is a valid ISO date string", () => {
    const s = createSchedule(makeSchedule({ cron: "*/5 * * * *", enabled: true }));
    const fetched = getSchedule(s.id);
    expect(fetched!.nextRunAt).toBeDefined();
    expect(new Date(fetched!.nextRunAt!).toISOString()).toBe(fetched!.nextRunAt);
  });

  it("returns date within 48 hours for frequent cron", () => {
    const s = createSchedule(makeSchedule({ cron: "30 6 * * *", enabled: true }));
    const fetched = getSchedule(s.id);
    expect(fetched!.nextRunAt).toBeDefined();
    const nextRun = new Date(fetched!.nextRunAt!);
    const hoursDiff = (nextRun.getTime() - Date.now()) / (1000 * 60 * 60);
    expect(hoursDiff).toBeLessThanOrEqual(48);
  });
});

// ── runScheduleTask — concurrent execution guard ────────────────────────────

describe("Concurrent execution guard (runningSchedules)", () => {
  it("runNow throws for nonexistent schedule", async () => {
    const { runNow } = await import("../src/scheduler.js");
    await expect(runNow("sched_nonexistent")).rejects.toThrow(/not found/i);
  });

  it("runNow updates lastRunAt on the schedule", async () => {
    const { executeChain } = await import("../src/executor.js");
    const mockExec = executeChain as ReturnType<typeof vi.fn>;
    // Make executeChain emit execution_started so runNow resolves
    mockExec.mockImplementation(async (_chain: any, _input: any, emitter: any) => {
      if (emitter) {
        emitter({ type: "execution_started", executionId: "exec_test_123" });
        emitter({ type: "execution_done", executionId: "exec_test_123", result: "ok", durationMs: 10 });
      }
    });

    const s = createSchedule(makeSchedule({ cron: "* * * * *", enabled: true }));
    expect(s.lastRunAt).toBeUndefined();

    const { runNow } = await import("../src/scheduler.js");
    const execId = await runNow(s.id);
    expect(execId).toBe("exec_test_123");

    // lastRunAt should now be set
    const fetched = getSchedule(s.id);
    expect(fetched!.lastRunAt).toBeDefined();
    expect(fetched!.lastRunId).toBe("exec_test_123");
  });
});

// ── createSchedule / updateSchedule — validation and persistence ────────────

describe("createSchedule validation", () => {
  it("assigns unique ID with sched_ prefix", () => {
    const s = createSchedule(makeSchedule());
    expect(s.id).toMatch(/^sched_[0-9a-f]{12}$/);
  });

  it("sets createdAt to current time", () => {
    const before = Date.now();
    const s = createSchedule(makeSchedule());
    const after = Date.now();
    const created = new Date(s.createdAt).getTime();
    expect(created).toBeGreaterThanOrEqual(before - 100);
    expect(created).toBeLessThanOrEqual(after + 100);
  });

  it("persists immediately to disk after creation", () => {
    const s = createSchedule(makeSchedule());
    expect(fs.existsSync(tmpFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(s.id);
  });

  it("stores all provided fields", () => {
    const s = createSchedule(makeSchedule({
      label: "My Label",
      chainName: "my-chain",
      input: { key: "val" },
      cron: "*/5 * * * *",
      enabled: false,
    }));
    expect(s.label).toBe("My Label");
    expect(s.chainName).toBe("my-chain");
    expect(s.input).toEqual({ key: "val" });
    expect(s.cron).toBe("*/5 * * * *");
    expect(s.enabled).toBe(false);
  });
});

describe("updateSchedule validation", () => {
  it("updates cron and restarts task", () => {
    const s = createSchedule(makeSchedule({ cron: "0 0 * * *", enabled: true }));
    const updated = updateSchedule(s.id, { cron: "*/10 * * * *" });
    expect(updated!.cron).toBe("*/10 * * * *");
    // Verify persistence
    initScheduler();
    expect(getSchedule(s.id)!.cron).toBe("*/10 * * * *");
  });

  it("updates enabled status and persists", () => {
    const s = createSchedule(makeSchedule({ enabled: true }));
    updateSchedule(s.id, { enabled: false });
    initScheduler();
    expect(getSchedule(s.id)!.enabled).toBe(false);
  });

  it("updates input and persists", () => {
    const s = createSchedule(makeSchedule({ input: { old: "val" } }));
    updateSchedule(s.id, { input: { new: "val2" } });
    initScheduler();
    expect(getSchedule(s.id)!.input).toEqual({ new: "val2" });
  });

  it("preserves createdAt on update", () => {
    const s = createSchedule(makeSchedule());
    const originalCreatedAt = s.createdAt;
    updateSchedule(s.id, { label: "updated" });
    expect(getSchedule(s.id)!.createdAt).toBe(originalCreatedAt);
  });

  it("returns null for nonexistent schedule", () => {
    expect(updateSchedule("sched_000000000000", { label: "x" })).toBeNull();
  });
});

// ── Atomic file write ───────────────────────────────────────────────────────

describe("Atomic file write (tmp + rename)", () => {
  it("does not leave .tmp files after successful write", () => {
    createSchedule(makeSchedule());
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  it("persisted file is valid JSON after multiple rapid writes", () => {
    for (let i = 0; i < 10; i++) {
      createSchedule(makeSchedule({ label: `rapid-${i}` }));
    }
    const content = fs.readFileSync(tmpFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed).toHaveLength(10);
  });

  it("persisted file is valid after create + update + delete sequence", () => {
    const s1 = createSchedule(makeSchedule({ label: "keep" }));
    const s2 = createSchedule(makeSchedule({ label: "delete-me" }));
    updateSchedule(s1.id, { label: "kept-updated" });
    deleteSchedule(s2.id);

    const content = fs.readFileSync(tmpFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label).toBe("kept-updated");
  });

  it("file survives reinit after atomic write", () => {
    createSchedule(makeSchedule({ label: "survives" }));
    // Reinit should reload from the atomic-written file
    initScheduler();
    const list = getSchedules();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("survives");
  });
});

// ── getSchedules enrichment ─────────────────────────────────────────────────

describe("getSchedules enrichment", () => {
  it("adds nextRunAt for enabled schedules", () => {
    createSchedule(makeSchedule({ cron: "0 0 * * *", enabled: true }));
    const list = getSchedules();
    expect(list[0].nextRunAt).toBeDefined();
  });

  it("omits nextRunAt for disabled schedules", () => {
    createSchedule(makeSchedule({ enabled: false }));
    const list = getSchedules();
    expect(list[0].nextRunAt).toBeUndefined();
  });

  it("returns a copy (not a reference to internal state)", () => {
    createSchedule(makeSchedule({ label: "original" }));
    const list = getSchedules();
    list[0].label = "modified";
    // Internal state should be unchanged
    expect(getSchedules()[0].label).toBe("original");
  });
});
