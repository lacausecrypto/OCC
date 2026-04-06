/**
 * Tests for the upgraded pre-tool system.
 *
 * Covers:
 * - http_fetch advanced (method, headers, body, json_path, timeout)
 * - Pre-tool chaining (output of A → input of B)
 * - Pre-tool caching (TTL)
 * - Parallel pre-tool execution
 * - Per-pre-tool retry
 * - Linter validation for new fields
 * - Schema validation for new fields
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { cleanupTmpDirSync } from "./_test-utils.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { loadChain } from "../src/loader.js";
import { lintChain } from "../src/linter.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-pretools-test-"));
  process.env.CHAINS_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.CHAINS_DIR;
  cleanupTmpDirSync(tmpDir);
});

// ─── http_fetch advanced schema ─────────────────────────────────────────────

describe("http_fetch advanced schema", () => {
  it("accepts method, headers, body fields", () => {
    fs.writeFileSync(path.join(tmpDir, "fetch-adv.yaml"), `
name: fetch-adv
steps:
  - id: s1
    pre_tools:
      - type: http_fetch
        url: "https://api.example.com/data"
        method: POST
        headers:
          Authorization: "Bearer token123"
          Content-Type: "application/json"
        body: '{"query": "test"}'
        inject_as: api_data
    prompt: "{api_data}"
    output_var: result
output: result
`);
    const chain = loadChain("fetch-adv");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.method).toBe("POST");
    expect(pt.headers?.Authorization).toBe("Bearer token123");
    expect(pt.body).toBe('{"query": "test"}');
  });

  it("accepts json_path for response extraction", () => {
    fs.writeFileSync(path.join(tmpDir, "fetch-jp.yaml"), `
name: fetch-jp
steps:
  - id: s1
    pre_tools:
      - type: http_fetch
        url: "https://api.example.com/users"
        json_path: "data.items[0].name"
        inject_as: first_user
    prompt: "{first_user}"
    output_var: result
output: result
`);
    const chain = loadChain("fetch-jp");
    expect((chain.steps[0] as any).pre_tools[0].json_path).toBe("data.items[0].name");
  });

  it("accepts all HTTP methods", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      fs.writeFileSync(path.join(tmpDir, `fetch-${method.toLowerCase()}.yaml`), `
name: fetch-${method.toLowerCase()}
steps:
  - id: s1
    pre_tools:
      - type: http_fetch
        url: "https://example.com"
        method: ${method}
        inject_as: data
    prompt: "{data}"
    output_var: result
output: result
`);
      const chain = loadChain(`fetch-${method.toLowerCase()}`);
      expect((chain.steps[0] as any).pre_tools[0].method).toBe(method);
    }
  });
});

// ─── Pre-tool timeout and retry schema ──────────────────────────────────────

describe("Pre-tool timeout and retry", () => {
  it("accepts timeout_ms and retry fields", () => {
    fs.writeFileSync(path.join(tmpDir, "pt-retry.yaml"), `
name: pt-retry
steps:
  - id: s1
    pre_tools:
      - type: http_fetch
        url: "https://api.example.com"
        timeout_ms: 5000
        retry: 3
        on_error: fail
        inject_as: data
    prompt: "{data}"
    output_var: result
output: result
`);
    const chain = loadChain("pt-retry");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.timeout_ms).toBe(5000);
    expect(pt.retry).toBe(3);
    expect(pt.on_error).toBe("fail");
  });
});

// ─── Pre-tool caching schema ────────────────────────────────────────────────

describe("Pre-tool caching", () => {
  it("accepts cache_ttl_minutes field", () => {
    fs.writeFileSync(path.join(tmpDir, "pt-cache.yaml"), `
name: pt-cache
steps:
  - id: s1
    pre_tools:
      - type: http_fetch
        url: "https://api.example.com/expensive"
        cache_ttl_minutes: 60
        inject_as: cached_data
    prompt: "{cached_data}"
    output_var: result
output: result
`);
    const chain = loadChain("pt-cache");
    expect((chain.steps[0] as any).pre_tools[0].cache_ttl_minutes).toBe(60);
  });
});

// ─── Parallel pre-tools schema ──────────────────────────────────────────────

describe("Parallel pre-tools", () => {
  it("accepts parallel field", () => {
    fs.writeFileSync(path.join(tmpDir, "pt-parallel.yaml"), `
name: pt-parallel
steps:
  - id: s1
    pre_tools:
      - type: http_fetch
        url: "https://api1.example.com"
        parallel: true
        inject_as: data1
      - type: http_fetch
        url: "https://api2.example.com"
        parallel: true
        inject_as: data2
      - type: bash
        command: "echo combined"
        inject_as: combined
    prompt: "{data1} {data2} {combined}"
    output_var: result
output: result
`);
    const chain = loadChain("pt-parallel");
    const pts = (chain.steps[0] as any).pre_tools;
    expect(pts[0].parallel).toBe(true);
    expect(pts[1].parallel).toBe(true);
    expect(pts[2].parallel).toBeUndefined(); // sequential by default
  });
});

// ─── Pre-tool chaining schema ───────────────────────────────────────────────

describe("Pre-tool chaining", () => {
  it("validates chain where pre-tool B references pre-tool A output", () => {
    fs.writeFileSync(path.join(tmpDir, "pt-chain.yaml"), `
name: pt-chain
steps:
  - id: s1
    pre_tools:
      - type: env_var
        var_name: API_TOKEN
        inject_as: token
      - type: http_fetch
        url: "https://api.example.com/data"
        headers:
          Authorization: "Bearer {token}"
        inject_as: api_data
    prompt: "{api_data}"
    output_var: result
output: result
`);
    const chain = loadChain("pt-chain");
    const pts = (chain.steps[0] as any).pre_tools;
    expect(pts[0].inject_as).toBe("token");
    expect(pts[1].headers?.Authorization).toBe("Bearer {token}");

    // Linter should not warn about {token} being undefined (it's injected by pre-tool A)
    const warnings = lintChain(chain).filter((i) =>
      i.level === "warning" && i.message.includes("token")
    );
    expect(warnings.length).toBe(0);
  });
});

// ─── Linter validation for new fields ───────────────────────────────────────

describe("Linter: new pre-tool validations", () => {
  it("warns on invalid http_fetch URL", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{
          type: "http_fetch" as any,
          url: "not-a-valid-url",
          inject_as: "data",
        }],
        prompt: "{data}",
        output_var: "result",
        tools: [],
        depends_on: [],
      }],
      output: "result",
    };
    const warnings = lintChain(chain as any).filter((i) =>
      i.level === "warning" && i.message.includes("URL")
    );
    expect(warnings.length).toBe(1);
  });

  it("warns on body with GET method", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{
          type: "http_fetch" as any,
          url: "https://example.com",
          method: "GET",
          body: '{"data": "test"}',
          inject_as: "data",
        }],
        prompt: "{data}",
        output_var: "result",
        tools: [],
        depends_on: [],
      }],
      output: "result",
    };
    const warnings = lintChain(chain as any).filter((i) =>
      i.level === "warning" && i.message.includes("body ignored")
    );
    expect(warnings.length).toBe(1);
  });

  it("tracks variable references in headers", () => {
    const chain = {
      name: "test",
      inputs: [{ name: "api_key", optional: false, description: "" }],
      steps: [{
        id: "s1",
        pre_tools: [{
          type: "http_fetch" as any,
          url: "https://example.com",
          headers: { Authorization: "Bearer {input.api_key}" },
          inject_as: "data",
        }],
        prompt: "{data}",
        output_var: "result",
        tools: [],
        depends_on: [],
      }],
      output: "result",
    };
    // api_key should not be reported as unused
    const infos = lintChain(chain as any).filter((i) =>
      i.level === "info" && i.message.includes("api_key")
    );
    expect(infos.length).toBe(0);
  });
});

// ─── Full example chains ────────────────────────────────────────────────────

describe("Full pre-tool chain examples", () => {
  it("validates authenticated API chain with chaining", () => {
    fs.writeFileSync(path.join(tmpDir, "auth-api.yaml"), `
name: auth-api
description: "Fetch data from authenticated API"
inputs:
  - name: query
steps:
  - id: fetch
    pre_tools:
      - type: env_var
        var_name: API_TOKEN
        inject_as: token
      - type: http_fetch
        url: "https://api.example.com/search"
        method: POST
        headers:
          Authorization: "Bearer {token}"
          Content-Type: "application/json"
        body: '{"q": "{input.query}", "limit": 10}'
        json_path: "results"
        timeout_ms: 10000
        retry: 2
        on_error: fail
        inject_as: search_results
    prompt: "Analyze: {search_results}"
    output_var: analysis
output: analysis
`);
    const chain = loadChain("auth-api");
    expect(chain.steps.length).toBe(1);
    const errors = lintChain(chain).filter((i) => i.level === "error");
    expect(errors.length).toBe(0);
  });

  it("validates parallel data fetching chain", () => {
    fs.writeFileSync(path.join(tmpDir, "parallel-fetch.yaml"), `
name: parallel-fetch
inputs:
  - name: topic
steps:
  - id: gather
    pre_tools:
      - type: web_search
        query: "{input.topic} news"
        parallel: true
        inject_as: news
      - type: http_fetch
        url: "https://api.example.com/data"
        parallel: true
        cache_ttl_minutes: 30
        inject_as: api_data
      - type: current_datetime
        parallel: true
        inject_as: now
    prompt: "Date: {now}\\nNews: {news}\\nData: {api_data}\\nAnalyze {input.topic}"
    output_var: analysis
output: analysis
`);
    const chain = loadChain("parallel-fetch");
    const pts = (chain.steps[0] as any).pre_tools;
    expect(pts.every((p: any) => p.parallel === true)).toBe(true);
    const errors = lintChain(chain).filter((i) => i.level === "error");
    expect(errors.length).toBe(0);
  });
});
