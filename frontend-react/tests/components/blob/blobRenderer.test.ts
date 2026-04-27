import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  tickPhysics,
  blobNodeAt,
  renderBlobCanvas,
} from "../../../src/components/blob/blobRenderer";
import type { BlobNode, BlobEdge, BlobNodeData } from "../../../src/types/blob";

// jsdom's HTMLCanvasElement.getContext returns null by default. The blob
// renderer creates an offscreen canvas via document.createElement("canvas")
// and calls .getContext("2d") on it. Without this stub, putImageData
// crashes ("Cannot read properties of null"). We provide a permissive
// Proxy-mock context so the offscreen path works.
beforeAll(() => {
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: () => CanvasRenderingContext2D };
  if (!("__patched" in proto)) {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      value: function () { return makeProxyCtx(); },
      configurable: true,
    });
    (proto as unknown as { __patched: boolean }).__patched = true;
  }
});

// Tests for the BLOB renderer's pure helpers (tickPhysics, blobNodeAt) and
// a smoke test of renderBlobCanvas via a Proxy-based mock context.

function makeNode(id: string, overrides: Partial<BlobNode> = {}): BlobNode {
  const data: BlobNodeData = { kind: "branch", topic: "t", summary: "s", chainSteps: [] };
  return {
    id, sessionId: "s", type: "branch",
    label: id,
    x: 0, y: 0,
    depth: 50, angle: 0,
    data,
    status: "idle",
    createdAt: "2026-01-01",
    growthProgress: 1,
    ...overrides,
  };
}

function makeEdge(id: string, from: string, to: string, overrides: Partial<BlobEdge> = {}): BlobEdge {
  return {
    id, sessionId: "s", from, to, type: "branch", growthProgress: 1, ...overrides,
  };
}

// ─── tickPhysics ───────────────────────────────────────────────────────

describe("tickPhysics", () => {
  it("returns a new map (does not mutate the input)", () => {
    const nodes = new Map([["a", makeNode("a", { x: 100, y: 100 })]]);
    const out = tickPhysics(nodes, new Map(), 0);
    expect(out).not.toBe(nodes);
  });

  it("leaves core nodes untouched (no breathing / spring)", () => {
    const core = makeNode("core", { type: "core", x: 0, y: 0, growthProgress: 1, data: { kind: "core", messages: [] } });
    const nodes = new Map([["core", core]]);
    const out = tickPhysics(nodes, new Map(), 1000);
    const updated = out.get("core")!;
    expect(updated.x).toBe(0);
    expect(updated.y).toBe(0);
  });

  it("skips nodes whose growthProgress is below 0.1", () => {
    const a = makeNode("a", { x: 50, y: 50, growthProgress: 0.05 });
    const nodes = new Map([["a", a]]);
    const out = tickPhysics(nodes, new Map(), 1000);
    const updated = out.get("a")!;
    expect(updated.x).toBe(50);
    expect(updated.y).toBe(50);
  });

  it("advances growthProgress on under-grown nodes", () => {
    // Use a 4-char id so the breathing phase computes from valid charCodes.
    const a = makeNode("baby", { growthProgress: 0.5 });
    const nodes = new Map([["baby", a]]);
    const out = tickPhysics(nodes, new Map(), 0);
    expect(out.get("baby")!.growthProgress).toBeGreaterThan(0.5);
  });

  it("clamps growthProgress at 1", () => {
    const a = makeNode("baby", { growthProgress: 1 });
    const nodes = new Map([["baby", a]]);
    const out = tickPhysics(nodes, new Map(), 0);
    expect(out.get("baby")!.growthProgress).toBe(1);
  });

  it("applies a spring force pulling connected nodes toward rest length", () => {
    // Two nodes very far apart — spring should pull them closer.
    const a = makeNode("baby", { x: 0, y: 0 });
    const b = makeNode("babb", { x: 1000, y: 0 });
    const nodes = new Map([["baby", a], ["babb", b]]);
    const edges = new Map([["e1", makeEdge("e1", "baby", "babb")]]);
    const out = tickPhysics(nodes, edges, 0);
    const aNew = out.get("baby")!;
    const bNew = out.get("babb")!;
    // a should drift right (positive x), b should drift left.
    expect(aNew.x).toBeGreaterThan(0);
    expect(bNew.x).toBeLessThan(1000);
  });

  it("repels siblings that are closer than 60 pixels", () => {
    // Two non-core nodes, no edge between them, within repulsion range.
    const a = makeNode("baby", { x: 0, y: 0 });
    const b = makeNode("babb", { x: 30, y: 0 });
    const nodes = new Map([["baby", a], ["babb", b]]);
    const out = tickPhysics(nodes, new Map(), 0);
    const aNew = out.get("baby")!;
    const bNew = out.get("babb")!;
    // Distance between the two should grow (repulsion).
    const distBefore = 30;
    const distAfter = Math.abs(bNew.x - aNew.x);
    expect(distAfter).toBeGreaterThan(distBefore);
  });

  it("ignores edges referencing missing nodes (no crash)", () => {
    const a = makeNode("baby", { x: 0, y: 0 });
    const nodes = new Map([["baby", a]]);
    const edges = new Map([["e1", makeEdge("e1", "baby", "ghost")]]);
    expect(() => tickPhysics(nodes, edges, 0)).not.toThrow();
  });

  it("advances growthProgress on under-grown edges (mutates edges map)", () => {
    const edges = new Map([["e1", makeEdge("e1", "a", "b", { growthProgress: 0.3 })]]);
    tickPhysics(new Map(), edges, 0);
    expect(edges.get("e1")!.growthProgress).toBeGreaterThan(0.3);
  });
});

