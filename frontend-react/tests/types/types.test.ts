import { describe, it, expect } from "vitest";
import type { StepType, PreToolType, ChainDefinition, ChainInput } from "../../src/types/chain";
import type { ExecutionEvent, StepStatus, ExecutionStatus, ChainExecution } from "../../src/types/execution";
import type { DesignPreset, SavedTheme, HSL } from "../../src/types/design";

// These are compile-time type tests — if they compile, the types are correct.
// We also validate some structural aspects at runtime.

describe("chain types", () => {
  it("StepType covers all step types", () => {
    const types: StepType[] = [
      "agent", "router", "gate", "evaluator", "transform",
      "loop", "merge", "browser", "subchain", "debate", "webhook",
    ];
    expect(types).toHaveLength(11);
  });

  it("PreToolType covers all pre-tool types", () => {
    const types: PreToolType[] = [
      "current_datetime", "http_fetch", "web_search", "read_file", "write_file",
      "bash", "env_var", "mcp_call", "db_query", "email", "pdf_generate", "ocr",
      "state_load", "state_save", "vector_query", "vector_index", "json_parse",
      "diff_inject", "notify", "semantic_cache", "screenshot", "sandbox_exec",
      "cost_gate", "ast_parse", "embed_compare", "graph_query", "parallel_fetch",
      "template_render", "approval_request",
    ];
    expect(types).toHaveLength(29);
  });

  it("ChainDefinition has required fields", () => {
    const def: ChainDefinition = {
      name: "test",
      steps: [{ id: "s1", prompt: "do it", output_var: "out" }],
      output: "out",
    };
    expect(def.name).toBe("test");
    expect(def.steps).toHaveLength(1);
  });

  it("ChainInput has correct shape", () => {
    const input: ChainInput = {
      name: "topic",
      description: "Research topic",
      optional: true,
    };
    expect(input.name).toBe("topic");
  });
});

describe("execution types", () => {
  it("StepStatus covers all statuses", () => {
    const statuses: StepStatus[] = ["pending", "running", "done", "error", "skipped"];
    expect(statuses).toHaveLength(5);
  });

  it("ExecutionStatus covers all statuses", () => {
    const statuses: ExecutionStatus[] = ["pending", "running", "done", "error", "skipped"];
    expect(statuses).toHaveLength(5);
  });

  it("ChainExecution has required fields", () => {
    const exec: ChainExecution = {
      id: "e1",
      chainName: "test",
      status: "running",
      input: { topic: "AI" },
      steps: {},
      startedAt: new Date().toISOString(),
    };
    expect(exec.id).toBe("e1");
    expect(exec.status).toBe("running");
  });

  it("ExecutionEvent discriminated union works", () => {
    const events: ExecutionEvent[] = [
      { type: "execution_started", executionId: "e1", chainName: "test" },
      { type: "step_started", executionId: "e1", stepId: "s1" },
      { type: "step_output", executionId: "e1", stepId: "s1", chunk: "hi" },
      { type: "step_done", executionId: "e1", stepId: "s1", durationMs: 100 },
      { type: "step_error", executionId: "e1", stepId: "s1", error: "boom" },
      { type: "step_log", executionId: "e1", stepId: "s1", message: "log", level: "info" },
      { type: "execution_done", executionId: "e1", result: "ok", durationMs: 500 },
      { type: "execution_error", executionId: "e1", error: "fail" },
      { type: "step_cache_hit", executionId: "e1", stepId: "s1" },
      { type: "step_waiting_approval", executionId: "e1", stepId: "s1", prompt: "approve?" },
      { type: "gate_action", executionId: "e1", stepId: "s1", action: "approved" },
    ];
    expect(events).toHaveLength(11);
  });
});

describe("design types", () => {
  it("DesignPreset has all HSL color fields", () => {
    const preset: DesignPreset = {
      name: "Test",
      fontFamily: "Inter",
      bg: [0, 0, 5],
      surface: [0, 0, 10],
      accent: [210, 80, 50],
      text: [0, 0, 95],
      text2: [0, 0, 60],
      border: [0, 0, 20],
      headingSize: 20, headingWeight: 600,
      bodySize: 14, bodyWeight: 400,
      lineHeight: 1.5, gridCols: 3,
      gap: 16, padding: 20,
      radius: 12, borderWidth: 1, elevation: 30,
    };
    expect(preset.bg).toHaveLength(3);
  });

  it("HSL type is [number, number, number]", () => {
    const hsl: HSL = [210, 80, 50];
    expect(hsl).toHaveLength(3);
  });

  it("SavedTheme has 4 presets and blend position", () => {
    const theme: SavedTheme = {
      id: "t1",
      name: "My Theme",
      createdAt: Date.now(),
      presets: Array.from({ length: 4 }, () => ({
        name: "P", fontFamily: "F",
        bg: [0,0,0] as HSL, surface: [0,0,0] as HSL, accent: [0,0,0] as HSL,
        text: [0,0,0] as HSL, text2: [0,0,0] as HSL, border: [0,0,0] as HSL,
        headingSize: 20, headingWeight: 600, bodySize: 14, bodyWeight: 400,
        lineHeight: 1.5, gridCols: 3, gap: 16, padding: 20,
        radius: 12, borderWidth: 1, elevation: 30,
      })),
      blendX: 0.5,
      blendY: 0.5,
    };
    expect(theme.presets).toHaveLength(4);
  });
});
