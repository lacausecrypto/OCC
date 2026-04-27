import { describe, it, expect } from "vitest";
import {
  getConnectedCanvasNodes,
  formatNodeForLLM,
  buildConnectedContext,
} from "../../src/utils/canvasContext";
import type { CanvasNode, CanvasEdge } from "../../src/types/canvas";

function makeNode(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, x: 0, y: 0, w: 200, h: 100,
    type: "agent", label: id,
    preTools: [], tools: [],
    outputVar: `${id}_out`, stepId: id,
    prompt: "",
    kind: "step",
    ...overrides,
  };
}

function edge(id: string, from: string, to: string): CanvasEdge {
  return { id, from, to };
}

describe("getConnectedCanvasNodes", () => {
  it("returns empty arrays when no edges touch the node", () => {
    const nodes = new Map([["a", makeNode("a")], ["b", makeNode("b")]]);
    const edges = new Map([["e1", edge("e1", "b", "c")]]);
    const r = getConnectedCanvasNodes("a", nodes, edges);
    expect(r.upstream).toEqual([]);
    expect(r.downstream).toEqual([]);
  });

  it("collects upstream and downstream neighbours separately", () => {
    const nodes = new Map([
      ["a", makeNode("a")],
      ["b", makeNode("b")],
      ["c", makeNode("c")],
      ["d", makeNode("d")],
    ]);
    const edges = new Map([
      ["e1", edge("e1", "a", "c")], // upstream of c
      ["e2", edge("e2", "b", "c")], // upstream of c
      ["e3", edge("e3", "c", "d")], // downstream of c
    ]);
    const r = getConnectedCanvasNodes("c", nodes, edges);
    expect(r.upstream.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(r.downstream.map((n) => n.id)).toEqual(["d"]);
  });

  it("does not follow edges transitively", () => {
    // a → b → c — only b is directly connected to c
    const nodes = new Map([
      ["a", makeNode("a")], ["b", makeNode("b")], ["c", makeNode("c")],
    ]);
    const edges = new Map([
      ["e1", edge("e1", "a", "b")],
      ["e2", edge("e2", "b", "c")],
    ]);
    const r = getConnectedCanvasNodes("c", nodes, edges);
    expect(r.upstream.map((n) => n.id)).toEqual(["b"]);
  });

  it("ignores self-loops", () => {
    const nodes = new Map([["a", makeNode("a")]]);
    const edges = new Map([["e1", edge("e1", "a", "a")]]);
    const r = getConnectedCanvasNodes("a", nodes, edges);
    expect(r.upstream).toEqual([]);
    expect(r.downstream).toEqual([]);
  });

  it("skips edges referencing missing nodes", () => {
    const nodes = new Map([["a", makeNode("a")]]);
    const edges = new Map([["e1", edge("e1", "ghost", "a")]]);
    const r = getConnectedCanvasNodes("a", nodes, edges);
    expect(r.upstream).toEqual([]);
  });
});

describe("formatNodeForLLM", () => {
  it("formats portal with URL, title, description", () => {
    const out = formatNodeForLLM(makeNode("p1", {
      kind: "portal",
      label: "GitHub",
      portalUrl: "https://github.com",
      portalTitle: "GitHub",
      portalDescription: "Where the world builds software",
    }));
    expect(out).toContain("Portal \"GitHub\"");
    expect(out).toContain("URL: https://github.com");
    expect(out).toContain("Title: GitHub");
    expect(out).toContain("Description: Where the world builds software");
  });

  it("returns empty string for portal without URL", () => {
    const out = formatNodeForLLM(makeNode("p1", { kind: "portal" }));
    expect(out).toBe("");
  });

  it("formats file with codeblock and path", () => {
    const out = formatNodeForLLM(makeNode("f1", {
      kind: "file",
      filePath: "config.yaml",
      fileContent: "foo: bar",
    }));
    expect(out).toContain("File \"config.yaml\"");
    expect(out).toContain("```");
    expect(out).toContain("foo: bar");
  });

  it("file without content emits header only", () => {
    const out = formatNodeForLLM(makeNode("f1", {
      kind: "file",
      filePath: "empty.txt",
    }));
    expect(out).toContain("File \"empty.txt\"");
    expect(out).not.toContain("```");
  });

  it("truncates long file content with marker", () => {
    const big = "x".repeat(5000);
    const out = formatNodeForLLM(makeNode("f1", {
      kind: "file",
      filePath: "big.txt",
      fileContent: big,
    }));
    expect(out).toContain("[truncated 1000 chars]");
    expect(out.length).toBeLessThan(big.length);
  });

  it("formats obsidian with markdown codeblock + vault", () => {
    const out = formatNodeForLLM(makeNode("o1", {
      kind: "obsidian",
      label: "MyNote",
      obsidianVault: "Personal",
      obsidianNotePath: "Projects/MyNote.md",
      obsidianContent: "# Title\n\nbody",
    }));
    expect(out).toContain("Obsidian note \"MyNote\"");
    expect(out).toContain("Projects/MyNote.md");
    expect(out).toContain("[vault: Personal]");
    expect(out).toContain("```markdown");
    expect(out).toContain("# Title");
  });

  it("formats sticky text", () => {
    const out = formatNodeForLLM(makeNode("s1", {
      kind: "sticky",
      label: "TODO",
      stickyText: "ship it",
    }));
    expect(out).toContain("Sticky note \"TODO\"");
    expect(out).toContain("ship it");
  });

  it("returns empty for sticky with only whitespace", () => {
    const out = formatNodeForLLM(makeNode("s1", {
      kind: "sticky",
      stickyText: "   \n  ",
    }));
    expect(out).toBe("");
  });

  it("formats text block markdown", () => {
    const out = formatNodeForLLM(makeNode("t1", {
      kind: "text",
      label: "Notes",
      markdown: "## Heading\n- item",
    }));
    expect(out).toContain("Text block \"Notes\"");
    expect(out).toContain("## Heading");
  });

  it("formats link with url + title", () => {
    const out = formatNodeForLLM(makeNode("l1", {
      kind: "link",
      label: "Docs",
      linkUrl: "https://docs.example.com",
      linkTitle: "API Docs",
    }));
    expect(out).toContain("Link \"API Docs\": https://docs.example.com");
  });

  it("formats terminal with recent messages", () => {
    const out = formatNodeForLLM(makeNode("term1", {
      kind: "terminal",
      label: "Helper",
      terminalModel: "claude-sonnet-4-6",
      terminalMessages: [
        { role: "user", content: "salut" },
        { role: "assistant", content: "bonjour" },
        { role: "user", content: "merci" },
        { role: "assistant", content: "de rien" },
        { role: "user", content: "au revoir" },
      ],
    }));
    expect(out).toContain("Connected agent \"Helper\"");
    expect(out).toContain("model: claude-sonnet-4-6");
    // Recent slice = last 4 messages, not the first one
    expect(out).not.toContain("salut");
    expect(out).toContain("au revoir");
  });

  it("terminal without messages reports empty state", () => {
    const out = formatNodeForLLM(makeNode("term1", {
      kind: "terminal",
      label: "Idle",
    }));
    expect(out).toContain("(no messages yet)");
  });

  it("formats workflow step with prompt + outputVar", () => {
    const out = formatNodeForLLM(makeNode("step1", {
      kind: "step",
      type: "agent",
      label: "Analyse",
      outputVar: "analysis_out",
      prompt: "Analyze the input",
    }));
    expect(out).toContain("Workflow step \"Analyse\"");
    expect(out).toContain("output_var: analysis_out");
    expect(out).toContain("prompt: Analyze the input");
  });

  it("returns empty for unsupported kind", () => {
    const node = makeNode("x", { kind: "step" });
    // Cast through unknown to inject an unknown kind without polluting the type.
    (node as unknown as { kind: string }).kind = "ufo";
    expect(formatNodeForLLM(node)).toBe("");
  });
});

describe("buildConnectedContext", () => {
  it("returns empty string when the node has no neighbours", () => {
    const nodes = new Map([["lonely", makeNode("lonely")]]);
    const ctx = buildConnectedContext("lonely", nodes, new Map());
    expect(ctx).toBe("");
  });

  it("returns empty string when neighbours have nothing useful to share", () => {
    // A connected sticky with only whitespace — formatNodeForLLM returns ""
    const nodes = new Map([
      ["term", makeNode("term", { kind: "terminal" })],
      ["sticky", makeNode("sticky", { kind: "sticky", stickyText: "   " })],
    ]);
    const edges = new Map([["e1", edge("e1", "sticky", "term")]]);
    const ctx = buildConnectedContext("term", nodes, edges);
    expect(ctx).toBe("");
  });

  it("includes upstream block with header when there is upstream content", () => {
    const nodes = new Map([
      ["term", makeNode("term", { kind: "terminal" })],
      ["portal", makeNode("portal", {
        kind: "portal",
        label: "GitHub",
        portalUrl: "https://github.com",
      })],
    ]);
    const edges = new Map([["e1", edge("e1", "portal", "term")]]);
    const ctx = buildConnectedContext("term", nodes, edges);
    expect(ctx).toContain("── Connected canvas context ──");
    expect(ctx).toContain("[Upstream connected items — these feed into you]");
    expect(ctx).toContain("Portal \"GitHub\"");
    expect(ctx).toContain("URL: https://github.com");
    expect(ctx).toContain("── End connected context ──");
  });

  it("includes downstream block when terminal feeds into another item", () => {
    const nodes = new Map([
      ["term", makeNode("term", { kind: "terminal" })],
      ["file", makeNode("file", {
        kind: "file",
        filePath: "out.md",
        fileContent: "result",
      })],
    ]);
    const edges = new Map([["e1", edge("e1", "term", "file")]]);
    const ctx = buildConnectedContext("term", nodes, edges);
    expect(ctx).toContain("[Downstream connected items — these consume your output]");
    expect(ctx).toContain("File \"out.md\"");
    expect(ctx).not.toContain("[Upstream connected items");
  });

  it("includes both upstream and downstream blocks when both exist", () => {
    const nodes = new Map([
      ["term", makeNode("term", { kind: "terminal" })],
      ["sticky", makeNode("sticky", { kind: "sticky", label: "Goal", stickyText: "ship feature" })],
      ["link", makeNode("link", { kind: "link", linkUrl: "https://example.com", linkTitle: "Ref" })],
    ]);
    const edges = new Map([
      ["e1", edge("e1", "sticky", "term")],
      ["e2", edge("e2", "term", "link")],
    ]);
    const ctx = buildConnectedContext("term", nodes, edges);
    expect(ctx).toContain("[Upstream connected items");
    expect(ctx).toContain("Sticky note \"Goal\"");
    expect(ctx).toContain("[Downstream connected items");
    expect(ctx).toContain("Link \"Ref\"");
    // Upstream should come before downstream in the rendered text
    expect(ctx.indexOf("Upstream")).toBeLessThan(ctx.indexOf("Downstream"));
  });

  it("filters out neighbours that produce empty formatted output", () => {
    const nodes = new Map([
      ["term", makeNode("term", { kind: "terminal" })],
      ["good", makeNode("good", { kind: "sticky", stickyText: "real text" })],
      ["empty", makeNode("empty", { kind: "portal" /* no portalUrl */ })],
    ]);
    const edges = new Map([
      ["e1", edge("e1", "good", "term")],
      ["e2", edge("e2", "empty", "term")],
    ]);
    const ctx = buildConnectedContext("term", nodes, edges);
    expect(ctx).toContain("real text");
    expect(ctx).not.toContain("Portal");
  });
});
