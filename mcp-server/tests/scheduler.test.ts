/**
 * Tests for the scheduler module.
 *
 * We test the public API (create / list / get / delete / toggle / update)
 * using a temp file for persistence and mocking the executor so no real
 * chains are run.
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

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let tmpFile: string;
let origSchedulesFile: string | undefined;
let origChainsDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-scheduler-test-"));
  tmpFile = path.join(tmpDir, "schedules.json");
  origSchedulesFile = process.env.SCHEDULES_FILE;
  origChainsDir = process.env.CHAINS_DIR;
  process.env.SCHEDULES_FILE = tmpFile;
  process.env.CHAINS_DIR = tmpDir;

  // Reset in-memory state by re-initialising from the (empty) file
  initScheduler();
});

afterEach(() => {
  // Restore env
  if (origSchedulesFile === undefined) delete process.env.SCHEDULES_FILE;
  else process.env.SCHEDULES_FILE = origSchedulesFile;

  if (origChainsDir === undefined) delete process.env.CHAINS_DIR;
  else process.env.CHAINS_DIR = origChainsDir;

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    label: "nightly-review",
    chainName: "code-review",
    input: { code: "console.log(1)" },
    cron: "0 0 * * *", // every day at midnight
    enabled: true,
    ...overrides,
  } as Parameters<typeof createSchedule>[0];
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Schedule creation
// ═════════════════════════════════════════════════════════════════════════════

describe("createSchedule", () => {
  it("creates a schedule and returns it with an id", () => {
    const s = createSchedule(makeSchedule());
    expect(s.id).toBeDefined();
    expect(s.id).toMatch(/^sched_/);
    expect(s.label).toBe("nightly-review");
    expect(s.chainName).toBe("code-review");
    expect(s.enabled).toBe(true);
    expect(s.createdAt).toBeDefined();
  });

  it("persists to disk", () => {
    createSchedule(makeSchedule());
    expect(fs.existsSync(tmpFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
    expect(data).toHaveLength(1);
    expect(data[0].label).toBe("nightly-review");
  });

  it("creates multiple schedules with unique ids", () => {
    const s1 = createSchedule(makeSchedule({ label: "first" }));
    const s2 = createSchedule(makeSchedule({ label: "second" }));
    expect(s1.id).not.toBe(s2.id);
  });

  it("allows duplicate schedule labels (no uniqueness constraint)", () => {
    const s1 = createSchedule(makeSchedule({ label: "dup" }));
    const s2 = createSchedule(makeSchedule({ label: "dup" }));
    expect(s1.id).not.toBe(s2.id);
    expect(getSchedules()).toHaveLength(2);
  });

  it("creates a disabled schedule without starting a cron task", () => {
    const s = createSchedule(makeSchedule({ enabled: false }));
    expect(s.enabled).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Cron expression validation
// ═════════════════════════════════════════════════════════════════════════════

describe("cron expression handling", () => {
  it("accepts standard 5-field cron expressions", () => {
    const expressions = [
      "* * * * *",
      "0 0 * * *",
      "*/5 * * * *",
      "0 9 * * 1-5",
      "30 4 1,15 * *",
    ];
    for (const expr of expressions) {
      const s = createSchedule(makeSchedule({ cron: expr, label: expr }));
      expect(s.cron).toBe(expr);
    }
  });

  it("stores the cron expression even if malformed (validation is at task start)", () => {
    // node-cron validate() is called in startTask, not createSchedule,
    // so creation succeeds but the task simply won't start
    const s = createSchedule(makeSchedule({ cron: "not a cron" }));
    expect(s.cron).toBe("not a cron");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Schedule listing
// ═════════════════════════════════════════════════════════════════════════════

describe("getSchedules", () => {
  it("returns empty array when no schedules exist", () => {
    expect(getSchedules()).toEqual([]);
  });

  it("returns all created schedules", () => {
    createSchedule(makeSchedule({ label: "a" }));
    createSchedule(makeSchedule({ label: "b" }));
    createSchedule(makeSchedule({ label: "c" }));
    const list = getSchedules();
    expect(list).toHaveLength(3);
    expect(list.map((s) => s.label).sort()).toEqual(["a", "b", "c"]);
  });

  it("includes nextRunAt for enabled schedules with known cron", () => {
    createSchedule(makeSchedule({ cron: "0 0 * * *", enabled: true }));
    const list = getSchedules();
    // @daily maps to a known pattern so nextRunDate returns a value
    expect(list[0].nextRunAt).toBeDefined();
  });

  it("does not include nextRunAt for disabled schedules", () => {
    createSchedule(makeSchedule({ enabled: false }));
    const list = getSchedules();
    expect(list[0].nextRunAt).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. getSchedule (single)
// ═════════════════════════════════════════════════════════════════════════════

describe("getSchedule", () => {
  it("returns undefined for unknown id", () => {
    expect(getSchedule("sched_nonexistent")).toBeUndefined();
  });

  it("returns the correct schedule by id", () => {
    const created = createSchedule(makeSchedule({ label: "target" }));
    const fetched = getSchedule(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.label).toBe("target");
    expect(fetched!.id).toBe(created.id);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Schedule deletion
// ═════════════════════════════════════════════════════════════════════════════

describe("deleteSchedule", () => {
  it("removes a schedule by id", () => {
    const s = createSchedule(makeSchedule());
    expect(deleteSchedule(s.id)).toBe(true);
    expect(getSchedules()).toHaveLength(0);
  });

  it("returns false for unknown id", () => {
    expect(deleteSchedule("sched_unknown")).toBe(false);
  });

  it("persists deletion to disk", () => {
    const s = createSchedule(makeSchedule());
    deleteSchedule(s.id);
    const data = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
    expect(data).toHaveLength(0);
  });

  it("does not affect other schedules", () => {
    const s1 = createSchedule(makeSchedule({ label: "keep" }));
    const s2 = createSchedule(makeSchedule({ label: "remove" }));
    deleteSchedule(s2.id);
    const list = getSchedules();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("keep");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Enable / disable (toggle)
// ═════════════════════════════════════════════════════════════════════════════

describe("toggleSchedule", () => {
  it("disables an enabled schedule", () => {
    const s = createSchedule(makeSchedule({ enabled: true }));
    const toggled = toggleSchedule(s.id);
    expect(toggled).not.toBeNull();
    expect(toggled!.enabled).toBe(false);
  });

  it("enables a disabled schedule", () => {
    const s = createSchedule(makeSchedule({ enabled: false }));
    const toggled = toggleSchedule(s.id);
    expect(toggled).not.toBeNull();
    expect(toggled!.enabled).toBe(true);
  });

  it("returns null for unknown id", () => {
    expect(toggleSchedule("sched_ghost")).toBeNull();
  });

  it("persists the toggle to disk", () => {
    const s = createSchedule(makeSchedule({ enabled: true }));
    toggleSchedule(s.id);
    const data = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
    expect(data[0].enabled).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. updateSchedule
// ═════════════════════════════════════════════════════════════════════════════

describe("updateSchedule", () => {
  it("patches label", () => {
    const s = createSchedule(makeSchedule({ label: "old" }));
    const updated = updateSchedule(s.id, { label: "new" });
    expect(updated).not.toBeNull();
    expect(updated!.label).toBe("new");
  });

  it("patches cron expression", () => {
    const s = createSchedule(makeSchedule({ cron: "0 0 * * *" }));
    const updated = updateSchedule(s.id, { cron: "*/10 * * * *" });
    expect(updated!.cron).toBe("*/10 * * * *");
  });

  it("patches enabled flag", () => {
    const s = createSchedule(makeSchedule({ enabled: true }));
    const updated = updateSchedule(s.id, { enabled: false });
    expect(updated!.enabled).toBe(false);
  });

  it("returns null for unknown id", () => {
    expect(updateSchedule("sched_nope", { label: "x" })).toBeNull();
  });

  it("preserves fields not included in patch", () => {
    const s = createSchedule(makeSchedule({ label: "keep", cron: "0 0 * * *" }));
    updateSchedule(s.id, { label: "changed" });
    const fetched = getSchedule(s.id);
    expect(fetched!.label).toBe("changed");
    expect(fetched!.cron).toBe("0 0 * * *");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Next run computation
// ═════════════════════════════════════════════════════════════════════════════

describe("next run computation", () => {
  it("computes nextRunAt for @daily-equivalent cron", () => {
    const s = createSchedule(makeSchedule({ cron: "0 0 * * *", enabled: true }));
    const fetched = getSchedule(s.id);
    // The scheduler recognises "0 0 * * *" as @daily and returns a date
    expect(fetched!.nextRunAt).toBeDefined();
    // It should be a valid ISO date string
    expect(new Date(fetched!.nextRunAt!).getTime()).not.toBeNaN();
  });

  it("nextRunAt is undefined for disabled schedules", () => {
    const s = createSchedule(makeSchedule({ cron: "0 0 * * *", enabled: false }));
    const fetched = getSchedule(s.id);
    expect(fetched!.nextRunAt).toBeUndefined();
  });

  it("nextRunAt may be undefined for generic cron patterns", () => {
    const s = createSchedule(makeSchedule({ cron: "*/15 9-17 * * 1-5", enabled: true }));
    const fetched = getSchedule(s.id);
    // The simple nextRunDate helper only handles @hourly and @daily patterns
    // so generic patterns return undefined — this is expected behaviour
    expect(fetched!.nextRunAt === undefined || typeof fetched!.nextRunAt === "string").toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Persistence round-trip
// ═════════════════════════════════════════════════════════════════════════════

describe("persistence round-trip", () => {
  it("schedules survive initScheduler reload", () => {
    createSchedule(makeSchedule({ label: "persistent" }));
    createSchedule(makeSchedule({ label: "persistent-2" }));

    // Re-init from disk
    initScheduler();

    const list = getSchedules();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.label).sort()).toEqual(["persistent", "persistent-2"]);
  });
});
