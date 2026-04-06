/**
 * Tests for Tier 3 pre-tool types.
 *
 * Covers:
 * - embed_compare: schema, linter, direct similarity tests
 * - graph_query: schema, direct graphWrite/graphRead tests
 * - parallel_fetch: schema, linter
 * - template_render: schema, linter, direct rendering tests
 * - approval_request: schema, direct createApprovalRequest tests
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanupTmpDirSync } from "./_test-utils.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadChain } from "../src/loader.js";
import { lintChain } from "../src/linter.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-pretool-tier3-"));
  process.env.CHAINS_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.CHAINS_DIR;
  cleanupTmpDirSync(tmpDir);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. embed_compare
// ═══════════════════════════════════════════════════════════════════════════════

describe("embed_compare", () => {
  it("schema: accepts text_a and text_b fields", () => {
    fs.writeFileSync(path.join(tmpDir, "embed-compare.yaml"), `
name: embed-compare
steps:
  - id: compare
    pre_tools:
      - type: embed_compare
        text_a: "The quick brown fox"
        text_b: "A fast dark fox"
        inject_as: similarity
    prompt: "Similarity: {similarity}"
    output_var: result
output: result
`);
    const chain = loadChain("embed-compare");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.type).toBe("embed_compare");
    expect(pt.text_a).toBe("The quick brown fox");
    expect(pt.text_b).toBe("A fast dark fox");
    expect(pt.inject_as).toBe("similarity");
  });

  it("linter: error when text_a or text_b missing", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "embed_compare" as any, inject_as: "sim" }],
        prompt: "{sim}",
        output_var: "result",
        tools: [],
        depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter(
      (i) => i.level === "error" && i.message.includes("text_a")
    );
    expect(errors.length).toBe(1);
  });

  it("linter: error when only text_a provided (text_b missing)", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "embed_compare" as any, text_a: "hello", inject_as: "sim" }],
        prompt: "{sim}",
        output_var: "result",
        tools: [],
        depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter(
      (i) => i.level === "error" && i.message.includes("text_a") || i.message.includes("text_b")
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it("direct: same text returns similarity ~1.0", async () => {
    const { embedCompare } = await import("../src/pretool-extras.js");
    const raw = await embedCompare("hello world", "hello world");
    const parsed = JSON.parse(raw);
    expect(parsed.similarity).toBeCloseTo(1.0, 1);
    expect(parsed.verdict).toBe("mostly_same");
  });

  it("direct: different text returns similarity < 0.3", async () => {
    const { embedCompare } = await import("../src/pretool-extras.js");
    const raw = await embedCompare("quantum physics", "chocolate cake recipe");
    const parsed = JSON.parse(raw);
    expect(parsed.similarity).toBeLessThan(0.3);
    expect(parsed.verdict).toBe("significantly_changed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. graph_query
// ═══════════════════════════════════════════════════════════════════════════════

describe("graph_query", () => {
  it("schema: accepts triples, graph_query_subject, graph_query_predicate", () => {
    fs.writeFileSync(path.join(tmpDir, "graph-query.yaml"), `
name: graph-query
steps:
  - id: query
    pre_tools:
      - type: graph_query
        triples:
          - subject: OCC
            predicate: is_a
            object: orchestrator
        graph_query_subject: OCC
        graph_query_predicate: is_a
        inject_as: graph_result
    prompt: "Graph: {graph_result}"
    output_var: result
output: result
`);
    const chain = loadChain("graph-query");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.type).toBe("graph_query");
    expect(pt.triples).toHaveLength(1);
    expect(pt.triples[0].subject).toBe("OCC");
    expect(pt.graph_query_subject).toBe("OCC");
    expect(pt.graph_query_predicate).toBe("is_a");
  });

  it("direct: write triples and read them back", async () => {
    // Use a unique DB path so we don't conflict with other tests
    const dbPath = path.join(tmpDir, "test-graph.db");
    process.env.OCC_GRAPH_DB = dbPath;

    const { graphWrite, graphRead, closeExtraDbs } = await import("../src/pretool-extras.js");

    try {
      const writeResult = graphWrite([
        { subject: "OCC", predicate: "is_a", object: "orchestrator" },
      ]);
      expect(writeResult).toContain("Inserted");

      const readResult = graphRead("OCC");
      expect(readResult).toContain("orchestrator");
    } finally {
      closeExtraDbs();
      delete process.env.OCC_GRAPH_DB;
    }
  });

  it("direct: graphRead returns no-triples for unknown subject", async () => {
    const dbPath = path.join(tmpDir, "test-graph-empty.db");
    process.env.OCC_GRAPH_DB = dbPath;

    const { graphRead, closeExtraDbs } = await import("../src/pretool-extras.js");

    try {
      const readResult = graphRead("NONEXISTENT_SUBJECT_XYZ");
      expect(readResult).toBe("(no triples found)");
    } finally {
      closeExtraDbs();
      delete process.env.OCC_GRAPH_DB;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. parallel_fetch
// ═══════════════════════════════════════════════════════════════════════════════

describe("parallel_fetch", () => {
  it("schema: accepts urls array and rate_limit_ms", () => {
    fs.writeFileSync(path.join(tmpDir, "parallel-fetch.yaml"), `
name: parallel-fetch
steps:
  - id: fetch
    pre_tools:
      - type: parallel_fetch
        urls:
          - "https://api.example.com/a"
          - "https://api.example.com/b"
          - "https://api.example.com/c"
        rate_limit_ms: 200
        inject_as: fetched
    prompt: "Fetched: {fetched}"
    output_var: result
output: result
`);
    const chain = loadChain("parallel-fetch");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.type).toBe("parallel_fetch");
    expect(pt.urls).toHaveLength(3);
    expect(pt.urls[0]).toBe("https://api.example.com/a");
    expect(pt.rate_limit_ms).toBe(200);
  });

  it("linter: error when urls missing", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "parallel_fetch" as any, inject_as: "data" }],
        prompt: "{data}",
        output_var: "result",
        tools: [],
        depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter(
      (i) => i.level === "error" && i.message.includes("urls")
    );
    expect(errors.length).toBe(1);
  });

  it("linter: error when urls is empty array", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "parallel_fetch" as any, urls: [], inject_as: "data" }],
        prompt: "{data}",
        output_var: "result",
        tools: [],
        depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter(
      (i) => i.level === "error" && i.message.includes("urls")
    );
    expect(errors.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. template_render
// ═══════════════════════════════════════════════════════════════════════════════

describe("template_render", () => {
  it("schema: accepts template and data fields", () => {
    fs.writeFileSync(path.join(tmpDir, "template-render.yaml"), `
name: template-render
steps:
  - id: render
    pre_tools:
      - type: template_render
        template: "Hello {{name}}, you have {{count}} items"
        data:
          name: Alice
          count: 5
        inject_as: rendered
    prompt: "{rendered}"
    output_var: result
output: result
`);
    const chain = loadChain("template-render");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.type).toBe("template_render");
    expect(pt.template).toContain("{{name}}");
    expect(pt.data.name).toBe("Alice");
  });

  it("linter: error when template missing", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "template_render" as any, data: { x: 1 }, inject_as: "r" }],
        prompt: "{r}",
        output_var: "result",
        tools: [],
        depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter(
      (i) => i.level === "error" && i.message.includes("template")
    );
    expect(errors.length).toBe(1);
  });

  it("direct: simple variable substitution", async () => {
    const { templateRender } = await import("../src/pretool-extras.js");
    const result = templateRender("Hello {{name}}", { name: "Alice" });
    expect(result).toBe("Hello Alice");
  });

  it("direct: each loop", async () => {
    const { templateRender } = await import("../src/pretool-extras.js");
    const result = templateRender("{{#each items}}{{this}},{{/each}}", { items: ["a", "b", "c"] });
    expect(result).toBe("a,b,c,");
  });

  it("direct: if/else (truthy)", async () => {
    const { templateRender } = await import("../src/pretool-extras.js");
    const result = templateRender("{{#if show}}yes{{else}}no{{/if}}", { show: true });
    expect(result).toBe("yes");
  });

  it("direct: nested property access", async () => {
    const { templateRender } = await import("../src/pretool-extras.js");
    const result = templateRender("{{user.name}}", { user: { name: "Bob" } });
    expect(result).toBe("Bob");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. approval_request
// ═══════════════════════════════════════════════════════════════════════════════

describe("approval_request", () => {
  it("schema: accepts title, description, expires_hours", () => {
    fs.writeFileSync(path.join(tmpDir, "approval-request.yaml"), `
name: approval-request
steps:
  - id: approve
    pre_tools:
      - type: approval_request
        title: "Deploy to production"
        description: "Approve deployment of v2.0"
        expires_hours: 4
        inject_as: approval
    prompt: "Approval: {approval}"
    output_var: result
output: result
`);
    const chain = loadChain("approval-request");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.type).toBe("approval_request");
    expect(pt.title).toBe("Deploy to production");
    expect(pt.description).toBe("Approve deployment of v2.0");
    expect(pt.expires_hours).toBe(4);
  });

  it("direct: returns JSON with approve_url, reject_command, token, expires_at", async () => {
    const { createApprovalRequest } = await import("../src/pretool-extras.js");
    const raw = createApprovalRequest("exec-123", "step-1", "Deploy", "Deploy v2", 24);
    const parsed = JSON.parse(raw);

    expect(parsed.approve_url).toBeDefined();
    expect(parsed.approve_url).toContain("exec-123");
    expect(parsed.reject_command).toBeDefined();
    expect(parsed.reject_command).toContain("approved");
    expect(parsed.token).toBeDefined();
    expect(typeof parsed.token).toBe("string");
    expect(parsed.token.length).toBeGreaterThan(0);
    expect(parsed.expires_at).toBeDefined();
    // expires_at should be a valid ISO date in the future
    const expiresAt = new Date(parsed.expires_at);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
