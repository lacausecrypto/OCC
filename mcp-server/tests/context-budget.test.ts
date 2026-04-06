/**
 * Tests for autoCompressVars() — Chain Auto-Budget context management.
 * Uses _compressFn override to avoid spawning real Claude CLI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { autoCompressVars } from "../src/claude-runner.js";

function chars(n: number, ch = "x"): string { return ch.repeat(n); }
function totalChars(vars: Record<string, string>): number {
  return Object.values(vars).reduce((s, v) => s + v.length, 0);
}

const onLog = vi.fn();
beforeEach(() => { onLog.mockClear(); });

// Fake compress: returns "[summary]"
const fakeCompress = vi.fn().mockResolvedValue("[summary]");
// Failing compress: forces truncation fallback
const failCompress = vi.fn().mockRejectedValue(new Error("mock fail"));

// ─── 1. No-op when under budget ───────────────────────────────────────────────

describe("autoCompressVars — under budget", () => {
  it("does not modify vars when total < maxChars", async () => {
    const vars = { "input.topic": chars(200), step1: chars(300), step2: chars(500) };
    const original = { ...vars };
    const result = await autoCompressVars(vars, 50000, 2, onLog, undefined, fakeCompress);
    expect(vars).toEqual(original);
    expect(result).toBe(totalChars(original));
    expect(onLog).not.toHaveBeenCalled();
    expect(fakeCompress).not.toHaveBeenCalled();
  });

  it("returns 0 for empty vars", async () => {
    const result = await autoCompressVars({}, 50000, 2, onLog, undefined, fakeCompress);
    expect(result).toBe(0);
  });
});

// ─── 2. Protects input.* vars ─────────────────────────────────────────────────

describe("autoCompressVars — protects input.*", () => {
  it("never compresses input.* vars", async () => {
    const vars = {
      "input.topic": chars(5000, "I"),
      "input.style": chars(3000, "S"),
      step1: chars(5000, "A"),
      step2: chars(5000, "B"),
      step3: chars(5000, "C"),
    };
    await autoCompressVars(vars, 10000, 1, onLog, undefined, failCompress);
    expect(vars["input.topic"]).toBe(chars(5000, "I"));
    expect(vars["input.style"]).toBe(chars(3000, "S"));
  });

  it("protects bare aliases (topic when input.topic exists)", async () => {
    const vars = {
      "input.topic": chars(2000, "I"),
      topic: chars(2000, "T"),
      step1: chars(5000, "A"),
      step2: chars(5000, "B"),
    };
    await autoCompressVars(vars, 5000, 1, onLog, undefined, failCompress);
    expect(vars["input.topic"]).toBe(chars(2000, "I"));
    expect(vars["topic"]).toBe(chars(2000, "T"));
  });
});

// ─── 3. Protects recent N vars ────────────────────────────────────────────────

describe("autoCompressVars — protects recent vars", () => {
  it("keeps last recentKeepCount step vars untouched", async () => {
    const vars = {
      step1: chars(5000, "A"),
      step2: chars(5000, "B"),
      step3: chars(5000, "C"),
      step4: chars(5000, "D"),
      step5: chars(5000, "E"),
    };
    await autoCompressVars(vars, 5000, 2, onLog, undefined, failCompress);
    // step4, step5 are recent (last 2)
    expect(vars.step4).toBe(chars(5000, "D"));
    expect(vars.step5).toBe(chars(5000, "E"));
    // Older steps truncated
    expect(vars.step1).toContain("[auto-truncated");
    expect(vars.step1.length).toBeLessThan(1200);
  });

  it("does nothing if all keys are recent", async () => {
    const vars = { step1: chars(3000), step2: chars(3000) };
    const original = { ...vars };
    await autoCompressVars(vars, 1000, 5, onLog, undefined, failCompress);
    expect(vars).toEqual(original); // 2 keys < recentKeepCount 5 → all recent
  });
});

// ─── 4. Truncation fallback ───────────────────────────────────────────────────

describe("autoCompressVars — truncation fallback", () => {
  it("truncates to 1000 chars when compress fails", async () => {
    const vars = { step1: chars(8000, "A"), step2: chars(8000, "B"), recent: chars(2000, "C") };
    await autoCompressVars(vars, 5000, 1, onLog, undefined, failCompress);
    expect(vars.step1.length).toBeLessThan(1100);
    expect(vars.step1).toContain("[auto-truncated from 8000 chars]");
    expect(vars.recent).toBe(chars(2000, "C"));
  });

  it("logs warn for each truncation", async () => {
    const vars = { step1: chars(5000), recent: chars(2000) };
    await autoCompressVars(vars, 1000, 1, onLog, undefined, failCompress);
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('Auto-truncated "step1"'), "warn");
  });
});

// ─── 5. Skips small vars ──────────────────────────────────────────────────────

describe("autoCompressVars — skips small vars", () => {
  it("does not compress old vars < 500 chars", async () => {
    const vars = { step1: chars(100, "S"), step2: chars(400, "M"), recent: chars(5000, "L") };
    await autoCompressVars(vars, 1000, 1, onLog, undefined, failCompress);
    expect(vars.step1).toBe(chars(100, "S"));
    expect(vars.step2).toBe(chars(400, "M"));
  });
});

// ─── 6. Summarization path ────────────────────────────────────────────────────

describe("autoCompressVars — summarization", () => {
  it("uses compress function and stores result", async () => {
    const mockCompress = vi.fn().mockResolvedValue("[compressed summary]");
    const vars = { old_step: chars(5000, "X"), recent: chars(1000, "R") };
    await autoCompressVars(vars, 2000, 1, onLog, undefined, mockCompress);
    expect(mockCompress).toHaveBeenCalledWith(chars(5000, "X"));
    expect(vars.old_step).toBe("[compressed summary]");
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("Auto-compressed"), "info");
  });
});

// ─── 7. Budget early stop ─────────────────────────────────────────────────────

describe("autoCompressVars — budget early stop", () => {
  it("stops after first compression if budget met", async () => {
    const mockCompress = vi.fn().mockResolvedValue("[short]");
    const vars = {
      step1: chars(2000, "A"),
      step2: chars(10000, "B"), // largest → processed first
      step3: chars(2000, "C"),
      recent: chars(1000, "R"),
    };
    // Total 15000, budget 6000. After step2 compressed to "[short]" (7 chars):
    // new total = 2000 + 7 + 2000 + 1000 = 5007 < 6000 → stop
    await autoCompressVars(vars, 6000, 1, onLog, undefined, mockCompress);
    expect(vars.step2).toBe("[short]");
    expect(vars.step1).toBe(chars(2000, "A")); // not compressed, budget met
    expect(vars.step3).toBe(chars(2000, "C")); // not compressed
    expect(mockCompress).toHaveBeenCalledTimes(1); // only step2
  });

  it("compresses largest first for max impact", async () => {
    const mockCompress = vi.fn().mockResolvedValue("[short]");
    const vars = { small: chars(600, "S"), large: chars(20000, "L"), recent: chars(500, "R") };
    await autoCompressVars(vars, 3000, 1, onLog, undefined, mockCompress);
    expect(vars.large).toBe("[short]");
    expect(vars.small).toBe(chars(600, "S")); // budget met after large
    expect(vars.recent).toBe(chars(500, "R"));
  });
});

// ─── 8. Edge cases ────────────────────────────────────────────────────────────

describe("autoCompressVars — edge cases", () => {
  it("handles single protected var over budget", async () => {
    const vars = { "input.data": chars(10000) };
    const original = vars["input.data"];
    await autoCompressVars(vars, 1000, 0, onLog, undefined, failCompress);
    expect(vars["input.data"]).toBe(original);
  });

  it("protects __early_exit", async () => {
    const vars = { __early_exit: "true", step1: chars(5000), recent: chars(1000) };
    await autoCompressVars(vars, 2000, 1, onLog, undefined, failCompress);
    expect(vars.__early_exit).toBe("true");
  });

  it("returns final total", async () => {
    const vars = { step1: chars(5000), step2: chars(1000) };
    const result = await autoCompressVars(vars, 2000, 1, onLog, undefined, failCompress);
    expect(result).toBe(totalChars(vars));
  });

  it("handles empty string values", async () => {
    const vars = { step1: "", step2: chars(5000), recent: chars(1000) };
    await autoCompressVars(vars, 2000, 1, onLog, undefined, failCompress);
    expect(vars.step1).toBe("");
  });
});
