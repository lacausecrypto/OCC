/**
 * Extended pretool-executor tests covering Tier 1-3 pre-tool types.
 *
 * Tests the pretool-executor dispatch for:
 * - state_load / state_save
 * - vector_query / vector_index
 * - json_parse
 * - cost_gate
 * - ast_parse
 * - embed_compare
 * - graph_query (write + read)
 * - template_render
 * - approval_request
 * - executePreToolWithRetry with retry + inject error
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { executeSinglePreTool, executePreToolWithRetry } from "../src/pretool-executor.js";
import { closeExtraDbs } from "../src/pretool-extras.js";
import type { PreTool, ChainExecution } from "../src/types.js";

const onLog = vi.fn();
let tmpDir: string;

beforeEach(() => {
  onLog.mockClear();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-pretool-ext-test-"));
  process.env.OCC_STATE_DB = path.join(tmpDir, "state.db");
  process.env.OCC_VECTOR_DB = path.join(tmpDir, "vectors.db");
  process.env.OCC_GRAPH_DB = path.join(tmpDir, "graph.db");
  process.env.OCC_SEMANTIC_CACHE_DB = path.join(tmpDir, "sem-cache.db");
});

afterEach(() => {
  closeExtraDbs();
  delete process.env.OCC_STATE_DB;
  delete process.env.OCC_VECTOR_DB;
  delete process.env.OCC_GRAPH_DB;
  delete process.env.OCC_SEMANTIC_CACHE_DB;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* EBUSY on Windows */ }
});

// ─── state_load / state_save via executor ────────────────────────────────────

