import { describe, it, expect, beforeEach, vi } from "vitest";
import { useFloorsStore } from "../../src/stores/floors";
import { useCanvasStore } from "../../src/stores/canvas";
import { useAnnotationStore } from "../../src/stores/annotations";
import type { CanvasNode } from "../../src/types/canvas";

// We stub requestAnimationFrame to a no-op so the spring animations
// triggered by switchFloor / toggleStackView / selectFromStack don't
// recurse forever during tests. Tests then assert the synchronous
// side effects only (immediate transition flags, data swaps, store
// updates) — the animation tail is visual and out of scope here.
let rafSpy: ReturnType<typeof vi.spyOn>;

function makeNode(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, x: 0, y: 0, w: 200, h: 100,
    type: "agent", label: id,
    preTools: [], tools: [],
    outputVar: "", stepId: id,
    prompt: "",
    ...overrides,
  };
}

function resetFloors() {
  useFloorsStore.setState({
    floors: new Map([["main", {
      id: "main", name: "Main", colorSlot: 0,
      nodes: new Map(), edges: new Map(),
      camera: { x: 0, y: 0, zoom: 1 },
      annotations: [], createdAt: 0,
    }]]),
    activeFloorId: "main",
    overviewOpen: false,
    stackViewOpen: false,
    transition: "idle",
    transitionTargetId: null,
    transitionScale: 1,
    transitionOffsetX: 0,
  });
}

function resetCanvas() {
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
}

let dateCounter = 1_700_000_000_000;
beforeEach(() => {
  localStorage.clear();
  rafSpy = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 0);
  // createFloor uses `floor_${Date.now()}` for ids. In tight test loops two
  // calls land in the same millisecond and the second overwrites the first
  // entry in the floors map. Force a monotonic Date.now so every floor
  // gets a distinct id.
  vi.spyOn(Date, "now").mockImplementation(() => ++dateCounter);
  resetFloors();
  resetCanvas();
  useAnnotationStore.setState({ annotations: [], selectedId: null, drawing: null });
});

// ─── Synchronous CRUD ──────────────────────────────────────────────────

describe("createFloor", () => {
  it("adds a new floor to the map and returns its id", () => {
    const id = useFloorsStore.getState().createFloor("Lab");
    const floors = useFloorsStore.getState().floors;
    expect(id).toMatch(/^floor_/);
    expect(floors.has(id)).toBe(true);
    expect(floors.get(id)?.name).toBe("Lab");
  });

  it("uses an auto-numbered name when none is provided", () => {
    const id = useFloorsStore.getState().createFloor();
    expect(useFloorsStore.getState().floors.get(id)?.name).toMatch(/^Floor /);
  });

  it("rotates the colorSlot index across consecutive new floors", () => {
    const id1 = useFloorsStore.getState().createFloor("a");
    const id2 = useFloorsStore.getState().createFloor("b");
    const s1 = useFloorsStore.getState().floors.get(id1)!.colorSlot;
    const s2 = useFloorsStore.getState().floors.get(id2)!.colorSlot;
    expect(typeof s1).toBe("number");
    expect(typeof s2).toBe("number");
    expect(s1).not.toBe(s2);
  });

  it("persists the new floor map to localStorage", () => {
    useFloorsStore.getState().createFloor("Persisted");
    const raw = localStorage.getItem("occ-floors");
    expect(raw).toBeTruthy();
    expect(raw).toContain("Persisted");
  });

  it("triggers the switch transition (sets transition to zooming-out)", () => {
    const id = useFloorsStore.getState().createFloor("Lab");
    expect(useFloorsStore.getState().transition).toBe("zooming-out");
    expect(useFloorsStore.getState().transitionTargetId).toBe(id);
  });
});

