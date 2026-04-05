/**
 * Tests for pure utility functions from claude-runner.ts.
 * Does NOT spawn any Claude CLI processes.
 *
 * Covers:
 * - getRunningExecutionCount / incrementRunningCount / decrementRunningCount
 * - canStartExecution
 * - validateClaudeBinary (graceful failure in test env)
 * - ERROR_LINE_PATTERNS filtering logic
 * - applyContextStrategy (truncate only — summarize needs Claude)
 * - MAX_CONCURRENT_EXECUTIONS constant
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getRunningExecutionCount,
  canStartExecution,
  incrementRunningCount,
  decrementRunningCount,
  validateClaudeBinary,
  MAX_CONCURRENT_EXECUTIONS,
  applyContextStrategy,
} from "../src/claude-runner.js";

// ─── Concurrent execution tracking ────────────────────────────────────────

describe("Concurrent execution tracking", () => {
  // Reset the counter before each test by decrementing to 0
  beforeEach(() => {
    while (getRunningExecutionCount() > 0) {
      decrementRunningCount();
    }
  });

  afterEach(() => {
    while (getRunningExecutionCount() > 0) {
      decrementRunningCount();
    }
  });

  describe("getRunningExecutionCount", () => {
    it("returns 0 initially", () => {
      expect(getRunningExecutionCount()).toBe(0);
    });

    it("returns correct count after increments", () => {
      incrementRunningCount();
      incrementRunningCount();
      expect(getRunningExecutionCount()).toBe(2);
    });
  });

  describe("incrementRunningCount", () => {
    it("increments by 1", () => {
      const before = getRunningExecutionCount();
      incrementRunningCount();
      expect(getRunningExecutionCount()).toBe(before + 1);
    });

    it("increments multiple times", () => {
      incrementRunningCount();
      incrementRunningCount();
      incrementRunningCount();
      expect(getRunningExecutionCount()).toBe(3);
    });
  });

  describe("decrementRunningCount", () => {
    it("decrements by 1", () => {
      incrementRunningCount();
      incrementRunningCount();
      decrementRunningCount();
      expect(getRunningExecutionCount()).toBe(1);
    });

    it("does not go below 0", () => {
      decrementRunningCount();
      decrementRunningCount();
      decrementRunningCount();
      expect(getRunningExecutionCount()).toBe(0);
    });

    it("does not go below 0 even with many decrements", () => {
      for (let i = 0; i < 100; i++) {
        decrementRunningCount();
      }
      expect(getRunningExecutionCount()).toBe(0);
    });
  });

  describe("canStartExecution", () => {
    it("returns true when count is 0", () => {
      expect(canStartExecution()).toBe(true);
    });

    it("returns true when under the limit", () => {
      for (let i = 0; i < MAX_CONCURRENT_EXECUTIONS - 1; i++) {
        incrementRunningCount();
      }
      expect(canStartExecution()).toBe(true);
    });

    it("returns false when at the limit", () => {
      for (let i = 0; i < MAX_CONCURRENT_EXECUTIONS; i++) {
        incrementRunningCount();
      }
      expect(canStartExecution()).toBe(false);
    });

    it("returns false when over the limit", () => {
      for (let i = 0; i < MAX_CONCURRENT_EXECUTIONS + 2; i++) {
        incrementRunningCount();
      }
      expect(canStartExecution()).toBe(false);
    });

    it("returns true again after decrement brings count below limit", () => {
      for (let i = 0; i < MAX_CONCURRENT_EXECUTIONS; i++) {
        incrementRunningCount();
      }
      expect(canStartExecution()).toBe(false);
      decrementRunningCount();
      expect(canStartExecution()).toBe(true);
    });
  });

  describe("increment/decrement symmetry", () => {
    it("returns to 0 after equal increments and decrements", () => {
      for (let i = 0; i < 5; i++) incrementRunningCount();
      for (let i = 0; i < 5; i++) decrementRunningCount();
      expect(getRunningExecutionCount()).toBe(0);
    });
  });
});

// ─── MAX_CONCURRENT_EXECUTIONS constant ────────────────────────────────────

describe("MAX_CONCURRENT_EXECUTIONS", () => {
  it("is a positive number", () => {
    expect(MAX_CONCURRENT_EXECUTIONS).toBeGreaterThan(0);
  });

  it("defaults to 5 (unless env override)", () => {
    // The default in code is 5 unless MAX_CONCURRENT_EXECUTIONS env is set
    if (!process.env.MAX_CONCURRENT_EXECUTIONS) {
      expect(MAX_CONCURRENT_EXECUTIONS).toBe(5);
    } else {
      expect(MAX_CONCURRENT_EXECUTIONS).toBe(Number(process.env.MAX_CONCURRENT_EXECUTIONS));
    }
  });
});

// ─── validateClaudeBinary ──────────────────────────────────────────────────

describe("validateClaudeBinary", () => {
  it("does not throw even if claude is not installed", () => {
    // validateClaudeBinary is designed to warn but not crash
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => validateClaudeBinary()).not.toThrow();
    stderrSpy.mockRestore();
  });

  it("writes a warning or success message to stderr", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    validateClaudeBinary();
    // Should write something about claude binary
    expect(stderrSpy).toHaveBeenCalled();
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const hasClaudeMessage = calls.some(
      (msg) => msg.includes("Claude binary") || msg.includes("claude") || msg.includes("Claude CLI"),
    );
    expect(hasClaudeMessage).toBe(true);
    stderrSpy.mockRestore();
  });
});

// ─── ERROR_LINE_PATTERNS filtering ─────────────────────────────────────────

describe("ERROR_LINE_PATTERNS filtering logic", () => {
  // Recreate the patterns from claude-runner.ts
  const ERROR_LINE_PATTERNS = [
    /^error:/i,
    /^warning:/i,
    /^fatal:/i,
    /^SIGTERM/,
    /^SIGKILL/,
    /^Traceback/,
    /^\s*at\s+/,    // stack trace line
    /^node:/,       // node internal error
  ];

  function isErrorLine(line: string): boolean {
    return ERROR_LINE_PATTERNS.some((p) => p.test(line.trim()));
  }

  describe("matches error patterns", () => {
    it("matches 'error: something went wrong'", () => {
      expect(isErrorLine("error: something went wrong")).toBe(true);
    });

    it("matches 'Error: uppercase'", () => {
      expect(isErrorLine("Error: Connection refused")).toBe(true);
    });

    it("matches 'warning: deprecation'", () => {
      expect(isErrorLine("warning: deprecation notice")).toBe(true);
    });

    it("matches 'Warning: uppercase'", () => {
      expect(isErrorLine("Warning: something")).toBe(true);
    });

    it("matches 'fatal: not a git repository'", () => {
      expect(isErrorLine("fatal: not a git repository")).toBe(true);
    });

    it("matches 'Fatal: uppercase'", () => {
      expect(isErrorLine("Fatal: out of memory")).toBe(true);
    });

    it("matches 'SIGTERM'", () => {
      expect(isErrorLine("SIGTERM received")).toBe(true);
    });

    it("matches 'SIGKILL'", () => {
      expect(isErrorLine("SIGKILL sent")).toBe(true);
    });

    it("matches 'Traceback (most recent call last):'", () => {
      expect(isErrorLine("Traceback (most recent call last):")).toBe(true);
    });

    it("matches stack trace line '    at Object.main (/app.js:10)'", () => {
      expect(isErrorLine("    at Object.main (/app.js:10)")).toBe(true);
    });

    it("matches 'node:internal/errors:496'", () => {
      expect(isErrorLine("node:internal/errors:496")).toBe(true);
    });
  });

  describe("does NOT match valid content", () => {
    it("does not match normal text", () => {
      expect(isErrorLine("This is a normal line of text")).toBe(false);
    });

    it("does not match JSON output", () => {
      expect(isErrorLine('{"type": "content_block_delta"}')).toBe(false);
    });

    it("does not match markdown", () => {
      expect(isErrorLine("# Heading")).toBe(false);
    });

    it("does not match code with error in the middle", () => {
      expect(isErrorLine('console.log("error: not a real error")')).toBe(false);
    });

    it("does not match 'at' in the middle of a sentence", () => {
      expect(isErrorLine("Look at this example")).toBe(false);
    });

    it("does not match 'warning' in the middle", () => {
      expect(isErrorLine("This is not a warning message")).toBe(false);
    });

    it("does not match empty string", () => {
      expect(isErrorLine("")).toBe(false);
    });

    it("does not match just whitespace", () => {
      expect(isErrorLine("   ")).toBe(false);
    });
  });
});

// ─── applyContextStrategy (truncate only) ──────────────────────────────────

describe("applyContextStrategy", () => {
  const onLog = vi.fn();

  beforeEach(() => {
    onLog.mockClear();
  });

  it("truncate: truncates long value to N chars", async () => {
    const vars = { long_text: "x".repeat(10000) };
    const result = await applyContextStrategy(vars, { long_text: "truncate:5000" }, onLog);
    expect(result.long_text.length).toBeLessThanOrEqual(5100); // includes "[truncated from...]"
    expect(result.long_text).toContain("[truncated from 10000 chars]");
  });

  it("truncate: does not truncate short value", async () => {
    const vars = { short: "hello" };
    const result = await applyContextStrategy(vars, { short: "truncate:5000" }, onLog);
    expect(result.short).toBe("hello");
  });

  it("full: keeps value unchanged", async () => {
    const vars = { data: "original value" };
    const result = await applyContextStrategy(vars, { data: "full" }, onLog);
    expect(result.data).toBe("original value");
  });

  it("skips missing variables", async () => {
    const vars = { present: "value" };
    const result = await applyContextStrategy(vars, { missing: "truncate:100" }, onLog);
    expect(result.present).toBe("value");
    expect(result.missing).toBeUndefined();
  });

  it("handles empty strategy", async () => {
    const vars = { data: "value" };
    const result = await applyContextStrategy(vars, {}, onLog);
    expect(result.data).toBe("value");
  });

  it("truncate logs the compression", async () => {
    const vars = { text: "x".repeat(2000) };
    await applyContextStrategy(vars, { text: "truncate:1000" }, onLog);
    expect(onLog).toHaveBeenCalledWith(
      expect.stringContaining("Context compressed text"),
      "info",
    );
  });

  it("handles multiple variables", async () => {
    const vars = {
      short: "brief",
      long: "x".repeat(5000),
      medium: "y".repeat(2000),
    };
    const result = await applyContextStrategy(
      vars,
      { short: "full", long: "truncate:1000", medium: "truncate:3000" },
      onLog,
    );
    expect(result.short).toBe("brief");
    expect(result.long.length).toBeLessThan(1200);
    expect(result.medium).toBe("y".repeat(2000)); // under limit, not truncated
  });

  it("truncate:0 truncates everything", async () => {
    const vars = { text: "some content" };
    const result = await applyContextStrategy(vars, { text: "truncate:0" }, onLog);
    expect(result.text).toContain("[truncated");
    expect(result.text.startsWith("\n[truncated")).toBe(true);
  });
});