describe("state_load / state_save via executor", () => {
  it("saves and loads state through pre-tool executor", async () => {
    // Save
    const saveResult = await executeSinglePreTool(
      { type: "state_save", inject_as: "save_ok", key: "test_key", value: "test_val", scope: "test" } as PreTool,
      {},
      onLog,
    );
    expect(saveResult).toContain("Saved");

    // Load
    const loadResult = await executeSinglePreTool(
      { type: "state_load", inject_as: "loaded", key: "test_key", scope: "test", default: "(none)" } as PreTool,
      {},
      onLog,
    );
    expect(loadResult).toBe("test_val");
  });

  it("returns default when key not found", async () => {
    const result = await executeSinglePreTool(
      { type: "state_load", inject_as: "loaded", key: "nonexistent", scope: "test", default: "fallback_val" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("fallback_val");
  });

  it("resolves variables in key and value", async () => {
    await executeSinglePreTool(
      { type: "state_save", inject_as: "r", key: "{prefix}_key", value: "{greeting} world", scope: "test" } as PreTool,
      { prefix: "my", greeting: "hello" },
      onLog,
    );
    const result = await executeSinglePreTool(
      { type: "state_load", inject_as: "r", key: "my_key", scope: "test" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("hello world");
  });
});

// ─── vector_query / vector_index via executor ────────────────────────────────

describe("vector_query / vector_index via executor", () => {
  it("indexes and queries text", async () => {
    const indexResult = await executeSinglePreTool(
      { type: "vector_index", inject_as: "idx", collection: "test_docs", source: "The quick brown fox jumps over the lazy dog", chunk_size: 512 } as PreTool,
      {},
      onLog,
    );
    expect(indexResult).toContain("Indexed");

    const queryResult = await executeSinglePreTool(
      { type: "vector_query", inject_as: "results", collection: "test_docs", query: "quick brown fox", top_k: 3 } as PreTool,
      {},
      onLog,
    );
    expect(queryResult).toContain("quick brown fox");
  });

  it("resolves variables in source text", async () => {
    const result = await executeSinglePreTool(
      { type: "vector_index", inject_as: "idx", collection: "vars_test", source: "{text_content}", chunk_size: 512 } as PreTool,
      { text_content: "Important document content here" },
      onLog,
    );
    expect(result).toContain("Indexed");
  });
});

// ─── json_parse via executor ─────────────────────────────────────────────────

describe("json_parse via executor", () => {
  it("parses JSON and extracts path", async () => {
    const result = await executeSinglePreTool(
      { type: "json_parse", inject_as: "parsed", input: '{"user":{"name":"Alice"}}', json_path: "user.name" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("Alice");
  });

  it("resolves variables in input", async () => {
    const result = await executeSinglePreTool(
      { type: "json_parse", inject_as: "parsed", input: "{json_data}", json_path: "status" } as PreTool,
      { json_data: '{"status":"ok","count":5}' },
      onLog,
    );
    expect(result).toBe("ok");
  });

  it("returns full JSON with default path", async () => {
    const result = await executeSinglePreTool(
      { type: "json_parse", inject_as: "parsed", input: '{"a":1}' } as PreTool,
      {},
      onLog,
    );
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });
});

// ─── cost_gate via executor ──────────────────────────────────────────────────

describe("cost_gate via executor", () => {
  it("reports cost status using execution steps", async () => {
    const execution = {
      id: "test-exec",
      chainName: "test",
      status: "running" as const,
      input: {},
      steps: {
        s1: { stepId: "s1", status: "done" as const, inputTokens: 1000, outputTokens: 500 },
      },
      startedAt: "2026-01-01T00:00:00Z",
    } as ChainExecution;

    const result = await executeSinglePreTool(
      { type: "cost_gate", inject_as: "cost", budget_usd: 10, action: "warn" } as PreTool,
      {},
      onLog,
      execution,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("within_budget");
    expect(parsed.budget_usd).toBe(10);
  });
});

// ─── ast_parse via executor ──────────────────────────────────────────────────

describe("ast_parse via executor", () => {
  it("extracts functions from a file", async () => {
    const tsFile = path.join(tmpDir, "test.ts");
    fs.writeFileSync(tsFile, 'export function hello() {}\nfunction world() {}');

    const origWorkspace = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = tmpDir;
    try {
      const result = await executeSinglePreTool(
        { type: "ast_parse", inject_as: "ast", path: tsFile, extract: ["functions"] } as PreTool,
        {},
        onLog,
      );
      expect(result).toContain("hello");
      expect(result).toContain("world");
    } finally {
      if (origWorkspace === undefined) delete process.env.WORKSPACE_DIR;
      else process.env.WORKSPACE_DIR = origWorkspace;
    }
  });
});

// ─── embed_compare via executor ──────────────────────────────────────────────

describe("embed_compare via executor", () => {
  it("compares two texts", async () => {
    const result = await executeSinglePreTool(
      { type: "embed_compare", inject_as: "cmp", text_a: "hello world", text_b: "hello earth" } as PreTool,
      {},
      onLog,
    );
    const parsed = JSON.parse(result);
    expect(parsed.similarity).toBeDefined();
    expect(parsed.method).toBe("jaccard_keywords");
  });

  it("resolves variables in text_a and text_b", async () => {
    const result = await executeSinglePreTool(
      { type: "embed_compare", inject_as: "cmp", text_a: "{old_text}", text_b: "{new_text}" } as PreTool,
      { old_text: "original document content", new_text: "updated document content" },
      onLog,
    );
    const parsed = JSON.parse(result);
    expect(parsed.similarity).toBeGreaterThan(0);
  });
});

// ─── graph_query via executor ────────────────────────────────────────────────

describe("graph_query via executor", () => {
  it("writes triples when triples are provided", async () => {
    const result = await executeSinglePreTool(
      {
        type: "graph_query", inject_as: "graph",
        triples: [
          { subject: "Alice", predicate: "knows", object: "Bob" },
          { subject: "Bob", predicate: "works_at", object: "Acme" },
        ],
      } as PreTool,
      {},
      onLog,
    );
    expect(result).toContain("2 triples");
  });

  it("reads triples when no triples provided", async () => {
    // First write
    await executeSinglePreTool(
      {
        type: "graph_query", inject_as: "write",
        triples: [{ subject: "X", predicate: "rel", object: "Y" }],
      } as PreTool,
      {},
      onLog,
    );
    // Then read
    const result = await executeSinglePreTool(
      {
        type: "graph_query", inject_as: "read",
        graph_query_subject: "X",
      } as PreTool,
      {},
      onLog,
    );
    expect(result).toContain("X");
    expect(result).toContain("rel");
    expect(result).toContain("Y");
  });

  it("resolves variables in triple values", async () => {
    const result = await executeSinglePreTool(
      {
        type: "graph_query", inject_as: "graph",
        triples: [{ subject: "{name}", predicate: "likes", object: "{food}" }],
      } as PreTool,
      { name: "Alice", food: "Pizza" },
      onLog,
    );
    expect(result).toContain("1 triple");
  });
});

// ─── template_render via executor ────────────────────────────────────────────

describe("template_render via executor", () => {
  it("renders a template with data (Handlebars syntax)", async () => {
    // Note: template is first resolved via resolveVariables ({var}), then templateRender ({{var}})
    const result = await executeSinglePreTool(
      {
        type: "template_render", inject_as: "rendered",
        template: "Hello {name}! You have {{count}} messages.",
        data: { count: "5" },
      } as PreTool,
      { name: "Alice" },
      onLog,
    );
    expect(result).toContain("Hello Alice");
    expect(result).toContain("5 messages");
  });

  it("merges vars and explicit data", async () => {
    // {from_vars} is resolved by resolveVariables first, {{from_data}} by templateRender
    const result = await executeSinglePreTool(
      {
        type: "template_render", inject_as: "rendered",
        template: "{from_vars} and {{from_data}}",
        data: { from_data: "data_val" },
      } as PreTool,
      { from_vars: "var_val" },
      onLog,
    );
    expect(result).toBe("var_val and data_val");
  });
});

// ─── approval_request via executor ───────────────────────────────────────────

describe("approval_request via executor", () => {
  it("creates an approval request with execution context", async () => {
    const result = await executeSinglePreTool(
      {
        type: "approval_request", inject_as: "approval",
        title: "Review Required",
        description: "Please review the output",
        expires_hours: 48,
      } as PreTool,
      {},
      onLog,
      undefined, // no execution
      "exec-123", // executionId
      { id: "gate1", output_var: "result", prompt: "" } as any, // step
    );
    const parsed = JSON.parse(result);
    expect(parsed.title).toBe("Review Required");
    expect(parsed.approve_url).toContain("exec-123");
    expect(parsed.approve_url).toContain("gate1");
  });
});

// ─── executePreToolWithRetry error modes ─────────────────────────────────────

describe("executePreToolWithRetry error modes", () => {
  it("injects error message when on_error is inject (default)", async () => {
    const result = await executePreToolWithRetry(
      { type: "ocr", inject_as: "ocr_result", image_path: "" } as PreTool,
      {},
      onLog,
    );
    expect(result).toContain("PRE-TOOL ERROR");
  });

  it("returns empty string when on_error is skip", async () => {
    const result = await executePreToolWithRetry(
      { type: "ocr", inject_as: "ocr_result", image_path: "", on_error: "skip" } as PreTool,
      {},
      onLog,
    );
    expect(result).toBe("");
  });

  it("throws when on_error is fail", async () => {
    await expect(
      executePreToolWithRetry(
        { type: "ocr", inject_as: "ocr_result", image_path: "", on_error: "fail" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/failed after/);
  });

  it("retries on failure before giving up", async () => {
    const startTime = Date.now();
    const result = await executePreToolWithRetry(
      { type: "ocr", inject_as: "ocr_result", image_path: "", retry: 1, on_error: "inject" } as PreTool,
      {},
      onLog,
    );
    const elapsed = Date.now() - startTime;
    // Should have retried once with ~1s backoff
    expect(elapsed).toBeGreaterThan(500);
    expect(result).toContain("PRE-TOOL ERROR");
    // Log should mention the retry
    const warnLogs = onLog.mock.calls.filter((c) => c[1] === "warn");
    expect(warnLogs.length).toBeGreaterThan(0);
  });
});

// ─── semantic_cache (error without claudeRunner) ─────────────────────────────

describe("semantic_cache via executor", () => {
  it("throws when no cached result and no claudeRunner", async () => {
    await expect(
      executeSinglePreTool(
        { type: "semantic_cache", inject_as: "cached", query: "test query" } as PreTool,
        {},
        onLog,
      ),
    ).rejects.toThrow(/requires a claudeRunner/);
  });
});
