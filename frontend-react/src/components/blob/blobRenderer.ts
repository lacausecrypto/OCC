/**
 * blobRenderer.ts — Physarum pixel renderer + node overlay.
 * The slime mold simulation runs on pixel data.
 * BLOB nodes are food sources that attract the organism.
 * Labels and UI elements are drawn on top.
 *
 * All colors are derived from the Design Space CSS variables (--m-accent,
 * --icon-*, --c-success, --c-error, --m-text, --m-bg, --m-font).
 */

import type { BlobNode, BlobEdge, BlobCamera } from "../../types/blob";
import { PhysarumSimulation, type FoodSource, type VeinPath } from "./physarumSim";

// ─── Dynamic node colors from Design Space ─────────────────────────────────

interface RGB { r: number; g: number; b: number }

/** Parse a CSS color value (hex, hsl, rgb) to RGB. */
function parseCssColor(val: string): RGB {
  val = val.trim();

  // Hex
  if (val.startsWith("#") && val.length >= 7) {
    return { r: parseInt(val.slice(1, 3), 16), g: parseInt(val.slice(3, 5), 16), b: parseInt(val.slice(5, 7), 16) };
  }
  if (val.startsWith("#") && val.length === 4) {
    return { r: parseInt(val[1] + val[1], 16), g: parseInt(val[2] + val[2], 16), b: parseInt(val[3] + val[3], 16) };
  }

  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgbM = val.match(/rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/);
  if (rgbM) return { r: parseInt(rgbM[1]), g: parseInt(rgbM[2]), b: parseInt(rgbM[3]) };

  // hsl(h, s%, l%)
  const hslM = val.match(/hsla?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)%?\s*[,\s]\s*([\d.]+)%?/);
  if (hslM) {
    const h = parseFloat(hslM[1]) / 360;
    const s = parseFloat(hslM[2]) / 100;
    const l = parseFloat(hslM[3]) / 100;
    if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      g: Math.round(hue2rgb(p, q, h) * 255),
      b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    };
  }

  return { r: 255, g: 220, b: 40 }; // fallback yellow
}

function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Build the node color palette from the current Design Space state. */
function buildNodeColors(): Record<string, RGB> {
  // Read icon-* variables set by applyBlend() in the design store
  const accent = parseCssColor(getCssVar("--m-accent") || "#0a84ff");
  const blue   = parseCssColor(getCssVar("--icon-blue") || "#0a84ff");
  const green  = parseCssColor(getCssVar("--icon-green") || "#30d158");
  const orange = parseCssColor(getCssVar("--icon-orange") || "#ff9f0a");
  const cyan   = parseCssColor(getCssVar("--icon-cyan") || "#64d2ff");
  const red    = parseCssColor(getCssVar("--icon-red") || "#ff375f");

  // Brighten colors for the physarum glow (canvas needs higher luminance)
  const brighten = (c: RGB, factor = 1.3): RGB => ({
    r: Math.min(255, Math.round(c.r * factor)),
    g: Math.min(255, Math.round(c.g * factor)),
    b: Math.min(255, Math.round(c.b * factor)),
  });

  return {
    core:   brighten(accent, 1.4),  // The BLOB — accent color, extra bright
    branch: brighten(green),         // Branches — green family
    step:   brighten(orange),        // Steps — orange family
    memory: brighten(blue),          // Memory — blue family
    input:  brighten(cyan),          // Input — cyan family
    output: brighten(green, 1.2),    // Output — green variant
    fork:   brighten(red),           // Fork — red family
  };
}

/** Read the current success/error colors from CSS. */
function getStatusColors(): { success: RGB; error: RGB } {
  return {
    success: parseCssColor(getCssVar("--c-success") || "#30d158"),
    error:   parseCssColor(getCssVar("--c-error") || "#ff375f"),
  };
}

function getBaseRadius(node: BlobNode): number {
  switch (node.type) {
    case "core": return 20;
    case "branch": return 10;
    case "step": return 6;
    case "memory": return 5;
    case "fork": return 5;
    default: return 6;
  }
}

function getFoodStrength(node: BlobNode): number {
  switch (node.type) {
    case "core": return 15;
    case "branch": return 6;
    case "step": return 3;
    case "memory": return 2;
    default: return 3;
  }
}

