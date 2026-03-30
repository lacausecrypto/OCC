import { describe, it, expect } from "vitest";
import { z } from "zod";

// ─── Zod schemas mirroring loader.ts for runtime validation ──────────────────

const PreToolSchema = z.object({
  type: z.enum([
    "current_datetime", "http_fetch", "web_search", "read_file", "write_file", "bash", "env_var",
    "mcp_call", "db_query", "email", "pdf_generate", "ocr",
    "state_load", "state_save", "vector_query", "vector_index", "json_parse", "diff_inject", "notify",
    "semantic_cache", "screenshot", "sandbox_exec", "cost_gate", "ast_parse",
    "embed_compare", "graph_query", "parallel_fetch", "template_render", "approval_request",
  ]),
  inject_as: z.string().min(1),
  label: z.string().optional(),
  url: z.string().optional(),
  query: z.string().optional(),
  path: z.string().optional(),
  content: z.string().optional(),
  command: z.string().optional(),
  var_name: z.string().optional(),
});

const RetrySchema = z.object({
  max: z.number(),
  delay_ms: z.number().optional(),
  backoff: z.number().optional(),
});

const StepSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["agent", "router", "gate", "evaluator", "transform", "loop", "merge", "browser", "subchain", "debate", "webhook"]).optional(),
  label: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string().min(1),
  tools: z.array(z.string()).optional().default([]),
  depends_on: z.array(z.string()).optional().default([]),
  output_var: z.string().min(1),
  cwd: z.string().optional(),
  pre_tools: z.array(PreToolSchema).optional(),
  condition: z.string().optional(),
  retry: RetrySchema.optional(),
  fallback_models: z.array(z.string()).optional(),
  routes: z.record(z.string(), z.array(z.string())).optional(),
  default_route: z.string().optional(),
  timeout_hours: z.number().optional(),
  on_timeout: z.enum(["skip", "error", "approve"]).optional(),
  input_var: z.string().optional(),
  criteria: z.string().optional(),
  on_fail: z.enum(["retry", "skip", "error"]).optional(),
  max_retries: z.number().optional(),
  retry_target: z.string().optional(),
  operation: z.enum(["json_extract", "regex_match", "template", "split", "merge", "truncate"]).optional(),
  json_path: z.string().optional(),
  regex: z.string().optional(),
  template_str: z.string().optional(),
  items_var: z.string().optional(),
  max_parallel: z.number().optional(),
  inputs: z.array(z.string()).optional(),
  strategy: z.enum(["concatenate", "json_array", "llm_summarize"]).optional(),
  browser_url: z.string().optional(),
  browser_task: z.string().optional(),
  browser_max_steps: z.number().optional(),
  context_strategy: z.record(z.string(), z.string()).optional(),
});

const StepResultSchema = z.object({
  stepId: z.string().min(1),
  status: z.enum(["pending", "running", "done", "error", "skipped"]),
  output: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationMs: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});

const ChainExecutionSchema = z.object({
  id: z.string().min(1),
  chainName: z.string().min(1),
  status: z.enum(["pending", "running", "done", "error"]),
  input: z.record(z.string(), z.string()),
  steps: z.record(z.string(), StepResultSchema),
  result: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationMs: z.number().optional(),
});

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
]);

// ─── Helper: minimal valid step ──────────────────────────────────────────────

function baseStep(overrides: Record<string, unknown> = {}) {
  return {
    id: "step1",
    prompt: "Do something",
    output_var: "result",
    ...overrides,
  };
}

// ─── 1. ChainStep types ─────────────────────────────────────────────────────

