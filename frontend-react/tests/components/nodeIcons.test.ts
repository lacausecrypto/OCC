import { describe, it, expect, vi } from "vitest";
import { drawNodeIcon } from "../../src/components/canvas/nodeIcons";

function createMockCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    ellipse: vi.fn(),
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    lineCap: "" as CanvasLineCap,
    lineJoin: "" as CanvasLineJoin,
  } as unknown as CanvasRenderingContext2D;
}

describe("drawNodeIcon", () => {
  const allTypes = [
    "agent", "router", "evaluator", "gate", "transform",
    "loop", "merge", "webhook", "subchain", "debate", "browser",
  ];

  for (const type of allTypes) {
    it(`draws ${type} icon without error`, () => {
      const ctx = createMockCtx();
      expect(() => drawNodeIcon(ctx, type, 50, 50, "#0a84ff")).not.toThrow();
      expect(ctx.save).toHaveBeenCalled();
      expect(ctx.restore).toHaveBeenCalled();
      expect(ctx.translate).toHaveBeenCalledWith(50, 50);
    });
  }

  it("draws default dot for unknown type", () => {
    const ctx = createMockCtx();
    drawNodeIcon(ctx, "unknown-type", 0, 0, "#fff");
    expect(ctx.arc).toHaveBeenCalled();
    expect(ctx.fill).toHaveBeenCalled();
  });

  it("sets correct color properties", () => {
    const ctx = createMockCtx();
    drawNodeIcon(ctx, "agent", 0, 0, "#ff0000");
    expect(ctx.strokeStyle).toBe("#ff0000");
    expect(ctx.fillStyle).toBe("#ff0000");
  });

  it("sets line properties", () => {
    const ctx = createMockCtx();
    drawNodeIcon(ctx, "agent", 0, 0, "#000");
    expect(ctx.lineWidth).toBe(1.5);
    expect(ctx.lineCap).toBe("round");
    expect(ctx.lineJoin).toBe("round");
  });

  it("evaluator uses fillRect for bar chart", () => {
    const ctx = createMockCtx();
    drawNodeIcon(ctx, "evaluator", 0, 0, "#000");
    expect(ctx.fillRect).toHaveBeenCalledTimes(3); // 3 bars
  });

  it("subchain uses strokeRect for nested boxes", () => {
    const ctx = createMockCtx();
    drawNodeIcon(ctx, "subchain", 0, 0, "#000");
    expect(ctx.strokeRect).toHaveBeenCalledTimes(2); // 2 boxes
  });

  it("browser uses ellipse for globe", () => {
    const ctx = createMockCtx();
    drawNodeIcon(ctx, "browser", 0, 0, "#000");
    expect(ctx.ellipse).toHaveBeenCalled();
  });
});
