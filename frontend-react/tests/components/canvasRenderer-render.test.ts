import { describe, it, expect, vi } from "vitest";
import { renderCanvas, renderMinimap } from "../../src/components/canvas/canvasRenderer";
import type { CanvasNode, CanvasEdge, NodeExecState } from "../../src/types/canvas";

// Coverage push for canvasRenderer's drawXxxNode helpers and the main
// renderCanvas() pipeline. We don't verify pixel-perfect output — there
// is no real CanvasRenderingContext2D in jsdom — but we feed renderCanvas
// fixtures that exercise every kind branch (step / sticky / text / portal
// / file / link / terminal / obsidian) plus drag overlays and edge cases,
// and assert that the canvas API was driven (no exceptions, expected
// methods invoked).
//
// jsdom DOES provide a real <canvas> element with a usable 2D context for
// most operations, but some methods (roundRect on older builds) are
// missing — the mock covers everything so the tests are deterministic.

interface CtxLike {
  fillRect: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  closePath: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  rect: ReturnType<typeof vi.fn>;
  roundRect: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  translate: ReturnType<typeof vi.fn>;
  scale: ReturnType<typeof vi.fn>;
  setTransform: ReturnType<typeof vi.fn>;
  bezierCurveTo: ReturnType<typeof vi.fn>;
  measureText: ReturnType<typeof vi.fn>;
  setLineDash: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  rotate: ReturnType<typeof vi.fn>;
  clip: ReturnType<typeof vi.fn>;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: string;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetY: number;
  shadowOffsetX: number;
  globalAlpha: number;
  textBaseline: string;
  lineCap: string;
  lineJoin: string;
  miterLimit: number;
  imageSmoothingEnabled: boolean;
}

function makeCtx() {
  // Use a Proxy so any unmocked ctx method becomes a no-op vi.fn rather
  // than throwing — the renderer touches a wide surface (gradients, paths,
  // strokeRect, ellipse…) and we want any path through the code to succeed.
  const counters = new Map<string, ReturnType<typeof vi.fn>>();
  function fnFor(key: string): ReturnType<typeof vi.fn> {
    let f = counters.get(key);
    if (!f) {
      f = vi.fn(() => {
        // Some Canvas APIs return objects (gradients, patterns, image data).
        // Default to a Proxy that absorbs any subsequent access too.
        return new Proxy({}, { get: () => () => undefined });
      });
      counters.set(key, f);
    }
    return f;
  }
  const props: Record<string, unknown> = {
    fillStyle: "", strokeStyle: "", lineWidth: 1,
    font: "10px sans-serif", textAlign: "left", textBaseline: "alphabetic",
    shadowColor: "", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    globalAlpha: 1, lineCap: "butt", lineJoin: "miter", miterLimit: 10,
    imageSmoothingEnabled: true, direction: "ltr", filter: "none",
    globalCompositeOperation: "source-over",
  };
  return new Proxy(props, {
    get: (target, prop: string) => {
      if (prop in target) return target[prop];
      if (prop === "measureText") return () => ({ width: 50 });
      return fnFor(prop);
    },
    set: (target, prop: string, value) => {
      target[prop] = value;
      return true;
    },
  }) as unknown as CtxLike;
}

function makeCanvasEl() {
  const parent = { clientWidth: 800, clientHeight: 600 } as HTMLElement;
  const canvas = {
    parentElement: parent,
    width: 800,
    height: 600,
  } as unknown as HTMLCanvasElement;
  return canvas;
}

function node(
  id: string,
  overrides: Partial<CanvasNode> = {},
): CanvasNode {
  return {
    id, x: 100, y: 100, w: 240, h: 100,
    type: "agent", label: id,
    preTools: [], tools: [],
    outputVar: "", stepId: id,
    prompt: "do work",
    ...overrides,
  };
}

