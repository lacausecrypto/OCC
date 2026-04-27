import { describe, it, expect, beforeEach } from "vitest";
import { applyPlanToCanvas, buildCanvasContext } from "../../src/stores/workflowChat";
import { useCanvasStore } from "../../src/stores/canvas";
import { useAppStore } from "../../src/stores/app";
import { useFloorsStore } from "../../src/stores/floors";
import type { CanvasNode, CanvasEdge } from "../../src/types/canvas";

// Tests for the workflow-chat helpers that drive the planner -> canvas
// roundtrip. Specifically:
//   - applyPlanToCanvas: regression for the "disconnected parallel chain"
//     bug — addSteps whose depends_on references an existing node must
//     wire into the existing chain, not float off below.
//   - buildCanvasContext: surface chain inputs, step details, and active
//     floor info (and warn when other floors have content while the
//     active one is empty).

function existingNode(id: string, label: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, x: 0, y: 0, w: 240, h: 80,
    type: "agent", label,
    preTools: [], tools: [],
    outputVar: "", stepId: id,
    prompt: "",
    ...overrides,
  };
}

function resetStores() {
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
  // Floors store: a single "main" floor, idle transition.
  useFloorsStore.setState({
    floors: new Map([["main", {
      id: "main", name: "Main", color: "#0a84ff",
      nodes: new Map(), edges: new Map(),
      camera: { x: 0, y: 0, zoom: 1 },
      annotations: [],
      createdAt: 0,
    }]]),
    activeFloorId: "main",
    overviewOpen: false,
    transition: "idle",
    transitionTargetId: null,
    transitionScale: 1,
    transitionOffsetX: 0,
    stackViewOpen: false,
  });
}

beforeEach(resetStores);

// ─── applyPlanToCanvas ─────────────────────────────────────────────────

describe("applyPlanToCanvas — fresh canvas", () => {
  it("creates nodes for each step in the plan", () => {
    const ids = applyPlanToCanvas({
      steps: [
        { type: "agent", label: "First", prompt: "do A" },
        { type: "agent", label: "Second", prompt: "do B" },
      ],
    });
    expect(ids).toHaveLength(2);
    const labels = [...useCanvasStore.getState().nodes.values()].map((n) => n.label).sort();
    expect(labels).toEqual(["First", "Second"]);
  });

  it("wires explicit depends_on edges between new steps", () => {
    applyPlanToCanvas({
      steps: [
        { type: "agent", label: "A", prompt: "" },
        { type: "agent", label: "B", prompt: "", depends_on: ["A"] },
      ],
    });
    const edges = [...useCanvasStore.getState().edges.values()];
    expect(edges).toHaveLength(1);
    const nodes = useCanvasStore.getState().nodes;
    const a = [...nodes.values()].find((n) => n.label === "A")!;
    const b = [...nodes.values()].find((n) => n.label === "B")!;
    expect(edges[0].from).toBe(a.id);
    expect(edges[0].to).toBe(b.id);
  });

  it("falls back to sequential wiring when no depends_on is provided", () => {
    applyPlanToCanvas({
      steps: [
        { type: "agent", label: "A", prompt: "" },
        { type: "agent", label: "B", prompt: "" },
        { type: "agent", label: "C", prompt: "" },
      ],
    });
    const edges = [...useCanvasStore.getState().edges.values()];
    // With 3 steps and no deps, the fallback chains them head-to-tail: A→B, B→C.
    expect(edges).toHaveLength(2);
  });

  it("forwards model / tools / preTools / advanced from the plan to the node", () => {
    applyPlanToCanvas({
      steps: [
        {
          type: "agent", label: "Step", prompt: "",
          model: "claude-haiku-4-5",
          tools: ["Read"],
          preTools: [{ type: "web_search", inject_as: "ctx", query: "x" }],
          advanced: { cache: { enabled: true, ttl_minutes: 30 } },
        },
      ],
    });
    const node = [...useCanvasStore.getState().nodes.values()][0];
    expect(node.model).toBe("claude-haiku-4-5");
    expect(node.tools).toEqual(["Read"]);
    expect(node.preTools).toHaveLength(1);
    expect(node.advanced?.cache?.enabled).toBe(true);
  });

  it("derives a default outputVar from the label when none is provided", () => {
    applyPlanToCanvas({ steps: [{ type: "agent", label: "Build Final Output", prompt: "" }] });
    const node = [...useCanvasStore.getState().nodes.values()][0];
    expect(node.outputVar).toBe("build_final_output_out");
  });
});