describe("deleteFloor", () => {
  it("removes the floor from the map", () => {
    const id = useFloorsStore.getState().createFloor("Doomed");
    // After createFloor we're mid-animation — reset transition so
    // deleteFloor's switchFloor("main") fallback can run.
    useFloorsStore.setState({ transition: "idle", transitionTargetId: null });
    useFloorsStore.getState().deleteFloor(id);
    expect(useFloorsStore.getState().floors.has(id)).toBe(false);
  });

  it("refuses to delete the last remaining floor", () => {
    // Only "main" exists.
    useFloorsStore.getState().deleteFloor("main");
    expect(useFloorsStore.getState().floors.size).toBe(1);
  });

  it("refuses to delete the 'main' floor even when other floors exist", () => {
    useFloorsStore.getState().createFloor("Other");
    useFloorsStore.setState({ transition: "idle", transitionTargetId: null });
    useFloorsStore.getState().deleteFloor("main");
    expect(useFloorsStore.getState().floors.has("main")).toBe(true);
  });

  it("switches to 'main' when deleting the active floor", () => {
    const id = useFloorsStore.getState().createFloor("Active");
    useFloorsStore.setState({
      activeFloorId: id, transition: "idle", transitionTargetId: null,
    });
    useFloorsStore.getState().deleteFloor(id);
    // Switch animation kicks off — assert the entry flag.
    expect(useFloorsStore.getState().transitionTargetId).toBe("main");
  });

  it("persists the deletion to localStorage", () => {
    const id = useFloorsStore.getState().createFloor("Doomed");
    useFloorsStore.setState({ transition: "idle", transitionTargetId: null });
    useFloorsStore.getState().deleteFloor(id);
    const raw = localStorage.getItem("occ-floors");
    expect(raw).not.toContain("Doomed");
  });
});

describe("renameFloor", () => {
  it("updates the floor name and persists", () => {
    useFloorsStore.getState().renameFloor("main", "First Floor");
    expect(useFloorsStore.getState().floors.get("main")?.name).toBe("First Floor");
    const raw = localStorage.getItem("occ-floors");
    expect(raw).toContain("First Floor");
  });

  it("is a no-op for unknown ids", () => {
    useFloorsStore.getState().renameFloor("ghost", "X");
    expect(useFloorsStore.getState().floors.get("main")?.name).toBe("Main");
  });
});

// ─── saveActiveFloor (snapshot of canvas + annotations) ────────────────

describe("saveActiveFloor", () => {
  it("snapshots the current canvas nodes/edges/camera into the active floor", () => {
    useCanvasStore.getState().addNode(makeNode("n1"));
    useCanvasStore.getState().addNode(makeNode("n2"));
    useCanvasStore.getState().addEdge({ id: "e1", from: "n1", to: "n2" });
    useCanvasStore.setState({ camera: { x: 50, y: 100, zoom: 1.5 } });

    useFloorsStore.getState().saveActiveFloor();
    const main = useFloorsStore.getState().floors.get("main")!;
    expect(main.nodes.size).toBe(2);
    expect(main.edges.size).toBe(1);
    expect(main.camera).toEqual({ x: 50, y: 100, zoom: 1.5 });
  });

  it("captures annotations alongside the canvas state", () => {
    useAnnotationStore.setState({
      annotations: [{ id: "a1", type: "draw", color: "#fff", strokeWidth: 2, points: [] }] as never,
    });
    useFloorsStore.getState().saveActiveFloor();
    const main = useFloorsStore.getState().floors.get("main")!;
    expect(main.annotations).toHaveLength(1);
  });

  it("persists the snapshot to localStorage", () => {
    useCanvasStore.getState().addNode(makeNode("persisted"));
    useFloorsStore.getState().saveActiveFloor();
    const raw = localStorage.getItem("occ-floors");
    expect(raw).toContain("persisted");
  });

  it("is a no-op when activeFloorId points to an unknown floor", () => {
    useFloorsStore.setState({ activeFloorId: "ghost" });
    expect(() => useFloorsStore.getState().saveActiveFloor()).not.toThrow();
  });
});

// ─── switchFloor (entry conditions only — animation stubbed) ───────────

describe("switchFloor", () => {
  it("is a no-op when target id == active id", () => {
    useFloorsStore.getState().switchFloor("main");
    expect(useFloorsStore.getState().transition).toBe("idle");
  });

  it("is a no-op when an animation is already in flight", () => {
    const id = useFloorsStore.getState().createFloor("Other");
    // After createFloor → already animating. switchFloor must bail.
    useFloorsStore.getState().switchFloor("main");
    expect(useFloorsStore.getState().transitionTargetId).toBe(id);
  });

  it("is a no-op for an unknown id", () => {
    useFloorsStore.getState().switchFloor("ghost");
    expect(useFloorsStore.getState().transition).toBe("idle");
  });

  it("kicks off zooming-out and registers the target id", () => {
    const id = useFloorsStore.getState().createFloor("Other");
    useFloorsStore.setState({ transition: "idle", transitionTargetId: null });
    useFloorsStore.getState().switchFloor(id);
    expect(useFloorsStore.getState().transition).toBe("zooming-out");
    expect(useFloorsStore.getState().transitionTargetId).toBe(id);
  });

  it("schedules a requestAnimationFrame tick", () => {
    const id = useFloorsStore.getState().createFloor("Other");
    useFloorsStore.setState({ transition: "idle", transitionTargetId: null });
    rafSpy.mockClear();
    useFloorsStore.getState().switchFloor(id);
    expect(rafSpy).toHaveBeenCalled();
  });
});