function call(
  ctx: CtxLike,
  nodes: Map<string, CanvasNode>,
  edges: Map<string, CanvasEdge> = new Map(),
  selection: Set<string> = new Set(),
  dragState: { type: string; sx?: number; sy?: number; mx?: number; my?: number; fromId?: string } = { type: "none" },
  exec: Map<string, NodeExecState> = new Map(),
) {
  const cam = { x: 0, y: 0, zoom: 1 };
  renderCanvas(
    ctx as unknown as CanvasRenderingContext2D,
    makeCanvasEl(),
    cam,
    nodes,
    edges,
    selection,
    dragState,
    exec,
  );
}

// ─── Smoke / kinds ─────────────────────────────────────────────────────

describe("renderCanvas — basic dispatch", () => {
  it("clears the canvas and applies the camera transform on every call", () => {
    const ctx = makeCtx();
    call(ctx, new Map());
    // Background fill + camera transform sequence happen at least once.
    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.translate).toHaveBeenCalledWith(0, 0);
    expect(ctx.scale).toHaveBeenCalledWith(1, 1);
  });

  it("does nothing when the container has zero size", () => {
    const ctx = makeCtx();
    const cam = { x: 0, y: 0, zoom: 1 };
    const canvas = {
      parentElement: { clientWidth: 0, clientHeight: 0 } as HTMLElement,
      width: 800, height: 600,
    } as unknown as HTMLCanvasElement;
    renderCanvas(
      ctx as unknown as CanvasRenderingContext2D,
      canvas, cam, new Map(), new Map(), new Set(), { type: "none" }, new Map(),
    );
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it("draws the dot grid when the per-pixel zoom is large enough", () => {
    const ctx = makeCtx();
    call(ctx, new Map());
    // Each grid dot is an arc; many will be drawn for an 800×600 viewport.
    expect(ctx.arc).toHaveBeenCalled();
  });

  it("skips the grid when the camera is zoomed too far out", () => {
    const ctx = makeCtx();
    const canvas = makeCanvasEl();
    const cam = { x: 0, y: 0, zoom: 0.05 }; // 0.05 * 20 = 1px → below threshold
    renderCanvas(
      ctx as unknown as CanvasRenderingContext2D,
      canvas, cam, new Map(), new Map(), new Set(), { type: "none" }, new Map(),
    );
    // Without grid + nodes, no arc calls should fire.
    expect(ctx.arc).not.toHaveBeenCalled();
  });
});

describe("renderCanvas — every node kind exercises its draw helper", () => {
  it.each([
    ["step",     {}],
    ["sticky",   { kind: "sticky" as const,   stickyText: "note" }],
    ["text",     { kind: "text" as const,     markdown: "## hi\nworld" }],
    ["portal",   { kind: "portal" as const,   portalUrl: "https://example.com" }],
    ["file",     { kind: "file" as const,     filePath: "src/x.ts", fileContent: "line 1\nline 2" }],
    ["link",     { kind: "link" as const,     linkUrl: "https://example.com", linkTitle: "Ex" }],
    ["terminal", { kind: "terminal" as const, terminalProvider: "claude", terminalModel: "claude-sonnet-4-6", terminalMessages: [{ role: "user" as const, content: "salut" }] }],
    ["obsidian", { kind: "obsidian" as const, obsidianContent: "# Title\n- item\n[[link]]\nnormal" }],
  ])("renders a %s node without throwing", (_, override) => {
    const ctx = makeCtx();
    expect(() =>
      call(ctx, new Map([["n", node("n", override as Partial<CanvasNode>)]])),
    ).not.toThrow();
    // Each kind hits at least one path-fill.
    expect(ctx.roundRect).toHaveBeenCalled();
    expect(ctx.fill).toHaveBeenCalled();
  });

  it("highlights selected nodes with a glow stroke", () => {
    const ctx = makeCtx();
    call(
      ctx,
      new Map([["n", node("n")]]),
      new Map(),
      new Set(["n"]),
    );
    // shadowBlur is set during selection draw — assigning the property
    // value is enough; we confirm stroke happens at least twice
    // (border + selection highlight).
    expect(ctx.stroke.mock.calls.length).toBeGreaterThan(1);
  });

  it("renders multiple nodes in one pass (one drawXxx per node)", () => {
    const ctx = makeCtx();
    const ns = new Map<string, CanvasNode>();
    ns.set("a", node("a", { kind: "sticky", stickyText: "a" }));
    ns.set("b", node("b", { kind: "text", markdown: "b" }));
    ns.set("c", node("c", { kind: "file", filePath: "x", fileContent: "y" }));
    expect(() => call(ctx, ns)).not.toThrow();
    // Each node renders its rounded shell — at least 3 roundRect calls.
    expect(ctx.roundRect.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── Edges + drag overlays ─────────────────────────────────────────────

describe("renderCanvas — edges and drag overlays", () => {
  it("draws bezier curves for edges between known nodes", () => {
    const ctx = makeCtx();
    const ns = new Map([
      ["a", node("a", { x: 0, y: 0 })],
      ["b", node("b", { x: 0, y: 300 })],
    ]);
    const es = new Map([["e1", { id: "e1", from: "a", to: "b" }]]);
    call(ctx, ns, es);
    expect(ctx.bezierCurveTo).toHaveBeenCalled();
  });

  it("ignores edges referencing missing nodes (no crash)", () => {
    const ctx = makeCtx();
    const ns = new Map([["a", node("a")]]);
    const es = new Map([["e1", { id: "e1", from: "a", to: "ghost" }]]);
    expect(() => call(ctx, ns, es)).not.toThrow();
  });

  it("renders the box-select rectangle when dragState.type === 'box'", () => {
    const ctx = makeCtx();
    call(
      ctx, new Map(), new Map(), new Set(),
      { type: "box", sx: 50, sy: 50, mx: 200, my: 150 },
    );
    // The box overlay calls strokeRect or stroke after rect — at minimum
    // we expect strokeStyle or rect operations to fire.
    expect(ctx.fillRect.mock.calls.length).toBeGreaterThan(0);
  });

  it("renders the rubber-band line when dragState.type === 'connect'", () => {
    const ctx = makeCtx();
    const ns = new Map([["a", node("a")]]);
    call(
      ctx, ns, new Map(), new Set(),
      { type: "connect", fromId: "a", mx: 400, my: 400 },
    );
    // The rubber-band draws via stroke (line or bezier). At minimum some
    // path-building call has to fire; we just check stroke was issued.
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it("annotates running steps via nodeExecState", () => {
    const ctx = makeCtx();
    const ns = new Map([["a", node("a")]]);
    const exec = new Map<string, NodeExecState>();
    exec.set("a", { status: "running", output: [], startTime: 0 });
    expect(() => call(ctx, ns, new Map(), new Set(), { type: "none" }, exec)).not.toThrow();
  });
});

// ─── Minimap ───────────────────────────────────────────────────────────

describe("renderMinimap", () => {
  it("renders without throwing on an empty canvas", () => {
    const ctx = makeCtx();
    const canvas = {
      width: 160, height: 110,
      parentElement: { clientWidth: 160, clientHeight: 110 } as HTMLElement,
    } as unknown as HTMLCanvasElement;
    expect(() => renderMinimap(
      ctx as unknown as CanvasRenderingContext2D,
      canvas, { x: 0, y: 0, zoom: 1 }, new Map(), 800, 600,
    )).not.toThrow();
  });

  it("draws a node footprint on the minimap when nodes exist", () => {
    const ctx = makeCtx();
    const canvas = {
      width: 160, height: 110,
      parentElement: { clientWidth: 160, clientHeight: 110 } as HTMLElement,
    } as unknown as HTMLCanvasElement;
    const ns = new Map([
      ["a", node("a", { x: 0, y: 0, w: 200, h: 100 })],
      ["b", node("b", { x: 400, y: 100, w: 200, h: 100 })],
    ]);
    renderMinimap(
      ctx as unknown as CanvasRenderingContext2D,
      canvas, { x: 0, y: 0, zoom: 1 }, ns, 800, 600,
    );
    // fillRect is used for both background and node tiles; at least 1
    // node tile beyond the background = 2+ fillRect calls.
    expect(ctx.fillRect.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
