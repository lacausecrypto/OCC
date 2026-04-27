import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCanvasInteractions } from "../../src/components/canvas/useCanvasInteractions";
import { useCanvasStore } from "../../src/stores/canvas";
import { useAnnotationStore } from "../../src/stores/annotations";
import type { CanvasNode } from "../../src/types/canvas";

// Coverage push for the "second half" of useCanvasInteractions —
// onPointerMove drag branches, onPointerUp outcomes, onPointerCancel,
// and the keyboard shortcut handler installed via window listener.
// onPointerDown was already covered by useCanvasInteractions.test.tsx.

function makeNode(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, x: 100, y: 100, w: 200, h: 100,
    type: "agent", label: id,
    preTools: [], tools: [],
    outputVar: "", stepId: id,
    prompt: "",
    ...overrides,
  };
}

function makeCanvasRef() {
  const parent = {
    clientWidth: 800,
    clientHeight: 600,
  } as HTMLElement;
  const el = {
    parentElement: parent,
    getBoundingClientRect: () => ({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLCanvasElement;
  return { current: el };
}

interface PtrEvent {
  button?: number;
  clientX: number;
  clientY: number;
  shiftKey?: boolean;
}
function pointerEvent({ button = 0, clientX, clientY, shiftKey = false }: PtrEvent) {
  return {
    button, clientX, clientY, shiftKey,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as React.PointerEvent;
}

function resetStore() {
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

beforeEach(() => {
  resetStore();
  useAnnotationStore.setState({
    annotations: [], selectedId: null, drawing: null, activeTool: "none",
  });
});

// ─── onPointerMove ─────────────────────────────────────────────────────

describe("onPointerMove — pan", () => {
  it("translates the camera by the pointer delta", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      dragState: { type: "pan", lastX: 100, lastY: 100 },
    });
    result.current.onPointerMove(pointerEvent({ clientX: 150, clientY: 80 }));
    const cam = useCanvasStore.getState().camera;
    expect(cam.x).toBe(50);
    expect(cam.y).toBe(-20);
  });

  it("updates the lastX/lastY anchor on each move (incremental)", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      dragState: { type: "pan", lastX: 100, lastY: 100 },
    });
    result.current.onPointerMove(pointerEvent({ clientX: 200, clientY: 100 }));
    const ds = useCanvasStore.getState().dragState;
    expect(ds.type).toBe("pan");
    expect(ds.lastX).toBe(200);
    expect(ds.lastY).toBe(100);
  });
});

describe("onPointerMove — node drag", () => {
  it("moves the dragged node and snaps to a 20px grid by default", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    const node = makeNode("a", { x: 100, y: 100, w: 100, h: 100 });
    useCanvasStore.setState({
      nodes: new Map([["a", node]]),
      dragState: {
        type: "node",
        offsets: new Map([["a", { dx: -50, dy: -50 }]]),
        sx: 0, sy: 0, mx: 0, my: 0,
      },
    });
    // Pointer at (167, 33) → canvas-space same (zoom=1, cam at origin).
    // After applying offset (-50, -50) → (117, -17) → snap to 120, -20.
    result.current.onPointerMove(pointerEvent({ clientX: 167, clientY: 33 }));
    const moved = useCanvasStore.getState().nodes.get("a")!;
    expect(moved.x).toBe(120);
    expect(moved.y).toBe(-20);
  });

  it("disables snap when shift is held (free move)", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      nodes: new Map([["a", makeNode("a")]]),
      dragState: {
        type: "node",
        offsets: new Map([["a", { dx: 0, dy: 0 }]]),
        sx: 0, sy: 0, mx: 0, my: 0,
      },
    });
    result.current.onPointerMove(
      pointerEvent({ clientX: 137, clientY: 113, shiftKey: true }),
    );
    const moved = useCanvasStore.getState().nodes.get("a")!;
    expect(moved.x).toBe(137);
    expect(moved.y).toBe(113);
  });

  it("moves every selected node by the same delta", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      nodes: new Map([
        ["a", makeNode("a", { x: 100, y: 100 })],
        ["b", makeNode("b", { x: 400, y: 100 })],
      ]),
      dragState: {
        type: "node",
        offsets: new Map([
          ["a", { dx: 0, dy: 0 }],
          ["b", { dx: 300, dy: 0 }],
        ]),
        sx: 0, sy: 0, mx: 0, my: 0,
      },
    });
    // Pointer at (200, 200) → A moves to (200, 200), B moves to (500, 200).
    result.current.onPointerMove(
      pointerEvent({ clientX: 200, clientY: 200, shiftKey: true }),
    );
    const aMoved = useCanvasStore.getState().nodes.get("a")!;
    const bMoved = useCanvasStore.getState().nodes.get("b")!;
    expect([aMoved.x, aMoved.y]).toEqual([200, 200]);
    expect([bMoved.x, bMoved.y]).toEqual([500, 200]);
  });
});