// ─── Toggle stack view + selectFromStack ───────────────────────────────

describe("toggleStackView / selectFromStack", () => {
  it("toggleStackView sets stackViewOpen + zooming-out the first time", () => {
    useFloorsStore.getState().toggleStackView();
    expect(useFloorsStore.getState().stackViewOpen).toBe(true);
    expect(useFloorsStore.getState().transition).toBe("zooming-out");
  });

  it("toggleStackView refuses to open when an animation is already in flight", () => {
    const id = useFloorsStore.getState().createFloor("Other");
    useFloorsStore.getState().toggleStackView();
    // Still mid-createFloor switch — toggleStackView should bail.
    expect(useFloorsStore.getState().stackViewOpen).toBe(false);
    expect(useFloorsStore.getState().transitionTargetId).toBe(id);
  });

  it("selectFromStack is a no-op when stackViewOpen is false", () => {
    const id = useFloorsStore.getState().createFloor("Other");
    useFloorsStore.setState({ transition: "idle", transitionTargetId: null });
    useFloorsStore.getState().selectFromStack(id);
    expect(useFloorsStore.getState().transition).toBe("idle");
  });

  it("selectFromStack closes the stack view when the chosen floor is already active", () => {
    useFloorsStore.setState({ stackViewOpen: true });
    useFloorsStore.getState().selectFromStack("main");
    // toggleStackView path: transition becomes zooming-in (we close).
    expect(useFloorsStore.getState().transition).toBe("zooming-in");
  });

  it("selectFromStack swaps canvas data and zooms in for a different floor", () => {
    const id = useFloorsStore.getState().createFloor("Target");
    // Stage a unique node into the target floor's snapshot.
    useFloorsStore.setState((s) => {
      const floors = new Map(s.floors);
      const target = floors.get(id)!;
      floors.set(id, {
        ...target,
        nodes: new Map([["target_node", makeNode("target_node")]]),
      });
      return { floors, transition: "idle", transitionTargetId: null, stackViewOpen: true };
    });
    useFloorsStore.getState().selectFromStack(id);
    expect(useFloorsStore.getState().activeFloorId).toBe(id);
    expect(useCanvasStore.getState().nodes.has("target_node")).toBe(true);
    expect(useFloorsStore.getState().transition).toBe("zooming-in");
  });
});

// ─── overviewOpen + getFloorList ───────────────────────────────────────

describe("setOverviewOpen", () => {
  it("flips the overviewOpen flag", () => {
    useFloorsStore.getState().setOverviewOpen(true);
    expect(useFloorsStore.getState().overviewOpen).toBe(true);
    useFloorsStore.getState().setOverviewOpen(false);
    expect(useFloorsStore.getState().overviewOpen).toBe(false);
  });
});

describe("getFloorList", () => {
  it("returns every floor as an array, in insertion order", () => {
    const a = useFloorsStore.getState().createFloor("A");
    const b = useFloorsStore.getState().createFloor("B");
    const list = useFloorsStore.getState().getFloorList();
    const names = list.map((f) => f.name);
    expect(names).toContain("Main");
    expect(names).toContain("A");
    expect(names).toContain("B");
    // First entry is always the original "main" floor since it's created
    // first; A and B follow in their creation order.
    expect(list[0].id).toBe("main");
    expect(list.findIndex((f) => f.id === a)).toBeLessThan(list.findIndex((f) => f.id === b));
  });

  it("returns a snapshot that doesn't share references with the internal map", () => {
    const list = useFloorsStore.getState().getFloorList();
    const before = list.length;
    useFloorsStore.getState().createFloor("New");
    expect(list.length).toBe(before); // old snapshot untouched
  });
});
