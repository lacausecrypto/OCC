import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCanvasInteractions } from "../../src/components/canvas/useCanvasInteractions";
import { useCanvasStore } from "../../src/stores/canvas";
import type { CanvasNode } from "../../src/types/canvas";

// useCanvasInteractions wires pointer/wheel/keyboard events to the canvas
// store. We test the pointerdown branch — the most bug-prone path — by
// rendering the hook with a fake canvas ref and asserting the resulting
// drag state. The handler reads only `button`, `clientX`, `clientY`, and
// `shiftKey` from the event, so a minimal cast is enough.

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

function makeCanvasRef(rect = { left: 0, top: 0, width: 800, height: 600 }) {
  const el = {
    getBoundingClientRect: () => ({
      ...rect,
      x: rect.left,
      y: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLCanvasElement;
  return { current: el };
}

interface PtrEvent {
  button: number;
  clientX: number;
  clientY: number;
  shiftKey?: boolean;
}
function pointerEvent({ button, clientX, clientY, shiftKey = false }: PtrEvent) {
  // The handler only reads these fields — no need to fake the full DOM event.
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
  });
}

beforeEach(resetStore);

describe("useCanvasInteractions onPointerDown — button filtering", () => {
  it("right-click on empty canvas does NOT arm box-select (regression for ca0146b)", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    result.current.onPointerDown(pointerEvent({ button: 2, clientX: 50, clientY: 50 }));
    expect(useCanvasStore.getState().dragState.type).toBe("none");
  });

  it("right-click on a node does NOT arm node-drag", () => {
    const ref = makeCanvasRef();
    useCanvasStore.setState({ nodes: new Map([["a", makeNode("a")]]) });
    const { result } = renderHook(() => useCanvasInteractions(ref));
    result.current.onPointerDown(pointerEvent({ button: 2, clientX: 200, clientY: 150 }));
    expect(useCanvasStore.getState().dragState.type).toBe("none");
    // Selection must also stay empty — right-click should not select.
    expect([...useCanvasStore.getState().selection]).toEqual([]);
  });

  it("middle-click arms pan regardless of activeTool", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    result.current.onPointerDown(pointerEvent({ button: 1, clientX: 30, clientY: 40 }));
    const ds = useCanvasStore.getState().dragState;
    expect(ds.type).toBe("pan");
    expect(ds.lastX).toBe(30);
    expect(ds.lastY).toBe(40);
  });

  it("left-click goes through to the regular branches", () => {
    const ref = makeCanvasRef();
    useCanvasStore.setState({ nodes: new Map([["a", makeNode("a")]]) });
    const { result } = renderHook(() => useCanvasInteractions(ref));
    result.current.onPointerDown(pointerEvent({ button: 0, clientX: 200, clientY: 150 }));
    const ds = useCanvasStore.getState().dragState;
    expect(ds.type).toBe("node");
  });
});

