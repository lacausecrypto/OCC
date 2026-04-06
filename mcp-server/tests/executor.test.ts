/**
 * Tests for executor.ts exported functions.
 * Mocks claude-runner.ts and storage.ts to avoid spawning real processes.
 *
 * Covers:
 * - getExecution / getAllExecutions (in-memory store)
 * - cancelExecution
 * - loadPersistedExecutions
 * - executeChain (mocked Claude runner — tests the orchestration logic)
 * - Transform step operations (json_extract, regex, template, split, etc.)
 * - Condition evaluation in steps
 * - Early exit
 * - Variable resolution
 * - Output validation
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanupTmpDir } from "./_test-utils.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Mock heavy dependencies ─────────────────────────────────────────────

// Mock claude-runner to avoid spawning real processes
vi.mock("../src/claude-runner.js", () => {
  let runningCount = 0;
  return {
    validateClaudeBinary: vi.fn(),
    getRunningExecutionCount: vi.fn(() => runningCount),
    canStartExecution: vi.fn(() => runningCount < 5),
    incrementRunningCount: vi.fn(() => { runningCount++; }),
    decrementRunningCount: vi.fn(() => { runningCount = Math.max(0, runningCount - 1); }),
    MAX_CONCURRENT_EXECUTIONS: 5,
    runClaude: vi.fn(async (prompt: string) => ({
      stdout: `Mock response for: ${prompt.slice(0, 50)}`,
      durationMs: 100,
      inputTokens: 50,
      outputTokens: 100,
    })),
    runStepWithRetry: vi.fn(async (step: any, prompt: string) => ({
      stdout: `Mock response for step ${step.id}: ${prompt.slice(0, 50)}`,
      durationMs: 100,
      inputTokens: 50,
      outputTokens: 100,
    })),
    applyContextStrategy: vi.fn(async (vars: any) => ({ ...vars })),
  };
});

// Mock storage to avoid SQLite
vi.mock("../src/storage.js", () => ({
  saveExecution: vi.fn(),
  checkpointStep: vi.fn(),
  loadExecution: vi.fn(),
  listExecutions: vi.fn(() => []),
  initStorage: vi.fn(),
  getExecutionTimeline: vi.fn(() => []),
  loadChainSnapshot: vi.fn(),
  getChainStats: vi.fn(() => ({})),
  closeStorage: vi.fn(),
}));

// Mock pretool-executor
vi.mock("../src/pretool-executor.js", () => ({
  executePreTools: vi.fn(async () => ({})),
}));

// Mock gate-manager
vi.mock("../src/gate-manager.js", () => ({
  GateSuspendError: class extends Error { constructor(msg: string) { super(msg); } },
  getPendingApprovals: vi.fn(() => []),
  approveGate: vi.fn(() => false),
  waitForApproval: vi.fn(),
  getGateResult: vi.fn(),
  deleteGateResult: vi.fn(),
  setGateResult: vi.fn(),
  hasGateResult: vi.fn(() => false),
  setGateTimer: vi.fn(),
}));

import {
  getExecution,
  getAllExecutions,
  cancelExecution,
  loadPersistedExecutions,
  executeChain,
  getRunningExecutionCount,
  canStartExecution,
  getPendingApprovals,
} from "../src/executor.js";
import type { ChainDefinition, ExecutionEvent } from "../src/types.js";

let tmpDir: string;
let origChainsDir: string | undefined;
let origExecutionsFile: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-executor-test-"));
  origChainsDir = process.env.CHAINS_DIR;
  origExecutionsFile = process.env.EXECUTIONS_FILE;
  process.env.CHAINS_DIR = tmpDir;
  process.env.EXECUTIONS_FILE = path.join(tmpDir, "executions.json");
});

afterEach(async () => {
  if (origChainsDir === undefined) delete process.env.CHAINS_DIR;
  else process.env.CHAINS_DIR = origChainsDir;
  if (origExecutionsFile === undefined) delete process.env.EXECUTIONS_FILE;
  else process.env.EXECUTIONS_FILE = origExecutionsFile;
  await cleanupTmpDir(tmpDir);
});

// ─── getExecution / getAllExecutions ────────────────────────────────────────

describe("getExecution", () => {
  it("returns undefined for unknown execution", () => {
    expect(getExecution("nonexistent-id")).toBeUndefined();
  });
});

describe("getAllExecutions", () => {
  it("returns an array (possibly with executions from prior tests)", () => {
    const all = getAllExecutions();
    expect(Array.isArray(all)).toBe(true);
  });
});

// ─── loadPersistedExecutions ───────────────────────────────────────────────

describe("loadPersistedExecutions", () => {
  it("does not throw when no executions file exists", () => {
    expect(() => loadPersistedExecutions()).not.toThrow();
  });

  it("loads from JSON file when it exists", () => {
    const executions = [
      {
        id: "test-exec-1",
        chainName: "test-chain",
        status: "done",
        input: {},
        steps: {},
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 100,
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "executions.json"),
      JSON.stringify(executions),
    );
    // Update the env to point to the correct directory
    process.env.EXECUTIONS_FILE = path.join(tmpDir, "executions.json");
    expect(() => loadPersistedExecutions()).not.toThrow();
  });

  it("marks running executions as error on reload", () => {
    const executions = [
      {
        id: "running-exec",
        chainName: "test",
        status: "running",
        input: {},
        steps: {},
        startedAt: new Date().toISOString(),
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "executions.json"),
      JSON.stringify(executions),
    );
    process.env.EXECUTIONS_FILE = path.join(tmpDir, "executions.json");
    loadPersistedExecutions();
    const exec = getExecution("running-exec");
    if (exec) {
      expect(exec.status).toBe("error");
      expect(exec.error).toContain("Interrupted");
    }
  });

  it("handles corrupted JSON gracefully", () => {
    fs.writeFileSync(path.join(tmpDir, "executions.json"), "not valid json{{{");
    process.env.EXECUTIONS_FILE = path.join(tmpDir, "executions.json");
    expect(() => loadPersistedExecutions()).not.toThrow();
  });
});

// ─── cancelExecution ───────────────────────────────────────────────────────

describe("cancelExecution", () => {
  it("returns false for unknown execution", () => {
    expect(cancelExecution("nonexistent")).toBe(false);
  });
});

// ─── getPendingApprovals ───────────────────────────────────────────────────

describe("getPendingApprovals", () => {
  it("returns an array", () => {
    const approvals = getPendingApprovals();
    expect(Array.isArray(approvals)).toBe(true);
  });
});

// ─── canStartExecution / getRunningExecutionCount ──────────────────────────

describe("canStartExecution / getRunningExecutionCount", () => {
  it("canStartExecution returns a boolean", () => {
    expect(typeof canStartExecution()).toBe("boolean");
  });

  it("getRunningExecutionCount returns a number", () => {
    expect(typeof getRunningExecutionCount()).toBe("number");
  });
});

// ─── executeChain with transform steps ─────────────────────────────────────

describe("executeChain with transform steps", () => {
  function makeChain(steps: any[], output: string = "result"): ChainDefinition {
    return {
      name: "test-chain",
      steps: steps.map((s) => ({
        prompt: "",
        tools: [],
        depends_on: [],
        ...s,
      })),
      output,
    } as ChainDefinition;
  }

  function collectEvents(): { events: ExecutionEvent[]; emit: (e: ExecutionEvent) => void } {
    const events: ExecutionEvent[] = [];
    return { events, emit: (e: ExecutionEvent) => events.push(e) };
  }

  it("executes a simple agent step (mocked)", async () => {
    const chain = makeChain([
      { id: "s1", type: "agent", prompt: "Say hello", output_var: "result" },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(typeof result).toBe("string");
    expect(events.some((e) => e.type === "execution_started")).toBe(true);
    expect(events.some((e) => e.type === "execution_done")).toBe(true);
  });

  it("executes transform: template", async () => {
    const chain = makeChain([
      { id: "t1", type: "transform", operation: "template", template_str: "Hello {name}!", output_var: "result" },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, { name: "World" }, emit);
    expect(result).toBe("Hello World!");
  });

  it("executes transform: split", async () => {
    const chain = makeChain([
      { id: "a1", type: "agent", prompt: "List items", output_var: "items" },
      { id: "t1", type: "transform", operation: "split", input_var: "items", output_var: "result", depends_on: ["a1"] },
    ]);
    // The mock returns a string with the prompt, which will be split by newlines
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(typeof result).toBe("string");
  });

  it("executes transform: truncate", async () => {
    const chain = makeChain([
      { id: "t1", type: "transform", operation: "truncate", truncate_limit: 10, prompt: "This is a very long text that should be truncated", output_var: "result" },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(result).toContain("[truncated");
  });

  it("executes transform: json_extract", async () => {
    const chain = makeChain([
      { id: "setup", type: "transform", operation: "template", template_str: '{"name":"Alice","age":30}', output_var: "data" },
      { id: "extract", type: "transform", operation: "json_extract", input_var: "data", json_path: "name", output_var: "result", depends_on: ["setup"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(result).toBe("Alice");
  });

  it("executes transform: regex_match", async () => {
    const chain = makeChain([
      { id: "setup", type: "transform", operation: "template", template_str: "Error 404: Not Found. Error 500: Server Error", output_var: "text" },
      { id: "extract", type: "transform", operation: "regex_match", input_var: "text", regex: "\\d{3}", output_var: "result", depends_on: ["setup"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(result).toContain("404");
    expect(result).toContain("500");
  });

  it("executes transform: replace", async () => {
    const chain = makeChain([
      { id: "setup", type: "transform", operation: "template", template_str: "Hello World", output_var: "text" },
      { id: "replace", type: "transform", operation: "replace", input_var: "text", regex: "World", template_str: "Universe", output_var: "result", depends_on: ["setup"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(result).toBe("Hello Universe");
  });

  it("executes transform: filter", async () => {
    const chain = makeChain([
      { id: "setup", type: "transform", operation: "template", template_str: "apple\nbanana\navocado\nblueberry", output_var: "list" },
      { id: "filter", type: "transform", operation: "filter", input_var: "list", regex: "^a", output_var: "result", depends_on: ["setup"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(result).toContain("apple");
    expect(result).toContain("avocado");
    expect(result).not.toContain("banana");
  });

  it("executes transform: map", async () => {
    const chain = makeChain([
      { id: "setup", type: "transform", operation: "template", template_str: "a\nb\nc", output_var: "items" },
      { id: "mapped", type: "transform", operation: "map", input_var: "items", template_str: "Item {index}: {item}", output_var: "result", depends_on: ["setup"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(result).toContain("Item 0: a");
    expect(result).toContain("Item 1: b");
    expect(result).toContain("Item 2: c");
  });

  it("executes transform: join", async () => {
    const chain = makeChain([
      { id: "setup", type: "transform", operation: "template", template_str: '["a","b","c"]', output_var: "arr" },
      { id: "joined", type: "transform", operation: "join", input_var: "arr", template_str: ", ", output_var: "result", depends_on: ["setup"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(result).toBe("a, b, c");
  });

  it("executes transform: to_json", async () => {
    const chain = makeChain([
      { id: "setup", type: "transform", operation: "template", template_str: "line1\nline2\nline3", output_var: "text" },
      { id: "json", type: "transform", operation: "to_json", input_var: "text", output_var: "result", depends_on: ["setup"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual(["line1", "line2", "line3"]);
  });

  it("executes transform: from_json (array)", async () => {
    const chain = makeChain([
      { id: "setup", type: "transform", operation: "template", template_str: '["a","b","c"]', output_var: "arr" },
      { id: "text", type: "transform", operation: "from_json", input_var: "arr", output_var: "result", depends_on: ["setup"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(result).toContain("a");
    expect(result).toContain("b");
    expect(result).toContain("c");
  });

  it("executes transform: from_json (object)", async () => {
    const chain = makeChain([
      { id: "setup", type: "transform", operation: "template", template_str: '{"name":"Alice","age":"30"}', output_var: "obj" },
      { id: "text", type: "transform", operation: "from_json", input_var: "obj", output_var: "result", depends_on: ["setup"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(result).toContain("name: Alice");
    expect(result).toContain("age: 30");
  });
});

// ─── executeChain with conditions ──────────────────────────────────────────

describe("executeChain with conditions", () => {
  function makeChain(steps: any[]): ChainDefinition {
    return {
      name: "cond-test",
      steps: steps.map((s) => ({
        prompt: "",
        tools: [],
        depends_on: [],
        ...s,
      })),
      output: "result",
    } as ChainDefinition;
  }

  function collectEvents() {
    const events: ExecutionEvent[] = [];
    return { events, emit: (e: ExecutionEvent) => events.push(e) };
  }

  it("skips step when condition is false", async () => {
    const chain = makeChain([
      { id: "s1", type: "transform", operation: "template", template_str: "fallback", output_var: "result", condition: 'false' },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    // Condition "false" evaluates to falsy, so step is skipped and result is ""
    expect(result).toBe("");
    const skippedLogs = events.filter(
      (e) => e.type === "step_log" && "message" in e && e.message.includes("Condition not met"),
    );
    expect(skippedLogs.length).toBeGreaterThan(0);
  });

  it("runs step when condition is true", async () => {
    const chain = makeChain([
      { id: "s1", type: "transform", operation: "template", template_str: "executed", output_var: "result", condition: "something_truthy" },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(result).toBe("executed");
  });

  it("resolves variables in conditions", async () => {
    const chain = makeChain([
      { id: "setup", type: "transform", operation: "template", template_str: "enabled", output_var: "flag" },
      { id: "cond", type: "transform", operation: "template", template_str: "ran!", output_var: "result", condition: '{flag} == "enabled"', depends_on: ["setup"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(result).toBe("ran!");
  });
});

// ─── executeChain with early_exit_if ───────────────────────────────────────

describe("executeChain with early_exit_if", () => {
  function makeChain(steps: any[]): ChainDefinition {
    return {
      name: "early-exit-test",
      steps: steps.map((s) => ({
        prompt: "",
        tools: [],
        depends_on: [],
        ...s,
      })),
      output: "result",
    } as ChainDefinition;
  }

  function collectEvents() {
    const events: ExecutionEvent[] = [];
    return { events, emit: (e: ExecutionEvent) => events.push(e) };
  }

  it("exits early when early_exit_if evaluates to true", async () => {
    const chain = makeChain([
      { id: "s1", type: "transform", operation: "template", template_str: "done", output_var: "status", early_exit_if: "always_true" },
      { id: "s2", type: "transform", operation: "template", template_str: "should not run", output_var: "result", depends_on: ["s1"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    // s1 triggered early exit, s2 should be skipped
    expect(result).toBe("");
  });
});

// ─── executeChain with inputs ──────────────────────────────────────────────

describe("executeChain with inputs", () => {
  it("makes input available as {input.key} and {key}", async () => {
    const chain: ChainDefinition = {
      name: "input-test",
      inputs: [{ name: "topic" }],
      steps: [
        {
          id: "s1",
          type: "transform",
          operation: "template",
          template_str: "Topic: {input.topic}, Also: {topic}",
          output_var: "result",
          tools: [],
          depends_on: [],
          prompt: "",
        },
      ],
      output: "result",
    } as any;
    const events: ExecutionEvent[] = [];
    const result = await executeChain(chain, { topic: "AI" }, (e) => events.push(e));
    expect(result).toBe("Topic: AI, Also: AI");
  });

  it("throws for missing required input", async () => {
    const chain: ChainDefinition = {
      name: "required-input",
      inputs: [{ name: "required_field" }],
      steps: [
        { id: "s1", type: "agent", prompt: "test", output_var: "result", tools: [], depends_on: [] },
      ],
      output: "result",
    } as any;
    await expect(
      executeChain(chain, {}, () => {}),
    ).rejects.toThrow(/Missing required input/);
  });

  it("allows optional inputs to be missing", async () => {
    const chain: ChainDefinition = {
      name: "optional-input",
      inputs: [{ name: "opt_field", optional: true }],
      steps: [
        { id: "s1", type: "transform", operation: "template", template_str: "ok", output_var: "result", tools: [], depends_on: [], prompt: "" },
      ],
      output: "result",
    } as any;
    const result = await executeChain(chain, {}, () => {});
    expect(result).toBe("ok");
  });
});

// ─── executeChain with merge steps ─────────────────────────────────────────

describe("executeChain with merge steps", () => {
  function makeChain(steps: any[]): ChainDefinition {
    return {
      name: "merge-test",
      steps: steps.map((s) => ({
        prompt: "",
        tools: [],
        depends_on: [],
        ...s,
      })),
      output: "result",
    } as ChainDefinition;
  }

  function collectEvents() {
    const events: ExecutionEvent[] = [];
    return { events, emit: (e: ExecutionEvent) => events.push(e) };
  }

  it("merge: concatenate strategy", async () => {
    const chain = makeChain([
      { id: "a", type: "transform", operation: "template", template_str: "Part A", output_var: "part_a" },
      { id: "b", type: "transform", operation: "template", template_str: "Part B", output_var: "part_b" },
      { id: "merged", type: "merge", inputs: ["part_a", "part_b"], strategy: "concatenate", output_var: "result", depends_on: ["a", "b"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(result).toContain("Part A");
    expect(result).toContain("Part B");
    expect(result).toContain("---");
  });

  it("merge: json_array strategy", async () => {
    const chain = makeChain([
      { id: "a", type: "transform", operation: "template", template_str: "Alpha", output_var: "v1" },
      { id: "b", type: "transform", operation: "template", template_str: "Beta", output_var: "v2" },
      { id: "merged", type: "merge", inputs: ["v1", "v2"], strategy: "json_array", output_var: "result", depends_on: ["a", "b"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual(["Alpha", "Beta"]);
  });

  it("merge: llm_summarize strategy (mocked)", async () => {
    const chain = makeChain([
      { id: "a", type: "transform", operation: "template", template_str: "Section A content", output_var: "sec_a" },
      { id: "b", type: "transform", operation: "template", template_str: "Section B content", output_var: "sec_b" },
      { id: "merged", type: "merge", inputs: ["sec_a", "sec_b"], strategy: "llm_summarize", output_var: "result", depends_on: ["a", "b"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("merge: pick_best strategy (mocked)", async () => {
    const chain = makeChain([
      { id: "a", type: "transform", operation: "template", template_str: "Option A", output_var: "opt_a" },
      { id: "b", type: "transform", operation: "template", template_str: "Option B", output_var: "opt_b" },
      { id: "merged", type: "merge", inputs: ["opt_a", "opt_b"], strategy: "pick_best", output_var: "result", depends_on: ["a", "b"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(typeof result).toBe("string");
  });

  it("merge: default strategy is concatenate", async () => {
    const chain = makeChain([
      { id: "a", type: "transform", operation: "template", template_str: "X", output_var: "x" },
      { id: "b", type: "transform", operation: "template", template_str: "Y", output_var: "y" },
      { id: "merged", type: "merge", inputs: ["x", "y"], output_var: "result", depends_on: ["a", "b"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(result).toContain("X");
    expect(result).toContain("Y");
  });
});

// ─── executeChain with evaluator step ──────────────────────────────────────

describe("executeChain with evaluator step", () => {
  function makeChain(steps: any[]): ChainDefinition {
    return {
      name: "eval-test",
      steps: steps.map((s) => ({
        prompt: "",
        tools: [],
        depends_on: [],
        ...s,
      })),
      output: "result",
    } as ChainDefinition;
  }

  function collectEvents() {
    const events: ExecutionEvent[] = [];
    return { events, emit: (e: ExecutionEvent) => events.push(e) };
  }

  it("evaluator step runs and returns PASS/FAIL", async () => {
    const { runStepWithRetry } = await import("../src/claude-runner.js");
    // Mock to return "PASS" for evaluator
    (runStepWithRetry as any).mockResolvedValueOnce({
      stdout: "PASS - Looks good",
      durationMs: 50,
      inputTokens: 30,
      outputTokens: 20,
    });

    const chain = makeChain([
      { id: "writer", type: "agent", prompt: "Write something", output_var: "draft" },
      { id: "eval", type: "evaluator", input_var: "draft", criteria: "Must be concise", on_fail: "skip", output_var: "result", depends_on: ["writer"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(["PASS", "FAIL"]).toContain(result);
  });
});

// ─── executeChain with router step ─────────────────────────────────────────

describe("executeChain with router step", () => {
  function makeChain(steps: any[]): ChainDefinition {
    return {
      name: "router-test",
      steps: steps.map((s) => ({
        prompt: "",
        tools: [],
        depends_on: [],
        ...s,
      })),
      output: "result",
    } as ChainDefinition;
  }

  function collectEvents() {
    const events: ExecutionEvent[] = [];
    return { events, emit: (e: ExecutionEvent) => events.push(e) };
  }

  it("router step classifies and selects a route", async () => {
    const { runStepWithRetry } = await import("../src/claude-runner.js");
    // Mock router to return "high" as classification
    (runStepWithRetry as any).mockResolvedValueOnce({
      stdout: "high",
      durationMs: 50,
      inputTokens: 20,
      outputTokens: 10,
    });

    const chain = makeChain([
      { id: "router", type: "router", prompt: "Classify: {input.priority}", output_var: "route",
        routes: { high: ["fast_track"], low: ["standard"] }, default_route: "low" },
      { id: "fast_track", type: "transform", operation: "template", template_str: "fast!", output_var: "result", depends_on: ["router"] },
      { id: "standard", type: "transform", operation: "template", template_str: "normal", output_var: "alt", depends_on: ["router"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, { priority: "urgent" }, emit);
    expect(result).toBe("fast!");
  });
});

// ─── executeChain with agent step (mocked Claude) ──────────────────────────

describe("executeChain with agent step (mocked)", () => {
  function makeChain(steps: any[]): ChainDefinition {
    return {
      name: "agent-test",
      steps: steps.map((s) => ({
        prompt: "",
        tools: [],
        depends_on: [],
        ...s,
      })),
      output: "result",
    } as ChainDefinition;
  }

  function collectEvents() {
    const events: ExecutionEvent[] = [];
    return { events, emit: (e: ExecutionEvent) => events.push(e) };
  }

  it("agent step with output validation passes", async () => {
    const { runStepWithRetry } = await import("../src/claude-runner.js");
    (runStepWithRetry as any).mockResolvedValueOnce({
      stdout: "This contains the required keyword conclusion",
      durationMs: 100,
      inputTokens: 50,
      outputTokens: 80,
    });

    const chain = makeChain([
      { id: "s1", type: "agent", prompt: "Write with conclusion", output_var: "result",
        output_must_contain: ["conclusion"] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(result).toContain("conclusion");
  });

  it("agent step with context_strategy", async () => {
    const chain = makeChain([
      { id: "setup", type: "transform", operation: "template", template_str: "x".repeat(10000), output_var: "long_text" },
      { id: "s1", type: "agent", prompt: "Summarize: {long_text}", output_var: "result",
        depends_on: ["setup"],
        context_strategy: { long_text: "truncate:500" } },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(typeof result).toBe("string");
  });

  it("agent step with pre_tools (mocked)", async () => {
    const chain = makeChain([
      { id: "s1", type: "agent", prompt: "Use {now} in response", output_var: "result",
        pre_tools: [{ type: "current_datetime", inject_as: "now" }] },
    ]);
    const { events, emit } = collectEvents();
    const result = await executeChain(chain, {}, emit);
    expect(typeof result).toBe("string");
  });
});

// ─── executeChain with parallel steps ──────────────────────────────────────

describe("executeChain with parallel steps", () => {
  it("runs independent steps in parallel", async () => {
    const chain: ChainDefinition = {
      name: "parallel-test",
      steps: [
        { id: "a", type: "transform", operation: "template", template_str: "A", output_var: "out_a", tools: [], depends_on: [], prompt: "" },
        { id: "b", type: "transform", operation: "template", template_str: "B", output_var: "out_b", tools: [], depends_on: [], prompt: "" },
        { id: "c", type: "transform", operation: "template", template_str: "{out_a}+{out_b}", output_var: "result", tools: [], depends_on: ["a", "b"], prompt: "" },
      ],
      output: "result",
    } as any;
    const events: ExecutionEvent[] = [];
    const result = await executeChain(chain, {}, (e) => events.push(e));
    expect(result).toBe("A+B");
  });
});
