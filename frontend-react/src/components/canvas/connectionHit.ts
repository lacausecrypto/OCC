/**
 * Edge hit detection for canvas connections.
 * Tests if a point in canvas-space is close to a bezier curve edge.
 * Uses recursive subdivision for accurate distance testing.
 */
import type { CanvasNode, CanvasEdge } from "../../types/canvas";
import { getRopeState, computeTargetSag, getRopeControlPoints } from "./ropePhysics";

/** Port position — mirrors the one in canvasRenderer.ts */
function portPos(n: CanvasNode, port: "in" | "out"): { x: number; y: number } {
  return port === "in"
    ? { x: n.x + n.w / 2, y: n.y }
    : { x: n.x + n.w / 2, y: n.y + n.h };
}

/** Point on a cubic bezier at parameter t (0..1) */
function bezierPoint(
  x0: number, y0: number,
  cp1x: number, cp1y: number,
  cp2x: number, cp2y: number,
  x1: number, y1: number,
  t: number,
): { x: number; y: number } {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: mt3 * x0 + 3 * mt2 * t * cp1x + 3 * mt * t2 * cp2x + t3 * x1,
    y: mt3 * y0 + 3 * mt2 * t * cp1y + 3 * mt * t2 * cp2y + t3 * y1,
  };
}

/** Distance from point to a cubic bezier curve, sampled at N points */
function distToBezier(
  px: number, py: number,
  x0: number, y0: number,
  cp1x: number, cp1y: number,
  cp2x: number, cp2y: number,
  x1: number, y1: number,
  samples = 32,
): number {
  let minDist = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const pt = bezierPoint(x0, y0, cp1x, cp1y, cp2x, cp2y, x1, y1, t);
    const dx = px - pt.x;
    const dy = py - pt.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

/**
 * Find which edge (if any) a canvas-space point is near.
 * Returns the edge ID or null.
 */
export function edgeAt(
  canvasX: number,
  canvasY: number,
  edges: Map<string, CanvasEdge>,
  nodes: Map<string, CanvasNode>,
  hitRadius = 8,
): string | null {
  let closestId: string | null = null;
  let closestDist = hitRadius;

  for (const edge of edges.values()) {
    const fromNode = nodes.get(edge.from);
    const toNode = nodes.get(edge.to);
    if (!fromNode || !toNode) continue;

    const fp = portPos(fromNode, "out");
    const tp = portPos(toNode, "in");

    // Get rope control points (same as renderer uses)
    const ropeState = getRopeState(edge.id);
    ropeState.targetSag = computeTargetSag(fp.x, fp.y, tp.x, tp.y);
    const [cp1x, cp1y, cp2x, cp2y] = getRopeControlPoints(
      fp.x, fp.y, tp.x, tp.y, ropeState.sag,
    );

    // Apply custom control point offsets if present
    const finalCp1x = cp1x + (edge.cp1?.dx ?? 0);
    const finalCp1y = cp1y + (edge.cp1?.dy ?? 0);
    const finalCp2x = cp2x + (edge.cp2?.dx ?? 0);
    const finalCp2y = cp2y + (edge.cp2?.dy ?? 0);

    const dist = distToBezier(
      canvasX, canvasY,
      fp.x, fp.y,
      finalCp1x, finalCp1y,
      finalCp2x, finalCp2y,
      tp.x, tp.y,
    );

    if (dist < closestDist) {
      closestDist = dist;
      closestId = edge.id;
    }
  }

  return closestId;
}

/**
 * Find the closest control point handle on a selected edge.
 * Returns "cp1" | "cp2" | null and the handle position.
 */
export function controlPointAt(
  canvasX: number,
  canvasY: number,
  edge: CanvasEdge,
  nodes: Map<string, CanvasNode>,
  hitRadius = 10,
): { handle: "cp1" | "cp2"; x: number; y: number } | null {
  const fromNode = nodes.get(edge.from);
  const toNode = nodes.get(edge.to);
  if (!fromNode || !toNode) return null;

  const fp = portPos(fromNode, "out");
  const tp = portPos(toNode, "in");

  const ropeState = getRopeState(edge.id);
  ropeState.targetSag = computeTargetSag(fp.x, fp.y, tp.x, tp.y);
  const [cp1x, cp1y, cp2x, cp2y] = getRopeControlPoints(
    fp.x, fp.y, tp.x, tp.y, ropeState.sag,
  );

  const handles: Array<{ handle: "cp1" | "cp2"; x: number; y: number }> = [
    { handle: "cp1", x: cp1x + (edge.cp1?.dx ?? 0), y: cp1y + (edge.cp1?.dy ?? 0) },
    { handle: "cp2", x: cp2x + (edge.cp2?.dx ?? 0), y: cp2y + (edge.cp2?.dy ?? 0) },
  ];

  for (const h of handles) {
    const dx = canvasX - h.x;
    const dy = canvasY - h.y;
    if (Math.sqrt(dx * dx + dy * dy) < hitRadius) return h;
  }

  return null;
}

/**
 * Get the midpoint of an edge curve (for popover positioning).
 */
export function edgeMidpoint(
  edge: CanvasEdge,
  nodes: Map<string, CanvasNode>,
): { x: number; y: number } | null {
  const fromNode = nodes.get(edge.from);
  const toNode = nodes.get(edge.to);
  if (!fromNode || !toNode) return null;

  const fp = portPos(fromNode, "out");
  const tp = portPos(toNode, "in");

  const ropeState = getRopeState(edge.id);
  const [cp1x, cp1y, cp2x, cp2y] = getRopeControlPoints(
    fp.x, fp.y, tp.x, tp.y, ropeState.sag,
  );

  return bezierPoint(
    fp.x, fp.y,
    cp1x + (edge.cp1?.dx ?? 0), cp1y + (edge.cp1?.dy ?? 0),
    cp2x + (edge.cp2?.dx ?? 0), cp2y + (edge.cp2?.dy ?? 0),
    tp.x, tp.y,
    0.5,
  );
}