describe("onPointerMove — box / connect (just update endpoints)", () => {
  it("box drag: updates mx/my as the pointer moves", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      dragState: { type: "box", sx: 50, sy: 50, mx: 50, my: 50 },
    });
    result.current.onPointerMove(pointerEvent({ clientX: 200, clientY: 250 }));
    const ds = useCanvasStore.getState().dragState;
    expect(ds.mx).toBe(200);
    expect(ds.my).toBe(250);
    // Origin sx/sy must not move.
    expect(ds.sx).toBe(50);
    expect(ds.sy).toBe(50);
  });

  it("connect drag: updates mx/my for the rubber-band line", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      dragState: { type: "connect", fromId: "a", mx: 100, my: 100 },
    });
    result.current.onPointerMove(pointerEvent({ clientX: 250, clientY: 350 }));
    const ds = useCanvasStore.getState().dragState;
    expect(ds.fromId).toBe("a");
    expect(ds.mx).toBe(250);
    expect(ds.my).toBe(350);
  });
});

describe("onPointerMove — resize", () => {
  it("expands a node's width when dragging the east handle", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      nodes: new Map([["a", makeNode("a", { x: 100, y: 100, w: 200, h: 100 })]]),
      dragState: {
        type: "resize",
        resizeNodeId: "a",
        resizeHandle: "e",
        resizeOrigin: { x: 100, y: 100, w: 200, h: 100 },
        sx: 300, sy: 150, mx: 300, my: 150,
      },
    });
    result.current.onPointerMove(
      pointerEvent({ clientX: 360, clientY: 150, shiftKey: true /* no snap */ }),
    );
    const node = useCanvasStore.getState().nodes.get("a")!;
    expect(node.w).toBe(260);
    expect(node.h).toBe(100);
  });

  it("shrinks node respecting the minW/minH guards", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      nodes: new Map([["a", makeNode("a", { x: 100, y: 100, w: 200, h: 100 })]]),
      dragState: {
        type: "resize",
        resizeNodeId: "a",
        resizeHandle: "e",
        resizeOrigin: { x: 100, y: 100, w: 200, h: 100 },
        sx: 300, sy: 150, mx: 300, my: 150,
      },
    });
    // Shrink hard left; minW (60) must clamp.
    result.current.onPointerMove(
      pointerEvent({ clientX: 10, clientY: 150, shiftKey: true }),
    );
    const node = useCanvasStore.getState().nodes.get("a")!;
    expect(node.w).toBe(60);
  });

  it("nw handle moves x/y as well as w/h", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      nodes: new Map([["a", makeNode("a", { x: 100, y: 100, w: 200, h: 100 })]]),
      dragState: {
        type: "resize",
        resizeNodeId: "a",
        resizeHandle: "nw",
        resizeOrigin: { x: 100, y: 100, w: 200, h: 100 },
        sx: 100, sy: 100, mx: 100, my: 100,
      },
    });
    result.current.onPointerMove(
      pointerEvent({ clientX: 80, clientY: 90, shiftKey: true }),
    );
    const node = useCanvasStore.getState().nodes.get("a")!;
    expect(node.x).toBe(80);
    expect(node.y).toBe(90);
    expect(node.w).toBe(220);
    expect(node.h).toBe(110);
  });
});

// ─── onPointerUp ───────────────────────────────────────────────────────

