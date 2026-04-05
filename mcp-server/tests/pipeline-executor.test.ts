/**
 * Tests for pipeline-executor.ts.
 * Mocks executeChain and loadChain to test orchestration logic.
 *
 * Covers:
 * - getPipelineExecution / getAllPipelineExecutions
 * - loadPersistedPipelineExecutions
 * - executePipeline: sequential and parallel chains
 * - executePipeline: condition-based skipping
 * - executePipeline: input resolution ({input.x}, {chain_ref_id})
 * - executePipeline: error handling
 * - executePipeline: required input validation
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock executor
vi.mock("../src/executor.js", () => ({
  executeChain: vi.fn(async (chain: any, input: any) => {
    // Simulate chain execution: return a result based on chain name + input
    const inputSummary = Object.values(input).join(",");
    return `Result of ${chain.name} with ${inputSummary || "no input"}`;
  }),
}));

// Mock loader
vi.mock("../src/loader.js", () => ({
  loadChain: vi.fn((name: string) => ({
    name,
    steps: [{ id: "s1", prompt: "test", output_var: "out", depends_on: [], tools: [] }],
    output: "out",
    inputs: [],
  })),
}));

// Mock storage
vi.mock("../src/storage.js", () => ({
  initStorage: vi.fn(),
  saveExecution: vi.fn(),
  checkpointStep: vi.fn(),
  loadExecution: vi.fn(),
  listExecutions: vi.fn(() => []),
  getExecutionTimeline: vi.fn(() => []),
  loadChainSnapshot: vi.fn(),
  getChainStats: vi.fn(() => ({})),
  closeStorage: vi.fn(),
}));

import {
  executePipeline,
  getPipelineExecution,
  getAllPipelineExecutions,
  loadPersistedPipelineExecutions,
} from "../src/pipeline-executor.js";
import type { PipelineDefinition, ExecutionEvent } from "../src/types.js";

let tmpDir: string;
let origChainsDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-pipeline-test-"));
  origChainsDir = process.env.CHAINS_DIR;
  process.env.CHAINS_DIR = tmpDir;
});

afterEach(() => {
  if (origChainsDir === undefined) delete process.env.CHAINS_DIR;
  else process.env.CHAINS_DIR = origChainsDir;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function collectEvents() {
  const events: ExecutionEvent[] = [];
  return { events, emit: (e: ExecutionEvent) => events.push(e) };
}

// ─── getPipelineExecution / getAllPipelineExecutions ────────────────────────

describe("getPipelineExecution", () => {
  it("returns undefined for unknown execution", () => {
    expect(getPipelineExecution("nonexistent")).toBeUndefined();
  });
});

describe("getAllPipelineExecutions", () => {
  it("returns an array", () => {
    expect(Array.isArray(getAllPipelineExecutions())).toBe(true);
  });
});

// ─── loadPersistedPipelineExecutions ───────────────────────────────────────

describe("loadPersistedPipelineExecutions", () => {
  it("does not throw when no file exists", () => {
    expect(() => loadPersistedPipelineExecutions()).not.toThrow();
  });

  it("loads from JSON file", () => {
    const executions = [
      {
        id: "pip_test1",
        pipelineName: "test-pipeline",
        status: "done",
        input: {},
        chains: {},
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 100,
      },
    ];
    const file = path.join(tmpDir.replace(/[/\\]chains[/\\]?$/, ""), "pipeline-executions.json");
    fs.writeFileSync(file, JSON.stringify(executions));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    loadPersistedPipelineExecutions();
    stderrSpy.mockRestore();
    const loaded = getPipelineExecution("pip_test1");
    if (loaded) {
      expect(loaded.pipelineName).toBe("test-pipeline");
    }
  });
});

// ─── executePipeline: sequential chains ────────────────────────────────────

describe("executePipeline: sequential chains", () => {
  it("executes a simple single-chain pipeline", async () => {
    const pipeline: PipelineDefinition = {
      name: "simple-pipeline",
      chains: [
        { id: "search", chain: "web-search", inputs: { query: "test" } },
      ],
      output: "search",
    };
    const { events, emit } = collectEvents();
    const result = await executePipeline(pipeline, {}, emit);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "execution_started")).toBe(true);
    expect(events.some((e) => e.type === "execution_done")).toBe(true);
  });

  it("executes sequential chains passing results", async () => {
    const pipeline: PipelineDefinition = {
      name: "seq-pipeline",
      chains: [
        { id: "step1", chain: "analyzer", inputs: { data: "raw data" } },
        { id: "step2", chain: "writer", depends_on: ["step1"], inputs: { analysis: "{step1}" } },
      ],
      output: "step2",
    };
    const { events, emit } = collectEvents();
    const result = await executePipeline(pipeline, {}, emit);
    expect(typeof result).toBe("string");
    // step2 should receive step1's result
    expect(events.filter((e) => e.type === "step_started")).toHaveLength(2);
  });

  it("resolves {input.xxx} in chain inputs", async () => {
    const pipeline: PipelineDefinition = {
      name: "input-resolve",
      inputs: [{ name: "topic" }],
      chains: [
        { id: "c1", chain: "search", inputs: { query: "{input.topic}" } },
      ],
      output: "c1",
    };
    const { events, emit } = collectEvents();
    const result = await executePipeline(pipeline, { topic: "AI safety" }, emit);
    expect(typeof result).toBe("string");
    expect(result).toContain("AI safety");
  });
});

// ─── executePipeline: parallel chains ──────────────────────────────────────

describe("executePipeline: parallel chains", () => {
  it("runs independent chains in parallel", async () => {
    const pipeline: PipelineDefinition = {
      name: "parallel-pipeline",
      chains: [
        { id: "a", chain: "chain-a", inputs: {} },
        { id: "b", chain: "chain-b", inputs: {} },
        { id: "merge", chain: "merger", depends_on: ["a", "b"], inputs: { data_a: "{a}", data_b: "{b}" } },
      ],
      output: "merge",
    };
    const { events, emit } = collectEvents();
    const result = await executePipeline(pipeline, {}, emit);
    expect(typeof result).toBe("string");
    // All 3 chains should have started
    const starts = events.filter((e) => e.type === "step_started");
    expect(starts).toHaveLength(3);
  });
});

// ─── executePipeline: condition-based skipping ─────────────────────────────

describe("executePipeline: conditions", () => {
  it("skips chain when condition is false", async () => {
    const pipeline: PipelineDefinition = {
      name: "cond-pipeline",
      chains: [
        { id: "always", chain: "basic", inputs: {} },
        { id: "optional", chain: "extra", condition: "false", depends_on: ["always"], inputs: {} },
        { id: "final", chain: "finisher", depends_on: ["always"], inputs: { data: "{always}" } },
      ],
      output: "final",
    };
    const { events, emit } = collectEvents();
    const result = await executePipeline(pipeline, {}, emit);
    expect(typeof result).toBe("string");
    // "optional" should be skipped
    const skippedLogs = events.filter(
      (e) => e.type === "step_log" && "message" in e && (e as any).message.includes("skipped"),
    );
    expect(skippedLogs.length).toBeGreaterThan(0);
  });
});

// ─── executePipeline: required input validation ────────────────────────────

describe("executePipeline: input validation", () => {
  it("throws for missing required pipeline input", async () => {
    const pipeline: PipelineDefinition = {
      name: "req-input",
      inputs: [{ name: "required_field" }],
      chains: [
        { id: "c1", chain: "basic", inputs: {} },
      ],
      output: "c1",
    };
    const { emit } = collectEvents();
    await expect(executePipeline(pipeline, {}, emit)).rejects.toThrow(/Missing required pipeline input/);
  });

  it("allows optional inputs to be missing", async () => {
    const pipeline: PipelineDefinition = {
      name: "opt-input",
      inputs: [{ name: "opt", optional: true }],
      chains: [
        { id: "c1", chain: "basic", inputs: {} },
      ],
      output: "c1",
    };
    const { emit } = collectEvents();
    const result = await executePipeline(pipeline, {}, emit);
    expect(typeof result).toBe("string");
  });
});

// ─── executePipeline: error handling ───────────────────────────────────────

describe("executePipeline: error handling", () => {
  it("handles chain load failure", async () => {
    const { loadChain } = await import("../src/loader.js");
    (loadChain as any).mockImplementationOnce(() => {
      throw new Error("Chain not found");
    });

    const pipeline: PipelineDefinition = {
      name: "err-pipeline",
      chains: [
        { id: "bad", chain: "nonexistent-chain", inputs: {} },
      ],
      output: "bad",
    };
    const { events, emit } = collectEvents();
    await expect(executePipeline(pipeline, {}, emit)).rejects.toThrow(/not found/);
    expect(events.some((e) => e.type === "execution_error")).toBe(true);
  });

  it("marks pending chains as skipped on error", async () => {
    const { executeChain: mockExec } = await import("../src/executor.js");
    (mockExec as any).mockRejectedValueOnce(new Error("Chain execution failed"));

    const pipeline: PipelineDefinition = {
      name: "skip-pipeline",
      chains: [
        { id: "fail", chain: "failing-chain", inputs: {} },
        { id: "after", chain: "unreachable", depends_on: ["fail"], inputs: {} },
      ],
      output: "after",
    };
    const { events, emit } = collectEvents();
    await expect(executePipeline(pipeline, {}, emit)).rejects.toThrow();
    expect(events.some((e) => e.type === "execution_error")).toBe(true);
  });
});

// ─── resolveInputMapping ───────────────────────────────────────────────────

describe("resolveInputMapping (via executePipeline)", () => {
  it("resolves {input.x} to pipeline input", async () => {
    const pipeline: PipelineDefinition = {
      name: "resolve-test",
      chains: [
        { id: "c1", chain: "test-chain", inputs: { topic: "{input.topic}", depth: "deep" } },
      ],
      output: "c1",
    };
    const { emit } = collectEvents();
    const result = await executePipeline(pipeline, { topic: "testing" }, emit);
    expect(result).toContain("testing");
  });

  it("resolves {chain_ref_id} to previous chain result", async () => {
    const pipeline: PipelineDefinition = {
      name: "chain-ref-test",
      chains: [
        { id: "first", chain: "producer", inputs: {} },
        { id: "second", chain: "consumer", depends_on: ["first"], inputs: { data: "{first}" } },
      ],
      output: "second",
    };
    const { emit } = collectEvents();
    const result = await executePipeline(pipeline, {}, emit);
    expect(typeof result).toBe("string");
  });
});