// ─── blobNodeAt ────────────────────────────────────────────────────────

describe("blobNodeAt", () => {
  it("returns null when no node lies under the point", () => {
    const nodes = new Map([["a", makeNode("a", { x: 0, y: 0 })]]);
    expect(blobNodeAt(1000, 1000, { x: 0, y: 0, zoom: 1 }, nodes)).toBeNull();
  });

  it("hits a node within its base radius × 2", () => {
    const nodes = new Map([["a", makeNode("a", { x: 100, y: 100 })]]);
    // Hit dead center.
    expect(blobNodeAt(100, 100, { x: 0, y: 0, zoom: 1 }, nodes)).toBe("a");
  });

  it("returns the closest node when several overlap", () => {
    const nodes = new Map([
      ["a", makeNode("a", { x: 100, y: 100 })],
      ["b", makeNode("b", { x: 110, y: 100 })],
    ]);
    // Click slightly closer to b.
    expect(blobNodeAt(108, 100, { x: 0, y: 0, zoom: 1 }, nodes)).toBe("b");
  });

  it("inverts the camera transform", () => {
    const nodes = new Map([["a", makeNode("a", { x: 100, y: 100 })]]);
    // Camera offset (50, 0) zoom 1 → screen (150, 100) maps to canvas (100, 100).
    expect(blobNodeAt(150, 100, { x: 50, y: 0, zoom: 1 }, nodes)).toBe("a");
  });
});

// ─── renderBlobCanvas (smoke) ──────────────────────────────────────────

function makeProxyCtx() {
  // Same Proxy trick as canvasRenderer-render: any unmocked method becomes a
  // no-op vi.fn so the renderer's wide call surface is absorbed silently.
  const cache = new Map<string, ReturnType<typeof vi.fn>>();
  function fnFor(key: string) {
    let f = cache.get(key);
    if (!f) {
      f = vi.fn(() => new Proxy({}, { get: () => () => undefined }));
      cache.set(key, f);
    }
    return f;
  }
  const props: Record<string, unknown> = {
    fillStyle: "", strokeStyle: "", lineWidth: 1,
    font: "12px sans-serif", textAlign: "left", textBaseline: "alphabetic",
    shadowColor: "", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    globalAlpha: 1, lineCap: "butt", lineJoin: "miter", miterLimit: 10,
    imageSmoothingEnabled: true, direction: "ltr", filter: "none",
    globalCompositeOperation: "source-over",
  };
  const proxy = new Proxy(props, {
    get: (target, prop: string) => {
      if (prop in target) return target[prop];
      if (prop === "measureText") return () => ({ width: 50 });
      if (prop === "createImageData") return (w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4), width: w, height: h,
      });
      if (prop === "getImageData") return (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4), width: w, height: h,
      });
      return fnFor(prop);
    },
    set: (target, prop: string, value) => {
      target[prop] = value;
      return true;
    },
  });
  return proxy as unknown as CanvasRenderingContext2D;
}
const makeCtx = makeProxyCtx;

function makeCanvasEl() {
  const parent = { clientWidth: 400, clientHeight: 300 } as HTMLElement;
  return {
    parentElement: parent,
    width: 400, height: 300,
    getContext: () => makeCtx(),
  } as unknown as HTMLCanvasElement;
}

describe("renderBlobCanvas — smoke", () => {
  it("renders an empty graph without throwing", () => {
    const ctx = makeCtx();
    expect(() =>
      renderBlobCanvas(
        ctx, makeCanvasEl(), { x: 0, y: 0, zoom: 1 },
        new Map(), new Map(), null, false, 0,
      ),
    ).not.toThrow();
  });

  it("renders with multiple node types without throwing", () => {
    const ctx = makeCtx();
    const nodes = new Map<string, BlobNode>([
      ["core", makeNode("core", { type: "core", x: 0, y: 0, data: { kind: "core", messages: [] } })],
      ["a", makeNode("a", { type: "branch", x: 100, y: 0 })],
      ["b", makeNode("b", { type: "step", x: -100, y: 50, data: { kind: "step", stepType: "agent", prompt: "hi" } })],
      ["c", makeNode("c", { type: "memory", x: 0, y: 100, data: { kind: "memory", concept: "x", facts: [], connections: [] } })],
    ]);
    const edges = new Map([
      ["e1", makeEdge("e1", "core", "a", { type: "root" })],
      ["e2", makeEdge("e2", "core", "b", { type: "branch" })],
      ["e3", makeEdge("e3", "core", "c", { type: "memory" })],
    ]);
    expect(() =>
      renderBlobCanvas(
        ctx, makeCanvasEl(), { x: 200, y: 150, zoom: 1 },
        nodes, edges, "a", false, 1234,
      ),
    ).not.toThrow();
  });
});
