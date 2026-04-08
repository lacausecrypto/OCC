import { describe, it, expect } from "vitest";
import { canvasToYaml } from "../../src/utils/canvasToYaml";
import type { CanvasNode, CanvasEdge } from "../../src/types/canvas";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<CanvasNode> & { id: string }): CanvasNode {
  return {
    x: 0, y: 0, w: 200, h: 100,
    type: "agent",
    label: overrides.id,
    model: undefined,
    preTools: [],
    tools: [],
    outputVar: "",
    stepId: overrides.id,
    prompt: "Do something",
    ...overrides,
  };
}

function makeEdge(from: string, to: string): CanvasEdge {
  return { id: `${from}->${to}`, from, to };
}

function toMap<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.id, i]));
}

// ─── Basic output ─────────────────────────────────────────────────────────────

describe("canvasToYaml — basic", () => {
  it("returns empty string for empty nodes", () => {
    const result = canvasToYaml(new Map(), new Map(), "test");
    expect(result).toBe("");
  });

  it("generates valid YAML for a single node", () => {
    const nodes = toMap([makeNode({ id: "step1", prompt: "Analyze this" })]);
    const result = canvasToYaml(nodes, new Map(), "my-chain");

    expect(result).toContain("name: my-chain");
    expect(result).toContain("version: '1.0'");
    expect(result).toContain("steps:");
    expect(result).toContain("id: step1");
    expect(result).toContain("type: agent");
    expect(result).toContain("prompt: Analyze this");
    expect(result).toContain("output:");
  });

  it("includes description when provided", () => {
    const nodes = toMap([makeNode({ id: "s1" })]);
    const result = canvasToYaml(nodes, new Map(), "test", "A test chain");
    expect(result).toContain("description: A test chain");
  });

  it("omits description when not provided", () => {
    const nodes = toMap([makeNode({ id: "s1" })]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).not.toContain("description:");
  });
});

// ─── Input detection ──────────────────────────────────────────────────────────

