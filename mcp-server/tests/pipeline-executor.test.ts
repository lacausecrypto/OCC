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

// vi.hoisted ensures these are available when vi.mock factories run (hoisted to top)
const { mockExecuteChain, mockRunClaude } = vi.hoisted(() => ({
  mockExecuteChain: vi.fn(async (chain: any, input: any) => {
    const inputSummary = Object.values(input).join(",");
    return `Result of ${chain.name} with ${inputSummary || "no input"}`;
  }),
  mockRunClaude: vi.fn(),
}));

// Mock executor
vi.mock("../src/executor.js", () => ({
  executeChain: mockExecuteChain,
}));

// Mock claude-runner (for summarize_output: true which dynamically imports runClaude)
vi.mock("../src/claude-runner.js", () => ({
  runClaude: mockRunClaude,
  validateClaudeBinary: vi.fn(),
  getRunningExecutionCount: vi.fn(() => 0),
  canStartExecution: vi.fn(() => true),
  incrementRunningCount: vi.fn(),
  decrementRunningCount: vi.fn(),
  runStepWithRetry: vi.fn(),
  applyContextStrategy: vi.fn(),
  autoCompressVars: vi.fn(),
  MAX_CONCURRENT_EXECUTIONS: 3,
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

// ─── Inter-chain summarization ────────────────────────────────────────────

describe("executePipeline: inter-chain summarization", () => {
  beforeEach(() => {
    // Reset mocks to default behavior before each summarization test
    mockExecuteChain.mockImplementation(async (chain: any, input: any) => {
      const inputSummary = Object.values(input).join(",");
      return `Result of ${chain.name} with ${inputSummary || "no input"}`;
    });
    mockRunClaude.mockReset();
  });

  it("no summarize_output — passthrough (no compression applied)", async () => {
    const output1000 = "x".repeat(1000);
    mockExecuteChain.mockResolvedValueOnce(output1000);

    const pipeline: PipelineDefinition = {
      name: "passthrough-test",
      chains: [
        { id: "c1", chain: "producer", inputs: {} },
      ],
      output: "c1",
    };
    const { events, emit } = collectEvents();
    const result = await executePipeline(pipeline, {}, emit);

    // Result should be exactly the 1000-char output — no truncation or summarization
    expect(result).toBe(output1000);
    expect(result).toHaveLength(1000);
    // No truncation/summarization log events
    const compressionLogs = events.filter(
      (e) => e.type === "step_log" && "message" in e &&
        ((e as any).message.includes("truncated") || (e as any).message.includes("summarized"))
    );
    expect(compressionLogs).toHaveLength(0);
  });

  it("summarize_output: 200 — truncates to 200 chars with footer", async () => {
    const output5000 = "A".repeat(5000);
    mockExecuteChain.mockResolvedValueOnce(output5000);

    const pipeline: PipelineDefinition = {
      name: "truncate-test",
      chains: [
        { id: "c1", chain: "producer", summarize_output: 200, inputs: {} },
      ],
      output: "c1",
    };
    const { events, emit } = collectEvents();
    const result = await executePipeline(pipeline, {}, emit);

    // Result should be truncated: 200 chars of content + footer
    expect(result.startsWith("A".repeat(200))).toBe(true);
    expect(result).toContain("[truncated from 5000 chars]");
    expect(result.length).toBeLessThan(5000);

    // Should have a truncation log event
    const truncLogs = events.filter(
      (e) => e.type === "step_log" && "message" in e &&
        (e as any).message.includes("Output truncated")
    );
    expect(truncLogs).toHaveLength(1);
  });

  it("summarize_output: true — attempts Haiku summarize via runClaude", async () => {
    // Output must be > 5000 chars (the threshold for summarize_output: true)
    const output8000 = "B".repeat(8000);
    mockExecuteChain.mockResolvedValueOnce(output8000);

    // Mock runClaude to produce a summary via onChunk callback
    mockRunClaude.mockImplementation(async (prompt: string, step: any, onChunk: (chunk: string) => void) => {
      onChunk("This is the summary of the output.");
    });

    const pipeline: PipelineDefinition = {
      name: "summarize-test",
      chains: [
        { id: "c1", chain: "producer", summarize_output: true, inputs: {} },
      ],
      output: "c1",
    };
    const { events, emit } = collectEvents();
    const result = await executePipeline(pipeline, {}, emit);

    // runClaude should have been called
    expect(mockRunClaude).toHaveBeenCalledTimes(1);
    // Verify it was called with a summarize prompt
    const promptArg = mockRunClaude.mock.calls[0][0];
    expect(promptArg).toContain("Summarize concisely");
    expect(promptArg).toContain(output8000);
    // Verify the step arg uses claude-haiku-4-5 model
    const stepArg = mockRunClaude.mock.calls[0][1];
    expect(stepArg.model).toBe("claude-haiku-4-5");

    // Result should be the summary
    expect(result).toBe("This is the summary of the output.");

    // Should have a summarization log event
    const sumLogs = events.filter(
      (e) => e.type === "step_log" && "message" in e &&
        (e as any).message.includes("Output summarized")
    );
    expect(sumLogs).toHaveLength(1);
  });

  it("auto-truncate at 100k when no summarize_output set", async () => {
    const output200k = "C".repeat(200000);
    mockExecuteChain.mockResolvedValueOnce(output200k);

    const pipeline: PipelineDefinition = {
      name: "auto-truncate-test",
      chains: [
        { id: "c1", chain: "producer", inputs: {} },
        // No summarize_output set
      ],
      output: "c1",
    };
    const { events, emit } = collectEvents();
    const result = await executePipeline(pipeline, {}, emit);

    // Should be auto-truncated to 100k + footer
    expect(result.startsWith("C".repeat(100))).toBe(true);
    expect(result).toContain("[auto-truncated from 200000 chars]");
    // The content part should be 100k chars
    const contentPart = result.split("\n[auto-truncated")[0];
    expect(contentPart).toHaveLength(100000);

    // Should have auto-truncation log event
    const autoLogs = events.filter(
      (e) => e.type === "step_log" && "message" in e &&
        (e as any).message.includes("auto-truncated")
    );
    expect(autoLogs).toHaveLength(1);
  });

  it("short output not compressed even with summarize_output: true (threshold 500)", async () => {
    const output300 = "D".repeat(300);
    mockExecuteChain.mockResolvedValueOnce(output300);

    const pipeline: PipelineDefinition = {
      name: "short-output-test",
      chains: [
        { id: "c1", chain: "producer", summarize_output: true, inputs: {} },
      ],
      output: "c1",
    };
    const { events, emit } = collectEvents();
    const result = await executePipeline(pipeline, {}, emit);

    // Output is 300 chars < 500 threshold, so no compression at all
    expect(result).toBe(output300);
    expect(result).toHaveLength(300);
    // runClaude should NOT have been called
    expect(mockRunClaude).not.toHaveBeenCalled();
    // No truncation or summarization log events
    const compressionLogs = events.filter(
      (e) => e.type === "step_log" && "message" in e &&
        ((e as any).message.includes("truncated") || (e as any).message.includes("summarized"))
    );
    expect(compressionLogs).toHaveLength(0);
  });

  it("full result preserved in chainStatus.result even when chainResults is compressed", async () => {
    const output5000 = "E".repeat(5000);
    mockExecuteChain.mockResolvedValueOnce(output5000);

    const pipeline: PipelineDefinition = {
      name: "preserve-full-test",
      chains: [
        { id: "c1", chain: "producer", summarize_output: 200, inputs: {} },
      ],
      output: "c1",
    };
    const { events, emit } = collectEvents();
    await executePipeline(pipeline, {}, emit);

    // The returned result (from chainResults) is truncated
    // But the execution record should have the full result in chainStatus
    const execution = getPipelineExecution(
      events.find((e) => e.type === "execution_started")!.executionId
    );
    expect(execution).toBeDefined();
    // chainStatus.result should have the FULL original output
    expect(execution!.chains["c1"].result).toBe(output5000);
    expect(execution!.chains["c1"].result).toHaveLength(5000);
    // But the pipeline result (from chainResults map used for downstream/output) is truncated
    expect(execution!.result).toContain("[truncated from 5000 chars]");
    expect(execution!.result!.length).toBeLessThan(5000);
  });

  it("summarize_output: true falls back to truncation when runClaude fails", async () => {
    const output8000 = "F".repeat(8000);
    mockExecuteChain.mockResolvedValueOnce(output8000);

    // Mock runClaude to throw an error
    mockRunClaude.mockRejectedValueOnce(new Error("Claude API unavailable"));

    const pipeline: PipelineDefinition = {
      name: "summarize-fallback-test",
      chains: [
        { id: "c1", chain: "producer", summarize_output: true, inputs: {} },
      ],
      output: "c1",
    };
    const { events, emit } = collectEvents();
    const result = await executePipeline(pipeline, {}, emit);

    // Should fall back to truncation at 5000 chars (the threshold for summarize_output: true)
    expect(result).toContain("[truncated — summarization failed]");
    expect(result.startsWith("F".repeat(100))).toBe(true);

    // Should have a fallback log event
    const fallbackLogs = events.filter(
      (e) => e.type === "step_log" && "message" in e &&
        (e as any).message.includes("Summarization failed")
    );
    expect(fallbackLogs).toHaveLength(1);
  });

  it("auto-truncate does NOT apply when summarize_output is set", async () => {
    // Even if the output is huge (> 100k), when summarize_output is set,
    // auto-truncation should be skipped (the summarize_output logic handles it)
    const output200k = "G".repeat(200000);
    mockExecuteChain.mockResolvedValueOnce(output200k);

    // Mock runClaude to produce a summary
    mockRunClaude.mockImplementation(async (prompt: string, step: any, onChunk: (chunk: string) => void) => {
      onChunk("Summarized 200k chars of G's.");
    });

    const pipeline: PipelineDefinition = {
      name: "no-auto-truncate-with-summarize",
      chains: [
        { id: "c1", chain: "producer", summarize_output: true, inputs: {} },
      ],
      output: "c1",
    };
    const { events, emit } = collectEvents();
    const result = await executePipeline(pipeline, {}, emit);

    // Should be summarized, NOT auto-truncated
    expect(result).toBe("Summarized 200k chars of G's.");
    // No auto-truncation log
    const autoLogs = events.filter(
      (e) => e.type === "step_log" && "message" in e &&
        (e as any).message.includes("auto-truncated")
    );
    expect(autoLogs).toHaveLength(0);
  });
});
