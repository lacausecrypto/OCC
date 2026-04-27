import { describe, it, expect } from "vitest";
import {
  screenToCanvas,
  nodeAt,
  portPos,
  resizeHandleAt,
  computeZoomToFit,
} from "../../src/components/canvas/canvasRenderer";
import type { CanvasNode, Camera } from "../../src/types/canvas";

// Pure-helper tests for canvasRenderer. We deliberately avoid touching
// renderCanvas() (it depends on a live CanvasRenderingContext2D and a real
// DOM canvas) — these tests exercise the geometry primitives that drive
// every interaction (hit-testing, port positioning, resize handles, fit).

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

const camIdent: Camera = { x: 0, y: 0, zoom: 1 };

describe("screenToCanvas", () => {
  it("is the identity transform when zoom=1 and offset=0", () => {
    expect(screenToCanvas(50, 75, camIdent)).toEqual({ x: 50, y: 75 });
  });

  it("inverts the camera offset", () => {
    expect(screenToCanvas(50, 75, { x: 10, y: -20, zoom: 1 })).toEqual({ x: 40, y: 95 });
  });

  it("inverts the camera zoom", () => {
    expect(screenToCanvas(100, 200, { x: 0, y: 0, zoom: 2 })).toEqual({ x: 50, y: 100 });
  });

  it("inverts both offset and zoom together", () => {
    // A screen point at (200, 200) with cam offset (50, 50) and zoom 2 should
    // map to canvas-space (75, 75).
    expect(screenToCanvas(200, 200, { x: 50, y: 50, zoom: 2 })).toEqual({ x: 75, y: 75 });
  });
});

describe("nodeAt", () => {
  it("returns null for empty node map", () => {
    expect(nodeAt(50, 50, camIdent, new Map())).toBeNull();
  });

  it("returns null when no node is under the point", () => {
    const nodes = new Map([["a", makeNode("a")]]);
    // Node "a" lives at [100,300] × [100,200]; click far outside.
    expect(nodeAt(0, 0, camIdent, nodes)).toBeNull();
  });

  it("hits a node whose body contains the point", () => {
    const nodes = new Map([["a", makeNode("a")]]);
    expect(nodeAt(150, 150, camIdent, nodes)).toBe("a");
  });

  it("hits on the inclusive border (x=node.x, y=node.y)", () => {
    const nodes = new Map([["a", makeNode("a")]]);
    expect(nodeAt(100, 100, camIdent, nodes)).toBe("a");
  });

  it("hits on the inclusive border (x=node.x+w, y=node.y+h)", () => {
    const nodes = new Map([["a", makeNode("a")]]);
    expect(nodeAt(300, 200, camIdent, nodes)).toBe("a");
  });

  it("returns the topmost node when several overlap (Map insertion order, last wins)", () => {
    // The renderer iterates entries in REVERSE so the *last* inserted node
    // wins — that's the "drawn on top" node visually.
    const nodes = new Map<string, CanvasNode>();
    nodes.set("bottom", makeNode("bottom"));
    nodes.set("top", makeNode("top"));
    expect(nodeAt(150, 150, camIdent, nodes)).toBe("top");
  });

  it("converts screen coords through the camera", () => {
    const nodes = new Map([["a", makeNode("a")]]);
    // Camera offset (50, 0) zoom 1 → screen point (200, 150) maps to canvas (150, 150).
    expect(nodeAt(200, 150, { x: 50, y: 0, zoom: 1 }, nodes)).toBe("a");
    // Same screen point at zoom 2 maps to canvas (75, 75) — outside the node.
    expect(nodeAt(200, 150, { x: 50, y: 0, zoom: 2 }, nodes)).toBeNull();
  });

  it("just-outside the bottom-right corner misses by 1px", () => {
    const nodes = new Map([["a", makeNode("a")]]);
    expect(nodeAt(301, 200, camIdent, nodes)).toBeNull();
    expect(nodeAt(300, 201, camIdent, nodes)).toBeNull();
  });
});

