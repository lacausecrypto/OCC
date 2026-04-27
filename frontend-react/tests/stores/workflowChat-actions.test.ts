import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  executeDetectedActions,
  useWorkflowChatStore,
} from "../../src/stores/workflowChat";
import { useCanvasStore } from "../../src/stores/canvas";
import { useAppStore } from "../../src/stores/app";
import type { CanvasNode } from "../../src/types/canvas";

// Tests for the [ACTION:*] action handlers triggered after a chat
// response. Each action emits a system message into the workflow-chat
// store reflecting what happened. We pass the live store's get/set so
// the action handler can read+write state the same way it does in
// production.

function makeNode(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, x: 0, y: 0, w: 200, h: 100,
    type: "agent", label: id,
    preTools: [], tools: [],
    outputVar: `${id}_out`, stepId: id,
    prompt: "do work",
    ...overrides,
  };
}

function resetAll() {
  useWorkflowChatStore.setState({
    contextKey: "_test",
    activeSessionId: "session_test",
    messages: [],
    input: "",
    streaming: false,
    thinkingStartedAt: null,
    chatModel: "claude-haiku-4-5",
    plannerModel: "claude-sonnet-4-6",
    configOpen: false,
  });
  useCanvasStore.setState({
    nodes: new Map(),
    edges: new Map(),
    selection: new Set(),
    selectedEdgeId: null,
    camera: { x: 0, y: 0, zoom: 1 },
    dragState: { type: "none" },
    activeTool: "select",
    undoStack: [],
    redoStack: [],
  });
  useAppStore.setState({ canvasChainName: "test-chain", pipelineName: null });
}

beforeEach(() => {
  resetAll();
  // Default stub for fetch — concrete tests override per case.
  globalThis.fetch = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
  );
});

const get = () => useWorkflowChatStore.getState();
const set = useWorkflowChatStore.setState;

// ─── Smoke ─────────────────────────────────────────────────────────────

describe("executeDetectedActions — smoke", () => {
  it("is a no-op when the fullText carries no [ACTION:*] tag", async () => {
    await executeDetectedActions("Plain narrative response.", get, set);
    expect(get().messages).toEqual([]);
  });

  it("dedupes repeated tags", async () => {
    // Two [ACTION:ANALYZE] in a row → one resulting system message.
    await executeDetectedActions("[ACTION:ANALYZE] [ACTION:ANALYZE]", get, set);
    const sysMsgs = get().messages.filter((m) => m.role === "system");
    expect(sysMsgs).toHaveLength(1);
  });
});

// ─── ANALYZE ───────────────────────────────────────────────────────────

describe("executeDetectedActions — [ACTION:ANALYZE]", () => {
  it("reports an empty canvas when no nodes exist", async () => {
    await executeDetectedActions("[ACTION:ANALYZE]", get, set);
    const last = get().messages.at(-1)!;
    expect(last.content).toMatch(/Canvas is empty/);
  });

  it("counts nodes/edges/roots and lists models", async () => {
    useCanvasStore.getState().addNode(makeNode("a", { model: "claude-sonnet-4-6" }));
    useCanvasStore.getState().addNode(makeNode("b", { model: "claude-haiku-4-5" }));
    useCanvasStore.getState().addEdge({ id: "e1", from: "a", to: "b" });
    await executeDetectedActions("[ACTION:ANALYZE]", get, set);
    const last = get().messages.at(-1)!;
    expect(last.content).toMatch(/2 steps/);
    expect(last.content).toMatch(/1 connections/);
    expect(last.content).toMatch(/1 root/);
    expect(last.content).toMatch(/claude-sonnet-4-6/);
    expect(last.content).toMatch(/claude-haiku-4-5/);
  });

  it("flags steps missing prompts", async () => {
    useCanvasStore.getState().addNode(makeNode("a", { prompt: "" }));
    await executeDetectedActions("[ACTION:ANALYZE]", get, set);
    const last = get().messages.at(-1)!;
    expect(last.content).toMatch(/missing prompts/);
    expect(last.content).toContain("a");
  });

  it("flags more than one disconnected step (orphans)", async () => {
    useCanvasStore.getState().addNode(makeNode("a"));
    useCanvasStore.getState().addNode(makeNode("b"));
    useCanvasStore.getState().addNode(makeNode("c"));
    // No edges → 3 orphans.
    await executeDetectedActions("[ACTION:ANALYZE]", get, set);
    const last = get().messages.at(-1)!;
    expect(last.content).toMatch(/disconnected steps/);
  });

  it("flags duplicate labels", async () => {
    useCanvasStore.getState().addNode(makeNode("a1", { label: "Step" }));
    useCanvasStore.getState().addNode(makeNode("a2", { label: "Step" }));
    await executeDetectedActions("[ACTION:ANALYZE]", get, set);
    const last = get().messages.at(-1)!;
    expect(last.content).toMatch(/Duplicate labels/i);
  });
});

