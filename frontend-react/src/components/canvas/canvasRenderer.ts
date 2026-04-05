/**
 * Pure canvas rendering functions for the chain editor.
 * No React state — takes data as arguments, draws on the provided context.
 */

import type { CanvasNode, CanvasEdge, Camera, NodeExecState } from "../../types/canvas";
import type { Annotation } from "../../stores/annotations";
import { drawNodeIcon } from "./nodeIcons";
import { renderAnnotations } from "./annotationRenderer";

/** Step type → icon color CSS variable mapping.
 *  Colors are derived from the Design Space accent via hue rotation.
 *  Read live from CSS at render time so they change in real-time. */
function getTypeColors(): Record<string, string> {
  const v = (name: string, fb: string) => cssVar(name, fb);
  return {
    agent:     v("--icon-blue", "#0a84ff"),
    router:    v("--icon-purple", "#bf5af2"),
    evaluator: v("--icon-red", "#ff375f"),
    gate:      v("--icon-orange", "#ff9f0a"),
    transform: v("--icon-purple", "#5e5ce6"),
    loop:      v("--icon-cyan", "#64d2ff"),
    merge:     v("--icon-green", "#30d158"),
    webhook:   v("--c-warning", "#ffd60a"),
    subchain:  v("--icon-purple", "#6366f1"),
    debate:    v("--icon-pink", "#ff6482"),
    browser:   v("--m-text2", "#a1a1aa"),
  };
}

// ─── Helper: read CSS variable ──────────────────────────────────────────
function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// ─── Coordinate conversion ──────────────────────────────────────────────
export function screenToCanvas(sx: number, sy: number, cam: Camera): { x: number; y: number } {
  return { x: (sx - cam.x) / cam.zoom, y: (sy - cam.y) / cam.zoom };
}

export function nodeAt(
  sx: number, sy: number, cam: Camera, nodes: Map<string, CanvasNode>,
): string | null {
  const c = screenToCanvas(sx, sy, cam);
  // Reverse iteration (topmost first)
  const entries = [...nodes.entries()].reverse();
  for (const [id, n] of entries) {
    if (c.x >= n.x && c.x <= n.x + n.w && c.y >= n.y && c.y <= n.y + n.h) return id;
  }
  return null;
}

export function portPos(n: CanvasNode, type: "in" | "out"): { x: number; y: number } {
  // Top-down DAG: input on top center, output on bottom center
  if (type === "in") return { x: n.x + n.w / 2, y: n.y };
  return { x: n.x + n.w / 2, y: n.y + n.h };
}