describe("useCanvasInteractions onPointerDown — drag-state outcomes", () => {
  it("left-click on empty space arms box-select and clears selection", () => {
    const ref = makeCanvasRef();
    useCanvasStore.setState({ selection: new Set(["a"]) });
    const { result } = renderHook(() => useCanvasInteractions(ref));
    result.current.onPointerDown(pointerEvent({ button: 0, clientX: 50, clientY: 50 }));
    const ds = useCanvasStore.getState().dragState;
    expect(ds.type).toBe("box");
    expect([...useCanvasStore.getState().selection]).toEqual([]);
  });

  it("shift-left-click on empty space arms box-select WITHOUT clearing selection", () => {
    const ref = makeCanvasRef();
    useCanvasStore.setState({ selection: new Set(["a"]) });
    const { result } = renderHook(() => useCanvasInteractions(ref));
    result.current.onPointerDown(
      pointerEvent({ button: 0, clientX: 50, clientY: 50, shiftKey: true }),
    );
    expect(useCanvasStore.getState().dragState.type).toBe("box");
    expect([...useCanvasStore.getState().selection]).toEqual(["a"]);
  });

  it("left-click on a node selects it and arms node-drag", () => {
    const ref = makeCanvasRef();
    useCanvasStore.setState({ nodes: new Map([["a", makeNode("a")]]) });
    const { result } = renderHook(() => useCanvasInteractions(ref));
    result.current.onPointerDown(pointerEvent({ button: 0, clientX: 200, clientY: 150 }));
    expect([...useCanvasStore.getState().selection]).toEqual(["a"]);
    const ds = useCanvasStore.getState().dragState;
    expect(ds.type).toBe("node");
    expect(ds.offsets?.size).toBe(1);
  });

  it("shift-left-click on an unselected node adds it to the selection (multi-select)", () => {
    const ref = makeCanvasRef();
    useCanvasStore.setState({
      nodes: new Map([
        ["a", makeNode("a", { x: 100, y: 100 })],
        ["b", makeNode("b", { x: 400, y: 100 })],
      ]),
      selection: new Set(["a"]),
    });
    const { result } = renderHook(() => useCanvasInteractions(ref));
    result.current.onPointerDown(
      pointerEvent({ button: 0, clientX: 500, clientY: 150, shiftKey: true }),
    );
    const sel = [...useCanvasStore.getState().selection].sort();
    expect(sel).toEqual(["a", "b"]);
  });

  it("shift-left-click on an already-selected node toggles it OUT of the selection", () => {
    const ref = makeCanvasRef();
    useCanvasStore.setState({
      nodes: new Map([
        ["a", makeNode("a", { x: 100, y: 100 })],
        ["b", makeNode("b", { x: 400, y: 100 })],
      ]),
      selection: new Set(["a", "b"]),
    });
    const { result } = renderHook(() => useCanvasInteractions(ref));
    result.current.onPointerDown(
      pointerEvent({ button: 0, clientX: 500, clientY: 150, shiftKey: true }),
    );
    expect([...useCanvasStore.getState().selection]).toEqual(["a"]);
  });

  it("connect tool: left-click on a node arms a connect-drag from that node", () => {
    const ref = makeCanvasRef();
    useCanvasStore.setState({
      nodes: new Map([["a", makeNode("a")]]),
      activeTool: "connect",
    });
    const { result } = renderHook(() => useCanvasInteractions(ref));
    result.current.onPointerDown(pointerEvent({ button: 0, clientX: 200, clientY: 150 }));
    const ds = useCanvasStore.getState().dragState;
    expect(ds.type).toBe("connect");
    expect(ds.fromId).toBe("a");
  });

  it("connect tool: left-click on empty space does NOT arm any drag", () => {
    const ref = makeCanvasRef();
    useCanvasStore.setState({ activeTool: "connect" });
    const { result } = renderHook(() => useCanvasInteractions(ref));
    result.current.onPointerDown(pointerEvent({ button: 0, clientX: 50, clientY: 50 }));
    expect(useCanvasStore.getState().dragState.type).toBe("none");
  });

  it("pan tool: left-click anywhere arms pan", () => {
    const ref = makeCanvasRef();
    useCanvasStore.setState({
      nodes: new Map([["a", makeNode("a")]]),
      activeTool: "pan",
    });
    const { result } = renderHook(() => useCanvasInteractions(ref));
    result.current.onPointerDown(pointerEvent({ button: 0, clientX: 200, clientY: 150 }));
    expect(useCanvasStore.getState().dragState.type).toBe("pan");
  });

  it("does nothing when canvasRef.current is null", () => {
    const ref = { current: null };
    const { result } = renderHook(() => useCanvasInteractions(ref));
    result.current.onPointerDown(pointerEvent({ button: 0, clientX: 200, clientY: 150 }));
    expect(useCanvasStore.getState().dragState.type).toBe("none");
  });
});

describe("useCanvasInteractions onWheel — zoom around cursor", () => {
  it("scroll up zooms in", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    const before = useCanvasStore.getState().camera.zoom;
    const evt = {
      clientX: 400, clientY: 300, deltaY: -100,
      ctrlKey: false, metaKey: false,
      preventDefault: () => {},
    } as unknown as React.WheelEvent;
    result.current.onWheel(evt);
    expect(useCanvasStore.getState().camera.zoom).toBeGreaterThan(before);
  });

  it("scroll down zooms out", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    const before = useCanvasStore.getState().camera.zoom;
    const evt = {
      clientX: 400, clientY: 300, deltaY: 100,
      ctrlKey: false, metaKey: false,
      preventDefault: () => {},
    } as unknown as React.WheelEvent;
    result.current.onWheel(evt);
    expect(useCanvasStore.getState().camera.zoom).toBeLessThan(before);
  });
});

describe("useCanvasInteractions zoomIn / zoomOut / zoomToFit", () => {
  it("zoomIn increases the zoom level", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    const before = useCanvasStore.getState().camera.zoom;
    result.current.zoomIn();
    expect(useCanvasStore.getState().camera.zoom).toBeGreaterThan(before);
  });

  it("zoomOut decreases the zoom level", () => {
    const ref = makeCanvasRef();
    const { result } = renderHook(() => useCanvasInteractions(ref));
    const before = useCanvasStore.getState().camera.zoom;
    result.current.zoomOut();
    expect(useCanvasStore.getState().camera.zoom).toBeLessThan(before);
  });

  it("zoomToFit centers content in the viewport", () => {
    const ref = makeCanvasRef();
    useCanvasStore.setState({
      nodes: new Map([["a", makeNode("a", { x: 0, y: 0, w: 200, h: 100 })]]),
    });
    const { result } = renderHook(() => useCanvasInteractions(ref));
    result.current.zoomToFit();
    const cam = useCanvasStore.getState().camera;
    // After zoom-to-fit, the node center (100, 50) must map close to the
    // viewport center (400, 300).
    expect(100 * cam.zoom + cam.x).toBeCloseTo(400, 1);
    expect(50 * cam.zoom + cam.y).toBeCloseTo(300, 1);
  });
});