// ─── MODIFY ────────────────────────────────────────────────────────────

describe("executeDetectedActions — [ACTION:MODIFY]", () => {
  it("rejects responses without a parseable JSON modifications block", async () => {
    await executeDetectedActions("[ACTION:MODIFY] (no JSON here)", get, set);
    const last = get().messages.at(-1)!;
    expect(last.content).toMatch(/parse|JSON/i);
  });

  it("applies a prompt patch to an existing step", async () => {
    useCanvasStore.getState().addNode(makeNode("a", { label: "Target", prompt: "old prompt" }));
    const fullText = `[ACTION:MODIFY]
\`\`\`json
{"modifications": [
  {"stepLabel": "Target", "patch": {"prompt": "new prompt"}}
]}
\`\`\``;
    await executeDetectedActions(fullText, get, set);
    const node = [...useCanvasStore.getState().nodes.values()][0];
    expect(node.prompt).toBe("new prompt");
    const last = get().messages.at(-1)!;
    expect(last.content).toMatch(/1 step\(s\) modified/);
  });

  it("removes a step when delete: true is set", async () => {
    useCanvasStore.getState().addNode(makeNode("a", { label: "Doomed" }));
    const fullText = `[ACTION:MODIFY]
\`\`\`json
{"modifications": [{"stepLabel": "Doomed", "delete": true}]}
\`\`\``;
    await executeDetectedActions(fullText, get, set);
    expect(useCanvasStore.getState().nodes.size).toBe(0);
    const last = get().messages.at(-1)!;
    expect(last.content).toMatch(/1 step\(s\) deleted/);
  });

  it("rewires depends_on by replacing incoming edges atomically", async () => {
    const canvas = useCanvasStore.getState();
    canvas.addNode(makeNode("a", { label: "Source A" }));
    canvas.addNode(makeNode("b", { label: "Source B" }));
    canvas.addNode(makeNode("c", { label: "Target" }));
    canvas.addEdge({ id: "e_old", from: "a", to: "c" });
    const fullText = `[ACTION:MODIFY]
\`\`\`json
{"modifications": [
  {"stepLabel": "Target", "patch": {"depends_on": ["Source B"]}}
]}
\`\`\``;
    await executeDetectedActions(fullText, get, set);
    const edges = [...useCanvasStore.getState().edges.values()];
    expect(edges).toHaveLength(1);
    expect(edges[0].from).toBe("b");
    expect(edges[0].to).toBe("c");
  });

  it("applies preTools and advanced fields together", async () => {
    useCanvasStore.getState().addNode(makeNode("a", { label: "Step" }));
    const fullText = `[ACTION:MODIFY]
\`\`\`json
{"modifications": [
  {"stepLabel": "Step", "patch": {
    "preTools": [{"type": "web_search", "inject_as": "ctx", "query": "x"}],
    "advanced": {"cache": {"enabled": true, "ttl_minutes": 30}}
  }}
]}
\`\`\``;
    await executeDetectedActions(fullText, get, set);
    const node = [...useCanvasStore.getState().nodes.values()][0];
    expect(node.preTools).toHaveLength(1);
    expect(node.advanced?.cache?.enabled).toBe(true);
  });

  it("reports unknown step labels in the result message", async () => {
    const fullText = `[ACTION:MODIFY]
\`\`\`json
{"modifications": [{"stepLabel": "Ghost", "patch": {"prompt": "x"}}]}
\`\`\``;
    await executeDetectedActions(fullText, get, set);
    const last = get().messages.at(-1)!;
    expect(last.content).toMatch(/not found.*Ghost/);
  });
});

// ─── RUN ───────────────────────────────────────────────────────────────

