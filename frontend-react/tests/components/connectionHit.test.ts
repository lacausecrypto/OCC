import { describe, it, expect, beforeEach } from "vitest";
import {
  edgeAt,
  controlPointAt,
  edgeMidpoint,
} from "../../src/components/canvas/connectionHit";
import { clearRopeStates, getRopeState } from "../../src/components/canvas/ropePhysics";
import type { CanvasNode, CanvasEdge } from "../../src/types/canvas";

// connectionHit decides whether a click landed on an edge or one of its
// bezier control points. The bezier itself uses live "rope physics" (sag
// + spring) — we reset that state before each test so ports always sit
// where the geometry says they should, with no leftover spring oscillation
// from previous tests.

function makeNode(id: string, x: number, y: number, w = 200, h = 100): CanvasNode {
  return {
    id, x, y, w, h,
    type: "agent", label: id,
    preTools: [], tools: [],
    outputVar: "", stepId: id,
    prompt: "",
  };
}

function makeEdge(id: string, from: string, to: string, overrides: Partial<CanvasEdge> = {}): CanvasEdge {
  return { id, from, to, ...overrides };
}

beforeEach(() => {
  clearRopeStates();
});

describe("edgeAt", () => {
  it("returns null when there are no edges", () => {
    expect(edgeAt(0, 0, new Map(), new Map())).toBeNull();
  });

  it("ignores edges referencing missing nodes", () => {
    const nodes = new Map<string, CanvasNode>();
    nodes.set("a", makeNode("a", 0, 0));
    const edges = new Map([["e1", makeEdge("e1", "a", "ghost")]]);
    expect(edgeAt(100, 100, edges, nodes)).toBeNull();
  });

  it("hits an edge when the click is near its midpoint", () => {
    // a (0..200) × (0..100) → output port (100, 100)
    // b (0..200) × (300..400) → input port (100, 300)
    // The edge runs roughly through (100, 200).
    const nodes = new Map<string, CanvasNode>();
    nodes.set("a", makeNode("a", 0, 0));
    nodes.set("b", makeNode("b", 0, 300));
    const edges = new Map([["e1", makeEdge("e1", "a", "b")]]);
    // Pre-stage the rope at its target sag so the bezier is deterministic.
    const r = getRopeState("e1");
    r.sag = r.targetSag;
    const mid = edgeMidpoint({ id: "e1", from: "a", to: "b" }, nodes);
    expect(mid).not.toBeNull();
    expect(edgeAt(mid!.x, mid!.y, edges, nodes, 4)).toBe("e1");
  });

  it("misses when the click is far from any curve sample", () => {
    const nodes = new Map<string, CanvasNode>();
    nodes.set("a", makeNode("a", 0, 0));
    nodes.set("b", makeNode("b", 0, 300));
    const edges = new Map([["e1", makeEdge("e1", "a", "b")]]);
    expect(edgeAt(1000, 1000, edges, nodes)).toBeNull();
  });

  it("returns the closest edge when several pass nearby", () => {
    // Two parallel edges; click halfway between them is closer to e1.
    const nodes = new Map<string, CanvasNode>();
    nodes.set("a", makeNode("a", 0, 0));
    nodes.set("b", makeNode("b", 0, 300));
    nodes.set("c", makeNode("c", 50, 0));
    nodes.set("d", makeNode("d", 50, 300));
    const edges = new Map([
      ["e1", makeEdge("e1", "a", "b")],
      ["e2", makeEdge("e2", "c", "d")],
    ]);
    for (const id of ["e1", "e2"]) {
      const r = getRopeState(id);
      r.sag = r.targetSag;
    }
    // Edge e1 runs at x≈100, e2 at x≈150. Click at x=110 → e1 wins.
    expect(edgeAt(110, 200, edges, nodes, 30)).toBe("e1");
    // Click at x=145 → e2 wins.
    expect(edgeAt(145, 200, edges, nodes, 30)).toBe("e2");
  });

  it("respects the hit radius", () => {
    const nodes = new Map<string, CanvasNode>();
    nodes.set("a", makeNode("a", 0, 0));
    nodes.set("b", makeNode("b", 0, 300));
    const edges = new Map([["e1", makeEdge("e1", "a", "b")]]);
    const r = getRopeState("e1");
    r.sag = r.targetSag;
    // Far enough from the curve that radius=2 misses but radius=50 catches.
    expect(edgeAt(140, 200, edges, nodes, 2)).toBeNull();
    expect(edgeAt(140, 200, edges, nodes, 50)).toBe("e1");
  });

  it("respects custom control point offsets (cp1/cp2 shift the curve)", () => {
    // Same two nodes, but the user has dragged cp1 way to the right —
    // the curve now bulges right, so a click at the original midpoint
    // should be FURTHER from the curve.
    const nodes = new Map<string, CanvasNode>();
    nodes.set("a", makeNode("a", 0, 0));
    nodes.set("b", makeNode("b", 0, 300));

    const straight = new Map([["e1", makeEdge("e1", "a", "b")]]);
    const bent = new Map([
      ["e1", makeEdge("e1", "a", "b", { cp1: { dx: 200, dy: 0 }, cp2: { dx: 200, dy: 0 } })],
    ]);
    for (const id of ["e1"]) {
      const r = getRopeState(id);
      r.sag = r.targetSag;
    }
    // A point on the straight line at x=100, y=200 should be near the
    // straight curve but far from the bent one.
    expect(edgeAt(100, 200, straight, nodes, 8)).toBe("e1");
    expect(edgeAt(100, 200, bent, nodes, 8)).toBeNull();
  });
});