describe("onPointerUp", () => {
  it("box-select picks every node intersecting the rectangle and resets dragState", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      nodes: new Map([
        ["a", makeNode("a", { x: 50, y: 50, w: 50, h: 50 })],   // inside
        ["b", makeNode("b", { x: 200, y: 50, w: 50, h: 50 })],  // outside
      ]),
      dragState: { type: "box", sx: 0, sy: 0, mx: 150, my: 150 },
    });
    result.current.onPointerUp(pointerEvent({ clientX: 150, clientY: 150 }));
    expect([...useCanvasStore.getState().selection]).toEqual(["a"]);
    expect(useCanvasStore.getState().dragState.type).toBe("none");
  });

  it("connect-drop creates an edge when dropped on a different node", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      nodes: new Map([
        ["a", makeNode("a", { x: 0, y: 0, w: 100, h: 100 })],
        ["b", makeNode("b", { x: 200, y: 200, w: 100, h: 100 })],
      ]),
      dragState: { type: "connect", fromId: "a", mx: 250, my: 250 },
    });
    result.current.onPointerUp(pointerEvent({ clientX: 250, clientY: 250 }));
    const edges = [...useCanvasStore.getState().edges.values()];
    expect(edges).toHaveLength(1);
    expect(edges[0].from).toBe("a");
    expect(edges[0].to).toBe("b");
  });

  it("connect-drop on the source node does NOT create an edge", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      nodes: new Map([["a", makeNode("a")]]),
      dragState: { type: "connect", fromId: "a", mx: 200, my: 150 },
    });
    result.current.onPointerUp(pointerEvent({ clientX: 200, clientY: 150 }));
    expect([...useCanvasStore.getState().edges.values()]).toEqual([]);
  });

  it("connect-drop deduplicates: doesn't add a second edge between the same pair", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      nodes: new Map([
        ["a", makeNode("a", { x: 0, y: 0, w: 100, h: 100 })],
        ["b", makeNode("b", { x: 200, y: 200, w: 100, h: 100 })],
      ]),
      edges: new Map([["existing", { id: "existing", from: "a", to: "b" }]]),
      dragState: { type: "connect", fromId: "a", mx: 250, my: 250 },
    });
    result.current.onPointerUp(pointerEvent({ clientX: 250, clientY: 250 }));
    expect([...useCanvasStore.getState().edges.values()]).toHaveLength(1);
  });

  it("any pointerUp resets dragState to 'none'", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      dragState: { type: "node", offsets: new Map(), sx: 0, sy: 0, mx: 0, my: 0 },
    });
    result.current.onPointerUp(pointerEvent({ clientX: 0, clientY: 0 }));
    expect(useCanvasStore.getState().dragState.type).toBe("none");
  });
});

// ─── onPointerCancel ───────────────────────────────────────────────────

describe("onPointerCancel", () => {
  it("aborts any in-flight drag", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      dragState: { type: "box", sx: 0, sy: 0, mx: 50, my: 50 },
    });
    result.current.onPointerCancel();
    expect(useCanvasStore.getState().dragState.type).toBe("none");
  });
});

// ─── Keyboard shortcuts ────────────────────────────────────────────────

function dispatchKey(opts: {
  key: string; meta?: boolean; ctrl?: boolean; shift?: boolean;
}) {
  const ev = new KeyboardEvent("keydown", {
    key: opts.key,
    ctrlKey: !!opts.ctrl,
    metaKey: !!opts.meta,
    shiftKey: !!opts.shift,
    bubbles: true,
  });
  window.dispatchEvent(ev);
}