describe("executeDetectedActions — [ACTION:RUN]", () => {
  it("aborts when no chain name is loaded on the canvas", async () => {
    useAppStore.setState({ canvasChainName: "", pipelineName: null });
    await executeDetectedActions("[ACTION:RUN]", get, set);
    const last = get().messages.at(-1)!;
    expect(last.content).toMatch(/No chain loaded/i);
  });

  it("aborts when the chain doesn't exist on the server (HEAD 404)", async () => {
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "HEAD") return Promise.resolve(new Response("", { status: 404 }));
      // shouldn't reach
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as unknown as typeof fetch;
    await executeDetectedActions("[ACTION:RUN]", get, set);
    const last = get().messages.at(-1)!;
    expect(last.content).toMatch(/not found on server/);
  });

  it("blocks the run when required text inputs are missing", async () => {
    // HEAD ok → schema fetch returns required input → execute should NOT be called.
    let executeCalled = false;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "HEAD") return Promise.resolve(new Response("", { status: 200 }));
      if (u.includes("/yaml-to-json")) {
        return Promise.resolve(new Response(JSON.stringify({
          inputs: [{ name: "topic", type: "string" }],
        }), { status: 200 }));
      }
      if (u.startsWith("/execute/")) {
        executeCalled = true;
        return Promise.resolve(new Response(JSON.stringify({ executionId: "x" }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as unknown as typeof fetch;
    await executeDetectedActions("[ACTION:RUN]", get, set);
    expect(executeCalled).toBe(false);
    const last = get().messages.at(-1)!;
    expect(last.content).toMatch(/missing required input/i);
  });

  it("blocks the run when an image input requires a user upload", async () => {
    let executeCalled = false;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "HEAD") return Promise.resolve(new Response("", { status: 200 }));
      if (u.includes("/yaml-to-json")) {
        return Promise.resolve(new Response(JSON.stringify({
          inputs: [{ name: "screenshot", type: "image" }],
        }), { status: 200 }));
      }
      if (u.startsWith("/execute/")) {
        executeCalled = true;
        return Promise.resolve(new Response(JSON.stringify({ executionId: "x" }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as unknown as typeof fetch;
    await executeDetectedActions("[ACTION:RUN]", get, set);
    expect(executeCalled).toBe(false);
    const last = get().messages.at(-1)!;
    expect(last.content).toMatch(/file\/image upload/i);
  });

  it("forwards inline JSON inputs to /execute and reports the execution id", async () => {
    let postedBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "HEAD") return Promise.resolve(new Response("", { status: 200 }));
      if (u.includes("/yaml-to-json")) {
        return Promise.resolve(new Response(JSON.stringify({
          inputs: [{ name: "topic", type: "string" }],
        }), { status: 200 }));
      }
      if (u.startsWith("/execute/")) {
        postedBody = JSON.parse(String(init?.body ?? "{}"));
        return Promise.resolve(
          new Response(JSON.stringify({ executionId: "exec_12345678" }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as unknown as typeof fetch;
    const fullText = `Will run now.\n[ACTION:RUN]\n\`\`\`json
{"topic": "Renewable energy"}
\`\`\``;
    await executeDetectedActions(fullText, get, set);
    const body = postedBody as unknown as { input?: Record<string, unknown> } | null;
    expect(body?.input).toEqual({ topic: "Renewable energy" });
    const last = get().messages.at(-1)!;
    expect(last.content).toMatch(/started/);
    expect(last.content).toContain("exec_12345");
  });

  it("ignores the modifications JSON block and only consumes the inputs block on RUN", async () => {
    // The LLM may emit both [ACTION:MODIFY] and [ACTION:RUN] in the same
    // response. The RUN handler must skip the MODIFY plan and only pick
    // the inputs object.
    let postedBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "HEAD") return Promise.resolve(new Response("", { status: 200 }));
      if (u.includes("/yaml-to-json")) {
        // No declared inputs — the run is unconditional.
        return Promise.resolve(new Response(JSON.stringify({ inputs: [] }), { status: 200 }));
      }
      if (u.startsWith("/execute/")) {
        postedBody = JSON.parse(String(init?.body ?? "{}"));
        return Promise.resolve(
          new Response(JSON.stringify({ executionId: "exec_x" }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as unknown as typeof fetch;
    // Need at least one node so MODIFY doesn't bail on "step not found".
    useCanvasStore.getState().addNode(makeNode("n", { label: "Existing" }));
    const fullText = `[ACTION:RUN]
\`\`\`json
{"modifications": [{"stepLabel": "Existing", "patch": {"prompt": "x"}}]}
\`\`\`
\`\`\`json
{"topic": "real input"}
\`\`\``;
    await executeDetectedActions(fullText, get, set);
    const body = postedBody as unknown as { input?: Record<string, unknown> } | null;
    expect(body?.input).toEqual({ topic: "real input" });
  });
});
