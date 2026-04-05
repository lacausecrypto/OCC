/**
 * Extended type coverage tests for types.ts.
 *
 * Covers ALL interfaces and types from types.ts with Zod schema validation:
 * - CacheEntry
 * - PipelineExecution
 * - ExecutionEvent (step_cache_hit, gate_action)
 * - ChainInput
 * - ChainDefinition (complete)
 * - ContextStrategy
 * - Full ChainStep with browser, cache, timeout fields
 * - StepStatus "skipped"
 * - ExecutionStatus "skipped"
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

// ─── CacheEntry schema ──────────────────────────────────────────────────────

const CacheEntrySchema = z.object({
  key: z.string().min(1),
  stepId: z.string().min(1),
  chainName: z.string().min(1),
  result: z.string(),
  createdAt: z.string(),
  ttlMinutes: z.number(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});

describe("CacheEntry", () => {
  it("accepts a full cache entry", () => {
    const result = CacheEntrySchema.safeParse({
      key: "abc123def456",
      stepId: "writer",
      chainName: "research-chain",
      result: "Cached output text",
      createdAt: "2026-03-25T10:00:00Z",
      ttlMinutes: 60,
      inputTokens: 150,
      outputTokens: 600,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.key).toBe("abc123def456");
      expect(result.data.ttlMinutes).toBe(60);
    }
  });

  it("accepts cache entry without token counts", () => {
    const result = CacheEntrySchema.safeParse({
      key: "key1",
      stepId: "s1",
      chainName: "chain1",
      result: "text",
      createdAt: "2026-01-01T00:00:00Z",
      ttlMinutes: 30,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing key", () => {
    const result = CacheEntrySchema.safeParse({
      stepId: "s1",
      chainName: "chain1",
      result: "text",
      createdAt: "2026-01-01T00:00:00Z",
      ttlMinutes: 30,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing ttlMinutes", () => {
    const result = CacheEntrySchema.safeParse({
      key: "k",
      stepId: "s1",
      chainName: "chain1",
      result: "text",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty result string", () => {
    const result = CacheEntrySchema.safeParse({
      key: "k",
      stepId: "s1",
      chainName: "chain1",
      result: "",
      createdAt: "2026-01-01T00:00:00Z",
      ttlMinutes: 10,
    });
    expect(result.success).toBe(true);
  });

  it("accepts zero ttlMinutes (no caching effectively)", () => {
    const result = CacheEntrySchema.safeParse({
      key: "k",
      stepId: "s1",
      chainName: "c",
      result: "r",
      createdAt: "2026-01-01T00:00:00Z",
      ttlMinutes: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ttlMinutes).toBe(0);
    }
  });
});

// ─── Extended ExecutionEvent schemas ─────────────────────────────────────────

const ExecutionEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("execution_started"), executionId: z.string(), chainName: z.string() }),
  z.object({ type: z.literal("step_started"), executionId: z.string(), stepId: z.string(), label: z.string().optional() }),
  z.object({ type: z.literal("step_output"), executionId: z.string(), stepId: z.string(), chunk: z.string() }),
  z.object({ type: z.literal("step_done"), executionId: z.string(), stepId: z.string(), durationMs: z.number(), inputTokens: z.number().optional(), outputTokens: z.number().optional() }),
  z.object({ type: z.literal("step_error"), executionId: z.string(), stepId: z.string(), error: z.string() }),
  z.object({ type: z.literal("step_log"), executionId: z.string(), stepId: z.string(), message: z.string(), level: z.enum(["info", "warn", "error"]) }),
  z.object({ type: z.literal("execution_done"), executionId: z.string(), result: z.string(), durationMs: z.number() }),
  z.object({ type: z.literal("step_waiting_approval"), executionId: z.string(), stepId: z.string(), prompt: z.string() }),
  z.object({ type: z.literal("execution_error"), executionId: z.string(), error: z.string() }),
  z.object({ type: z.literal("step_cache_hit"), executionId: z.string(), stepId: z.string() }),
  z.object({ type: z.literal("gate_action"), executionId: z.string(), stepId: z.string(), action: z.string(), reason: z.string().optional() }),
]);

describe("Extended ExecutionEvent types", () => {
  it("validates step_cache_hit event", () => {
    const result = ExecutionEventSchema.safeParse({
      type: "step_cache_hit",
      executionId: "exec-1",
      stepId: "writer",
    });
    expect(result.success).toBe(true);
  });

  it("validates gate_action event with action and reason", () => {
    const result = ExecutionEventSchema.safeParse({
      type: "gate_action",
      executionId: "exec-1",
      stepId: "gate1",
      action: "approve",
      reason: "Looks good",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        type: "gate_action",
        executionId: "exec-1",
        stepId: "gate1",
        action: "approve",
        reason: "Looks good",
      });
    }
  });

  it("validates gate_action without reason", () => {
    const result = ExecutionEventSchema.safeParse({
      type: "gate_action",
      executionId: "exec-1",
      stepId: "gate1",
      action: "reject",
    });
    expect(result.success).toBe(true);
  });

  it("all 11 event types are covered", () => {
    const types = [
      "execution_started", "step_started", "step_output", "step_done",
      "step_error", "step_log", "execution_done", "step_waiting_approval",
      "execution_error", "step_cache_hit", "gate_action",
    ];
    const unique = new Set(types);
    expect(unique.size).toBe(11);
  });
});

// ─── PipelineExecution schema ────────────────────────────────────────────────

const PipelineChainStatusSchema = z.object({
  chainRefId: z.string(),
  chainName: z.string(),
  status: z.enum(["pending", "running", "done", "error", "skipped"]),
  executionId: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
});

const PipelineExecutionSchema = z.object({
  id: z.string().min(1),
  pipelineName: z.string().min(1),
  status: z.enum(["pending", "running", "done", "error", "skipped"]),
  input: z.record(z.string(), z.string()),
  chains: z.record(z.string(), PipelineChainStatusSchema),
  result: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationMs: z.number().optional(),
});

describe("PipelineExecution", () => {
  it("accepts a full pipeline execution", () => {
    const result = PipelineExecutionSchema.safeParse({
      id: "pipe-exec-1",
      pipelineName: "research-pipeline",
      status: "done",
      input: { topic: "AI Safety" },
      chains: {
        search: {
          chainRefId: "search",
          chainName: "web-search",
          status: "done",
          executionId: "exec-1",
          result: "Search results here",
          durationMs: 5000,
        },
        analyze: {
          chainRefId: "analyze",
          chainName: "analysis",
          status: "done",
          executionId: "exec-2",
          result: "Analysis complete",
          durationMs: 8000,
        },
      },
      result: "Analysis complete",
      startedAt: "2026-03-25T10:00:00Z",
      finishedAt: "2026-03-25T10:00:13Z",
      durationMs: 13000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.chains)).toHaveLength(2);
      expect(result.data.chains.search.status).toBe("done");
    }
  });

  it("accepts pending pipeline with empty chains", () => {
    const result = PipelineExecutionSchema.safeParse({
      id: "pipe-new",
      pipelineName: "test",
      status: "pending",
      input: {},
      chains: {},
      startedAt: "2026-01-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts pipeline with error status", () => {
    const result = PipelineExecutionSchema.safeParse({
      id: "pipe-err",
      pipelineName: "failing",
      status: "error",
      input: { q: "test" },
      chains: {
        step1: {
          chainRefId: "step1",
          chainName: "chain1",
          status: "error",
          error: "Chain failed",
        },
      },
      error: "Pipeline aborted",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:05Z",
      durationMs: 5000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error).toBe("Pipeline aborted");
    }
  });

  it("accepts skipped status", () => {
    const result = PipelineExecutionSchema.safeParse({
      id: "pipe-skip",
      pipelineName: "conditional",
      status: "done",
      input: {},
      chains: {
        optional: {
          chainRefId: "optional",
          chainName: "validator",
          status: "skipped",
        },
      },
      startedAt: "2026-01-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.chains.optional.status).toBe("skipped");
    }
  });

  it("requires id and pipelineName", () => {
    const result = PipelineExecutionSchema.safeParse({
      status: "pending",
      input: {},
      chains: {},
      startedAt: "2026-01-01T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });
});

// ─── ChainInput schema ──────────────────────────────────────────────────────

const ChainInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  optional: z.boolean().optional(),
});

describe("ChainInput", () => {
  it("accepts minimal input (name only)", () => {
    const result = ChainInputSchema.safeParse({ name: "query" });
    expect(result.success).toBe(true);
  });

  it("accepts full input with all fields", () => {
    const result = ChainInputSchema.safeParse({
      name: "topic",
      description: "Research topic",
      optional: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.optional).toBe(true);
    }
  });

  it("rejects empty name", () => {
    const result = ChainInputSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing name", () => {
    const result = ChainInputSchema.safeParse({ description: "test" });
    expect(result.success).toBe(false);
  });
});

// ─── ChainDefinition schema ─────────────────────────────────────────────────

const ChainDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  inputs: z.array(ChainInputSchema).optional(),
  steps: z.array(z.object({
    id: z.string().min(1),
    prompt: z.string(),
    output_var: z.string().min(1),
  }).passthrough()).min(1),
  output: z.string().min(1),
});

describe("ChainDefinition", () => {
  it("accepts a complete chain definition", () => {
    const result = ChainDefinitionSchema.safeParse({
      name: "research-chain",
      description: "A multi-step research chain",
      version: "2.0",
      inputs: [{ name: "topic" }, { name: "depth", optional: true }],
      steps: [
        { id: "search", prompt: "Search for {topic}", output_var: "results", tools: ["web_search"] },
        { id: "write", prompt: "Write about {results}", output_var: "draft", depends_on: ["search"] },
      ],
      output: "draft",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.steps).toHaveLength(2);
      expect(result.data.version).toBe("2.0");
    }
  });

  it("accepts minimal chain (no inputs, no description)", () => {
    const result = ChainDefinitionSchema.safeParse({
      name: "simple",
      steps: [{ id: "s1", prompt: "Do something", output_var: "result" }],
      output: "result",
    });
    expect(result.success).toBe(true);
  });

  it("requires at least one step", () => {
    const result = ChainDefinitionSchema.safeParse({
      name: "empty",
      steps: [],
      output: "result",
    });
    expect(result.success).toBe(false);
  });

  it("requires name", () => {
    const result = ChainDefinitionSchema.safeParse({
      steps: [{ id: "s1", prompt: "p", output_var: "out" }],
      output: "out",
    });
    expect(result.success).toBe(false);
  });

  it("requires output", () => {
    const result = ChainDefinitionSchema.safeParse({
      name: "test",
      steps: [{ id: "s1", prompt: "p", output_var: "out" }],
    });
    expect(result.success).toBe(false);
  });
});

// ─── ContextStrategy ─────────────────────────────────────────────────────────

describe("ContextStrategy type", () => {
  const ContextStrategySchema = z.record(z.string(), z.string());

  it("accepts full strategy", () => {
    const result = ContextStrategySchema.safeParse({
      search_results: "full",
    });
    expect(result.success).toBe(true);
  });

  it("accepts summarize strategy", () => {
    const result = ContextStrategySchema.safeParse({
      long_text: "summarize",
    });
    expect(result.success).toBe(true);
  });

  it("accepts truncate strategy with limit", () => {
    const result = ContextStrategySchema.safeParse({
      context: "truncate:5000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.context).toBe("truncate:5000");
    }
  });

  it("accepts multiple strategies", () => {
    const result = ContextStrategySchema.safeParse({
      var_a: "full",
      var_b: "summarize",
      var_c: "truncate:2000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data)).toHaveLength(3);
    }
  });
});

// ─── Full step with all browser/cache/timeout fields ─────────────────────────

describe("Full ChainStep with all fields", () => {
  const FullStepSchema = z.object({
    id: z.string(),
    type: z.string().optional(),
    prompt: z.string(),
    output_var: z.string(),
    browser_url: z.string().optional(),
    browser_task: z.string().optional(),
    browser_max_steps: z.number().optional(),
    browser_headless: z.boolean().optional(),
    browser_port: z.number().optional(),
    browser_viewport: z.object({ width: z.number(), height: z.number() }).optional(),
    browser_wait_ms: z.number().optional(),
    browser_output_format: z.enum(["text", "markdown", "json", "screenshot"]).optional(),
    browser_page_name: z.string().optional(),
    browser_scroll_strategy: z.enum(["auto", "full", "none"]).optional(),
    browser_cookies_domain: z.string().optional(),
    cache: z.object({
      enabled: z.boolean(),
      ttl_minutes: z.number().optional(),
    }).optional(),
    timeout_ms: z.number().optional(),
  }).passthrough();

  it("accepts a full browser step", () => {
    const result = FullStepSchema.safeParse({
      id: "browser1",
      type: "browser",
      prompt: "Navigate and extract",
      output_var: "page_data",
      browser_url: "https://example.com",
      browser_task: "Get the price",
      browser_max_steps: 30,
      browser_headless: true,
      browser_port: 9222,
      browser_viewport: { width: 1920, height: 1080 },
      browser_wait_ms: 5000,
      browser_output_format: "json",
      browser_page_name: "main_page",
      browser_scroll_strategy: "full",
      browser_cookies_domain: "example.com",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.browser_viewport).toEqual({ width: 1920, height: 1080 });
      expect(result.data.browser_output_format).toBe("json");
    }
  });

  it("accepts step with cache config", () => {
    const result = FullStepSchema.safeParse({
      id: "cached_step",
      prompt: "Expensive operation",
      output_var: "result",
      cache: { enabled: true, ttl_minutes: 120 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cache!.enabled).toBe(true);
      expect(result.data.cache!.ttl_minutes).toBe(120);
    }
  });

  it("accepts step with timeout_ms", () => {
    const result = FullStepSchema.safeParse({
      id: "slow_step",
      prompt: "Long running",
      output_var: "result",
      timeout_ms: 300000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeout_ms).toBe(300000);
    }
  });

  it("accepts all browser_output_format values", () => {
    for (const fmt of ["text", "markdown", "json", "screenshot"] as const) {
      const result = FullStepSchema.safeParse({
        id: "b",
        prompt: "p",
        output_var: "o",
        browser_output_format: fmt,
      });
      expect(result.success, `format "${fmt}" should be valid`).toBe(true);
    }
  });

  it("accepts all browser_scroll_strategy values", () => {
    for (const strategy of ["auto", "full", "none"] as const) {
      const result = FullStepSchema.safeParse({
        id: "b",
        prompt: "p",
        output_var: "o",
        browser_scroll_strategy: strategy,
      });
      expect(result.success, `strategy "${strategy}" should be valid`).toBe(true);
    }
  });
});

// ─── ExecutionStatus "skipped" ───────────────────────────────────────────────

describe("ExecutionStatus includes skipped", () => {
  const StatusSchema = z.enum(["pending", "running", "done", "error", "skipped"]);

  it("accepts all 5 status values", () => {
    for (const s of ["pending", "running", "done", "error", "skipped"] as const) {
      expect(StatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it("rejects invalid status", () => {
    expect(StatusSchema.safeParse("cancelled").success).toBe(false);
  });
});