describe("ChainStep types", () => {
  const ALL_STEP_TYPES = ["agent", "router", "gate", "evaluator", "transform", "loop", "merge", "browser"] as const;

  it("accepts all 8 StepType values", () => {
    for (const t of ALL_STEP_TYPES) {
      const result = StepSchema.safeParse(baseStep({ type: t }));
      expect(result.success, `StepType "${t}" should be valid`).toBe(true);
    }
  });

  it("rejects an invalid StepType", () => {
    const result = StepSchema.safeParse(baseStep({ type: "invalid_type" }));
    expect(result.success).toBe(false);
  });

  it("defaults type to undefined (agent) when omitted", () => {
    const result = StepSchema.safeParse(baseStep());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBeUndefined();
    }
  });

  describe("router step", () => {
    it("accepts routes + default_route", () => {
      const result = StepSchema.safeParse(baseStep({
        type: "router",
        routes: { high: ["step_a"], low: ["step_b"] },
        default_route: "low",
      }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.routes).toEqual({ high: ["step_a"], low: ["step_b"] });
        expect(result.data.default_route).toBe("low");
      }
    });
  });

  describe("gate step", () => {
    it("accepts timeout_hours + on_timeout", () => {
      for (const val of ["skip", "error", "approve"] as const) {
        const result = StepSchema.safeParse(baseStep({
          type: "gate",
          timeout_hours: 24,
          on_timeout: val,
        }));
        expect(result.success, `on_timeout "${val}" should be valid`).toBe(true);
      }
    });

    it("rejects invalid on_timeout value", () => {
      const result = StepSchema.safeParse(baseStep({
        type: "gate",
        timeout_hours: 1,
        on_timeout: "cancel",
      }));
      expect(result.success).toBe(false);
    });
  });

  describe("evaluator step", () => {
    it("accepts input_var, criteria, on_fail, max_retries, retry_target", () => {
      const result = StepSchema.safeParse(baseStep({
        type: "evaluator",
        input_var: "draft",
        criteria: "Must be concise",
        on_fail: "retry",
        max_retries: 3,
        retry_target: "step_writer",
      }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.input_var).toBe("draft");
        expect(result.data.criteria).toBe("Must be concise");
        expect(result.data.max_retries).toBe(3);
        expect(result.data.retry_target).toBe("step_writer");
      }
    });

    it("accepts all 3 on_fail values", () => {
      for (const val of ["retry", "skip", "error"] as const) {
        const result = StepSchema.safeParse(baseStep({
          type: "evaluator",
          on_fail: val,
        }));
        expect(result.success, `on_fail "${val}" should be valid`).toBe(true);
      }
    });

    it("rejects invalid on_fail value", () => {
      const result = StepSchema.safeParse(baseStep({
        type: "evaluator",
        on_fail: "abort",
      }));
      expect(result.success).toBe(false);
    });
  });

  describe("transform step", () => {
    const ALL_OPERATIONS = ["json_extract", "regex_match", "template", "split", "merge", "truncate"] as const;

    it("accepts all 6 operation values", () => {
      for (const op of ALL_OPERATIONS) {
        const result = StepSchema.safeParse(baseStep({
          type: "transform",
          operation: op,
        }));
        expect(result.success, `operation "${op}" should be valid`).toBe(true);
      }
    });

    it("rejects invalid operation value", () => {
      const result = StepSchema.safeParse(baseStep({
        type: "transform",
        operation: "uppercase",
      }));
      expect(result.success).toBe(false);
    });

    it("accepts json_path, regex, template_str fields", () => {
      const result = StepSchema.safeParse(baseStep({
        type: "transform",
        operation: "json_extract",
        json_path: "$.data.name",
        regex: "\\d+",
        template_str: "Hello {name}",
      }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.json_path).toBe("$.data.name");
        expect(result.data.regex).toBe("\\d+");
        expect(result.data.template_str).toBe("Hello {name}");
      }
    });
  });

  describe("merge step", () => {
    it("accepts inputs + strategy", () => {
      const result = StepSchema.safeParse(baseStep({
        type: "merge",
        inputs: ["var_a", "var_b", "var_c"],
        strategy: "json_array",
      }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.inputs).toEqual(["var_a", "var_b", "var_c"]);
        expect(result.data.strategy).toBe("json_array");
      }
    });

    it("accepts all 3 strategy values", () => {
      for (const val of ["concatenate", "json_array", "llm_summarize"] as const) {
        const result = StepSchema.safeParse(baseStep({
          type: "merge",
          inputs: ["a"],
          strategy: val,
        }));
        expect(result.success, `strategy "${val}" should be valid`).toBe(true);
      }
    });

    it("rejects invalid strategy value", () => {
      const result = StepSchema.safeParse(baseStep({
        type: "merge",
        strategy: "average",
      }));
      expect(result.success).toBe(false);
    });
  });

  describe("browser step", () => {
    it("accepts browser_url, browser_task, browser_max_steps", () => {
      const result = StepSchema.safeParse(baseStep({
        type: "browser",
        browser_url: "https://example.com",
        browser_task: "Extract the main headline",
        browser_max_steps: 15,
      }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.browser_url).toBe("https://example.com");
        expect(result.data.browser_task).toBe("Extract the main headline");
        expect(result.data.browser_max_steps).toBe(15);
      }
    });
  });
});

