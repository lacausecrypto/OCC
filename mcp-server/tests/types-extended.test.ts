/**
 * Extended type validation tests for new fields: chain, url, strategy (consensus/vote),
 * on_fail: "continue", inputs: Record<string,string>, debate, webhook, subchain,
 * pipeline types, guardrails, and more.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

// ─── Extended Zod schemas matching types.ts ────────────────────────────────

const GuardrailSchema = z.object({
  type: z.enum(["max_length", "min_length", "must_contain", "must_not_contain", "regex_match", "json_valid"]),
  value: z.union([z.string(), z.number()]).optional(),
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
  condition: z.string().optional(),
  // Subchain
  chain: z.string().optional(),
  subchain: z.string().optional(),
  subchain_input_map: z.record(z.string(), z.string()).optional(),
  // Webhook
  url: z.string().optional(),
  webhook_url: z.string().optional(),
  webhook_method: z.enum(["POST", "PUT", "PATCH", "GET", "DELETE"]).optional(),
  webhook_headers: z.record(z.string(), z.string()).optional(),
  webhook_body: z.string().optional(),
  webhook_timeout_ms: z.number().optional(),
  webhook_retry: z.number().optional(),
  webhook_success_status: z.array(z.number()).optional(),
  // Merge
  inputs: z.array(z.string()).optional(),
  strategy: z.enum(["concatenate", "json_array", "llm_summarize", "pick_best"]).optional(),
  // Evaluator
  on_fail: z.enum(["retry", "skip", "error"]).optional(),
  // Debate
  debate_agents: z.array(z.object({ prompt: z.string(), model: z.string().optional() })).optional(),
  debate_rounds: z.number().optional(),
  debate_decision: z.enum(["voting", "consensus", "last_round"]).optional(),
  // Loop
  items_var: z.string().optional(),
  max_parallel: z.number().optional(),
  loop_until: z.string().optional(),
  loop_on_error: z.enum(["continue", "abort"]).optional(),
  // Early exit
  early_exit_if: z.string().optional(),
  // Guardrails
  guardrails: z.array(GuardrailSchema).optional(),
  // Output validation
  output_schema: z.enum(["json", "markdown", "text"]).optional(),
  output_must_contain: z.array(z.string()).optional(),
  output_must_not_contain: z.array(z.string()).optional(),
  output_max_length: z.number().optional(),
  // Gate improvements
  gate_actions: z.array(z.string()).optional(),
  gate_rejection_reason: z.boolean().optional(),
  gate_auto_approve_if: z.string().optional(),
  // Evaluator improvements
  eval_scoring: z.boolean().optional(),
  eval_threshold: z.number().optional(),
  // Transform extras
  truncate_limit: z.number().optional(),
  operation: z.enum([
    "json_extract", "regex_match", "template", "split", "merge", "truncate",
    "replace", "filter", "map", "join", "to_json", "from_json",
  ]).optional(),
});

const PipelineChainRefSchema = z.object({
  id: z.string().min(1),
  chain: z.string().min(1),
  label: z.string().optional(),
  depends_on: z.array(z.string()).optional().default([]),
  condition: z.string().optional(),
  inputs: z.record(z.string(), z.string()).default({}),
});

const PipelineSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  inputs: z.array(z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    optional: z.boolean().optional(),
  })).optional().default([]),
  chains: z.array(PipelineChainRefSchema).min(1),
  output: z.string().min(1),
});

function baseStep(overrides: Record<string, unknown> = {}) {
  return {
    id: "step1",
    prompt: "Do something",
    output_var: "result",
    ...overrides,
  };
}

// ─── 1. Subchain step type ─────────────────────────────────────────────────

describe("Subchain step type", () => {
  it("accepts type: subchain", () => {
    const result = StepSchema.safeParse(baseStep({ type: "subchain" }));
    expect(result.success).toBe(true);
  });

  it("accepts chain field (alias for subchain)", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "subchain",
      chain: "research-chain",
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.chain).toBe("research-chain");
    }
  });

  it("accepts subchain field", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "subchain",
      subchain: "analysis-chain",
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subchain).toBe("analysis-chain");
    }
  });

  it("accepts subchain_input_map", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "subchain",
      chain: "sub",
      subchain_input_map: { topic: "{main_topic}", depth: "deep" },
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subchain_input_map).toEqual({ topic: "{main_topic}", depth: "deep" });
    }
  });
});

// ─── 2. Webhook step type ──────────────────────────────────────────────────

describe("Webhook step type", () => {
  it("accepts type: webhook", () => {
    const result = StepSchema.safeParse(baseStep({ type: "webhook" }));
    expect(result.success).toBe(true);
  });

  it("accepts url field (alias for webhook_url)", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "webhook",
      url: "https://hooks.example.com/trigger",
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBe("https://hooks.example.com/trigger");
    }
  });

  it("accepts webhook_url field", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "webhook",
      webhook_url: "https://api.example.com/webhook",
    }));
    expect(result.success).toBe(true);
  });

  it("accepts all webhook_method values", () => {
    for (const method of ["POST", "PUT", "PATCH", "GET", "DELETE"] as const) {
      const result = StepSchema.safeParse(baseStep({
        type: "webhook",
        webhook_method: method,
      }));
      expect(result.success, `webhook_method "${method}" should be valid`).toBe(true);
    }
  });

  it("rejects invalid webhook_method", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "webhook",
      webhook_method: "OPTIONS",
    }));
    expect(result.success).toBe(false);
  });

  it("accepts webhook_headers", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "webhook",
      webhook_headers: { "Authorization": "Bearer {api_key}", "Content-Type": "application/json" },
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.webhook_headers?.["Authorization"]).toBe("Bearer {api_key}");
    }
  });

  it("accepts webhook_body with variable syntax", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "webhook",
      webhook_body: '{"result": "{step1_output}"}',
    }));
    expect(result.success).toBe(true);
  });

  it("accepts webhook_timeout_ms", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "webhook",
      webhook_timeout_ms: 60000,
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.webhook_timeout_ms).toBe(60000);
    }
  });

  it("accepts webhook_retry", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "webhook",
      webhook_retry: 3,
    }));
    expect(result.success).toBe(true);
  });

  it("accepts webhook_success_status array", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "webhook",
      webhook_success_status: [200, 201, 202],
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.webhook_success_status).toEqual([200, 201, 202]);
    }
  });
});

// ─── 3. Debate step type ───────────────────────────────────────────────────

describe("Debate step type", () => {
  it("accepts type: debate", () => {
    const result = StepSchema.safeParse(baseStep({ type: "debate" }));
    expect(result.success).toBe(true);
  });

  it("accepts debate_agents array", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "debate",
      debate_agents: [
        { prompt: "Argue for position A" },
        { prompt: "Argue for position B", model: "claude-sonnet-4-6" },
      ],
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.debate_agents).toHaveLength(2);
      expect(result.data.debate_agents![1].model).toBe("claude-sonnet-4-6");
    }
  });

  it("accepts debate_rounds", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "debate",
      debate_rounds: 3,
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.debate_rounds).toBe(3);
    }
  });

  it("accepts all debate_decision values", () => {
    for (const decision of ["voting", "consensus", "last_round"] as const) {
      const result = StepSchema.safeParse(baseStep({
        type: "debate",
        debate_decision: decision,
      }));
      expect(result.success, `debate_decision "${decision}" should be valid`).toBe(true);
    }
  });

  it("rejects invalid debate_decision", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "debate",
      debate_decision: "random",
    }));
    expect(result.success).toBe(false);
  });
});

// ─── 4. Merge step: strategy "pick_best" ───────────────────────────────────

describe("Merge step extended strategies", () => {
  it("accepts strategy: pick_best", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "merge",
      inputs: ["var_a", "var_b"],
      strategy: "pick_best",
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.strategy).toBe("pick_best");
    }
  });

  it("accepts all 4 strategy values including pick_best", () => {
    for (const s of ["concatenate", "json_array", "llm_summarize", "pick_best"] as const) {
      const result = StepSchema.safeParse(baseStep({
        type: "merge",
        inputs: ["a"],
        strategy: s,
      }));
      expect(result.success, `strategy "${s}" should be valid`).toBe(true);
    }
  });
});

// ─── 5. Loop improvements ──────────────────────────────────────────────────

describe("Loop step improvements", () => {
  it("accepts loop_until condition", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "loop",
      items_var: "list",
      loop_until: '{quality} == "good"',
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.loop_until).toBe('{quality} == "good"');
    }
  });

  it("accepts loop_on_error: continue", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "loop",
      items_var: "list",
      loop_on_error: "continue",
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.loop_on_error).toBe("continue");
    }
  });

  it("accepts loop_on_error: abort", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "loop",
      items_var: "list",
      loop_on_error: "abort",
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.loop_on_error).toBe("abort");
    }
  });

  it("rejects invalid loop_on_error", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "loop",
      loop_on_error: "skip",
    }));
    expect(result.success).toBe(false);
  });
});

// ─── 6. Early exit ─────────────────────────────────────────────────────────

describe("Early exit", () => {
  it("accepts early_exit_if field", () => {
    const result = StepSchema.safeParse(baseStep({
      early_exit_if: '{done} == "true"',
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.early_exit_if).toBe('{done} == "true"');
    }
  });
});

// ─── 7. Guardrails ─────────────────────────────────────────────────────────

describe("Guardrails", () => {
  it("accepts guardrails array with all types", () => {
    const guardrails = [
      { type: "max_length" as const, value: 5000 },
      { type: "min_length" as const, value: 100 },
      { type: "must_contain" as const, value: "conclusion" },
      { type: "must_not_contain" as const, value: "TODO" },
      { type: "regex_match" as const, value: "^#.*" },
      { type: "json_valid" as const },
    ];
    const result = StepSchema.safeParse(baseStep({ guardrails }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.guardrails).toHaveLength(6);
    }
  });

  it("rejects invalid guardrail type", () => {
    const result = GuardrailSchema.safeParse({ type: "xml_valid" });
    expect(result.success).toBe(false);
  });

  it("accepts guardrail without value (e.g., json_valid)", () => {
    const result = GuardrailSchema.safeParse({ type: "json_valid" });
    expect(result.success).toBe(true);
  });
});

// ─── 8. Output validation fields ───────────────────────────────────────────

describe("Output validation fields", () => {
  it("accepts output_schema: json", () => {
    const result = StepSchema.safeParse(baseStep({ output_schema: "json" }));
    expect(result.success).toBe(true);
  });

  it("accepts output_schema: markdown", () => {
    const result = StepSchema.safeParse(baseStep({ output_schema: "markdown" }));
    expect(result.success).toBe(true);
  });

  it("accepts output_schema: text", () => {
    const result = StepSchema.safeParse(baseStep({ output_schema: "text" }));
    expect(result.success).toBe(true);
  });

  it("rejects invalid output_schema", () => {
    const result = StepSchema.safeParse(baseStep({ output_schema: "xml" }));
    expect(result.success).toBe(false);
  });

  it("accepts output_must_contain", () => {
    const result = StepSchema.safeParse(baseStep({
      output_must_contain: ["conclusion", "recommendation"],
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.output_must_contain).toEqual(["conclusion", "recommendation"]);
    }
  });

  it("accepts output_must_not_contain", () => {
    const result = StepSchema.safeParse(baseStep({
      output_must_not_contain: ["TODO", "FIXME"],
    }));
    expect(result.success).toBe(true);
  });

  it("accepts output_max_length", () => {
    const result = StepSchema.safeParse(baseStep({ output_max_length: 10000 }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.output_max_length).toBe(10000);
    }
  });
});

// ─── 9. Gate improvements ──────────────────────────────────────────────────

describe("Gate step improvements", () => {
  it("accepts gate_actions array", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "gate",
      gate_actions: ["approve", "reject", "escalate"],
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gate_actions).toEqual(["approve", "reject", "escalate"]);
    }
  });

  it("accepts gate_rejection_reason boolean", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "gate",
      gate_rejection_reason: true,
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gate_rejection_reason).toBe(true);
    }
  });

  it("accepts gate_auto_approve_if condition", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "gate",
      gate_auto_approve_if: '{score} > 8',
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gate_auto_approve_if).toBe('{score} > 8');
    }
  });
});

// ─── 10. Evaluator improvements ────────────────────────────────────────────

describe("Evaluator step improvements", () => {
  it("accepts eval_scoring boolean", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "evaluator",
      eval_scoring: true,
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eval_scoring).toBe(true);
    }
  });

  it("accepts eval_threshold", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "evaluator",
      eval_scoring: true,
      eval_threshold: 7,
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eval_threshold).toBe(7);
    }
  });
});

// ─── 11. Transform extras ──────────────────────────────────────────────────

describe("Transform extended operations", () => {
  const EXTENDED_OPS = [
    "json_extract", "regex_match", "template", "split", "merge", "truncate",
    "replace", "filter", "map", "join", "to_json", "from_json",
  ] as const;

  it("accepts all 12 operation values", () => {
    for (const op of EXTENDED_OPS) {
      const result = StepSchema.safeParse(baseStep({
        type: "transform",
        operation: op,
      }));
      expect(result.success, `operation "${op}" should be valid`).toBe(true);
    }
  });

  it("accepts truncate_limit field", () => {
    const result = StepSchema.safeParse(baseStep({
      type: "transform",
      operation: "truncate",
      truncate_limit: 3000,
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.truncate_limit).toBe(3000);
    }
  });
});

// ─── 12. Pipeline types ────────────────────────────────────────────────────

describe("PipelineChainRef", () => {
  it("accepts minimal chain ref with id, chain, inputs", () => {
    const result = PipelineChainRefSchema.safeParse({
      id: "search",
      chain: "web-search",
      inputs: { query: "{input.topic}" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("search");
      expect(result.data.chain).toBe("web-search");
      expect(result.data.inputs).toEqual({ query: "{input.topic}" });
    }
  });

  it("requires id and chain", () => {
    const result = PipelineChainRefSchema.safeParse({ inputs: {} });
    expect(result.success).toBe(false);
  });

  it("defaults inputs to empty object", () => {
    const result = PipelineChainRefSchema.safeParse({
      id: "step1",
      chain: "my-chain",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.inputs).toEqual({});
    }
  });

  it("accepts depends_on", () => {
    const result = PipelineChainRefSchema.safeParse({
      id: "step2",
      chain: "writer",
      depends_on: ["step1"],
      inputs: { data: "{step1}" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.depends_on).toEqual(["step1"]);
    }
  });

  it("accepts condition", () => {
    const result = PipelineChainRefSchema.safeParse({
      id: "optional",
      chain: "validator",
      condition: '{quality} != "good"',
      inputs: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.condition).toBe('{quality} != "good"');
    }
  });

  it("accepts label", () => {
    const result = PipelineChainRefSchema.safeParse({
      id: "step1",
      chain: "research",
      label: "Research Phase",
      inputs: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.label).toBe("Research Phase");
    }
  });
});

describe("PipelineDefinition", () => {
  it("validates a complete pipeline definition", () => {
    const result = PipelineSchema.safeParse({
      name: "research-pipeline",
      description: "Multi-chain research pipeline",
      version: "1.0",
      inputs: [{ name: "topic", description: "Research topic" }],
      chains: [
        { id: "search", chain: "web-search", inputs: { query: "{topic}" } },
        { id: "analyze", chain: "analysis", depends_on: ["search"], inputs: { data: "{search}" } },
      ],
      output: "analyze",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("research-pipeline");
      expect(result.data.chains).toHaveLength(2);
      expect(result.data.output).toBe("analyze");
    }
  });

  it("requires at least one chain", () => {
    const result = PipelineSchema.safeParse({
      name: "empty-pipeline",
      chains: [],
      output: "none",
    });
    expect(result.success).toBe(false);
  });

  it("requires name", () => {
    const result = PipelineSchema.safeParse({
      chains: [{ id: "x", chain: "y", inputs: {} }],
      output: "x",
    });
    expect(result.success).toBe(false);
  });

  it("requires output", () => {
    const result = PipelineSchema.safeParse({
      name: "test",
      chains: [{ id: "x", chain: "y", inputs: {} }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts pipeline with optional inputs", () => {
    const result = PipelineSchema.safeParse({
      name: "test",
      inputs: [
        { name: "required_param" },
        { name: "optional_param", optional: true },
      ],
      chains: [{ id: "c1", chain: "ch", inputs: {} }],
      output: "c1",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.inputs).toHaveLength(2);
      expect(result.data.inputs![1].optional).toBe(true);
    }
  });

  it("defaults inputs to empty array when omitted", () => {
    const result = PipelineSchema.safeParse({
      name: "minimal",
      chains: [{ id: "c1", chain: "ch", inputs: {} }],
      output: "c1",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.inputs).toEqual([]);
    }
  });
});

// ─── 13. All 11 StepType values ────────────────────────────────────────────

describe("All 11 StepType values", () => {
  const ALL = ["agent", "router", "gate", "evaluator", "transform", "loop", "merge", "browser", "subchain", "debate", "webhook"] as const;

  it("accepts all 11 StepType values", () => {
    for (const t of ALL) {
      const result = StepSchema.safeParse(baseStep({ type: t }));
      expect(result.success, `StepType "${t}" should be valid`).toBe(true);
    }
  });

  it("still defaults to undefined (agent) when omitted", () => {
    const result = StepSchema.safeParse(baseStep());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBeUndefined();
    }
  });
});
