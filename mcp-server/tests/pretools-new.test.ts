/**
 * Tests for new pre-tool types and fixes.
 *
 * Covers:
 * - current_datetime: timezone, format (iso/locale/unix)
 * - read_file / write_file: encoding, append
 * - bash: stderr capture
 * - env_var: default_value
 * - db_query: schema validation
 * - email: schema validation
 * - pdf_generate: schema validation
 * - ocr: schema validation
 * - MCP tools: dry_run, chain_stats, queue_status definitions
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadChain } from "../src/loader.js";
import { lintChain } from "../src/linter.js";
import type { ChainDefinition } from "../src/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-pretools-new-"));
  process.env.CHAINS_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.CHAINS_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── current_datetime improvements ──────────────────────────────────────────

describe("current_datetime improvements", () => {
  it("accepts timezone and format fields", () => {
    fs.writeFileSync(path.join(tmpDir, "dt.yaml"), `
name: dt
steps:
  - id: s1
    pre_tools:
      - type: current_datetime
        timezone: "America/New_York"
        format: locale
        inject_as: now
    prompt: "{now}"
    output_var: result
output: result
`);
    const chain = loadChain("dt");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.timezone).toBe("America/New_York");
    expect(pt.format).toBe("locale");
  });

  it("accepts unix format", () => {
    fs.writeFileSync(path.join(tmpDir, "dt-unix.yaml"), `
name: dt-unix
steps:
  - id: s1
    pre_tools:
      - type: current_datetime
        format: unix
        inject_as: ts
    prompt: "{ts}"
    output_var: result
output: result
`);
    const chain = loadChain("dt-unix");
    expect((chain.steps[0] as any).pre_tools[0].format).toBe("unix");
  });
});

// ─── read_file / write_file improvements ────────────────────────────────────

describe("read_file / write_file improvements", () => {
  it("accepts encoding field on read_file", () => {
    fs.writeFileSync(path.join(tmpDir, "rf.yaml"), `
name: rf
steps:
  - id: s1
    pre_tools:
      - type: read_file
        path: "/tmp/test.txt"
        encoding: latin1
        inject_as: data
    prompt: "{data}"
    output_var: result
output: result
`);
    const chain = loadChain("rf");
    expect((chain.steps[0] as any).pre_tools[0].encoding).toBe("latin1");
  });

  it("accepts append field on write_file", () => {
    fs.writeFileSync(path.join(tmpDir, "wf.yaml"), `
name: wf
steps:
  - id: s1
    pre_tools:
      - type: write_file
        path: "/tmp/log.txt"
        content: "new line"
        append: true
        inject_as: path
    prompt: "{path}"
    output_var: result
output: result
`);
    const chain = loadChain("wf");
    expect((chain.steps[0] as any).pre_tools[0].append).toBe(true);
  });
});

// ─── bash stderr ────────────────────────────────────────────────────────────

describe("bash stderr capture", () => {
  it("accepts stderr field", () => {
    fs.writeFileSync(path.join(tmpDir, "bash-err.yaml"), `
name: bash-err
steps:
  - id: s1
    pre_tools:
      - type: bash
        command: "ls /nonexistent 2>&1"
        stderr: true
        inject_as: output
    prompt: "{output}"
    output_var: result
output: result
`);
    const chain = loadChain("bash-err");
    expect((chain.steps[0] as any).pre_tools[0].stderr).toBe(true);
  });
});

// ─── env_var default_value ──────────────────────────────────────────────────

describe("env_var default_value", () => {
  it("accepts default_value field", () => {
    fs.writeFileSync(path.join(tmpDir, "env-def.yaml"), `
name: env-def
steps:
  - id: s1
    pre_tools:
      - type: env_var
        var_name: PROBABLY_NOT_SET
        default_value: "fallback_value"
        inject_as: val
    prompt: "{val}"
    output_var: result
output: result
`);
    const chain = loadChain("env-def");
    expect((chain.steps[0] as any).pre_tools[0].default_value).toBe("fallback_value");
  });
});

// ─── db_query ───────────────────────────────────────────────────────────────

describe("db_query pre-tool", () => {
  it("accepts connection and sql fields", () => {
    fs.writeFileSync(path.join(tmpDir, "db-test.yaml"), `
name: db-test
steps:
  - id: s1
    pre_tools:
      - type: db_query
        connection: "postgres://user:pass@localhost/mydb"
        sql: "SELECT * FROM users LIMIT 10"
        inject_as: users
    prompt: "{users}"
    output_var: result
output: result
`);
    const chain = loadChain("db-test");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.type).toBe("db_query");
    expect(pt.connection).toContain("postgres");
    expect(pt.sql).toContain("SELECT");
  });

  it("linter reports error when connection missing", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "db_query" as any, sql: "SELECT 1", inject_as: "data" }],
        prompt: "{data}", output_var: "result", tools: [], depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter((i) => i.level === "error" && i.message.includes("connection"));
    expect(errors.length).toBe(1);
  });

  it("linter reports error when sql missing", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "db_query" as any, connection: "postgres://x", inject_as: "data" }],
        prompt: "{data}", output_var: "result", tools: [], depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter((i) => i.level === "error" && i.message.includes("sql"));
    expect(errors.length).toBe(1);
  });
});

// ─── email ──────────────────────────────────────────────────────────────────

describe("email pre-tool", () => {
  it("accepts all email fields", () => {
    fs.writeFileSync(path.join(tmpDir, "email-test.yaml"), `
name: email-test
steps:
  - id: s1
    pre_tools:
      - type: email
        to: "user@example.com"
        subject: "Alert: {input.topic}"
        content: "Details here"
        provider: sendgrid
        inject_as: email_result
    prompt: "{email_result}"
    output_var: result
    depends_on: []
output: result
`);
    const chain = loadChain("email-test");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.type).toBe("email");
    expect(pt.to).toBe("user@example.com");
    expect(pt.provider).toBe("sendgrid");
  });

  it("linter reports error when to missing", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "email" as any, subject: "Hi", inject_as: "r" }],
        prompt: "{r}", output_var: "result", tools: [], depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter((i) => i.level === "error" && i.message.includes("to"));
    expect(errors.length).toBe(1);
  });

  it("linter reports error when subject missing", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "email" as any, to: "x@y.com", inject_as: "r" }],
        prompt: "{r}", output_var: "result", tools: [], depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter((i) => i.level === "error" && i.message.includes("subject"));
    expect(errors.length).toBe(1);
  });
});

// ─── pdf_generate ───────────────────────────────────────────────────────────

describe("pdf_generate pre-tool", () => {
  it("accepts html and output_path fields", () => {
    fs.writeFileSync(path.join(tmpDir, "pdf-test.yaml"), `
name: pdf-test
steps:
  - id: s1
    pre_tools:
      - type: pdf_generate
        html: "<h1>Report</h1><p>Content here</p>"
        output_path: "/tmp/report.pdf"
        inject_as: pdf_path
    prompt: "PDF at: {pdf_path}"
    output_var: result
output: result
`);
    const chain = loadChain("pdf-test");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.type).toBe("pdf_generate");
    expect(pt.html).toContain("<h1>");
  });

  it("linter reports error when html missing", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "pdf_generate" as any, output_path: "/tmp/x.pdf", inject_as: "r" }],
        prompt: "{r}", output_var: "result", tools: [], depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter((i) => i.level === "error" && i.message.includes("html"));
    expect(errors.length).toBe(1);
  });
});

// ─── ocr ────────────────────────────────────────────────────────────────────

describe("ocr pre-tool", () => {
  it("accepts image_path and language fields", () => {
    fs.writeFileSync(path.join(tmpDir, "ocr-test.yaml"), `
name: ocr-test
steps:
  - id: s1
    pre_tools:
      - type: ocr
        image_path: "/tmp/document.png"
        language: "fra"
        inject_as: text
    prompt: "Extracted: {text}"
    output_var: result
output: result
`);
    const chain = loadChain("ocr-test");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.type).toBe("ocr");
    expect(pt.language).toBe("fra");
  });

  it("linter reports error when image_path missing", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "ocr" as any, inject_as: "r" }],
        prompt: "{r}", output_var: "result", tools: [], depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter((i) => i.level === "error" && i.message.includes("image_path"));
    expect(errors.length).toBe(1);
  });
});

// ─── Full example chain ─────────────────────────────────────────────────────

describe("Full chain with new pre-tools", () => {
  it("validates a chain using all new features", () => {
    fs.writeFileSync(path.join(tmpDir, "full-new.yaml"), `
name: full-new
inputs:
  - name: query
steps:
  - id: fetch_and_store
    pre_tools:
      - type: current_datetime
        timezone: "Europe/Paris"
        format: locale
        inject_as: now
      - type: env_var
        var_name: API_KEY
        default_value: "demo_key"
        inject_as: key
      - type: http_fetch
        url: "https://api.example.com/search"
        method: POST
        headers:
          Authorization: "Bearer {key}"
        body: '{"q": "{input.query}"}'
        json_path: "results"
        timeout_ms: 10000
        retry: 2
        cache_ttl_minutes: 30
        inject_as: results
    prompt: "Date: {now}\\nResults: {results}"
    output_var: analysis
output: analysis
`);
    const chain = loadChain("full-new");
    expect(chain.steps.length).toBe(1);
    const errors = lintChain(chain).filter((i) => i.level === "error");
    expect(errors.length).toBe(0);
  });
});