describe("applyPlanToCanvas — addSteps onto an existing canvas", () => {
  function seedExisting() {
    const store = useCanvasStore.getState();
    store.addNode(existingNode("e1", "Analyse", { x: 80, y: 80 }));
    store.addNode(existingNode("e2", "Validation", { x: 80, y: 220 }));
    store.addEdge({ id: "edge_e1_e2", from: "e1", to: "e2" });
  }

  it("wires depends_on referencing an EXISTING node (regression for disconnected chain bug)", () => {
    seedExisting();
    applyPlanToCanvas({
      steps: [{ type: "agent", label: "New Step", prompt: "", depends_on: ["Validation"] }],
    });
    const nodes = useCanvasStore.getState().nodes;
    const newNode = [...nodes.values()].find((n) => n.label === "New Step")!;
    const edges = [...useCanvasStore.getState().edges.values()];
    // Original e1→e2 edge plus new e2→newNode edge.
    expect(edges).toHaveLength(2);
    const wired = edges.find((e) => e.to === newNode.id);
    expect(wired?.from).toBe("e2");
  });

  it("wires depends_on referencing ANOTHER NEW step (label resolved within the plan)", () => {
    seedExisting();
    applyPlanToCanvas({
      steps: [
        { type: "agent", label: "X", prompt: "", depends_on: ["Validation"] },
        { type: "agent", label: "Y", prompt: "", depends_on: ["X"] },
      ],
    });
    const nodes = useCanvasStore.getState().nodes;
    const x = [...nodes.values()].find((n) => n.label === "X")!;
    const y = [...nodes.values()].find((n) => n.label === "Y")!;
    const edges = [...useCanvasStore.getState().edges.values()];
    // Original e1→e2 + new e2→X + new X→Y.
    expect(edges).toHaveLength(3);
    expect(edges.some((e) => e.from === "e2" && e.to === x.id)).toBe(true);
    expect(edges.some((e) => e.from === x.id && e.to === y.id)).toBe(true);
  });

  it("attaches the first new step to the existing leaf when depends_on is omitted", () => {
    seedExisting();
    applyPlanToCanvas({
      steps: [
        { type: "agent", label: "Tail-1", prompt: "" },
        { type: "agent", label: "Tail-2", prompt: "" },
      ],
    });
    const nodes = useCanvasStore.getState().nodes;
    const t1 = [...nodes.values()].find((n) => n.label === "Tail-1")!;
    const t2 = [...nodes.values()].find((n) => n.label === "Tail-2")!;
    const edges = [...useCanvasStore.getState().edges.values()];
    // e1→e2 + e2→Tail-1 (leaf attach) + Tail-1→Tail-2 (sequential).
    expect(edges.some((e) => e.from === "e2" && e.to === t1.id)).toBe(true);
    expect(edges.some((e) => e.from === t1.id && e.to === t2.id)).toBe(true);
  });

  it("places new nodes BELOW the existing ones (no overlap)", () => {
    seedExisting();
    const oldMaxY = Math.max(
      ...[...useCanvasStore.getState().nodes.values()].map((n) => n.y + n.h),
    );
    applyPlanToCanvas({ steps: [{ type: "agent", label: "Below", prompt: "" }] });
    const newNode = [...useCanvasStore.getState().nodes.values()].find((n) => n.label === "Below")!;
    expect(newNode.y).toBeGreaterThanOrEqual(oldMaxY);
  });

  it("ignores self-referential depends_on entries (no n→n edge)", () => {
    applyPlanToCanvas({
      steps: [{ type: "agent", label: "Self", prompt: "", depends_on: ["Self"] }],
    });
    const edges = [...useCanvasStore.getState().edges.values()];
    expect(edges).toHaveLength(0);
  });
});

// ─── buildCanvasContext ────────────────────────────────────────────────