describe("keyboard shortcuts (window-level)", () => {
  it("Delete removes selected nodes (and their edges)", () => {
    const ref = makeCanvasRef();
    renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      nodes: new Map([
        ["a", makeNode("a")],
        ["b", makeNode("b")],
      ]),
      edges: new Map([["e1", { id: "e1", from: "a", to: "b" }]]),
      selection: new Set(["a"]),
    });
    dispatchKey({ key: "Delete" });
    expect(useCanvasStore.getState().nodes.has("a")).toBe(false);
    // The edge that referenced "a" should be gone too.
    expect([...useCanvasStore.getState().edges.values()]).toHaveLength(0);
  });

  it("Delete removes the selected edge when no node is selected", () => {
    const ref = makeCanvasRef();
    renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      nodes: new Map([
        ["a", makeNode("a")],
        ["b", makeNode("b")],
      ]),
      edges: new Map([["e1", { id: "e1", from: "a", to: "b" }]]),
      selectedEdgeId: "e1",
      selection: new Set(),
    });
    dispatchKey({ key: "Delete" });
    expect(useCanvasStore.getState().edges.has("e1")).toBe(false);
  });

  it("Cmd+A selects every node on the canvas", () => {
    const ref = makeCanvasRef();
    renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      nodes: new Map([
        ["a", makeNode("a")],
        ["b", makeNode("b")],
        ["c", makeNode("c")],
      ]),
    });
    dispatchKey({ key: "a", meta: true });
    expect([...useCanvasStore.getState().selection].sort()).toEqual(["a", "b", "c"]);
  });

  it("Escape clears the selection", () => {
    const ref = makeCanvasRef();
    renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({ selection: new Set(["a", "b"]) });
    dispatchKey({ key: "Escape" });
    expect([...useCanvasStore.getState().selection]).toEqual([]);
  });

  it("Cmd+Z pops the undo stack", () => {
    const ref = makeCanvasRef();
    renderHook(() => useCanvasInteractions(ref));
    const store = useCanvasStore.getState();
    store.addNode(makeNode("a"));
    store.pushUndo();
    store.addNode(makeNode("b"));
    expect(useCanvasStore.getState().nodes.size).toBe(2);
    dispatchKey({ key: "z", meta: true });
    expect(useCanvasStore.getState().nodes.size).toBe(1);
  });

  it("Cmd+Shift+Z pops the redo stack (after an undo)", () => {
    const ref = makeCanvasRef();
    renderHook(() => useCanvasInteractions(ref));
    const store = useCanvasStore.getState();
    store.addNode(makeNode("a"));
    store.pushUndo();
    store.addNode(makeNode("b"));
    dispatchKey({ key: "z", meta: true }); // undo
    expect(useCanvasStore.getState().nodes.size).toBe(1);
    dispatchKey({ key: "z", meta: true, shift: true }); // redo
    expect(useCanvasStore.getState().nodes.size).toBe(2);
  });

  it("Cmd+= zooms in", () => {
    const ref = makeCanvasRef();
    renderHook(() => useCanvasInteractions(ref));
    const before = useCanvasStore.getState().camera.zoom;
    dispatchKey({ key: "=" });
    expect(useCanvasStore.getState().camera.zoom).toBeGreaterThan(before);
  });

  it("Cmd+- zooms out", () => {
    const ref = makeCanvasRef();
    renderHook(() => useCanvasInteractions(ref));
    const before = useCanvasStore.getState().camera.zoom;
    dispatchKey({ key: "-" });
    expect(useCanvasStore.getState().camera.zoom).toBeLessThan(before);
  });

  it("'0' fits the camera to the content", () => {
    const ref = makeCanvasRef();
    renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      nodes: new Map([["a", makeNode("a", { x: 0, y: 0, w: 200, h: 100 })]]),
    });
    dispatchKey({ key: "0" });
    const cam = useCanvasStore.getState().camera;
    // After zoomToFit, node center (100, 50) maps near (400, 300).
    expect(100 * cam.zoom + cam.x).toBeCloseTo(400, 1);
  });

  it("Cmd+S dispatches the 'occ-canvas-save' custom event", () => {
    const ref = makeCanvasRef();
    renderHook(() => useCanvasInteractions(ref));
    let received = false;
    const onSave = () => { received = true; };
    window.addEventListener("occ-canvas-save", onSave);
    dispatchKey({ key: "s", meta: true });
    window.removeEventListener("occ-canvas-save", onSave);
    expect(received).toBe(true);
  });

  it("Cmd+D duplicates the selected nodes (and inner edges)", () => {
    const ref = makeCanvasRef();
    renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      nodes: new Map([
        ["a", makeNode("a", { x: 100, y: 100 })],
        ["b", makeNode("b", { x: 400, y: 100 })],
      ]),
      edges: new Map([["e1", { id: "e1", from: "a", to: "b" }]]),
      selection: new Set(["a", "b"]),
    });
    dispatchKey({ key: "d", meta: true });
    // Original 2 + duplicates 2 = 4 nodes; original 1 edge + duplicate 1 = 2.
    expect(useCanvasStore.getState().nodes.size).toBe(4);
    expect([...useCanvasStore.getState().edges.values()]).toHaveLength(2);
  });

  it("Cmd+C then Cmd+V pastes a translated copy of the selected subgraph", () => {
    const ref = makeCanvasRef();
    renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      nodes: new Map([
        ["a", makeNode("a", { x: 100, y: 100 })],
        ["b", makeNode("b", { x: 400, y: 100 })],
      ]),
      edges: new Map([["e1", { id: "e1", from: "a", to: "b" }]]),
      selection: new Set(["a", "b"]),
    });
    dispatchKey({ key: "c", meta: true });
    dispatchKey({ key: "v", meta: true });
    expect(useCanvasStore.getState().nodes.size).toBe(4);
  });

  it("ignores keys when focus is on an INPUT/TEXTAREA/SELECT", () => {
    const ref = makeCanvasRef();
    renderHook(() => useCanvasInteractions(ref));
    useCanvasStore.setState({
      nodes: new Map([["a", makeNode("a")]]),
      selection: new Set(["a"]),
    });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const ev = new KeyboardEvent("keydown", { key: "Delete", bubbles: true });
    Object.defineProperty(ev, "target", { value: input });
    window.dispatchEvent(ev);
    document.body.removeChild(input);
    expect(useCanvasStore.getState().nodes.has("a")).toBe(true);
  });
});