describe("portPos", () => {
  it("input port sits at top-center of the node bounding box", () => {
    const n = makeNode("a", { x: 100, y: 100, w: 200, h: 100 });
    expect(portPos(n, "in")).toEqual({ x: 200, y: 100 });
  });

  it("output port sits at bottom-center of the node bounding box", () => {
    const n = makeNode("a", { x: 100, y: 100, w: 200, h: 100 });
    expect(portPos(n, "out")).toEqual({ x: 200, y: 200 });
  });

  it("respects custom dimensions", () => {
    const n = makeNode("a", { x: 0, y: 0, w: 50, h: 30 });
    expect(portPos(n, "in")).toEqual({ x: 25, y: 0 });
    expect(portPos(n, "out")).toEqual({ x: 25, y: 30 });
  });
});

describe("resizeHandleAt", () => {
  // Node footprint: [100, 300] × [100, 200].
  // Handles: nw(100,100), n(200,100), ne(300,100), e(300,150),
  //          se(300,200), s(200,200), sw(100,200), w(100,150).
  const n = makeNode("a");

  it.each([
    ["nw", 100, 100],
    ["n",  200, 100],
    ["ne", 300, 100],
    ["e",  300, 150],
    ["se", 300, 200],
    ["s",  200, 200],
    ["sw", 100, 200],
    ["w",  100, 150],
  ] as const)("hits the %s handle at its exact position", (handle, x, y) => {
    expect(resizeHandleAt(x, y, n)).toBe(handle);
  });

  it("hits within the default 8px radius", () => {
    // 5px from the nw corner is still within the default 8px hit radius.
    expect(resizeHandleAt(105, 100, n)).toBe("nw");
    expect(resizeHandleAt(100, 105, n)).toBe("nw");
  });

  it("misses when outside the hit radius", () => {
    // 10px from nw → dx²+dy² = 200 > 64.
    expect(resizeHandleAt(110, 110, n)).toBeNull();
  });

  it("respects a custom hit radius", () => {
    expect(resizeHandleAt(112, 100, n, 8)).toBeNull();
    expect(resizeHandleAt(112, 100, n, 16)).toBe("nw");
  });

  it("returns null when far from every handle", () => {
    expect(resizeHandleAt(200, 150, n)).toBeNull(); // dead center
  });
});

describe("computeZoomToFit", () => {
  it("returns a neutral camera when there are no nodes", () => {
    expect(computeZoomToFit(new Map(), 800, 600)).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("centers a single node in the viewport", () => {
    const nodes = new Map([["a", makeNode("a", { x: 100, y: 100, w: 200, h: 100 })]]);
    const cam = computeZoomToFit(nodes, 800, 600);
    // Node center is (200, 150) in canvas space — the camera should map
    // that to the viewport center (400, 300).
    expect(200 * cam.zoom + cam.x).toBeCloseTo(400, 5);
    expect(150 * cam.zoom + cam.y).toBeCloseTo(300, 5);
  });

  it("clamps zoom to a max of 2", () => {
    // Tiny node + huge container would otherwise zoom way past 2.
    const nodes = new Map([["a", makeNode("a", { x: 0, y: 0, w: 10, h: 10 })]]);
    const cam = computeZoomToFit(nodes, 4000, 4000);
    expect(cam.zoom).toBeLessThanOrEqual(2);
  });

  it("shrinks zoom when content is wider than container", () => {
    const nodes = new Map([["a", makeNode("a", { x: 0, y: 0, w: 4000, h: 100 })]]);
    const cam = computeZoomToFit(nodes, 800, 600);
    expect(cam.zoom).toBeLessThan(1);
  });

  it("includes padding in the fit calculation", () => {
    // Two cameras for two container widths; the wider one should have
    // strictly higher zoom (padding is constant, content is constant).
    const nodes = new Map([["a", makeNode("a", { x: 0, y: 0, w: 1000, h: 200 })]]);
    const camNarrow = computeZoomToFit(nodes, 800, 600);
    const camWide = computeZoomToFit(nodes, 1600, 600);
    expect(camWide.zoom).toBeGreaterThan(camNarrow.zoom);
  });
});