// ─── Simulation singleton ───────────────────────────────────────────────────

let sim: PhysarumSimulation | null = null;
let lastCamX = 0, lastCamY = 0, lastCamZoom = 1;
let tmpCanvas: HTMLCanvasElement | null = null;
let tmpCtx: CanvasRenderingContext2D | null = null;
let cachedImgData: ImageData | null = null;

/** Track previous node statuses to detect transitions */
const prevNodeStatuses = new Map<string, string>();

// ─── Physics (simple spring + breathing) ────────────────────────────────────

export function tickPhysics(
  nodes: Map<string, BlobNode>,
  edges: Map<string, BlobEdge>,
  time: number,
): Map<string, BlobNode> {
  const updated = new Map(nodes);

  for (const [id, node] of updated) {
    if (node.type === "core") continue;
    if (node.growthProgress < 0.1) continue;

    let fx = 0, fy = 0;

    // Breathing
    const phase = (id.charCodeAt(2) + id.charCodeAt(3)) * 0.1;
    fx += Math.sin(time * 0.0006 + phase) * 0.1;
    fy += Math.cos(time * 0.0005 + phase * 1.3) * 0.08;

    // Spring to parent
    for (const [, edge] of edges) {
      if (edge.to !== id && edge.from !== id) continue;
      const otherId = edge.to === id ? edge.from : edge.to;
      const other = nodes.get(otherId);
      if (!other) continue;
      const dx = other.x - node.x;
      const dy = other.y - node.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const restLen = 80;
      const displacement = dist - restLen;
      const springK = 0.001;
      fx += (dx / dist) * displacement * springK;
      fy += (dy / dist) * displacement * springK;
    }

    // Sibling repulsion
    for (const [otherId, other] of nodes) {
      if (otherId === id || other.type === "core") continue;
      const dx = node.x - other.x;
      const dy = node.y - other.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      if (dist < 60) {
        const force = 0.05 * (60 - dist) / 60;
        fx += (dx / dist) * force;
        fy += (dy / dist) * force;
      }
    }

    updated.set(id, { ...node, x: node.x + fx, y: node.y + fy });
  }

  // Growth
  for (const [id, node] of updated) {
    if (node.growthProgress < 1) {
      updated.set(id, { ...node, growthProgress: Math.min(1, node.growthProgress + 0.012) });
    }
  }
  for (const [id, edge] of edges) {
    if (edge.growthProgress < 1) {
      edges.set(id, { ...edge, growthProgress: Math.min(1, edge.growthProgress + 0.01) });
    }
  }

  return updated;
}

// ─── Parse bg color ─────────────────────────────────────────────────────────

function parseBgColor(): RGB {
  return parseCssColor(getCssVar("--m-bg") || "#0d0d0d");
}

// ─── Main render ────────────────────────────────────────────────────────────

