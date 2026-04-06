/**
 * Tests for Tier 1 pre-tools.
 *
 * Covers:
 * - state_load / state_save: schema, linter, chaining
 * - vector_query / vector_index: schema, linter
 * - json_parse: schema, linter, direct function tests
 * - diff_inject: schema, linter
 * - notify: schema, linter
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanupTmpDirSync } from "./_test-utils.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadChain } from "../src/loader.js";
import { lintChain } from "../src/linter.js";
import { jsonParse } from "../src/pretool-extras.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-pretool-tier1-"));
  process.env.CHAINS_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.CHAINS_DIR;
  cleanupTmpDirSync(tmpDir);
});

// ─── state_load / state_save ───────────────────────────────────────────────

describe("state_load / state_save schema", () => {
  it("accepts key, value, scope, default fields on state_save", () => {
    fs.writeFileSync(path.join(tmpDir, "ss.yaml"), `
name: ss
steps:
  - id: s1
    pre_tools:
      - type: state_save
        key: "user_pref"
        value: "dark_mode"
        scope: "session"
        inject_as: save_result
    prompt: "{save_result}"
    output_var: result
output: result
`);
    const chain = loadChain("ss");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.type).toBe("state_save");
    expect(pt.key).toBe("user_pref");
    expect(pt.value).toBe("dark_mode");
    expect(pt.scope).toBe("session");
  });

  it("accepts key, scope, default fields on state_load", () => {
    fs.writeFileSync(path.join(tmpDir, "sl.yaml"), `
name: sl
steps:
  - id: s1
    pre_tools:
      - type: state_load
        key: "user_pref"
        scope: "session"
        default: "light_mode"
        inject_as: pref
    prompt: "{pref}"
    output_var: result
output: result
`);
    const chain = loadChain("sl");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.type).toBe("state_load");
    expect(pt.key).toBe("user_pref");
    expect(pt.scope).toBe("session");
    expect(pt.default).toBe("light_mode");
  });
});

describe("state_load / state_save linter", () => {
  it("reports error when key missing on state_load", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "state_load" as any, scope: "global", inject_as: "val" }],
        prompt: "{val}", output_var: "result", tools: [], depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter((i) =>
      i.level === "error" && i.message.includes("key")
    );
    expect(errors.length).toBe(1);
  });

  it("reports error when key missing on state_save", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "state_save" as any, value: "foo", inject_as: "r" }],
        prompt: "{r}", output_var: "result", tools: [], depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter((i) =>
      i.level === "error" && i.message.includes("key")
    );
    expect(errors.length).toBe(1);
  });

  it("reports error when value missing on state_save", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "state_save" as any, key: "k", inject_as: "r" }],
        prompt: "{r}", output_var: "result", tools: [], depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter((i) =>
      i.level === "error" && i.message.includes("value")
    );
    expect(errors.length).toBe(1);
  });
});

describe("state_save then state_load chaining", () => {
  it("validates a full chain that saves then loads state", () => {
    fs.writeFileSync(path.join(tmpDir, "state-chain.yaml"), `
name: state-chain
steps:
  - id: save
    pre_tools:
      - type: state_save
        key: "last_query"
        value: "hello world"
        scope: "chain"
        inject_as: save_ok
    prompt: "Saved: {save_ok}"
    output_var: save_result
  - id: load
    depends_on:
      - save
    pre_tools:
      - type: state_load
        key: "last_query"
        scope: "chain"
        default: "(none)"
        inject_as: loaded
    prompt: "Loaded: {loaded}"
    output_var: load_result
output: load_result
`);
    const chain = loadChain("state-chain");
    expect(chain.steps.length).toBe(2);
    const errors = lintChain(chain).filter((i) => i.level === "error");
    expect(errors.length).toBe(0);
  });
});

// ─── vector_query / vector_index ───────────────────────────────────────────

describe("vector_query / vector_index schema", () => {
  it("accepts collection, top_k on vector_query", () => {
    fs.writeFileSync(path.join(tmpDir, "vq.yaml"), `
name: vq
steps:
  - id: s1
    pre_tools:
      - type: vector_query
        collection: "docs"
        top_k: 5
        inject_as: results
    prompt: "{results}"
    output_var: result
output: result
`);
    const chain = loadChain("vq");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.type).toBe("vector_query");
    expect(pt.collection).toBe("docs");
    expect(pt.top_k).toBe(5);
  });

  it("accepts collection, source, chunk_size on vector_index", () => {
    fs.writeFileSync(path.join(tmpDir, "vi.yaml"), `
name: vi
steps:
  - id: s1
    pre_tools:
      - type: vector_index
        collection: "docs"
        source: "/tmp/data.txt"
        chunk_size: 512
        inject_as: index_result
    prompt: "{index_result}"
    output_var: result
output: result
`);
    const chain = loadChain("vi");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.type).toBe("vector_index");
    expect(pt.collection).toBe("docs");
    expect(pt.source).toBe("/tmp/data.txt");
    expect(pt.chunk_size).toBe(512);
  });
});

describe("vector_query / vector_index linter", () => {
  it("reports error when collection missing on vector_query", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "vector_query" as any, top_k: 3, inject_as: "r" }],
        prompt: "{r}", output_var: "result", tools: [], depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter((i) =>
      i.level === "error" && i.message.includes("collection")
    );
    expect(errors.length).toBe(1);
  });

  it("reports error when source missing on vector_index", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "vector_index" as any, collection: "docs", inject_as: "r" }],
        prompt: "{r}", output_var: "result", tools: [], depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter((i) =>
      i.level === "error" && i.message.includes("source")
    );
    expect(errors.length).toBe(1);
  });
});

// ─── json_parse ────────────────────────────────────────────────────────────

describe("json_parse schema", () => {
  it("accepts input and json_path fields", () => {
    fs.writeFileSync(path.join(tmpDir, "jp.yaml"), `
name: jp
steps:
  - id: s1
    pre_tools:
      - type: json_parse
        input: '{"status":"ok"}'
        json_path: "status"
        inject_as: parsed
    prompt: "{parsed}"
    output_var: result
output: result
`);
    const chain = loadChain("jp");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.type).toBe("json_parse");
    expect(pt.input).toBe('{"status":"ok"}');
    expect(pt.json_path).toBe("status");
  });
});

describe("json_parse linter", () => {
  it("reports error when input missing", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "json_parse" as any, json_path: "a.b", inject_as: "r" }],
        prompt: "{r}", output_var: "result", tools: [], depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter((i) =>
      i.level === "error" && i.message.includes("input")
    );
    expect(errors.length).toBe(1);
  });
});

describe("jsonParse direct function tests", () => {
  it("extracts value at simple path", () => {
    expect(jsonParse('{"a":{"b":1}}', "a.b")).toBe("1");
  });

  it("extracts value at array path", () => {
    expect(jsonParse('{"items":[{"name":"x"}]}', "items[0].name")).toBe("x");
  });

  it("extracts value from markdown-wrapped JSON", () => {
    expect(jsonParse('```json\n{"x":1}\n```', "x")).toBe("1");
  });
});

// ─── diff_inject ───────────────────────────────────────────────────────────

describe("diff_inject schema", () => {
  it("accepts repo, base, head, max_tokens fields", () => {
    fs.writeFileSync(path.join(tmpDir, "di.yaml"), `
name: di
steps:
  - id: s1
    pre_tools:
      - type: diff_inject
        repo: "/home/user/project"
        base: "main"
        head: "feature-branch"
        max_tokens: 4000
        inject_as: diff
    prompt: "Review: {diff}"
    output_var: result
output: result
`);
    const chain = loadChain("di");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.type).toBe("diff_inject");
    expect(pt.repo).toBe("/home/user/project");
    expect(pt.base).toBe("main");
    expect(pt.head).toBe("feature-branch");
    expect(pt.max_tokens).toBe(4000);
  });
});

describe("diff_inject linter", () => {
  it("reports error when repo missing", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "diff_inject" as any, base: "main", head: "dev", inject_as: "d" }],
        prompt: "{d}", output_var: "result", tools: [], depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter((i) =>
      i.level === "error" && i.message.includes("repo")
    );
    expect(errors.length).toBe(1);
  });
});

// ─── notify ────────────────────────────────────────────────────────────────

describe("notify schema", () => {
  it("accepts channel, webhook_url, message fields", () => {
    fs.writeFileSync(path.join(tmpDir, "nt.yaml"), `
name: nt
steps:
  - id: s1
    pre_tools:
      - type: notify
        channel: "slack"
        webhook_url: "https://hooks.slack.com/services/XXX"
        message: "Chain completed"
        inject_as: notify_result
    prompt: "{notify_result}"
    output_var: result
output: result
`);
    const chain = loadChain("nt");
    const pt = (chain.steps[0] as any).pre_tools[0];
    expect(pt.type).toBe("notify");
    expect(pt.channel).toBe("slack");
    expect(pt.webhook_url).toBe("https://hooks.slack.com/services/XXX");
    expect(pt.message).toBe("Chain completed");
  });
});

describe("notify linter", () => {
  it("reports error when channel missing", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "notify" as any, message: "hello", webhook_url: "https://x.com", inject_as: "r" }],
        prompt: "{r}", output_var: "result", tools: [], depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter((i) =>
      i.level === "error" && i.message.includes("channel")
    );
    expect(errors.length).toBe(1);
  });

  it("reports error when message missing", () => {
    const chain = {
      name: "test",
      steps: [{
        id: "s1",
        pre_tools: [{ type: "notify" as any, channel: "slack", webhook_url: "https://x.com", inject_as: "r" }],
        prompt: "{r}", output_var: "result", tools: [], depends_on: [],
      }],
      output: "result",
    };
    const errors = lintChain(chain as any).filter((i) =>
      i.level === "error" && i.message.includes("message")
    );
    expect(errors.length).toBe(1);
  });
});
