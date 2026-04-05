import { describe, it, expect } from "vitest";
import { canvasToYaml } from "../../src/utils/canvasToYaml";
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