export function renderBlobCanvas(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  camera: BlobCamera,
  nodes: Map<string, BlobNode>,
  edges: Map<string, BlobEdge>,
  time: number,
) {
  const dpr = window.devicePixelRatio || 1;
  const pw = canvas.parentElement?.clientWidth ?? 0;
  const ph = canvas.parentElement?.clientHeight ?? 0;
  if (pw < 10 || ph < 10) return;
  const w = pw;
  const h = ph;

  const simW = Math.floor(w);
  const simH = Math.floor(h);

  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }

  if (!sim || sim.width !== simW || sim.height !== simH) {
    sim = new PhysarumSimulation(simW, simH);
    lastCamX = camera.x; lastCamY = camera.y; lastCamZoom = camera.zoom;
  }

  // Clear trail map when camera moves
  const camDx = Math.abs(camera.x - lastCamX);
  const camDy = Math.abs(camera.y - lastCamY);
  const camDz = Math.abs(camera.zoom - lastCamZoom);
  if (camDx > 1 || camDy > 1 || camDz > 0.005) {
    sim.trailMap.fill(0);
    sim.colorMap.fill(0);
    lastCamX = camera.x; lastCamY = camera.y; lastCamZoom = camera.zoom;
  }

  // ─── Read dynamic colors from Design Space ────────────────
  const NODE_COLORS = buildNodeColors();
  const statusColors = getStatusColors();

  // ─── Map nodes to food sources (in screen coords) ─────────
  const foods: FoodSource[] = [];
  const coreColor = NODE_COLORS.core;
  let hasCore = false;

  for (const [, node] of nodes) {
    if (node.growthProgress < 0.1) continue;
    const c = NODE_COLORS[node.type] ?? NODE_COLORS.step;
    const screenX = node.x * camera.zoom + w / 2 + camera.x;
    const screenY = node.y * camera.zoom + h / 2 + camera.y;
    const baseR = getBaseRadius(node) * node.growthProgress * camera.zoom;
    const baseS = getFoodStrength(node) * node.growthProgress;
    foods.push({ x: screenX, y: screenY, radius: baseR, strength: baseS, r: c.r, g: c.g, b: c.b });

    if (node.type === "core") {
      hasCore = true;
      // Gentle breathing
      const breath = Math.sin(time * 0.0008) * 2 * camera.zoom;
      foods[foods.length - 1].radius = baseR + breath;
      foods[foods.length - 1].strength = baseS + Math.sin(time * 0.001) * 2;
    }
  }

  // Fallback: always show a living blob at center
  if (!hasCore) {
    const cx = w / 2 + camera.x;
    const cy = h / 2 + camera.y;
    const breath = Math.sin(time * 0.0008) * 2 * camera.zoom;
    foods.push({ x: cx, y: cy, radius: (20 + breath) * camera.zoom, strength: 15 + Math.sin(time * 0.001) * 2, r: coreColor.r, g: coreColor.g, b: coreColor.b });
  }

  sim.setFoodSources(foods);

  // ─── Build vein paths from edges ───────────────────────────
  const veins: VeinPath[] = [];
  for (const [, edge] of edges) {
    if (edge.growthProgress < 0.1) continue;
    const fromNode = nodes.get(edge.from);
    const toNode = nodes.get(edge.to);
    if (!fromNode || !toNode) continue;

    const fromC = NODE_COLORS[fromNode.type] ?? NODE_COLORS.step;
    const toC = NODE_COLORS[toNode.type] ?? NODE_COLORS.step;

    const sx1 = fromNode.x * camera.zoom + w / 2 + camera.x;
    const sy1 = fromNode.y * camera.zoom + h / 2 + camera.y;
    const sx2 = toNode.x * camera.zoom + w / 2 + camera.x;
    const sy2 = toNode.y * camera.zoom + h / 2 + camera.y;

    const ex = sx1 + (sx2 - sx1) * edge.growthProgress;
    const ey = sy1 + (sy2 - sy1) * edge.growthProgress;

    const isActive = fromNode.status === "running" || fromNode.status === "thinking"
                   || toNode.status === "running" || toNode.status === "thinking";

    veins.push({
      x1: sx1, y1: sy1,
      x2: ex, y2: ey,
      strength: 6 * edge.growthProgress,
      r: Math.round((fromC.r + toC.r) / 2),
      g: Math.round((fromC.g + toC.g) / 2),
      b: Math.round((fromC.b + toC.b) / 2),
      active: isActive,
    });
  }
  sim.setVeinPaths(veins);

  // ─── Detect status transitions and trigger pulses ──────────
  for (const [, node] of nodes) {
    const prev = prevNodeStatuses.get(node.id);
    if (prev !== node.status) {
      const screenX = node.x * camera.zoom + w / 2 + camera.x;
      const screenY = node.y * camera.zoom + h / 2 + camera.y;

      if (node.status === "done" && prev !== undefined) {
        const sc = statusColors.success;
        sim.triggerPulse(screenX, screenY, 60 * camera.zoom, 15, sc.r, sc.g, sc.b);
      } else if (node.status === "error" && prev !== undefined) {
        const ec = statusColors.error;
        sim.triggerPulse(screenX, screenY, 30 * camera.zoom, 8, ec.r, ec.g, ec.b);
      }
    }
    prevNodeStatuses.set(node.id, node.status);
  }
  for (const id of prevNodeStatuses.keys()) {
    if (!nodes.has(id)) prevNodeStatuses.delete(id);
  }

  // ─── Run simulation step ────
  sim.tick();

  // ─── Render physarum to pixels ─────────────────────────────
  const bg = parseBgColor();
  if (!cachedImgData || cachedImgData.width !== simW || cachedImgData.height !== simH) {
    cachedImgData = ctx.createImageData(simW, simH);
  }
  const imgData = cachedImgData;
  sim.renderToImageData(imgData, bg.r, bg.g, bg.b);

  if (!tmpCanvas || tmpCanvas.width !== simW || tmpCanvas.height !== simH) {
    tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = simW;
    tmpCanvas.height = simH;
    tmpCtx = tmpCanvas.getContext("2d");
  }
  tmpCtx!.putImageData(imgData, 0, 0);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.drawImage(tmpCanvas, 0, 0, w, h);

  // ─── Draw labels on top ────────────────────────────────────
  ctx.save();
  ctx.translate(w / 2 + camera.x, h / 2 + camera.y);
  ctx.scale(camera.zoom, camera.zoom);

  const textColor = getCssVar("--m-text") || "#f5f5f7";
  const fontFamily = getCssVar("--m-font") || "-apple-system, BlinkMacSystemFont, sans-serif";

  for (const [, node] of nodes) {
    if (node.growthProgress < 0.3) continue;
    const r = getBaseRadius(node) * node.growthProgress;
    ctx.save();
    ctx.globalAlpha = node.growthProgress * 0.85;

    const fontSize = node.type === "core" ? 13 : node.type === "branch" ? 10 : 8;
    ctx.font = `600 ${fontSize}px ${fontFamily}`;
    ctx.fillStyle = textColor;
    ctx.textAlign = "center";

    // Shadow for readability
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 4;

    if (node.type === "core") {
      ctx.fillText("BLOB", node.x, node.y + r + 20);
    } else {
      const label = node.label.length > 18 ? node.label.slice(0, 16) + "..." : node.label;
      ctx.fillText(label, node.x, node.y + r + 16);
      // Type label in node color
      ctx.font = `500 7px ${fontFamily}`;
      const c = NODE_COLORS[node.type] ?? NODE_COLORS.step;
      ctx.fillStyle = `rgb(${c.r}, ${c.g}, ${c.b})`;
      ctx.fillText(node.type.toUpperCase(), node.x, node.y + r + 26);
    }

    // Status indicator — organic glow
    ctx.shadowBlur = 0;
    if (node.status === "running" || node.status === "thinking") {
      const pulse = 0.4 + Math.sin(time * 0.006) * 0.3;
      const glow = ctx.createRadialGradient(node.x, node.y, r, node.x, node.y, r + 12);
      glow.addColorStop(0, `rgba(255, 255, 255, ${pulse * 0.3})`);
      glow.addColorStop(1, "transparent");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 12, 0, Math.PI * 2);
      ctx.fill();
    } else if (node.status === "done") {
      const sc = statusColors.success;
      const glow = ctx.createRadialGradient(node.x, node.y, r * 0.5, node.x, node.y, r + 6);
      glow.addColorStop(0, `rgba(${sc.r}, ${sc.g}, ${sc.b}, 0.15)`);
      glow.addColorStop(1, "transparent");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 6, 0, Math.PI * 2);
      ctx.fill();
    } else if (node.status === "error") {
      const ec = statusColors.error;
      const glow = ctx.createRadialGradient(node.x, node.y, r * 0.5, node.x, node.y, r + 6);
      glow.addColorStop(0, `rgba(${ec.r}, ${ec.g}, ${ec.b}, 0.2)`);
      glow.addColorStop(1, "transparent");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 6, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  // Fallback BLOB label at center when no core node
  if (!hasCore) {
    ctx.font = `600 13px ${fontFamily}`;
    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 4;
    ctx.fillText("BLOB", 0, 50);
    ctx.shadowBlur = 0;
  }

  ctx.restore();
}

// ─── Hit testing ────────────────────────────────────────────────────────────

export function blobNodeAt(
  sx: number, sy: number,
  camera: BlobCamera,
  nodes: Map<string, BlobNode>,
): string | null {
  const cx = (sx - camera.x) / camera.zoom;
  const cy = (sy - camera.y) / camera.zoom;
  let closest: string | null = null;
  let closestDist = Infinity;
  for (const [id, node] of nodes) {
    const dx = cx - node.x;
    const dy = cy - node.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const hitR = getBaseRadius(node) * 2;
    if (dist < hitR && dist < closestDist) {
      closestDist = dist;
      closest = id;
    }
  }
  return closest;
}