// ─── Main render function ───────────────────────────────────────────────
export function renderCanvas(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  cam: Camera,
  nodes: Map<string, CanvasNode>,
  edges: Map<string, CanvasEdge>,
  selection: Set<string>,
  dragState: { type: string; sx?: number; sy?: number; mx?: number; my?: number; fromId?: string },
  nodeExecState: Map<string, NodeExecState>,
  annotations?: Annotation[],
  drawingAnnotation?: Annotation | null,
  selectedAnnotationId?: string | null,
): void {
  const parentW = canvas.parentElement?.clientWidth ?? canvas.width;
  const parentH = canvas.parentElement?.clientHeight ?? canvas.height;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = parentW * dpr;
  canvas.height = parentH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Theme colors + fonts (read from morphable CSS vars)
  const surfaceColor = cssVar("--m-surface", "#1a1a1e");
  const borderColor = cssVar("--m-border", "#2d2d2d");
  const textColor = cssVar("--m-text", "#f5f5f7");
  const text2Color = cssVar("--m-text2", "#6e6e73");
  const accentColor = cssVar("--m-accent", "#0a84ff");
  const radius = parseFloat(cssVar("--m-radius", "10"));
  const fontFamily = cssVar("--m-font", "system-ui, sans-serif").split(",")[0].trim();
  const monoFamily = cssVar("--m-font-mono", "monospace").split(",")[0].trim();
  const TYPE_COLORS = getTypeColors();

  // Clear
  const bgColor = cssVar("--m-bg", "#0a0a0a");
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, parentW, parentH);

  ctx.save();
  ctx.translate(cam.x, cam.y);
  ctx.scale(cam.zoom, cam.zoom);

  // ─── Dot grid ─────────────────────────────────────────────────────
  const gridSize = 20;
  if (gridSize * cam.zoom >= 10) {
    const startX = Math.floor(-cam.x / cam.zoom / gridSize) * gridSize;
    const startY = Math.floor(-cam.y / cam.zoom / gridSize) * gridSize;
    const endX = startX + parentW / cam.zoom + gridSize * 2;
    const endY = startY + parentH / cam.zoom + gridSize * 2;
    ctx.fillStyle = text2Color + "26"; // 15% alpha
    for (let gx = startX; gx < endX; gx += gridSize) {
      for (let gy = startY; gy < endY; gy += gridSize) {
        ctx.beginPath();
        ctx.arc(gx, gy, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const nodeCount = nodes.size;
  const useShadows = nodeCount <= 25;
  const useDetails = nodeCount <= 80;

  // ─── Edges ────────────────────────────────────────────────────────
  for (const edge of edges.values()) {
    const fromNode = nodes.get(edge.from);
    const toNode = nodes.get(edge.to);
    if (!fromNode || !toNode) continue;

    const fp = portPos(fromNode, "out"); // bottom center
    const tp = portPos(toNode, "in");    // top center
    const srcColor = TYPE_COLORS[fromNode.type] ?? "#888";
    const dy = Math.abs(tp.y - fp.y);

    ctx.strokeStyle = srcColor + "60";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(fp.x, fp.y);

    // Smooth S-curve: control points go down from source, up from target
    const cpDist = Math.max(40, dy * 0.4);
    ctx.bezierCurveTo(
      fp.x, fp.y + cpDist,
      tp.x, tp.y - cpDist,
      tp.x, tp.y,
    );
    ctx.stroke();

    // Arrow head pointing down into target
    const arrowSize = 6;
    ctx.fillStyle = srcColor + "60";
    ctx.beginPath();
    ctx.moveTo(tp.x, tp.y);
    ctx.lineTo(tp.x - arrowSize * 0.5, tp.y - arrowSize);
    ctx.lineTo(tp.x + arrowSize * 0.5, tp.y - arrowSize);
    ctx.closePath();
    ctx.fill();
  }

  // ─── Connect drag line ────────────────────────────────────────────
  if (dragState.type === "connect" && dragState.fromId) {
    const fromNode = nodes.get(dragState.fromId);
    if (fromNode && dragState.mx !== undefined && dragState.my !== undefined) {
      const fp = portPos(fromNode, "out");
      const mp = screenToCanvas(dragState.mx, dragState.my, cam);
      ctx.strokeStyle = accentColor + "80";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(fp.x, fp.y);
      ctx.lineTo(mp.x, mp.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ─── Nodes ────────────────────────────────────────────────────────
  for (const n of nodes.values()) {
    const color = TYPE_COLORS[n.type] ?? "#888";
    const isSelected = selection.has(n.id);
    const rr = Math.min(radius, n.h / 2);

    // Shape path
    ctx.beginPath();
    if (n.type === "router") {
      // Diamond
      ctx.moveTo(n.x + n.w / 2, n.y + 2);
      ctx.lineTo(n.x + n.w - 2, n.y + n.h / 2);
      ctx.lineTo(n.x + n.w / 2, n.y + n.h - 2);
      ctx.lineTo(n.x + 2, n.y + n.h / 2);
      ctx.closePath();
    } else if (n.type === "gate") {
      // Hexagon
      const inset = 14;
      ctx.moveTo(n.x + inset, n.y);
      ctx.lineTo(n.x + n.w - inset, n.y);
      ctx.lineTo(n.x + n.w, n.y + n.h / 2);
      ctx.lineTo(n.x + n.w - inset, n.y + n.h);
      ctx.lineTo(n.x + inset, n.y + n.h);
      ctx.lineTo(n.x, n.y + n.h / 2);
      ctx.closePath();
    } else if (n.type === "loop") {
      // Stadium (pill)
      const pillR = n.h / 2;
      ctx.roundRect(n.x, n.y, n.w, n.h, pillR);
    } else {
      ctx.roundRect(n.x, n.y, n.w, n.h, rr);
    }

    // Fill
    ctx.fillStyle = surfaceColor;
    if (useShadows) {
      ctx.shadowColor = color + "22";
      ctx.shadowBlur = isSelected ? 16 : 8;
      ctx.shadowOffsetY = 2;
    }
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // Border
    if (n.type === "subchain") {
      ctx.setLineDash([6, 3]);
    }
    ctx.strokeStyle = isSelected ? color : borderColor;
    ctx.lineWidth = isSelected ? 2.5 : 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // ─── Top accent bar (clipped to same shape as node) ─────────
    if (n.type !== "router") {
      ctx.save();
      ctx.beginPath();
      if (n.type === "loop") {
        ctx.roundRect(n.x, n.y, n.w, n.h, n.h / 2);
      } else if (n.type === "gate") {
        const inset = 14;
        ctx.moveTo(n.x + inset, n.y);
        ctx.lineTo(n.x + n.w - inset, n.y);
        ctx.lineTo(n.x + n.w, n.y + n.h / 2);
        ctx.lineTo(n.x + n.w - inset, n.y + n.h);
        ctx.lineTo(n.x + inset, n.y + n.h);
        ctx.lineTo(n.x, n.y + n.h / 2);
        ctx.closePath();
      } else {
        ctx.roundRect(n.x, n.y, n.w, n.h, rr);
      }
      ctx.clip();
      ctx.fillStyle = color;
      ctx.fillRect(n.x, n.y, n.w, 2.5);
      ctx.restore();
    }

    // ─── Inner content ──────────────────────────────────────────
    const innerX = n.type === "router" ? n.x + n.w * 0.3 : n.type === "loop" ? n.x + n.h / 2 + 4 : n.x + 4;
    const innerW = n.type === "router" ? n.w * 0.4 : n.type === "loop" ? n.w - n.h - 8 : n.w - 8;

    if (n.type === "router") {
      // Diamond: centered content
      const cx = n.x + n.w / 2;
      const cy = n.y + n.h / 2;
      if (useDetails) drawNodeIcon(ctx, n.type, cx, cy - 14, color);
      ctx.fillStyle = textColor;
      ctx.font = `600 11px ${fontFamily}, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(n.label.slice(0, 20), cx, cy + 2);
      ctx.fillStyle = color;
      ctx.font = `600 8px ${fontFamily}, sans-serif`;
      ctx.fillText(n.type, cx, cy + 14);
    } else {
      // Standard layout: icon circle + label + type
      const iconX = innerX + 16;
      const labelY = n.y + n.h / 2 - 4;

      if (useDetails) {
        // Icon circle
        ctx.fillStyle = color + "15";
        ctx.strokeStyle = color + "30";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(iconX, n.y + n.h / 2, 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        drawNodeIcon(ctx, n.type, iconX, n.y + n.h / 2, color);
      }

      // Label
      const labelX = useDetails ? iconX + 20 : innerX + 6;
      const maxTextW = innerW - (useDetails ? 46 : 12);
      ctx.fillStyle = textColor;
      ctx.font = `600 12px ${fontFamily}, sans-serif`;
      ctx.textAlign = "left";
      let displayLabel = n.label;
      if (maxTextW > 10) {
        while (ctx.measureText(displayLabel).width > maxTextW && displayLabel.length > 3) {
          displayLabel = displayLabel.slice(0, -1);
        }
        if (displayLabel !== n.label) displayLabel += "\u2026";
      }
      ctx.fillText(displayLabel, labelX, labelY);

      // Type + model
      ctx.fillStyle = text2Color;
      ctx.font = `500 9px ${fontFamily}, sans-serif`;
      let meta = n.type;
      if (useDetails && n.model) meta += ` \u00B7 ${n.model}`;
      ctx.fillText(meta, labelX, labelY + 14);
    }

    // ─── Ports (top=input, bottom=output for top-down DAG) ────
    const ip = portPos(n, "in"); // top center
    ctx.fillStyle = surfaceColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(ip.x, ip.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const op = portPos(n, "out"); // bottom center
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(op.x, op.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // ─── Selection glow (follows node shape) ─────────────────────
    if (isSelected) {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = color + "60";
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (n.type === "router") {
        ctx.moveTo(n.x + n.w / 2, n.y - 3);
        ctx.lineTo(n.x + n.w + 3, n.y + n.h / 2);
        ctx.lineTo(n.x + n.w / 2, n.y + n.h + 3);
        ctx.lineTo(n.x - 3, n.y + n.h / 2);
        ctx.closePath();
      } else if (n.type === "gate") {
        const inset = 14;
        ctx.moveTo(n.x + inset - 2, n.y - 3);
        ctx.lineTo(n.x + n.w - inset + 2, n.y - 3);
        ctx.lineTo(n.x + n.w + 3, n.y + n.h / 2);
        ctx.lineTo(n.x + n.w - inset + 2, n.y + n.h + 3);
        ctx.lineTo(n.x + inset - 2, n.y + n.h + 3);
        ctx.lineTo(n.x - 3, n.y + n.h / 2);
        ctx.closePath();
      } else if (n.type === "loop") {
        ctx.roundRect(n.x - 3, n.y - 3, n.w + 6, n.h + 6, n.h / 2 + 3);
      } else {
        ctx.roundRect(n.x - 3, n.y - 3, n.w + 6, n.h + 6, rr + 3);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ─── Execution overlay ──────────────────────────────────────
    const execState = nodeExecState.get(n.id);
    if (execState) {
      drawExecOverlay(ctx, n, execState, color, textColor, text2Color, borderColor, fontFamily, monoFamily);
    }
  }

  // ─── Box select ───────────────────────────────────────────────
  if (dragState.type === "box" && dragState.sx !== undefined && dragState.mx !== undefined) {
    const s = screenToCanvas(dragState.sx, dragState.sy!, cam);
    const m = screenToCanvas(dragState.mx, dragState.my!, cam);
    const bx = Math.min(s.x, m.x), by = Math.min(s.y, m.y);
    const bw = Math.abs(m.x - s.x), bh = Math.abs(m.y - s.y);
    ctx.fillStyle = accentColor + "1A"; // 10%
    ctx.strokeStyle = accentColor + "80";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.setLineDash([]);
  }

  // ─── Annotations (drawings, shapes, text) ─────────────────────
  if (annotations && annotations.length > 0 || drawingAnnotation) {
    renderAnnotations(ctx, cam, annotations ?? [], drawingAnnotation ?? null, selectedAnnotationId);
  }

  ctx.restore();
}

// ─── Execution overlay on a node ────────────────────────────────────────
function drawExecOverlay(
  ctx: CanvasRenderingContext2D,
  n: CanvasNode,
  state: NodeExecState,
  color: string,
  textColor: string,
  text2Color: string,
  borderColor: string,
  fontFamily: string,
  monoFamily: string,
): void {
  const now = Date.now();
  const x = n.x, y = n.y, nw = n.w, nh = n.h;
  const isRunning = state.status === "running";

  // Status colors (read from CSS vars for theme consistency)
  const successColor = cssVar("--c-success", "#30d158");
  const errorColor = cssVar("--c-error", "#ff375f");
  const warningColor = cssVar("--c-warning", "#ff9f0a");
  const infoColor = cssVar("--c-info", "#64d2ff");

  // ── Running: pulsing glow border + animated progress ring + duration badge ──
  if (isRunning) {
    ctx.save();
    const pulse = 0.5 + 0.5 * Math.sin(now / 500);

    // Outer glow
    ctx.shadowColor = color;
    ctx.shadowBlur = 8 + 8 * pulse;
    ctx.beginPath();
    ctx.roundRect(x - 2, y - 2, nw + 4, nh + 4, 12);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.3 + 0.4 * pulse;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";

    // Inner pulsing border
    ctx.beginPath();
    ctx.roundRect(x - 1, y - 1, nw + 2, nh + 2, 11);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.5 + 0.5 * pulse;
    ctx.stroke();

    // Animated progress dots along bottom edge
    const dotCount = 3;
    const dotSpacing = nw / (dotCount + 1);
    for (let i = 0; i < dotCount; i++) {
      const phase = (now / 600 + i * 0.3) % 1;
      const dotAlpha = Math.sin(phase * Math.PI);
      ctx.globalAlpha = dotAlpha * 0.8;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x + dotSpacing * (i + 1), y + nh + 1, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Duration badge (colored pill, top-right)
    if (state.startTime) {
      const dur = ((now - state.startTime) / 1000).toFixed(0) + "s";
      ctx.font = `600 9px ${monoFamily}, monospace`;
      const dw = ctx.measureText(dur).width + 10;
      ctx.beginPath();
      ctx.roundRect(x + nw - dw, y - 16, dw, 16, 4);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.fillText(dur, x + nw - dw / 2, y - 4);
      ctx.textAlign = "left";
    }
    ctx.restore();
  }

  // ── Done: green badge with checkmark ──
  if (state.status === "done") {
    ctx.save();
    const bx = x + nw - 2, by = y - 2;
    ctx.shadowColor = successColor;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(bx, by, 8, 0, Math.PI * 2);
    ctx.fillStyle = successColor;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(bx - 3.5, by);
    ctx.lineTo(bx - 1, by + 3);
    ctx.lineTo(bx + 3.5, by - 2.5);
    ctx.stroke();
    ctx.restore();
  }

  // ── Error: red badge with X ──
  if (state.status === "error") {
    ctx.save();
    const bx = x + nw - 2, by = y - 2;
    ctx.shadowColor = errorColor;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(bx, by, 8, 0, Math.PI * 2);
    ctx.fillStyle = errorColor;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(bx - 3, by - 3);
    ctx.lineTo(bx + 3, by + 3);
    ctx.moveTo(bx + 3, by - 3);
    ctx.lineTo(bx - 3, by + 3);
    ctx.stroke();
    ctx.restore();
  }

  // ── Mini terminal — auto-hide 5s after done/error ──
  const termVisible =
    isRunning ||
    (state.output.length > 0 && state.finishedAt && now - state.finishedAt < 5000);
  if (!termVisible) return;

  // Fade out in last 1.5s
  const termOpacity =
    !isRunning && state.finishedAt
      ? Math.max(0, 1 - Math.max(0, now - state.finishedAt - 3500) / 1500)
      : 1;
  if (termOpacity <= 0) return;

  const numLines = Math.min(state.output.length, 4);
  const lineH = 13;
  const termW = Math.min(Math.max(nw, 260), 360);
  const termH = 20 + numLines * lineH + 8;
  const tx = x + (nw - termW) / 2; // centered below node
  const ty = y + nh + 10;

  ctx.save();
  ctx.globalAlpha = termOpacity;

  // Background with subtle border
  ctx.beginPath();
  ctx.roundRect(tx, ty, termW, termH, 8);
  ctx.fillStyle = "rgba(10,10,14,0.92)";
  ctx.fill();
  ctx.strokeStyle = isRunning ? color + "40" : borderColor + "30";
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // Left accent bar
  ctx.fillStyle = isRunning ? color : state.status === "done" ? successColor : errorColor;
  ctx.beginPath();
  ctx.roundRect(tx, ty, 3, termH, [8, 0, 0, 8]);
  ctx.fill();

  // Header: label + status indicator
  ctx.font = `600 8px ${fontFamily}, sans-serif`;
  ctx.fillStyle = isRunning ? color + "90" : text2Color;
  ctx.textAlign = "left";
  ctx.fillText(n.label.slice(0, 35), tx + 10, ty + 12);

  // Status text (right-aligned in header)
  if (!isRunning && state.status) {
    ctx.textAlign = "right";
    ctx.fillStyle = state.status === "done" ? successColor + "80" : errorColor + "80";
    ctx.fillText(state.status, tx + termW - 8, ty + 12);
    ctx.textAlign = "left";
  }

  // Output lines with syntax-aware coloring
  const lastLines = state.output.slice(-numLines);
  const maxChars = Math.floor((termW - 20) / 5.2);
  ctx.font = "400 10px monospace";

  lastLines.forEach((rawLine, li) => {
    const lineY = ty + 24 + li * lineH;
    const line = rawLine.length > maxChars ? rawLine.slice(0, maxChars - 1) + "\u2026" : rawLine;

    // Color based on content
    if (line.startsWith("ERROR") || line.startsWith("[error]")) {
      ctx.fillStyle = errorColor;
    } else if (line.startsWith("[warn")) {
      ctx.fillStyle = warningColor;
    } else if (line.startsWith("[info]") || line.startsWith("[cache")) {
      ctx.fillStyle = infoColor + "80";
    } else if (line.startsWith("[gate") || line.startsWith("[awaiting")) {
      ctx.fillStyle = warningColor;
    } else {
      ctx.fillStyle = isRunning ? textColor : text2Color;
    }
    ctx.fillText(line, tx + 10, lineY);
  });

  // Blinking cursor (block cursor style)
  if (isRunning) {
    const blinkOn = Math.sin(now / 400 * Math.PI) > 0;
    if (blinkOn) {
      const lastLine = lastLines[lastLines.length - 1] ?? "";
      const cx = tx + 10 + Math.min(lastLine.length, maxChars) * 5.2;
      const cy = ty + 14 + (numLines - 1) * lineH;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.7 * termOpacity;
      ctx.fillRect(cx, cy, 6, 11);
      ctx.globalAlpha = termOpacity;
    }
  }

  ctx.restore();
}

// ─── Minimap renderer ───────────────────────────────────────────────────
export function renderMinimap(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  cam: Camera,
  nodes: Map<string, CanvasNode>,
  mainW: number,
  mainH: number,
): void {
  const mmW = canvas.width;
  const mmH = canvas.height;
  ctx.fillStyle = cssVar("--m-surface", "#1a1a1e");
  ctx.fillRect(0, 0, mmW, mmH);

  if (nodes.size === 0) return;

  // Bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes.values()) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  const pad = 50;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  const scaleX = mmW / (maxX - minX);
  const scaleY = mmH / (maxY - minY);
  const scale = Math.min(scaleX, scaleY);
  const ox = (mmW - (maxX - minX) * scale) / 2;
  const oy = (mmH - (maxY - minY) * scale) / 2;

  // Draw nodes
  const mmTypeColors = getTypeColors();
  for (const n of nodes.values()) {
    const color = mmTypeColors[n.type] ?? "#888";
    ctx.fillStyle = color + "80";
    ctx.fillRect(
      ox + (n.x - minX) * scale,
      oy + (n.y - minY) * scale,
      Math.max(2, n.w * scale),
      Math.max(2, n.h * scale),
    );
  }

  // Viewport rect
  const vx = ox + (-cam.x / cam.zoom - minX) * scale;
  const vy = oy + (-cam.y / cam.zoom - minY) * scale;
  const vw = (mainW / cam.zoom) * scale;
  const vh = (mainH / cam.zoom) * scale;
  const viewportColor = cssVar("--m-text2", "#86868b");
  ctx.strokeStyle = viewportColor;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.strokeRect(vx, vy, vw, vh);
  ctx.globalAlpha = 1;
}

// ─── Zoom to fit ────────────────────────────────────────────────────────
export function computeZoomToFit(
  nodes: Map<string, CanvasNode>,
  containerW: number,
  containerH: number,
): Camera {
  if (nodes.size === 0) return { x: 0, y: 0, zoom: 1 };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes.values()) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  const pad = 80;
  const zoom = Math.min(containerW / (maxX - minX + pad * 2), containerH / (maxY - minY + pad * 2), 2);
  return {
    zoom,
    x: containerW / 2 - ((minX + maxX) / 2) * zoom,
    y: containerH / 2 - ((minY + maxY) / 2) * zoom,
  };
}