describe("controlPointAt", () => {
  function setup() {
    const nodes = new Map<string, CanvasNode>();
    nodes.set("a", makeNode("a", 0, 0));
    nodes.set("b", makeNode("b", 0, 300));
    const edge: CanvasEdge = { id: "e1", from: "a", to: "b" };
    const r = getRopeState(edge.id);
    r.sag = r.targetSag;
    return { nodes, edge };
  }

  it("returns null when nodes are missing", () => {
    const nodes = new Map<string, CanvasNode>();
    const edge: CanvasEdge = { id: "e1", from: "ghost", to: "ghost" };
    expect(controlPointAt(0, 0, edge, nodes)).toBeNull();
  });

  it("returns null when the click is far from both control points", () => {
    const { nodes, edge } = setup();
    expect(controlPointAt(1000, 1000, edge, nodes)).toBeNull();
  });

  // For a vertical edge from (100,100) to (100,300):
  // getRopeControlPoints returns cp1 ≈ (100, 100+cpDist) ~ (100, 180)
  // and cp2 ≈ (100, 300−cpDist) ~ (100, 220). The two handles are roughly
  // 40px apart. controlPointAt iterates [cp1, cp2] and returns the first
  // handle within radius — to disambiguate cp2, we use a hit radius
  // tighter than that 40px gap.

  it("hits cp1 when the click is right on it (no custom offset)", () => {
    const { nodes, edge } = setup();
    const handle = controlPointAt(100, 180, edge, nodes, 25);
    expect(handle?.handle).toBe("cp1");
  });

  it("hits cp2 when the click is right on it", () => {
    const { nodes, edge } = setup();
    // 25px radius is smaller than the cp1↔cp2 gap (~40), so cp1 is out
    // of range and cp2 wins. With radius 200 cp1 would always win because
    // it comes first in the iteration order.
    const handle = controlPointAt(100, 220, edge, nodes, 25);
    expect(handle?.handle).toBe("cp2");
  });

  it("respects custom cp1/cp2 offsets when picking", () => {
    const nodes = new Map<string, CanvasNode>();
    nodes.set("a", makeNode("a", 0, 0));
    nodes.set("b", makeNode("b", 0, 300));
    const shifted: CanvasEdge = {
      id: "e1", from: "a", to: "b",
      cp1: { dx: 100, dy: 0 },
      cp2: { dx: -100, dy: 0 },
    };
    const r = getRopeState(shifted.id);
    r.sag = r.targetSag;
    // cp1 base ≈ (100, 180), shifted x → ≈ (200, 180).
    const h1 = controlPointAt(200, 180, shifted, nodes, 25);
    expect(h1?.handle).toBe("cp1");
    // cp2 base ≈ (100, 220), shifted x → ≈ (0, 220).
    const h2 = controlPointAt(0, 220, shifted, nodes, 25);
    expect(h2?.handle).toBe("cp2");
  });

  it("returns the handle position alongside the discriminator", () => {
    const { nodes, edge } = setup();
    const h = controlPointAt(100, 180, edge, nodes, 25);
    expect(h).not.toBeNull();
    expect(typeof h!.x).toBe("number");
    expect(typeof h!.y).toBe("number");
  });
});

describe("edgeMidpoint", () => {
  it("returns null when nodes are missing", () => {
    const edge: CanvasEdge = { id: "e1", from: "ghost", to: "x" };
    expect(edgeMidpoint(edge, new Map())).toBeNull();
  });

  it("returns the mid-bezier point between the source and target ports", () => {
    const nodes = new Map<string, CanvasNode>();
    nodes.set("a", makeNode("a", 0, 0));
    nodes.set("b", makeNode("b", 0, 300));
    const edge: CanvasEdge = { id: "e1", from: "a", to: "b" };
    const r = getRopeState(edge.id);
    r.sag = r.targetSag;
    const mid = edgeMidpoint(edge, nodes);
    expect(mid).not.toBeNull();
    // Source port (100, 100) → target port (100, 300). At t=0.5 the
    // bezier midpoint sits roughly at x=100 (the curve is symmetric around
    // the line) and y in the 100..300 range.
    expect(mid!.x).toBeCloseTo(100, 1);
    expect(mid!.y).toBeGreaterThan(100);
    expect(mid!.y).toBeLessThan(300);
  });
});
