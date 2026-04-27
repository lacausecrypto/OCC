import { describe, it, expect } from "vitest";
import { preToolsToData } from "../../src/components/canvas/StepEditModal";
import type { PreTool } from "../../src/types/chain";

// `preToolsToData` adapts the canonical PreTool shape (saved on a CanvasNode
// or in YAML) into the editor-side PreToolData shape used by the modal's
// state. The modal field is keyed `tool` while the engine field is keyed
// `type` — these tests pin the conversion contract so a future rename
// doesn't silently break the editor.

describe("preToolsToData", () => {
  it("returns an empty array for an empty input", () => {
    expect(preToolsToData([])).toEqual([]);
  });

  it("expands a string-only pre-tool into { tool, inject_as }", () => {
    // Some legacy chain definitions write pre_tools as bare strings.
    const out = preToolsToData(["web_search" as unknown as PreTool]);
    expect(out).toHaveLength(1);
    expect(out[0].tool).toBe("web_search");
    expect(out[0].inject_as).toBe("web_search_data");
  });

  it("preserves explicit inject_as on object pre-tools", () => {
    const input: PreTool[] = [
      { type: "web_search", inject_as: "results", query: "claude code" } as PreTool,
    ];
    const out = preToolsToData(input);
    expect(out).toHaveLength(1);
    expect(out[0].inject_as).toBe("results");
    // Type-specific param survives the conversion.
    expect((out[0] as Record<string, unknown>).query).toBe("claude code");
  });

  it("derives a default inject_as when missing", () => {
    // Engine PreTools sometimes arrive without inject_as (legacy YAML).
    // The modal needs SOMETHING to render in the inject_as input.
    const input = [
      { type: "http_fetch", url: "https://example.com" } as unknown as PreTool,
    ];
    const out = preToolsToData(input);
    expect(out[0].inject_as).toBeTruthy();
    expect(out[0].inject_as).toMatch(/_data$/);
  });

  it("keeps timeout / retry / cache settings intact", () => {
    const input = [
      {
        type: "http_fetch",
        inject_as: "page",
        url: "https://example.com",
        timeout_ms: 5000,
        retry: 2,
        cache_ttl_minutes: 30,
        on_error: "skip",
      } as unknown as PreTool,
    ];
    const out = preToolsToData(input) as Array<Record<string, unknown>>;
    expect(out[0].timeout_ms).toBe(5000);
    expect(out[0].retry).toBe(2);
    expect(out[0].cache_ttl_minutes).toBe(30);
    expect(out[0].on_error).toBe("skip");
  });

  it("preserves order across multiple pre-tools", () => {
    const input: PreTool[] = [
      { type: "web_search", inject_as: "a", query: "first" } as PreTool,
      { type: "http_fetch", inject_as: "b", url: "https://x" } as PreTool,
      { type: "bash", inject_as: "c", command: "ls" } as PreTool,
    ];
    const out = preToolsToData(input);
    expect(out.map((p) => p.inject_as)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array or its elements", () => {
    const original: PreTool[] = [
      { type: "web_search", inject_as: "ctx", query: "static" } as PreTool,
    ];
    const snapshot = JSON.stringify(original);
    preToolsToData(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("handles a mix of string and object entries (legacy YAML)", () => {
    const input = [
      "web_search" as unknown as PreTool,
      { type: "http_fetch", inject_as: "page", url: "https://x" } as PreTool,
    ];
    const out = preToolsToData(input);
    expect(out).toHaveLength(2);
    expect(out[0].tool).toBe("web_search");
    expect(out[0].inject_as).toBe("web_search_data");
    expect(out[1].inject_as).toBe("page");
  });
});