describe("buildCanvasContext", () => {
  it("reports an empty canvas when no nodes exist", () => {
    const ctx = buildCanvasContext();
    expect(ctx).toMatch(/0 steps/);
    expect(ctx).toMatch(/Canvas is empty/);
  });

  it("includes step labels, types and dependencies for non-empty canvases", () => {
    const store = useCanvasStore.getState();
    store.addNode(existingNode("e1", "Step One"));
    store.addNode(existingNode("e2", "Step Two"));
    store.addEdge({ id: "edge_1", from: "e1", to: "e2" });
    const ctx = buildCanvasContext();
    expect(ctx).toContain("\"Step One\" (agent)");
    expect(ctx).toContain("\"Step Two\" (agent)");
    // The dependency arrow references the upstream label, not the id.
    expect(ctx).toMatch(/Step Two[\s\S]*← \[Step One\]/);
  });

  it("surfaces a typed Inputs section when prompts reference {input.X}", () => {
    const store = useCanvasStore.getState();
    store.addNode(existingNode("e1", "Fetch", {
      prompt: "Hit {input.url} and summarize {input.topic}",
    }));
    const ctx = buildCanvasContext();
    expect(ctx).toContain("Inputs (fill these on RUN):");
    expect(ctx).toContain("topic (string)");
    expect(ctx).toMatch(/url \(url\)/);
  });

  it("flags image/file inputs as requiring a user upload", () => {
    const store = useCanvasStore.getState();
    store.addNode(existingNode("e1", "Caption", {
      prompt: "Caption {input.image}",
    }));
    const ctx = buildCanvasContext();
    expect(ctx).toContain("image (image)");
    expect(ctx).toMatch(/REQUIRES USER UPLOAD/i);
  });

  it("warns when the active floor is empty but other floors hold steps", () => {
    // Active "main" floor stays empty; populate "secondary" with one node snapshot.
    useFloorsStore.setState({
      floors: new Map([
        ["main", {
          id: "main", name: "Main", color: "#0a84ff",
          nodes: new Map(), edges: new Map(),
          camera: { x: 0, y: 0, zoom: 1 },
          annotations: [], createdAt: 0,
        }],
        ["second", {
          id: "second", name: "Other", color: "#30d158",
          nodes: new Map([["x", existingNode("x", "Hidden")]]),
          edges: new Map(),
          camera: { x: 0, y: 0, zoom: 1 },
          annotations: [], createdAt: 0,
        }],
      ]),
      activeFloorId: "main",
    });
    const ctx = buildCanvasContext();
    expect(ctx).toMatch(/Canvas is empty on this floor/);
    expect(ctx).toContain("Other");
  });

  it("includes the active floor name in the chain header line", () => {
    useFloorsStore.setState({
      floors: new Map([
        ["main", {
          id: "main", name: "Main", color: "#0a84ff",
          nodes: new Map(), edges: new Map(),
          camera: { x: 0, y: 0, zoom: 1 },
          annotations: [], createdAt: 0,
        }],
        ["second", {
          id: "second", name: "Other", color: "#30d158",
          nodes: new Map(), edges: new Map(),
          camera: { x: 0, y: 0, zoom: 1 },
          annotations: [], createdAt: 0,
        }],
      ]),
      activeFloorId: "main",
    });
    useCanvasStore.getState().addNode(existingNode("e1", "Foo"));
    const ctx = buildCanvasContext();
    expect(ctx).toContain("floor:\"Main\"");
    expect(ctx).toContain("(2 floors total)");
  });
});

// ─── Sanity: no leakage between plan applications ──────────────────────

describe("applyPlanToCanvas does not mutate the input plan", () => {
  it("leaves the plan steps array intact", () => {
    const plan = {
      steps: [
        { type: "agent" as const, label: "A", prompt: "" },
        { type: "agent" as const, label: "B", prompt: "", depends_on: ["A"] },
      ],
    };
    const snapshot = JSON.stringify(plan);
    applyPlanToCanvas(plan);
    expect(JSON.stringify(plan)).toBe(snapshot);
  });
});

// We need at least one reference to keep `CanvasEdge` in scope for type
// hints used in the helpers above.
const _typeRef: CanvasEdge | undefined = undefined;
void _typeRef;