// ─── 2. RetryConfig ──────────────────────────────────────────────────────────

describe("RetryConfig", () => {
  it("accepts max only", () => {
    const result = RetrySchema.safeParse({ max: 3 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max).toBe(3);
      expect(result.data.delay_ms).toBeUndefined();
      expect(result.data.backoff).toBeUndefined();
    }
  });

  it("accepts max + delay_ms + backoff", () => {
    const result = RetrySchema.safeParse({ max: 5, delay_ms: 1000, backoff: 2 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max).toBe(5);
      expect(result.data.delay_ms).toBe(1000);
      expect(result.data.backoff).toBe(2);
    }
  });

  it("accepts retry within a step", () => {
    const result = StepSchema.safeParse(baseStep({
      retry: { max: 2, delay_ms: 500, backoff: 1.5 },
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.retry).toEqual({ max: 2, delay_ms: 500, backoff: 1.5 });
    }
  });

  it("rejects missing max", () => {
    const result = RetrySchema.safeParse({ delay_ms: 1000 });
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric max", () => {
    const result = RetrySchema.safeParse({ max: "three" });
    expect(result.success).toBe(false);
  });
});

// ─── 3. PreTool types ────────────────────────────────────────────────────────

describe("PreTool types", () => {
  const ALL_PRE_TOOL_TYPES = [
    "current_datetime", "http_fetch", "web_search", "read_file", "write_file", "bash", "env_var",
    "mcp_call", "db_query", "email", "pdf_generate", "ocr",
    "state_load", "state_save", "vector_query", "vector_index", "json_parse", "diff_inject", "notify",
    "semantic_cache", "screenshot", "sandbox_exec", "cost_gate", "ast_parse",
    "embed_compare", "graph_query", "parallel_fetch", "template_render", "approval_request",
  ] as const;

  it("accepts all 27 PreToolType values", () => {
    for (const t of ALL_PRE_TOOL_TYPES) {
      const result = PreToolSchema.safeParse({ type: t, inject_as: "var_" + t });
      expect(result.success, `PreToolType "${t}" should be valid`).toBe(true);
    }
  });

  it("rejects invalid PreToolType", () => {
    const result = PreToolSchema.safeParse({ type: "ftp_upload", inject_as: "out" });
    expect(result.success).toBe(false);
  });

  it("requires inject_as", () => {
    const result = PreToolSchema.safeParse({ type: "current_datetime" });
    expect(result.success).toBe(false);
  });

  it("rejects empty inject_as", () => {
    const result = PreToolSchema.safeParse({ type: "bash", inject_as: "" });
    expect(result.success).toBe(false);
  });

  it("http_fetch: accepts url param", () => {
    const result = PreToolSchema.safeParse({
      type: "http_fetch",
      inject_as: "page",
      url: "https://api.example.com/data",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.url).toBe("https://api.example.com/data");
  });

  it("web_search: accepts query param", () => {
    const result = PreToolSchema.safeParse({
      type: "web_search",
      inject_as: "results",
      query: "latest news on {topic}",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.query).toBe("latest news on {topic}");
  });

  it("read_file: accepts path param", () => {
    const result = PreToolSchema.safeParse({
      type: "read_file",
      inject_as: "file_content",
      path: "/tmp/data.json",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.path).toBe("/tmp/data.json");
  });

  it("write_file: accepts path + content params", () => {
    const result = PreToolSchema.safeParse({
      type: "write_file",
      inject_as: "write_result",
      path: "/tmp/output.txt",
      content: "Hello {name}",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.path).toBe("/tmp/output.txt");
      expect(result.data.content).toBe("Hello {name}");
    }
  });

  it("bash: accepts command param", () => {
    const result = PreToolSchema.safeParse({
      type: "bash",
      inject_as: "cmd_output",
      command: "echo {greeting}",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.command).toBe("echo {greeting}");
  });

  it("env_var: accepts var_name param", () => {
    const result = PreToolSchema.safeParse({
      type: "env_var",
      inject_as: "api_key",
      var_name: "OPENAI_KEY",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.var_name).toBe("OPENAI_KEY");
  });

  it("current_datetime: no extra params needed", () => {
    const result = PreToolSchema.safeParse({
      type: "current_datetime",
      inject_as: "now",
    });
    expect(result.success).toBe(true);
  });
});

// ─── 4. ExecutionEvent types ─────────────────────────────────────────────────

describe("ExecutionEvent types", () => {
  const ALL_EVENT_TYPES = [
    "execution_started",
    "step_started",
    "step_output",
    "step_done",
    "step_error",
    "step_log",
    "execution_done",
    "step_waiting_approval",
    "execution_error",
  ] as const;

  it("all 9 event type strings are distinct", () => {
    const unique = new Set(ALL_EVENT_TYPES);
    expect(unique.size).toBe(ALL_EVENT_TYPES.length);
    expect(unique.size).toBe(9);
  });

  it("step_waiting_approval is included", () => {
    expect(ALL_EVENT_TYPES).toContain("step_waiting_approval");
  });

  it("validates execution_started", () => {
    const result = ExecutionEventSchema.safeParse({
      type: "execution_started",
      executionId: "exec-1",
      chainName: "my_chain",
    });
    expect(result.success).toBe(true);
  });

  it("validates step_started with optional label", () => {
    const result = ExecutionEventSchema.safeParse({
      type: "step_started",
      executionId: "exec-1",
      stepId: "s1",
      label: "Writer",
    });
    expect(result.success).toBe(true);
  });

  it("validates step_output", () => {
    const result = ExecutionEventSchema.safeParse({
      type: "step_output",
      executionId: "exec-1",
      stepId: "s1",
      chunk: "partial text",
    });
    expect(result.success).toBe(true);
  });

  it("validates step_done with token counts", () => {
    const result = ExecutionEventSchema.safeParse({
      type: "step_done",
      executionId: "exec-1",
      stepId: "s1",
      durationMs: 1500,
      inputTokens: 200,
      outputTokens: 800,
    });
    expect(result.success).toBe(true);
  });

  it("validates step_error", () => {
    const result = ExecutionEventSchema.safeParse({
      type: "step_error",
      executionId: "exec-1",
      stepId: "s1",
      error: "Model refused",
    });
    expect(result.success).toBe(true);
  });

  it("validates step_log with all 3 levels", () => {
    for (const level of ["info", "warn", "error"] as const) {
      const result = ExecutionEventSchema.safeParse({
        type: "step_log",
        executionId: "exec-1",
        stepId: "s1",
        message: "Something happened",
        level,
      });
      expect(result.success, `log level "${level}" should be valid`).toBe(true);
    }
  });

  it("validates execution_done", () => {
    const result = ExecutionEventSchema.safeParse({
      type: "execution_done",
      executionId: "exec-1",
      result: "Final output",
      durationMs: 5000,
    });
    expect(result.success).toBe(true);
  });

  it("validates step_waiting_approval", () => {
    const result = ExecutionEventSchema.safeParse({
      type: "step_waiting_approval",
      executionId: "exec-1",
      stepId: "gate_review",
      prompt: "Please approve this step",
    });
    expect(result.success).toBe(true);
  });

  it("validates execution_error", () => {
    const result = ExecutionEventSchema.safeParse({
      type: "execution_error",
      executionId: "exec-1",
      error: "Chain failed",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown event type", () => {
    const result = ExecutionEventSchema.safeParse({
      type: "step_paused",
      executionId: "exec-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects event missing required fields", () => {
    const result = ExecutionEventSchema.safeParse({
      type: "step_done",
      executionId: "exec-1",
      // missing stepId and durationMs
    });
    expect(result.success).toBe(false);
  });
});

// ─── 5. StepResult / ChainExecution ──────────────────────────────────────────

describe("StepResult", () => {
  const ALL_STEP_STATUSES = ["pending", "running", "done", "error", "skipped"] as const;

  it("accepts all StepStatus values", () => {
    for (const status of ALL_STEP_STATUSES) {
      const result = StepResultSchema.safeParse({ stepId: "s1", status });
      expect(result.success, `StepStatus "${status}" should be valid`).toBe(true);
    }
  });

  it("rejects invalid StepStatus", () => {
    const result = StepResultSchema.safeParse({ stepId: "s1", status: "cancelled" });
    expect(result.success).toBe(false);
  });

  it("accepts full StepResult with all fields", () => {
    const result = StepResultSchema.safeParse({
      stepId: "writer",
      status: "done",
      output: "Generated text",
      error: undefined,
      startedAt: "2026-03-25T10:00:00Z",
      finishedAt: "2026-03-25T10:00:05Z",
      durationMs: 5000,
      inputTokens: 150,
      outputTokens: 600,
    });
    expect(result.success).toBe(true);
  });

  it("requires stepId", () => {
    const result = StepResultSchema.safeParse({ status: "pending" });
    expect(result.success).toBe(false);
  });
});

describe("ChainExecution", () => {
  const ALL_EXECUTION_STATUSES = ["pending", "running", "done", "error"] as const;

  it("accepts all ExecutionStatus values", () => {
    for (const status of ALL_EXECUTION_STATUSES) {
      const result = ChainExecutionSchema.safeParse({
        id: "exec-1",
        chainName: "test_chain",
        status,
        input: {},
        steps: {},
        startedAt: "2026-03-25T10:00:00Z",
      });
      expect(result.success, `ExecutionStatus "${status}" should be valid`).toBe(true);
    }
  });

  it("rejects invalid ExecutionStatus", () => {
    const result = ChainExecutionSchema.safeParse({
      id: "exec-1",
      chainName: "test_chain",
      status: "cancelled",
      input: {},
      steps: {},
      startedAt: "2026-03-25T10:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a full ChainExecution with nested steps", () => {
    const result = ChainExecutionSchema.safeParse({
      id: "exec-42",
      chainName: "research_chain",
      status: "done",
      input: { topic: "AI safety", depth: "deep" },
      steps: {
        search: {
          stepId: "search",
          status: "done",
          output: "Found 5 results",
          startedAt: "2026-03-25T10:00:00Z",
          finishedAt: "2026-03-25T10:00:02Z",
          durationMs: 2000,
          inputTokens: 100,
          outputTokens: 300,
        },
        writer: {
          stepId: "writer",
          status: "done",
          output: "Final report content",
          startedAt: "2026-03-25T10:00:02Z",
          finishedAt: "2026-03-25T10:00:08Z",
          durationMs: 6000,
          inputTokens: 400,
          outputTokens: 1200,
        },
      },
      result: "Final report content",
      startedAt: "2026-03-25T10:00:00Z",
      finishedAt: "2026-03-25T10:00:08Z",
      durationMs: 8000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.steps)).toHaveLength(2);
      expect(result.data.steps["search"].status).toBe("done");
      expect(result.data.result).toBe("Final report content");
      expect(result.data.durationMs).toBe(8000);
    }
  });

  it("accepts minimal ChainExecution (pending, no steps done)", () => {
    const result = ChainExecutionSchema.safeParse({
      id: "exec-new",
      chainName: "basic",
      status: "pending",
      input: { query: "test" },
      steps: {},
      startedAt: "2026-03-25T12:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("requires id, chainName, status, input, steps, startedAt", () => {
    const result = ChainExecutionSchema.safeParse({
      id: "exec-1",
      // missing chainName, status, input, steps, startedAt
    });
    expect(result.success).toBe(false);
  });

  it("accepts ChainExecution with error field", () => {
    const result = ChainExecutionSchema.safeParse({
      id: "exec-err",
      chainName: "failing_chain",
      status: "error",
      input: {},
      steps: {
        step1: { stepId: "step1", status: "error", error: "Model overloaded" },
      },
      error: "Chain aborted due to step failure",
      startedAt: "2026-03-25T14:00:00Z",
      finishedAt: "2026-03-25T14:00:01Z",
      durationMs: 1000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error).toBe("Chain aborted due to step failure");
      expect(result.data.steps["step1"].error).toBe("Model overloaded");
    }
  });
});