describe("canvasToYaml — input detection", () => {
  it("detects {input.topic} in prompts", () => {
    const nodes = toMap([
      makeNode({ id: "s1", prompt: "Research {input.topic} deeply" }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("inputs:");
    expect(result).toContain("name: topic");
  });

  it("detects multiple inputs", () => {
    const nodes = toMap([
      makeNode({ id: "s1", prompt: "{input.topic} for {input.audience}" }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("name: audience");
    expect(result).toContain("name: topic");
  });

  it("omits inputs section when no {input.*} patterns", () => {
    const nodes = toMap([makeNode({ id: "s1", prompt: "Just do it" })]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).not.toContain("inputs:");
  });
});

// ─── Topological sort & dependencies ──────────────────────────────────────────

describe("canvasToYaml — dependencies", () => {
  it("adds depends_on from edges", () => {
    const nodes = toMap([
      makeNode({ id: "research" }),
      makeNode({ id: "summarize" }),
    ]);
    const edges = toMap([makeEdge("research", "summarize")]);
    const result = canvasToYaml(nodes, edges, "test");
    expect(result).toContain("depends_on:");
    expect(result).toContain("research");
  });

  it("respects topological order", () => {
    const nodes = toMap([
      makeNode({ id: "c" }),
      makeNode({ id: "a" }),
      makeNode({ id: "b" }),
    ]);
    const edges = toMap([
      makeEdge("a", "b"),
      makeEdge("b", "c"),
    ]);
    const result = canvasToYaml(nodes, edges, "test");
    const aIdx = result.indexOf("id: a");
    const bIdx = result.indexOf("id: b");
    const cIdx = result.indexOf("id: c");
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
  });

  it("handles disconnected nodes", () => {
    const nodes = toMap([
      makeNode({ id: "isolated" }),
      makeNode({ id: "connected1" }),
      makeNode({ id: "connected2" }),
    ]);
    const edges = toMap([makeEdge("connected1", "connected2")]);
    const result = canvasToYaml(nodes, edges, "test");
    expect(result).toContain("id: isolated");
    expect(result).toContain("id: connected1");
    expect(result).toContain("id: connected2");
  });
});

// ─── Multiline prompts ────────────────────────────────────────────────────────

describe("canvasToYaml — multiline prompts", () => {
  it("uses YAML block scalar for multiline prompts", () => {
    const nodes = toMap([
      makeNode({ id: "s1", prompt: "Line 1\nLine 2\nLine 3" }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("prompt: |");
    expect(result).toContain("      Line 1");
    expect(result).toContain("      Line 2");
  });
});

// ─── Tools & pre-tools ───────────────────────────────────────────────────────

describe("canvasToYaml — tools", () => {
  it("emits tools array", () => {
    const nodes = toMap([
      makeNode({ id: "s1", tools: ["Read", "Write", "Edit"] }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("tools: [Read, Write, Edit]");
  });

  it("omits tools when empty", () => {
    const nodes = toMap([makeNode({ id: "s1", tools: [] })]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).not.toContain("tools:");
  });

  it("emits pre_tools with type and inject_as", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        preTools: [
          { type: "web_search", inject_as: "search_results", query: "test query" } as any,
        ],
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("pre_tools:");
    expect(result).toContain("type: web_search");
    expect(result).toContain("inject_as: search_results");
  });

  it("emits pre_tool optional fields", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        preTools: [
          {
            type: "web_search",
            inject_as: "results",
            on_error: "skip",
            timeout_ms: 5000,
            retry: 2,
            cache_ttl_minutes: 30,
            parallel: true,
          } as any,
        ],
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("on_error: skip");
    expect(result).toContain("timeout_ms: 5000");
    expect(result).toContain("retry: 2");
    expect(result).toContain("cache_ttl_minutes: 30");
    expect(result).toContain("parallel: true");
  });
});

// ─── Labels & model ───────────────────────────────────────────────────────────

describe("canvasToYaml — labels and model", () => {
  it("emits label when different from stepId", () => {
    const nodes = toMap([
      makeNode({ id: "s1", stepId: "s1", label: "Research Step" }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("label: Research Step");
  });

  it("omits label when same as stepId", () => {
    const nodes = toMap([
      makeNode({ id: "s1", stepId: "research", label: "research" }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).not.toMatch(/label: research\n/);
  });

  it("emits model when specified", () => {
    const nodes = toMap([
      makeNode({ id: "s1", model: "claude-sonnet-4-20250514" }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("model: claude-sonnet-4-20250514");
  });

  it("omits model when not specified", () => {
    const nodes = toMap([makeNode({ id: "s1" })]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).not.toContain("model:");
  });
});

// ─── Output var ───────────────────────────────────────────────────────────────

describe("canvasToYaml — output", () => {
  it("uses node outputVar if set", () => {
    const nodes = toMap([
      makeNode({ id: "s1", outputVar: "my_output" }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("output_var: my_output");
    expect(result).toContain("output: my_output");
  });

  it("defaults output_var to stepId_out", () => {
    const nodes = toMap([
      makeNode({ id: "s1", outputVar: "" }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("output_var: s1_out");
  });

  it("last node output_var becomes the chain output", () => {
    const nodes = toMap([
      makeNode({ id: "first", outputVar: "first_out" }),
      makeNode({ id: "last", outputVar: "final_result" }),
    ]);
    const edges = toMap([makeEdge("first", "last")]);
    const result = canvasToYaml(nodes, edges, "test");
    // Last line should reference last node's output
    expect(result.trimEnd().endsWith("output: final_result")).toBe(true);
  });
});

// ─── Advanced config ──────────────────────────────────────────────────────────

describe("canvasToYaml — advanced config", () => {
  it("emits timeout_ms", () => {
    const nodes = toMap([
      makeNode({ id: "s1", advanced: { timeout_ms: 30000 } }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("timeout_ms: 30000");
  });

  it("emits condition", () => {
    const nodes = toMap([
      makeNode({ id: "s1", advanced: { condition: "steps.s0.success" } }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("condition:");
  });

  it("emits retry config", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        advanced: { retry: { max: 3, delay_ms: 1000, backoff: 2 } },
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("retry:");
    expect(result).toContain("max: 3");
    expect(result).toContain("delay_ms: 1000");
    expect(result).toContain("backoff: 2");
  });

  it("emits fallback_models", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        advanced: { fallback_models: ["gpt-4o", "claude-sonnet-4-20250514"] },
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("fallback_models:");
    expect(result).toContain("gpt-4o");
  });

  it("emits cache config", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        advanced: { cache: { enabled: true, ttl_minutes: 60 } },
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("cache:");
    expect(result).toContain("enabled: true");
    expect(result).toContain("ttl_minutes: 60");
  });

  it("emits output validation fields", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        advanced: {
          output_schema: "json",
          output_max_length: 5000,
          output_must_contain: ["summary", "conclusion"],
          output_must_not_contain: ["TODO"],
        },
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("output_schema: json");
    expect(result).toContain("output_max_length: 5000");
    expect(result).toContain("output_must_contain:");
    expect(result).toContain("output_must_not_contain:");
  });

  it("emits guardrails", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        advanced: {
          guardrails: [
            { type: "max_tokens", value: 1000 },
            { type: "no_pii" },
          ],
        },
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("guardrails:");
    expect(result).toContain("type: max_tokens");
    expect(result).toContain("value: 1000");
    expect(result).toContain("type: no_pii");
  });

  it("emits early_exit_if and cwd", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        advanced: {
          early_exit_if: "output.includes('DONE')",
          cwd: "/tmp/work",
        },
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("early_exit_if:");
    expect(result).toContain("cwd:");
  });
});

// ─── Type-specific advanced fields ────────────────────────────────────────────

describe("canvasToYaml — type-specific fields", () => {
  it("emits router routes and default_route", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        type: "router",
        advanced: {
          routes: { positive: ["step_a"], negative: ["step_b"] },
          default_route: "step_c",
        },
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("routes:");
    expect(result).toContain("positive:");
    expect(result).toContain("default_route:");
  });

  it("emits evaluator fields", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        type: "evaluator",
        advanced: {
          input_var: "draft",
          criteria: "quality > 8",
          on_fail: "retry",
          max_retries: 3,
          retry_target: "writer",
          eval_scoring: true,
          eval_threshold: 7,
        },
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("input_var:");
    expect(result).toContain("criteria:");
    expect(result).toContain("on_fail:");
    expect(result).toContain("max_retries: 3");
    expect(result).toContain("retry_target:");
    expect(result).toContain("eval_scoring: true");
    expect(result).toContain("eval_threshold: 7");
  });

  it("emits gate fields", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        type: "gate",
        advanced: {
          timeout_hours: 24,
          on_timeout: "skip",
          gate_actions: ["approve", "reject"],
          gate_auto_approve_if: "cost < 10",
          gate_rejection_reason: true,
        },
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("timeout_hours: 24");
    expect(result).toContain("on_timeout:");
    expect(result).toContain("gate_actions:");
    expect(result).toContain("gate_auto_approve_if:");
    expect(result).toContain("gate_rejection_reason: true");
  });

  it("emits transform fields", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        type: "transform",
        advanced: {
          operation: "extract",
          json_path: "$.data",
          regex: "\\d+",
          template_str: "Result: {{value}}",
          truncate_limit: 500,
        },
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("operation:");
    expect(result).toContain("json_path:");
    expect(result).toContain("regex:");
    expect(result).toContain("template_str:");
    expect(result).toContain("truncate_limit: 500");
  });

  it("emits loop fields", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        type: "loop",
        advanced: {
          items_var: "urls",
          max_parallel: 5,
          loop_until: "all_done",
          loop_on_error: "continue",
        },
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("items_var:");
    expect(result).toContain("max_parallel: 5");
    expect(result).toContain("loop_until:");
    expect(result).toContain("loop_on_error:");
  });

  it("emits merge fields", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        type: "merge",
        advanced: {
          inputs: ["step_a_out", "step_b_out"],
          strategy: "concatenate",
        },
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("inputs:");
    expect(result).toContain("strategy:");
  });

  it("emits webhook fields", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        type: "webhook",
        advanced: {
          webhook_url: "https://api.example.com/hook",
          webhook_method: "POST",
          webhook_headers: { "Authorization": "Bearer token" },
          webhook_body: '{"key": "value"}',
          webhook_timeout_ms: 10000,
          webhook_retry: 3,
        },
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("webhook_url:");
    expect(result).toContain("webhook_method:");
    expect(result).toContain("webhook_headers:");
    expect(result).toContain("webhook_body:");
    expect(result).toContain("webhook_timeout_ms: 10000");
    expect(result).toContain("webhook_retry: 3");
  });

  it("emits subchain fields", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        type: "subchain",
        advanced: {
          subchain: "data-pipeline",
          subchain_input_map: { topic: "main_topic", depth: "3" },
        },
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("subchain: data-pipeline");
    expect(result).toContain("subchain_input_map:");
    expect(result).toContain("topic:");
  });

  it("emits debate fields", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        type: "debate",
        advanced: {
          debate_rounds: 3,
          debate_decision: "voting",
          debate_agents: [
            { prompt: "Argue for", model: "claude-sonnet-4-20250514" },
            { prompt: "Argue against" },
          ],
        },
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("debate_rounds: 3");
    expect(result).toContain("debate_decision:");
    expect(result).toContain("debate_agents:");
    expect(result).toContain("prompt: Argue for");
    expect(result).toContain("model: claude-sonnet-4-20250514");
  });

  it("emits browser fields", () => {
    const nodes = toMap([
      makeNode({
        id: "s1",
        type: "browser",
        advanced: {
          browser_url: "https://example.com",
          browser_task: "Extract main content",
          browser_max_steps: 10,
          browser_wait_ms: 2000,
          browser_output_format: "markdown",
          browser_headless: false,
        },
      }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("browser_url:");
    expect(result).toContain("browser_task:");
    expect(result).toContain("browser_max_steps: 10");
    expect(result).toContain("browser_wait_ms: 2000");
    expect(result).toContain("browser_output_format:");
    expect(result).toContain("browser_headless: false");
  });
});

// ─── sanitizeId edge cases ────────────────────────────────────────────────────

describe("canvasToYaml — id sanitization", () => {
  it("lowercases and replaces special chars", () => {
    const nodes = toMap([
      makeNode({ id: "s1", stepId: "My Step #1!", label: "My Step #1!" }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("id: my_step_1");
  });

  it("collapses multiple underscores", () => {
    const nodes = toMap([
      makeNode({ id: "s1", stepId: "a___b", label: "a___b" }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("id: a_b");
  });
});

// ─── yamlStr edge cases ───────────────────────────────────────────────────────

describe("canvasToYaml — YAML string quoting", () => {
  it("quotes strings with colons", () => {
    const nodes = toMap([
      makeNode({ id: "s1", prompt: "key: value" }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    // Should be quoted
    expect(result).toContain('"key: value"');
  });

  it("quotes strings with special characters", () => {
    const nodes = toMap([
      makeNode({ id: "s1" }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "special: chain #1");
    expect(result).toContain('"special: chain #1"');
  });

  it("handles empty prompt with TODO", () => {
    const nodes = toMap([
      makeNode({ id: "s1", prompt: "" }),
    ]);
    const result = canvasToYaml(nodes, new Map(), "test");
    expect(result).toContain("TODO: add prompt");
  });
});
