/**
 * Tests for the chain linter and dry-run (linter.ts).
 *
 * Covers:
 * - Variable reference detection (defined, undefined, edge cases)
 * - Dependency graph errors (circular, missing deps)
 * - Router route validation
 * - Evaluator target validation
 * - Merge input validation
 * - Pre-tool field validation (all types)
 * - Unreachable step detection
 * - Unused output_var detection
 * - Dry-run execution plan + cost estimation
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { lintChain, dryRunChain } from "../src/linter.js";
import { loadChain } from "../src/loader.js";
import type { ChainDefinition } from "../src/types.js";

let tmpDir: string;

function makeChain(overrides: Partial<ChainDefinition> = {}): ChainDefinition {
  return {
    name: "test",
    inputs: [{ name: "topic", description: "The topic", optional: false }],
    steps: [
      { id: "s1", prompt: "Write about {input.topic}", output_var: "result", tools: [], depends_on: [] },
    ],
    output: "result",
    ...overrides,
  } as ChainDefinition;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-linter-test-"));
  process.env.CHAINS_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.CHAINS_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Clean chains ───────────────────────────────────────────────────────────

describe("Clean chain validation", () => {
  it("returns no issues for a minimal valid chain", () => {
    const issues = lintChain(makeChain());
    const errors = issues.filter((i) => i.level === "error");
    expect(errors.length).toBe(0);
  });

  it("returns no errors for a chain with depends_on", () => {
    const chain = makeChain({
      steps: [
        { id: "s1", prompt: "Step 1", output_var: "out1", tools: [], depends_on: [] },
        { id: "s2", prompt: "Use {out1}", output_var: "out2", tools: [], depends_on: ["s1"] },
      ],
      output: "out2",
    });
    const errors = lintChain(chain).filter((i) => i.level === "error");
    expect(errors.length).toBe(0);
  });
});

// ─── Variable references ────────────────────────────────────────────────────

describe("Variable reference detection", () => {
  it("warns on undefined variable in prompt", () => {
    const chain = makeChain({
      steps: [
        { id: "s1", prompt: "Use {undefined_var}", output_var: "result", tools: [], depends_on: [] },
      ],
    });
    const warnings = lintChain(chain).filter((i) => i.level === "warning");
    expect(warnings.some((w) => w.message.includes("undefined_var"))).toBe(true);
  });

  it("does not warn on valid input reference", () => {
    const chain = makeChain({
      steps: [
        { id: "s1", prompt: "Use {input.topic}", output_var: "result", tools: [], depends_on: [] },
      ],
    });
    const warnings = lintChain(chain).filter((i) => i.level === "warning" && i.message.includes("input.topic"));
    expect(warnings.length).toBe(0);
  });

  it("does not warn on pre-tool inject_as variable", () => {
    const chain = makeChain({
      steps: [
        {
          id: "s1",
          prompt: "Data: {search_data}",
          output_var: "result",
          tools: [],
          depends_on: [],
          pre_tools: [{ type: "web_search" as any, query: "test", inject_as: "search_data" }],
        },
      ],
    });
    const warnings = lintChain(chain).filter((i) => i.level === "warning" && i.message.includes("search_data"));
    expect(warnings.length).toBe(0);
  });

  it("does not warn on {item} in loop context", () => {
    const chain = makeChain({
      steps: [
        { id: "s1", prompt: "Process {item}", output_var: "result", tools: [], depends_on: [] },
      ],
    });
    const warnings = lintChain(chain).filter((i) => i.message.includes("{item}"));
    expect(warnings.length).toBe(0);
  });
});

// ─── Dependency graph ───────────────────────────────────────────────────────

describe("Dependency graph validation", () => {
  it("detects circular dependencies", () => {
    const chain = makeChain({
      steps: [
        { id: "a", prompt: "A", output_var: "out_a", tools: [], depends_on: ["b"] },
        { id: "b", prompt: "B", output_var: "out_b", tools: [], depends_on: ["a"] },
      ],
      output: "out_a",
    });
    const errors = lintChain(chain).filter((i) => i.level === "error");
    expect(errors.some((e) => e.message.includes("Circular"))).toBe(true);
  });

  it("detects missing depends_on target", () => {
    const chain = makeChain({
      steps: [
        { id: "s1", prompt: "X", output_var: "result", tools: [], depends_on: ["ghost"] },
      ],
    });
    const errors = lintChain(chain).filter((i) => i.level === "error");
    expect(errors.some((e) => e.message.includes("ghost"))).toBe(true);
  });

  it("detects invalid output var", () => {
    const chain = makeChain({ output: "nonexistent_var" });
    const errors = lintChain(chain).filter((i) => i.level === "error");
    expect(errors.some((e) => e.message.includes("nonexistent_var"))).toBe(true);
  });

  it("detects duplicate step IDs", () => {
    const chain = makeChain({
      steps: [
        { id: "dup", prompt: "A", output_var: "out1", tools: [], depends_on: [] },
        { id: "dup", prompt: "B", output_var: "out2", tools: [], depends_on: [] },
      ],
      output: "out1",
    });
    const errors = lintChain(chain).filter((i) => i.level === "error");
    expect(errors.some((e) => e.message.includes("Duplicate"))).toBe(true);
  });
});

// ─── Router validation ──────────────────────────────────────────────────────

describe("Router step validation", () => {
  it("detects invalid route target", () => {
    const chain = makeChain({
      steps: [
        {
          id: "router",
          type: "router" as any,
          prompt: "Classify",
          output_var: "route",
          tools: [],
          depends_on: [],
          routes: { a: ["ghost_step"] },
        },
      ],
      output: "route",
    });
    const errors = lintChain(chain).filter((i) => i.level === "error");
    expect(errors.some((e) => e.message.includes("ghost_step"))).toBe(true);
  });
});

// ─── Evaluator validation ───────────────────────────────────────────────────

describe("Evaluator step validation", () => {
  it("detects invalid retry_target", () => {
    const chain = makeChain({
      steps: [
        {
          id: "eval",
          type: "evaluator" as any,
          prompt: "Evaluate",
          output_var: "result",
          tools: [],
          depends_on: [],
          retry_target: "nonexistent",
        },
      ],
    });
    const errors = lintChain(chain).filter((i) => i.level === "error");
    expect(errors.some((e) => e.message.includes("nonexistent"))).toBe(true);
  });

  it("warns on unknown input_var", () => {
    const chain = makeChain({
      steps: [
        {
          id: "eval",
          type: "evaluator" as any,
          prompt: "Evaluate",
          output_var: "result",
          tools: [],
          depends_on: [],
          input_var: "unknown_var",
        },
      ],
    });
    const warnings = lintChain(chain).filter((i) => i.level === "warning");
    expect(warnings.some((w) => w.message.includes("unknown_var"))).toBe(true);
  });
});

// ─── Pre-tool validation ────────────────────────────────────────────────────

describe("Pre-tool field validation", () => {
  const preToolTests = [
    { type: "web_search", missing: "query", fields: {} },
    { type: "http_fetch", missing: "url", fields: {} },
    { type: "read_file", missing: "path", fields: {} },
    { type: "bash", missing: "command", fields: {} },
    { type: "env_var", missing: "var_name", fields: {} },
    { type: "mcp_call", missing: "server", fields: { tool: "test" } },
    { type: "mcp_call", missing: "tool", fields: { server: "test" } },
  ];

  for (const { type, missing, fields } of preToolTests) {
    it(`detects ${type} missing "${missing}"`, () => {
      const chain = makeChain({
        steps: [
          {
            id: "s1",
            prompt: "X",
            output_var: "result",
            tools: [],
            depends_on: [],
            pre_tools: [{ type: type as any, inject_as: "data", ...fields }],
          },
        ],
      });
      const errors = lintChain(chain).filter((i) => i.level === "error");
      expect(errors.some((e) => e.message.includes(missing))).toBe(true);
    });
  }
});

// ─── Unused output_var ──────────────────────────────────────────────────────

describe("Unused output_var detection", () => {
  it("reports unused intermediate output_var as info", () => {
    const chain = makeChain({
      steps: [
        { id: "s1", prompt: "A", output_var: "unused_thing", tools: [], depends_on: [] },
        { id: "s2", prompt: "B", output_var: "result", tools: [], depends_on: [] },
      ],
    });
    const infos = lintChain(chain).filter((i) => i.level === "info");
    expect(infos.some((i) => i.message.includes("unused_thing"))).toBe(true);
  });

  it("does not report chain output as unused", () => {
    const chain = makeChain();
    const infos = lintChain(chain).filter((i) => i.message.includes("result"));
    expect(infos.length).toBe(0);
  });

  it("does not report var used in condition", () => {
    const chain = makeChain({
      steps: [
        { id: "s1", prompt: "A", output_var: "flag", tools: [], depends_on: [] },
        { id: "s2", prompt: "B", output_var: "result", tools: [], depends_on: [], condition: '{flag} == "yes"' },
      ],
    });
    const infos = lintChain(chain).filter((i) => i.message.includes("flag"));
    expect(infos.length).toBe(0);
  });

  it("does not report var used in loop_until", () => {
    const chain = makeChain({
      steps: [
        { id: "s1", prompt: "A", output_var: "loop_flag", tools: [], depends_on: [] },
        { id: "s2", prompt: "B", output_var: "result", tools: [], depends_on: [], loop_until: '{loop_flag} == "done"' },
      ],
    });
    const infos = lintChain(chain).filter((i) => i.message.includes("loop_flag"));
    expect(infos.length).toBe(0);
  });

  it("does not report var used in subchain_input_map", () => {
    const chain = makeChain({
      steps: [
        { id: "s1", prompt: "A", output_var: "data", tools: [], depends_on: [] },
        {
          id: "s2", type: "subchain" as any, prompt: "B", output_var: "result",
          tools: [], depends_on: [], subchain: "other", subchain_input_map: { input: "{data}" },
        },
      ],
    });
    const infos = lintChain(chain).filter((i) => i.message.includes('"data"'));
    expect(infos.length).toBe(0);
  });
});

// ─── Merge validation ───────────────────────────────────────────────────────

describe("Merge step validation", () => {
  it("warns on unknown merge input", () => {
    const chain = makeChain({
      steps: [
        {
          id: "m1",
          type: "merge" as any,
          prompt: "Merge",
          output_var: "result",
          tools: [],
          depends_on: [],
          inputs: ["ghost_var"],
        },
      ],
    });
    const warnings = lintChain(chain).filter((i) => i.level === "warning");
    expect(warnings.some((w) => w.message.includes("ghost_var"))).toBe(true);
  });
});

// ─── Dry-run ────────────────────────────────────────────────────────────────

describe("Dry-run", () => {
  it("returns execution plan with waves", () => {
    const chain = makeChain({
      steps: [
        { id: "a", prompt: "Step A {input.topic}", output_var: "out_a", tools: [], depends_on: [] },
        { id: "b", prompt: "Step B {input.topic}", output_var: "out_b", tools: [], depends_on: [] },
        { id: "c", prompt: "Combine {out_a} {out_b}", output_var: "result", tools: [], depends_on: ["a", "b"] },
      ],
    });

    const result = dryRunChain(chain, { topic: "AI" });

    expect(result.plan.length).toBe(3);
    // a and b should be in wave 1 (parallel)
    expect(result.plan[0].wave).toBe(1);
    expect(result.plan[1].wave).toBe(1);
    // c should be in wave 2
    expect(result.plan[2].wave).toBe(2);
    expect(result.plan[2].stepId).toBe("c");
  });

  it("resolves input variables in prompt preview", () => {
    const chain = makeChain();
    const result = dryRunChain(chain, { topic: "quantum computing" });

    expect(result.plan[0].promptPreview).toContain("quantum computing");
  });

  it("includes cost estimation", () => {
    const chain = makeChain({
      steps: [
        { id: "s1", model: "claude-sonnet-4-6", prompt: "A", output_var: "out1", tools: [], depends_on: [] },
        { id: "s2", model: "claude-haiku-4-5", prompt: "B", output_var: "result", tools: [], depends_on: [] },
      ],
    });

    const result = dryRunChain(chain, { topic: "test" });
    expect(result.estimatedCost.totalSteps).toBe(2);
    expect(result.estimatedCost.parallelWaves).toBe(1); // Both in wave 1
    expect(result.estimatedCost.models["claude-sonnet-4-6"]).toBe(1);
    expect(result.estimatedCost.models["claude-haiku-4-5"]).toBe(1);
  });

  it("reports missing required inputs", () => {
    const chain = makeChain();
    const result = dryRunChain(chain, {}); // Missing "topic"

    const errors = result.issues.filter((i) => i.level === "error");
    expect(errors.some((e) => e.message.includes("topic"))).toBe(true);
  });

  it("includes lint issues in dry-run result", () => {
    const chain = makeChain({
      steps: [
        { id: "s1", prompt: "Use {ghost}", output_var: "result", tools: [], depends_on: [] },
      ],
    });

    const result = dryRunChain(chain, { topic: "test" });
    expect(result.issues.some((i) => i.message.includes("ghost"))).toBe(true);
  });
});

// ─── Real chain validation ──────────────────────────────────────────────────

describe("Real demo chain validation", () => {
  const chainsDir = path.resolve(__dirname, "..", "..", "chains");

  if (fs.existsSync(chainsDir)) {
    const files = fs.readdirSync(chainsDir).filter((f) => f.endsWith(".yaml"));

    for (const file of files) {
      it(`${file} has zero lint errors`, () => {
        process.env.CHAINS_DIR = chainsDir;
        const name = path.basename(file, ".yaml");
        const chain = loadChain(name);
        const errors = lintChain(chain).filter((i) => i.level === "error");
        expect(errors).toEqual([]);
      });
    }
  }
});
