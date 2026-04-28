import { describe, it, expect } from "vitest";
import { canvasToYaml, detectInputs } from "../../src/utils/canvasToYaml";
import type { CanvasNode, CanvasEdge } from "../../src/types/canvas";

function makeNode(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, x: 0, y: 0, w: 200, h: 100,
    type: "agent", label: id,
    preTools: [], tools: [],
    outputVar: `${id}_out`, stepId: id,
    prompt: "do the thing",
    ...overrides,
  };
}

describe("canvasToYaml", () => {
  it("returns empty string for empty nodes", () => {
    expect(canvasToYaml(new Map(), new Map(), "test")).toBe("");
  });

  it("generates valid YAML with name and version", () => {
    const nodes = new Map([["n1", makeNode("n1")]]);
    const yaml = canvasToYaml(nodes, new Map(), "my-chain");
    expect(yaml).toContain("name: my-chain");
    expect(yaml).toContain("version:");
    expect(yaml).toContain("steps:");
  });

  it("includes description when provided", () => {
    const nodes = new Map([["n1", makeNode("n1")]]);
    const yaml = canvasToYaml(nodes, new Map(), "test", "A description");
    expect(yaml).toContain("description: A description");
  });

  it("serializes step id, type, and prompt", () => {
    const nodes = new Map([["n1", makeNode("n1", { type: "router", prompt: "Route it" })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("id: n1");
    expect(yaml).toContain("type: router");
    expect(yaml).toContain("prompt: Route it");
  });

  it("serializes multi-line prompts with | syntax", () => {
    const nodes = new Map([["n1", makeNode("n1", { prompt: "line 1\nline 2\nline 3" })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("prompt: |");
    expect(yaml).toContain("      line 1");
    expect(yaml).toContain("      line 2");
  });

  it("serializes tools array", () => {
    const nodes = new Map([["n1", makeNode("n1", { tools: ["Read", "Write"] })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("tools: [Read, Write]");
  });

  it("serializes pre-tools", () => {
    const nodes = new Map([["n1", makeNode("n1", {
      preTools: [{ type: "web_search", inject_as: "results", query: "test query" }],
    })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("pre_tools:");
    expect(yaml).toContain("type: web_search");
    expect(yaml).toContain("inject_as: results");
  });

  it("serializes edges as depends_on", () => {
    const nodes = new Map([
      ["n1", makeNode("n1")],
      ["n2", makeNode("n2")],
    ]);
    const edges = new Map<string, CanvasEdge>([
      ["e1", { id: "e1", from: "n1", to: "n2" }],
    ]);
    const yaml = canvasToYaml(nodes, edges, "test");
    expect(yaml).toContain("depends_on: [n1]");
  });

  it("serializes output_var", () => {
    const nodes = new Map([["n1", makeNode("n1", { outputVar: "final_result" })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("output_var: final_result");
    expect(yaml).toContain("output: final_result");
  });

  it("detects {input.*} patterns as inputs", () => {
    const nodes = new Map([
      ["n1", makeNode("n1", { prompt: "Research {input.topic} in depth about {input.focus}" })],
    ]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("inputs:");
    expect(yaml).toContain("name: focus");
    expect(yaml).toContain("name: topic");
  });

  it("handles model field", () => {
    const nodes = new Map([["n1", makeNode("n1", { model: "claude-sonnet-4-6" })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("model: claude-sonnet-4-6");
  });

  it("serializes label when different from id", () => {
    const nodes = new Map([["n1", makeNode("n1", { label: "Step One", stepId: "n1" })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("label: Step One");
  });

  it("topologically sorts nodes (respects dependency order)", () => {
    const nodes = new Map([
      ["n2", makeNode("n2")],
      ["n1", makeNode("n1")],
    ]);
    const edges = new Map<string, CanvasEdge>([
      ["e1", { id: "e1", from: "n1", to: "n2" }],
    ]);
    const yaml = canvasToYaml(nodes, edges, "test");
    const n1Pos = yaml.indexOf("id: n1");
    const n2Pos = yaml.indexOf("id: n2");
    expect(n1Pos).toBeLessThan(n2Pos);
  });

  it("serializes retry config", () => {
    const nodes = new Map([["n1", makeNode("n1", {
      advanced: { retry: { max: 3, delay_ms: 2000, backoff: 2 } },
    })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("retry:");
    expect(yaml).toContain("max: 3");
    expect(yaml).toContain("delay_ms: 2000");
  });

  it("serializes cache config", () => {
    const nodes = new Map([["n1", makeNode("n1", {
      advanced: { cache: { enabled: true, ttl_minutes: 60 } },
    })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("cache:");
    expect(yaml).toContain("enabled: true");
    expect(yaml).toContain("ttl_minutes: 60");
  });

  it("serializes a full chain with 3 connected steps", () => {
    const nodes = new Map([
      ["s1", makeNode("s1", { label: "Research", prompt: "Research {input.topic}", model: "claude-sonnet-4-6", tools: ["WebSearch"] })],
      ["s2", makeNode("s2", { label: "Analyze", prompt: "Analyze {s1_out}" })],
      ["s3", makeNode("s3", { label: "Report", prompt: "Write report", outputVar: "final_report" })],
    ]);
    const edges = new Map<string, CanvasEdge>([
      ["e1", { id: "e1", from: "s1", to: "s2" }],
      ["e2", { id: "e2", from: "s2", to: "s3" }],
    ]);
    const yaml = canvasToYaml(nodes, edges, "deep-research", "Multi-step research");
    expect(yaml).toContain("name: deep-research");
    expect(yaml).toContain("description: Multi-step research");
    expect(yaml).toContain("inputs:");
    expect(yaml).toContain("name: topic");
    expect(yaml).toContain("output: final_report");
    // All 3 steps present
    expect(yaml).toContain("id: s1");
    expect(yaml).toContain("id: s2");
    expect(yaml).toContain("id: s3");
  });

  it("handles special characters in YAML values", () => {
    const nodes = new Map([["n1", makeNode("n1", { prompt: 'Say "hello" & goodbye: now' })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    // Should be quoted
    expect(yaml).toContain('"');
  });
});

describe("detectInputs", () => {
  it("returns empty list when no {input} references exist", () => {
    const nodes = new Map([["n1", makeNode("n1", { prompt: "do the thing" })]]);
    expect(detectInputs(nodes)).toEqual([]);
  });

  it("extracts named inputs from {input.X} patterns", () => {
    const nodes = new Map([
      ["n1", makeNode("n1", { prompt: "Research {input.topic} on {input.source}" })],
    ]);
    const out = detectInputs(nodes);
    expect(out.map((i) => i.name).sort()).toEqual(["source", "topic"]);
  });

  it("dedupes inputs across multiple steps", () => {
    const nodes = new Map([
      ["a", makeNode("a", { prompt: "use {input.topic}" })],
      ["b", makeNode("b", { prompt: "summarize {input.topic} please" })],
    ]);
    const out = detectInputs(nodes);
    expect(out.length).toBe(1);
    expect(out[0].name).toBe("topic");
  });

  it("returns inputs sorted alphabetically", () => {
    const nodes = new Map([
      ["n1", makeNode("n1", { prompt: "{input.zebra} {input.apple} {input.mango}" })],
    ]);
    const out = detectInputs(nodes);
    expect(out.map((i) => i.name)).toEqual(["apple", "mango", "zebra"]);
  });

  it("treats bare {input} as a single text-typed field named 'input'", () => {
    const nodes = new Map([["n1", makeNode("n1", { prompt: "Process this: {input}" })]]);
    const out = detectInputs(nodes);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("input");
    expect(out[0].type).toBe("text");
    expect(out[0].description).toMatch(/free-form/i);
  });

  it("ignores bare {input} when named {input.X} is also present", () => {
    const nodes = new Map([
      ["n1", makeNode("n1", { prompt: "{input.topic} and {input}" })],
    ]);
    const out = detectInputs(nodes);
    // Only the named one is preserved; bare {input} is the fallback for the
    // case where NO named refs exist at all.
    expect(out.map((i) => i.name)).toEqual(["topic"]);
  });

  it("ignores non-step canvas items (sticky/portal/etc)", () => {
    const nodes = new Map([
      ["s", makeNode("s", { kind: "sticky", stickyText: "{input.shouldNotMatter}" })],
      ["t", makeNode("t", { prompt: "{input.real}" })],
    ]);
    const out = detectInputs(nodes);
    expect(out.map((i) => i.name)).toEqual(["real"]);
  });

  it.each([
    ["image", "image"],
    ["photo", "image"],
    ["screenshot", "image"],
    ["file", "file"],
    ["document", "file"],
    ["pdf", "file"],
    ["url", "url"],
    ["link", "url"],
    ["website", "url"],
    ["code", "text"],
    ["snippet", "text"],
    ["json", "json"],
    ["payload", "json"],
    ["count", "number"],
    ["depth", "number"],
    ["limit", "number"],
    ["enabled", "boolean"],
    ["verbose", "boolean"],
    ["topic", "string"],
    ["query", "string"],
    ["prompt", "text"],
    ["description", "text"],
    ["body", "text"],
  ])("infers type for {input.%s} as %s", (name, expectedType) => {
    const nodes = new Map([["n1", makeNode("n1", { prompt: `Use {input.${name}} now` })]]);
    const out = detectInputs(nodes);
    expect(out[0].type).toBe(expectedType);
  });

  it("falls back to type 'string' for unknown names", () => {
    const nodes = new Map([["n1", makeNode("n1", { prompt: "{input.foobar}" })]]);
    const out = detectInputs(nodes);
    expect(out[0].type).toBe("string");
  });
});

describe("canvasToYaml inputs section", () => {
  it("emits inputs with name, description and type when non-string", () => {
    const nodes = new Map([
      ["n1", makeNode("n1", { prompt: "fetch {input.url} and process {input.topic}" })],
    ]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("inputs:");
    expect(yaml).toContain("name: topic");
    expect(yaml).toContain("name: url");
    // url is non-string → type emitted
    expect(yaml).toMatch(/name: url[\s\S]*type: url/);
    // topic is string → type omitted (default)
    const topicBlock = yaml.match(/name: topic[\s\S]*?(?=- name:|steps:|$)/)?.[0] ?? "";
    expect(topicBlock).not.toMatch(/type:/);
  });

  it("emits a synthetic 'input' field for chains using bare {input}", () => {
    const nodes = new Map([["n1", makeNode("n1", { prompt: "Analyze: {input}" })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("inputs:");
    expect(yaml).toContain("name: input");
    expect(yaml).toMatch(/name: input[\s\S]*type: text/);
  });

  it("does not emit inputs section when no {input} references exist", () => {
    const nodes = new Map([["n1", makeNode("n1", { prompt: "no placeholders here" })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).not.toContain("inputs:");
  });
});

describe("canvasToYaml — tools serialization", () => {
  it("omits tools section entirely when array is empty", () => {
    const nodes = new Map([["n1", makeNode("n1", { tools: [] })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).not.toContain("tools:");
  });

  it("emits a single tool inline", () => {
    const nodes = new Map([["n1", makeNode("n1", { tools: ["Read"] })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("tools: [Read]");
  });

  it("preserves tool order across many tools", () => {
    const tools = ["WebSearch", "Read", "Bash", "Glob", "Grep", "Edit"];
    const nodes = new Map([["n1", makeNode("n1", { tools })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain(`tools: [${tools.join(", ")}]`);
  });

  it("does not collapse duplicate tools (mirrors user intent — fixing dupes is the editor's job)", () => {
    const nodes = new Map([["n1", makeNode("n1", { tools: ["Read", "Read"] })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("tools: [Read, Read]");
  });
});

describe("canvasToYaml — pre-tools serialization", () => {
  it("omits pre_tools when array is empty", () => {
    const nodes = new Map([["n1", makeNode("n1", { preTools: [] })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).not.toContain("pre_tools:");
  });

  it("emits a minimal web_search pre-tool", () => {
    const nodes = new Map([["n1", makeNode("n1", {
      preTools: [{ type: "web_search", inject_as: "results", query: "claude code" }],
    })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("pre_tools:");
    expect(yaml).toContain("- type: web_search");
    expect(yaml).toContain("inject_as: results");
    expect(yaml).toContain("query: ");
    expect(yaml).toContain("claude code");
  });

  it("emits an http_fetch with method/headers/body via the generic field loop", () => {
    const nodes = new Map([["n1", makeNode("n1", {
      preTools: [{
        type: "http_fetch", inject_as: "page",
        url: "https://example.com",
        method: "POST",
        body: '{"x":1}',
      }],
    })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("- type: http_fetch");
    expect(yaml).toContain("inject_as: page");
    expect(yaml).toMatch(/url:\s*"?https:\/\/example\.com"?/);
    expect(yaml).toContain("method: POST");
    expect(yaml).toContain("body:");
  });

  it("emits resilience knobs (timeout_ms, retry, cache_ttl_minutes, on_error, parallel)", () => {
    const nodes = new Map([["n1", makeNode("n1", {
      preTools: [{
        type: "web_search",
        inject_as: "r",
        query: "x",
        timeout_ms: 8000,
        retry: 3,
        cache_ttl_minutes: 15,
        on_error: "skip",
        parallel: true,
      }],
    })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("timeout_ms: 8000");
    expect(yaml).toContain("retry: 3");
    expect(yaml).toContain("cache_ttl_minutes: 15");
    expect(yaml).toContain("on_error: skip");
    expect(yaml).toContain("parallel: true");
  });

  it("does not emit parallel when it is false", () => {
    const nodes = new Map([["n1", makeNode("n1", {
      preTools: [{ type: "web_search", inject_as: "r", query: "x", parallel: false }],
    })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).not.toContain("parallel:");
  });

  it("skips empty / null / undefined / object-typed param values silently", () => {
    const nodes = new Map([["n1", makeNode("n1", {
      preTools: [{
        type: "http_fetch",
        inject_as: "page",
        url: "https://example.com",
        body: "",                                   // empty → skip
        json_path: undefined,                       // undefined → skip
        // @ts-expect-error — testing runtime guard for null values
        method: null,
        // Object-typed params (headers) are not flattened by the generic loop.
        headers: { "x-foo": "bar" },
      }],
    })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).not.toContain("body:");
    expect(yaml).not.toContain("json_path:");
    expect(yaml).not.toContain("method:");
    expect(yaml).not.toContain("x-foo");
  });

  it("emits multiple pre-tools in declared order", () => {
    const nodes = new Map([["n1", makeNode("n1", {
      preTools: [
        { type: "web_search", inject_as: "a", query: "first" },
        { type: "http_fetch", inject_as: "b", url: "https://x" },
        { type: "bash", inject_as: "c", command: "ls" },
      ],
    })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    const aPos = yaml.indexOf("inject_as: a");
    const bPos = yaml.indexOf("inject_as: b");
    const cPos = yaml.indexOf("inject_as: c");
    expect(aPos).toBeGreaterThan(0);
    expect(bPos).toBeGreaterThan(aPos);
    expect(cPos).toBeGreaterThan(bPos);
  });

  it("quotes inject_as values containing yaml special chars", () => {
    const nodes = new Map([["n1", makeNode("n1", {
      preTools: [{ type: "web_search", inject_as: "with: colon", query: "x" }],
    })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    // yamlStr will quote-wrap the colon-containing inject_as
    expect(yaml).toMatch(/inject_as:\s*"with: colon"/);
  });

  it("co-exists with tools in the same step", () => {
    const nodes = new Map([["n1", makeNode("n1", {
      tools: ["WebFetch"],
      preTools: [{ type: "web_search", inject_as: "q", query: "x" }],
    })]]);
    const yaml = canvasToYaml(nodes, new Map(), "test");
    expect(yaml).toContain("tools: [WebFetch]");
    expect(yaml).toContain("- type: web_search");
    // Tools always come before pre_tools in the emitted block
    const toolsPos = yaml.indexOf("tools: [WebFetch]");
    const preToolsPos = yaml.indexOf("pre_tools:");
    expect(toolsPos).toBeLessThan(preToolsPos);
  });
});

