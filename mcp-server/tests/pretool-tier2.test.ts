import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadChain } from "../src/loader.js";
import { lintChain } from "../src/linter.js";
import { costGate, astParse } from "../src/pretool-extras.js";
import * as yaml from "js-yaml";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let originalChainsDir: string | undefined;

function writeYaml(filename: string, obj: unknown): void {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, yaml.dump(obj), "utf-8");
}

/** Minimal valid chain with a single pre_tool step. */
function chainWithPreTool(preTool: Record<string, unknown>, name = "test-chain"): Record<string, unknown> {
  return {
    name,
    steps: [
      {
        id: "s1",
        prompt: "Do something with {injected}",
        output_var: "result",
        pre_tools: [preTool],
      },
    ],
    output: "result",
  };
}

/** Build a ChainDefinition in-memory for lintChain. */
function buildChainDef(preTool: Record<string, unknown>) {
  const obj = chainWithPreTool(preTool);
  writeYaml("lint-target.yaml", obj);
  return loadChain("lint-target");
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-pretool-tier2-test-"));
  originalChainsDir = process.env.CHAINS_DIR;
  process.env.CHAINS_DIR = tmpDir;
});

afterEach(() => {
  if (originalChainsDir === undefined) {
    delete process.env.CHAINS_DIR;
  } else {
    process.env.CHAINS_DIR = originalChainsDir;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =============================================================================
// 1. semantic_cache
// =============================================================================

describe("semantic_cache", () => {
  it("schema: accepts query, cache_ttl_minutes, similarity_threshold", () => {
    const chain = chainWithPreTool({
      type: "semantic_cache",
      inject_as: "cached",
      query: "What is the capital of France?",
      cache_ttl_minutes: 60,
      similarity_threshold: 0.85,
    });
    writeYaml("semantic_cache.yaml", chain);
    const loaded = loadChain("semantic_cache");
    const pt = loaded.steps[0].pre_tools![0];
    expect(pt.type).toBe("semantic_cache");
    expect(pt.query).toBe("What is the capital of France?");
    expect(pt.cache_ttl_minutes).toBe(60);
    expect(pt.similarity_threshold).toBe(0.85);
  });
});

// =============================================================================
// 2. screenshot
// =============================================================================

describe("screenshot", () => {
  it("schema: accepts url, viewport, wait_ms", () => {
    const chain = chainWithPreTool({
      type: "screenshot",
      inject_as: "shot",
      url: "https://example.com",
      viewport: { width: 1280, height: 720 },
      wait_ms: 2000,
    });
    writeYaml("screenshot.yaml", chain);
    const loaded = loadChain("screenshot");
    const pt = loaded.steps[0].pre_tools![0];
    expect(pt.type).toBe("screenshot");
    expect(pt.url).toBe("https://example.com");
    expect(pt.viewport).toEqual({ width: 1280, height: 720 });
    expect(pt.wait_ms).toBe(2000);
  });

  it("linter: error when url missing", () => {
    const chain = buildChainDef({
      type: "screenshot",
      inject_as: "shot",
      // url intentionally omitted
    });
    const issues = lintChain(chain);
    const errors = issues.filter((i) => i.level === "error");
    expect(errors.some((e) => e.message.includes("screenshot") && e.message.includes("url"))).toBe(true);
  });
});

// =============================================================================
// 3. sandbox_exec
// =============================================================================

describe("sandbox_exec", () => {
  it("schema: accepts image, command, mount", () => {
    const chain = chainWithPreTool({
      type: "sandbox_exec",
      inject_as: "sandbox_out",
      image: "node:20-alpine",
      command: "node -e 'console.log(42)'",
      mount: "/tmp/data:/data:ro",
    });
    writeYaml("sandbox_exec.yaml", chain);
    const loaded = loadChain("sandbox_exec");
    const pt = loaded.steps[0].pre_tools![0];
    expect(pt.type).toBe("sandbox_exec");
    expect(pt.image).toBe("node:20-alpine");
    expect(pt.command).toBe("node -e 'console.log(42)'");
    expect(pt.mount).toBe("/tmp/data:/data:ro");
  });

  it("linter: error when image missing", () => {
    const chain = buildChainDef({
      type: "sandbox_exec",
      inject_as: "sandbox_out",
      command: "echo hi",
      // image intentionally omitted
    });
    const issues = lintChain(chain);
    const errors = issues.filter((i) => i.level === "error");
    expect(errors.some((e) => e.message.includes("sandbox_exec") && e.message.includes("image"))).toBe(true);
  });

  it("linter: error when command missing", () => {
    const chain = buildChainDef({
      type: "sandbox_exec",
      inject_as: "sandbox_out",
      image: "alpine:latest",
      // command intentionally omitted
    });
    const issues = lintChain(chain);
    const errors = issues.filter((i) => i.level === "error");
    expect(errors.some((e) => e.message.includes("sandbox_exec") && e.message.includes("command"))).toBe(true);
  });
});

// =============================================================================
// 4. cost_gate
// =============================================================================

describe("cost_gate", () => {
  it("schema: accepts budget_usd, action", () => {
    const chain = chainWithPreTool({
      type: "cost_gate",
      inject_as: "cost_check",
      budget_usd: 5.0,
      action: "warn",
    });
    writeYaml("cost_gate.yaml", chain);
    const loaded = loadChain("cost_gate");
    const pt = loaded.steps[0].pre_tools![0];
    expect(pt.type).toBe("cost_gate");
    expect(pt.budget_usd).toBe(5.0);
    expect(pt.action).toBe("warn");
  });

  it("linter: error when budget_usd missing", () => {
    const chain = buildChainDef({
      type: "cost_gate",
      inject_as: "cost_check",
      action: "skip",
      // budget_usd intentionally omitted
    });
    const issues = lintChain(chain);
    const errors = issues.filter((i) => i.level === "error");
    expect(errors.some((e) => e.message.includes("cost_gate") && e.message.includes("budget_usd"))).toBe(true);
  });

  it("direct: within budget returns status within_budget", () => {
    const result = JSON.parse(
      costGate(10.0, { s1: { inputTokens: 1000, outputTokens: 500 } }, "warn"),
    );
    expect(result.status).toBe("within_budget");
    expect(result.action).toBe("continue");
    expect(result.budget_usd).toBe(10.0);
    expect(result.spent_usd).toBeGreaterThan(0);
    expect(result.remaining_usd).toBeGreaterThan(0);
  });

  it("direct: over budget returns status over_budget with action", () => {
    const result = JSON.parse(
      costGate(0.0001, { s1: { inputTokens: 100000, outputTokens: 50000 } }, "skip"),
    );
    expect(result.status).toBe("over_budget");
    expect(result.action).toBe("skip");
    expect(result.remaining_usd).toBeLessThan(0);
  });
});

// =============================================================================
// 5. ast_parse
// =============================================================================

describe("ast_parse", () => {
  it("schema: accepts path, extract array", () => {
    const chain = chainWithPreTool({
      type: "ast_parse",
      inject_as: "ast",
      path: "/tmp/code.ts",
      extract: ["functions", "classes", "exports"],
    });
    writeYaml("ast_parse.yaml", chain);
    const loaded = loadChain("ast_parse");
    const pt = loaded.steps[0].pre_tools![0];
    expect(pt.type).toBe("ast_parse");
    expect(pt.path).toBe("/tmp/code.ts");
    expect(pt.extract).toEqual(["functions", "classes", "exports"]);
  });

  it("direct: extracts function names from TypeScript", () => {
    const tempFile = path.join(tmpDir, "sample.ts");
    fs.writeFileSync(
      tempFile,
      `export function greetUser(name: string): string {
  return "Hello " + name;
}

class UserService {
  findAll() { return []; }
}
`,
      "utf-8",
    );

    const result = astParse(tempFile, ["functions"]);
    expect(result).toContain("greetUser");
  });

  it("direct: extracts class names from TypeScript", () => {
    const tempFile = path.join(tmpDir, "sample-cls.ts");
    fs.writeFileSync(
      tempFile,
      `export function greetUser(name: string): string {
  return "Hello " + name;
}

class UserService {
  findAll() { return []; }
}
`,
      "utf-8",
    );

    const result = astParse(tempFile, ["classes"]);
    expect(result).toContain("UserService");
  });
});
