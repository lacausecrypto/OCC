/**
 * Pure canvas rendering functions for the chain editor.
 * No React state — takes data as arguments, draws on the provided context.
 */

import type { CanvasNode, CanvasEdge, Camera, NodeExecState } from "../../types/canvas";
import type { Annotation } from "../../stores/annotations";
import { drawNodeIcon } from "./nodeIcons";
import { renderAnnotations } from "./annotationRenderer";
import { getRopeState, computeTargetSag, getRopeControlPoints } from "./ropePhysics";

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
    image_gen: v("--icon-pink", "#ff6b9d"),
  };
}

// ─── Helper: read CSS variable ──────────────────────────────────────────
function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// ─── Visual tiers (hierarchy) ──────────────────────────────────────────
// Primary  → cœur d'exécution, full detail (model + label)
// Utility  → helpers de logique, compact
// Flow     → control flow, icon-prominent, minimal text
const TIER_PRIMARY = new Set(["agent", "subchain", "debate", "browser", "webhook", "image_gen"]);
const TIER_FLOW    = new Set(["router", "loop", "merge"]);
// Utility = everything else (transform, evaluator, gate)

function getTier(type: string): "primary" | "utility" | "flow" {
  if (TIER_PRIMARY.has(type)) return "primary";
  if (TIER_FLOW.has(type)) return "flow";
  return "utility";
}

// ─── Type-specific subtitle generator ───────────────────────────────────
/** Returns a short, useful subtitle for a node — what it actually does,
 *  not just its type. Falls back to type name if no specific data. */
function getTypeSubtitle(n: CanvasNode): string {
  const adv = n.advanced ?? {};
  switch (n.type) {
    case "agent": {
      // Show model, or first meaningful word of prompt
      if (n.model) return n.model.replace(/^claude-/, "").replace(/-/g, " ");
      if (n.prompt) {
        const first = n.prompt.trim().slice(0, 28);
        return first + (n.prompt.length > 28 ? "…" : "");
      }
      return "agent";
    }
    case "evaluator": {
      if (adv.criteria) return adv.criteria.slice(0, 28) + (adv.criteria.length > 28 ? "…" : "");
      if (adv.eval_threshold !== undefined) return `score ≥ ${adv.eval_threshold}`;
      return "evaluate";
    }
    case "gate": {
      if (adv.gate_actions?.length) return adv.gate_actions.join(", ").slice(0, 26);
      if (adv.timeout_hours) return `timeout ${adv.timeout_hours}h`;
      return "manual approval";
    }
    case "router": {
      const routeCount = Object.keys(adv.routes ?? {}).length;
      if (routeCount) return `${routeCount} routes`;
      return "branch";
    }
    case "transform": {
      if (adv.operation) return adv.operation.slice(0, 28);
      if (adv.json_path) return `json: ${adv.json_path.slice(0, 20)}`;
      if (adv.regex) return `regex`;
      if (adv.template_str) return `template`;
      return "transform";
    }
    case "loop": {
      if (adv.items_var) {
        const max = adv.max_parallel ? ` × ${adv.max_parallel}` : "";
        return `for ${adv.items_var}${max}`;
      }
      if (adv.loop_until) return `until ${adv.loop_until.slice(0, 18)}`;
      return "iterate";
    }
    case "merge": {
      const inputCount = (adv.inputs ?? []).length;
      const strat = adv.strategy ?? "concatenate";
      if (inputCount) return `${inputCount} → 1 · ${strat}`;
      return strat;
    }
    case "webhook": {
      if (adv.webhook_url) {
        try { return `${adv.webhook_method ?? "POST"} ${new URL(adv.webhook_url).hostname}`; }
        catch { return adv.webhook_method ?? "POST"; }
      }
      return "webhook";
    }
    case "subchain": {
      if (adv.subchain) return adv.subchain;
      return "subchain";
    }
    case "debate": {
      const agents = adv.debate_agents?.length ?? 0;
      const rounds = adv.debate_rounds ?? 1;
      if (agents) return `${agents} agents · ${rounds} rounds`;
      return "debate";
    }
    case "browser": {
      if (adv.browser_url) {
        try { return new URL(adv.browser_url).hostname; }
        catch { return "browser"; }
      }
      return "browser";
    }
    case "image_gen": {
      // Show "model · size" or "size · n images" as primary signal
      const model = adv.image_model;
      const size = adv.image_size ?? "1024x1024";
      const n_imgs = adv.image_n ?? 1;
      if (model) {
        // Strip provider prefix like "openai/" or "black-forest-labs/"
        const shortModel = model.includes("/") ? model.split("/").pop()! : model;
        return `${shortModel} · ${size}`;
      }
      if (n_imgs > 1) return `${n_imgs}× ${size}`;
      return size;
    }
    default:
      return n.model ?? n.type;
  }
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
  selectedEdgeId?: string | null,
): void {
  const parentW = canvas.parentElement?.clientWidth ?? canvas.width;
  const parentH = canvas.parentElement?.clientHeight ?? canvas.height;
  // Guard: skip render if container has 0 size (during sidebar transition)
  if (parentW < 1 || parentH < 1) return;
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

  // ─── Origin crosshair ───────────────────────────────────────────
  if (cam.zoom >= 0.3) {
    ctx.strokeStyle = text2Color + "18";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-40, 0); ctx.lineTo(40, 0);
    ctx.moveTo(0, -40); ctx.lineTo(0, 40);
    ctx.stroke();
  }

  const nodeCount = nodes.size;
  const useShadows = nodeCount <= 25;
  const useDetails = nodeCount <= 80;

  // ─── Edges (rope physics catenary curves) ─────────────────────────
  for (const edge of edges.values()) {
    const fromNode = nodes.get(edge.from);
    const toNode = nodes.get(edge.to);
    if (!fromNode || !toNode) continue;

    const fp = portPos(fromNode, "out"); // bottom center
    const tp = portPos(toNode, "in");    // top center
    // Delegate edges (terminal ↔ terminal, agent-to-agent) get a distinct
    // purple stroke + dashed pattern + bidirectional arrows, so the user
    // can read at a glance that they enable agent delegation rather than
    // the default one-way context propagation. Other edges keep the
    // type-color convention.
    const isDelegate = edge.kind === "delegate";
    const srcColor = isDelegate ? "#bf5af2" : (TYPE_COLORS[fromNode.type] ?? "#888");

    // Get rope physics state for this edge
    const ropeState = getRopeState(edge.id);
    ropeState.targetSag = computeTargetSag(fp.x, fp.y, tp.x, tp.y);
    const [baseCp1x, baseCp1y, baseCp2x, baseCp2y] = getRopeControlPoints(fp.x, fp.y, tp.x, tp.y, ropeState.sag);

    // Apply custom control point offsets
    const cp1x = baseCp1x + (edge.cp1?.dx ?? 0);
    const cp1y = baseCp1y + (edge.cp1?.dy ?? 0);
    const cp2x = baseCp2x + (edge.cp2?.dx ?? 0);
    const cp2y = baseCp2y + (edge.cp2?.dy ?? 0);

    const isEdgeSelected = edge.id === selectedEdgeId;

    // Draw rope curve
    if (isEdgeSelected) {
      // Glow for selected edge
      ctx.save();
      ctx.shadowColor = srcColor + "80";
      ctx.shadowBlur = 12;
      ctx.strokeStyle = srcColor + "CC";
      ctx.lineWidth = 3;
      if (isDelegate) ctx.setLineDash([8, 4]);
      ctx.beginPath();
      ctx.moveTo(fp.x, fp.y);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, tp.x, tp.y);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.save();
      ctx.strokeStyle = isDelegate ? srcColor + "AA" : srcColor + "60";
      ctx.lineWidth = isDelegate ? 2 : 1.5;
      if (isDelegate) ctx.setLineDash([8, 4]);
      ctx.beginPath();
      ctx.moveTo(fp.x, fp.y);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, tp.x, tp.y);
      ctx.stroke();
      ctx.restore();
    }

    // Arrow head — for delegate edges we draw arrows on BOTH ends to
    // signal that delegation is bidirectional (each terminal can call
    // the other). Context edges keep the single arrow into the target.
    const arrowSize = isEdgeSelected ? 8 : 6;
    ctx.fillStyle = isEdgeSelected ? srcColor + "CC" : srcColor + "AA";
    ctx.beginPath();
    ctx.moveTo(tp.x, tp.y);
    ctx.lineTo(tp.x - arrowSize * 0.5, tp.y - arrowSize);
    ctx.lineTo(tp.x + arrowSize * 0.5, tp.y - arrowSize);
    ctx.closePath();
    ctx.fill();
    if (isDelegate) {
      ctx.beginPath();
      ctx.moveTo(fp.x, fp.y);
      ctx.lineTo(fp.x - arrowSize * 0.5, fp.y + arrowSize);
      ctx.lineTo(fp.x + arrowSize * 0.5, fp.y + arrowSize);
      ctx.closePath();
      ctx.fill();
    }

    // Control point handles for selected edge
    if (isEdgeSelected) {
      const handleR = 5;
      for (const [hx, hy] of [[cp1x, cp1y], [cp2x, cp2y]]) {
        // Line from endpoint to control point
        ctx.strokeStyle = srcColor + "40";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        if (hx === cp1x) { ctx.moveTo(fp.x, fp.y); } else { ctx.moveTo(tp.x, tp.y); }
        ctx.lineTo(hx, hy);
        ctx.stroke();
        ctx.setLineDash([]);

        // Handle circle
        ctx.fillStyle = surfaceColor;
        ctx.strokeStyle = srcColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(hx, hy, handleR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
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
    // Dispatch to kind-specific renderer for non-step items
    const kind = n.kind ?? "step";
    if (kind === "sticky") { drawStickyNode(ctx, n, selection.has(n.id), fontFamily); continue; }
    if (kind === "text") { drawTextNode(ctx, n, selection.has(n.id), textColor, text2Color, fontFamily); continue; }
    if (kind === "portal") { drawPortalNode(ctx, n, selection.has(n.id), textColor, text2Color, surfaceColor, borderColor, fontFamily); continue; }
    if (kind === "file") { drawFileNode(ctx, n, selection.has(n.id), textColor, text2Color, surfaceColor, borderColor, fontFamily, monoFamily); continue; }
    if (kind === "link") { drawLinkNode(ctx, n, selection.has(n.id), textColor, text2Color, surfaceColor, borderColor, fontFamily); continue; }
    if (kind === "terminal") { drawTerminalNode(ctx, n, selection.has(n.id), textColor, text2Color, surfaceColor, borderColor, fontFamily, monoFamily); continue; }
    if (kind === "obsidian") { drawObsidianNode(ctx, n, selection.has(n.id), textColor, text2Color, surfaceColor, borderColor, fontFamily, monoFamily); continue; }
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
    // Glow only on active states (selected or running) — calm at rest
    const execStateForGlow = nodeExecState.get(n.id);
    const isExecuting = execStateForGlow?.status === "running";
    if (useShadows && (isSelected || isExecuting)) {
      ctx.shadowColor = color + (isExecuting ? "55" : "33");
      ctx.shadowBlur = isExecuting ? 14 : 12;
      ctx.shadowOffsetY = 2;
    } else if (useShadows) {
      // Subtle neutral depth shadow (no color, no glow)
      ctx.shadowColor = "rgba(0,0,0,0.18)";
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1;
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

    // ─── Top accent bar — tier-aware (no bar for router/flow) ───
    const tierForBar = getTier(n.type);
    if (n.type !== "router" && tierForBar !== "flow") {
      ctx.save();
      ctx.beginPath();
      if (n.type === "gate") {
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
      // Primary: thick solid bar; Utility: thin minimal bar
      const barH = tierForBar === "primary" ? 5 : 2;
      ctx.fillRect(n.x, n.y, n.w, barH);
      // Gradient fade only on primary tier
      if (tierForBar === "primary") {
        const grad = ctx.createLinearGradient(n.x, n.y, n.x, n.y + 5);
        grad.addColorStop(0, color);
        grad.addColorStop(1, color + "00");
        ctx.fillStyle = grad;
        ctx.fillRect(n.x, n.y + 5, n.w, 4);
      }
      ctx.restore();
    }

    // ─── Inner content (tier-aware layout) ──────────────────────
    const tier = getTier(n.type);

    if (n.type === "router") {
      // ── ROUTER: diamond, icon-centric ──────────────────────────
      const cx = n.x + n.w / 2;
      const cy = n.y + n.h / 2;
      if (useDetails) drawNodeIcon(ctx, n.type, cx, cy - 12, color);
      ctx.fillStyle = textColor;
      ctx.font = `700 11px ${fontFamily}, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(n.label.slice(0, 16), cx, cy + 4);
      const sub = getTypeSubtitle(n);
      if (sub) {
        ctx.fillStyle = color;
        ctx.font = `500 8px ${fontFamily}, sans-serif`;
        ctx.fillText(sub.slice(0, 18), cx, cy + 14);
      }
    } else if (tier === "flow") {
      // ── FLOW (loop/merge): icon-prominent, mono subtitle ───────
      const innerX = n.type === "loop" ? n.x + n.h / 2 + 4 : n.x + 4;
      const innerW = n.type === "loop" ? n.w - n.h - 8 : n.w - 8;
      const iconX = innerX + 14;

      if (useDetails) drawNodeIcon(ctx, n.type, iconX, n.y + n.h / 2, color);

      const labelX = useDetails ? iconX + 18 : innerX + 6;
      const maxTextW = innerW - (useDetails ? 36 : 12);

      ctx.fillStyle = textColor;
      ctx.font = `600 11px ${fontFamily}, sans-serif`;
      ctx.textAlign = "left";
      let displayLabel = n.label;
      if (maxTextW > 10) {
        while (ctx.measureText(displayLabel).width > maxTextW && displayLabel.length > 3) {
          displayLabel = displayLabel.slice(0, -1);
        }
        if (displayLabel !== n.label) displayLabel += "\u2026";
      }
      ctx.fillText(displayLabel, labelX, n.y + n.h / 2 - 3);

      ctx.fillStyle = color;
      ctx.font = `500 9px ${monoFamily}, monospace`;
      const sub = getTypeSubtitle(n);
      let displaySub = sub;
      if (maxTextW > 10) {
        while (ctx.measureText(displaySub).width > maxTextW && displaySub.length > 3) {
          displaySub = displaySub.slice(0, -1);
        }
        if (displaySub !== sub) displaySub += "\u2026";
      }
      ctx.fillText(displaySub, labelX, n.y + n.h / 2 + 10);
    } else {
      // ── PRIMARY / UTILITY: icon + label + type-specific subtitle
      const innerX = n.x + 4;
      const innerW = n.w - 8;
      const iconR = tier === "primary" ? 14 : 11;
      const iconX = innerX + iconR + 2;
      const labelY = n.y + n.h / 2 - 4;

      if (useDetails) {
        if (tier === "primary") {
          // Primary: filled circle, more visual weight
          ctx.fillStyle = color + "15";
          ctx.strokeStyle = color + "40";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(iconX, n.y + n.h / 2, iconR, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else {
          // Utility: dashed outline, more discreet
          ctx.strokeStyle = color + "50";
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.arc(iconX, n.y + n.h / 2, iconR, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        drawNodeIcon(ctx, n.type, iconX, n.y + n.h / 2, color);
      }

      const labelX = useDetails ? iconX + iconR + 7 : innerX + 6;
      const maxTextW = innerW - (useDetails ? iconR * 2 + 14 : 12);
      ctx.fillStyle = textColor;
      const labelWeight = tier === "primary" ? 700 : 600;
      const labelSize = tier === "primary" ? 12 : 11;
      ctx.font = `${labelWeight} ${labelSize}px ${fontFamily}, sans-serif`;
      ctx.textAlign = "left";
      let displayLabel = n.label;
      if (maxTextW > 10) {
        while (ctx.measureText(displayLabel).width > maxTextW && displayLabel.length > 3) {
          displayLabel = displayLabel.slice(0, -1);
        }
        if (displayLabel !== n.label) displayLabel += "\u2026";
      }
      ctx.fillText(displayLabel, labelX, labelY);

      ctx.font = `500 9px ${fontFamily}, sans-serif`;
      const sub = getTypeSubtitle(n);
      ctx.fillStyle = tier === "primary" ? text2Color : color + "B0";
      let displaySub = sub;
      if (maxTextW > 10) {
        while (ctx.measureText(displaySub).width > maxTextW && displaySub.length > 3) {
          displaySub = displaySub.slice(0, -1);
        }
        if (displaySub !== sub) displaySub += "\u2026";
      }
      ctx.fillText(displaySub, labelX, labelY + 14);
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

    // ─── Selection glow (soft outer glow ring) ─────────────────────
    if (isSelected) {
      ctx.save();
      ctx.shadowColor = color + "80";
      ctx.shadowBlur = 18;
      ctx.strokeStyle = color + "90";
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (n.type === "router") {
        ctx.moveTo(n.x + n.w / 2, n.y - 2);
        ctx.lineTo(n.x + n.w + 2, n.y + n.h / 2);
        ctx.lineTo(n.x + n.w / 2, n.y + n.h + 2);
        ctx.lineTo(n.x - 2, n.y + n.h / 2);
        ctx.closePath();
      } else if (n.type === "gate") {
        const inset = 14;
        ctx.moveTo(n.x + inset - 1, n.y - 2);
        ctx.lineTo(n.x + n.w - inset + 1, n.y - 2);
        ctx.lineTo(n.x + n.w + 2, n.y + n.h / 2);
        ctx.lineTo(n.x + n.w - inset + 1, n.y + n.h + 2);
        ctx.lineTo(n.x + inset - 1, n.y + n.h + 2);
        ctx.lineTo(n.x - 2, n.y + n.h / 2);
        ctx.closePath();
      } else if (n.type === "loop") {
        ctx.roundRect(n.x - 2, n.y - 2, n.w + 4, n.h + 4, n.h / 2 + 2);
      } else {
        ctx.roundRect(n.x - 2, n.y - 2, n.w + 4, n.h + 4, rr + 2);
      }
      ctx.stroke();
      ctx.restore();
    }

    // ─── Execution overlay ──────────────────────────────────────
    const execState = nodeExecState.get(n.id);
    if (execState) {
      drawExecOverlay(ctx, n, execState, color, textColor, text2Color, borderColor, fontFamily, monoFamily);
    }
  }

  // ─── Resize handles on selected nodes ─────────────────────────
  for (const id of selection) {
    const n = nodes.get(id);
    if (n) drawResizeHandles(ctx, n, accentColor);
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
  _textColor: string,
  _text2Color: string,
  _borderColor: string,
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

  // ── Mini terminal (Apple-style glass) — stays 15s after done/error ──
  const TERM_LINGER_MS = 15000;
  const TERM_FADE_MS = 3000;
  const termVisible =
    isRunning ||
    (state.output.length > 0 && state.finishedAt && now - state.finishedAt < TERM_LINGER_MS);
  if (!termVisible) return;

  // Smooth fade out in last 3s
  const termOpacity =
    !isRunning && state.finishedAt
      ? Math.max(0, 1 - Math.max(0, now - state.finishedAt - (TERM_LINGER_MS - TERM_FADE_MS)) / TERM_FADE_MS)
      : 1;
  if (termOpacity <= 0) return;

  // ─── Dimensions ──────────────────────────────────────────────
  const MAX_LINES = 6;
  const numLines = Math.min(state.output.length, MAX_LINES);
  const lineH = 14;
  const titleBarH = 28;
  const padBottom = 10;
  const termW = Math.min(Math.max(nw + 40, 280), 400);
  const termH = titleBarH + numLines * lineH + padBottom;
  const tx = x + (nw - termW) / 2;
  const ty = y + nh + 12;
  const r = 10; // border radius

  ctx.save();
  ctx.globalAlpha = termOpacity;

  // ─── Drop shadow (Apple-style layered) ───────────────────────
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  ctx.beginPath();
  ctx.roundRect(tx, ty, termW, termH, r);
  ctx.fillStyle = "rgba(0,0,0,0.01)";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // ─── Glass background ───────────────────────────────────────
  ctx.beginPath();
  ctx.roundRect(tx, ty, termW, termH, r);
  ctx.fillStyle = "rgba(28,28,30,0.88)";
  ctx.fill();

  // Subtle inner border (vitreous)
  ctx.beginPath();
  ctx.roundRect(tx + 0.5, ty + 0.5, termW - 1, termH - 1, r);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // Top highlight edge (glass reflection)
  ctx.beginPath();
  ctx.moveTo(tx + r, ty + 0.5);
  ctx.lineTo(tx + termW - r, ty + 0.5);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // ─── Title bar with traffic lights ──────────────────────────
  // Separator line
  ctx.beginPath();
  ctx.moveTo(tx + 8, ty + titleBarH - 0.5);
  ctx.lineTo(tx + termW - 8, ty + titleBarH - 0.5);
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // Traffic light dots
  const dotY = ty + titleBarH / 2;
  const dotR = 4;
  const dotGap = 14;
  const dotStartX = tx + 14;

  // Red dot
  ctx.beginPath();
  ctx.arc(dotStartX, dotY, dotR, 0, Math.PI * 2);
  ctx.fillStyle = state.status === "error" ? "#ff5f57" : "rgba(255,95,87,0.35)";
  ctx.fill();

  // Yellow dot
  ctx.beginPath();
  ctx.arc(dotStartX + dotGap, dotY, dotR, 0, Math.PI * 2);
  ctx.fillStyle = isRunning ? "#febc2e" : "rgba(254,188,46,0.35)";
  ctx.fill();

  // Green dot
  ctx.beginPath();
  ctx.arc(dotStartX + dotGap * 2, dotY, dotR, 0, Math.PI * 2);
  ctx.fillStyle = state.status === "done" ? "#28c840" : "rgba(40,200,64,0.35)";
  ctx.fill();

  // Title text (centered)
  ctx.font = `600 10px ${fontFamily}, -apple-system, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.textAlign = "center";
  const titleText = n.label.length > 30 ? n.label.slice(0, 28) + "\u2026" : n.label;
  ctx.fillText(titleText, tx + termW / 2, ty + titleBarH / 2 + 3.5);
  ctx.textAlign = "left";

  // Duration / status badge (right side of title bar)
  if (isRunning && state.startTime) {
    const dur = ((now - state.startTime) / 1000).toFixed(0) + "s";
    ctx.font = `500 9px ${monoFamily}, 'SF Mono', monospace`;
    ctx.fillStyle = color;
    ctx.textAlign = "right";
    ctx.fillText(dur, tx + termW - 12, ty + titleBarH / 2 + 3);
    ctx.textAlign = "left";
  } else if (state.status === "done" && state.startTime && state.finishedAt) {
    const dur = ((state.finishedAt - state.startTime) / 1000).toFixed(1) + "s";
    ctx.font = `500 9px ${monoFamily}, 'SF Mono', monospace`;
    ctx.fillStyle = successColor + "90";
    ctx.textAlign = "right";
    ctx.fillText(dur, tx + termW - 12, ty + titleBarH / 2 + 3);
    ctx.textAlign = "left";
  } else if (state.status === "error") {
    ctx.font = `600 9px ${fontFamily}, sans-serif`;
    ctx.fillStyle = errorColor + "90";
    ctx.textAlign = "right";
    ctx.fillText("error", tx + termW - 12, ty + titleBarH / 2 + 3);
    ctx.textAlign = "left";
  }

  // ─── Output lines (pixel-precise truncation + clip) ─────────
  const lastLines = state.output.slice(-MAX_LINES);
  const textPadL = 12;
  const textPadR = 12;
  const textMaxW = termW - textPadL - textPadR;
  ctx.font = `400 10px ${monoFamily}, 'SF Mono', 'Fira Code', monospace`;

  // Clip region to prevent any text overflow
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(tx, ty + titleBarH, termW, termH - titleBarH, [0, 0, r, r]);
  ctx.clip();

  lastLines.forEach((rawLine, li) => {
    const lineY = ty + titleBarH + 12 + li * lineH;

    // Truncate using measureText for pixel-perfect fit
    let line = rawLine;
    if (ctx.measureText(line).width > textMaxW) {
      while (line.length > 1 && ctx.measureText(line + "\u2026").width > textMaxW) {
        line = line.slice(0, -1);
      }
      line += "\u2026";
    }

    // Syntax-aware coloring
    if (line.startsWith("ERROR") || line.startsWith("[error]")) {
      ctx.fillStyle = errorColor;
    } else if (line.startsWith("[warn")) {
      ctx.fillStyle = warningColor;
    } else if (line.startsWith("[info]") || line.startsWith("[cache")) {
      ctx.fillStyle = infoColor + "60";
    } else if (line.startsWith("[gate") || line.startsWith("[awaiting")) {
      ctx.fillStyle = warningColor;
    } else {
      ctx.fillStyle = isRunning ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.55)";
    }
    ctx.fillText(line, tx + textPadL, lineY);
  });

  // ─── Blinking cursor (thin line, Apple Terminal style) ──────
  if (isRunning) {
    const blinkOn = Math.sin(now / 500 * Math.PI) > 0;
    if (blinkOn) {
      const lastLine = lastLines[lastLines.length - 1] ?? "";
      const cursorX = tx + textPadL + ctx.measureText(lastLine).width;
      const cursorY = ty + titleBarH + 2 + Math.max(0, numLines - 1) * lineH;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.8 * termOpacity;
      ctx.fillRect(Math.min(cursorX, tx + termW - textPadR), cursorY, 1.5, 13);
      ctx.globalAlpha = termOpacity;
    }
  }

  ctx.restore(); // end clip

  // ─── Connection line from node to terminal ─────────────────
  ctx.beginPath();
  ctx.moveTo(x + nw / 2, y + nh);
  ctx.lineTo(x + nw / 2, ty);
  ctx.strokeStyle = isRunning ? color + "30" : "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.restore();
}

// ─── Rich node type renderers ──────────────────────────────────────────

function drawStickyNode(
  ctx: CanvasRenderingContext2D,
  n: CanvasNode,
  isSelected: boolean,
  fontFamily: string,
) {
  const color = n.stickyColor ?? "#FFF9C4";
  const r = 6;

  // Shadow
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;

  // Body
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, n.h, r);
  ctx.fill();
  ctx.restore();

  // Corner fold triangle
  const foldSize = 16;
  ctx.fillStyle = "rgba(0,0,0,0.08)";
  ctx.beginPath();
  ctx.moveTo(n.x + n.w - foldSize, n.y);
  ctx.lineTo(n.x + n.w, n.y);
  ctx.lineTo(n.x + n.w, n.y + foldSize);
  ctx.closePath();
  ctx.fill();

  // Fold crease
  ctx.strokeStyle = "rgba(0,0,0,0.1)";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(n.x + n.w - foldSize, n.y);
  ctx.lineTo(n.x + n.w, n.y + foldSize);
  ctx.stroke();

  // Text
  const text = n.stickyText ?? n.label ?? "";
  const fontSize = n.fontSize ?? 13;
  ctx.fillStyle = "rgba(0,0,0,0.78)";
  ctx.font = `500 ${fontSize}px ${fontFamily}, sans-serif`;
  ctx.textAlign = "left";
  const padding = 10;
  const maxW = n.w - padding * 2;
  const lines = wrapText(ctx, text, maxW);
  const lineH = fontSize * 1.35;
  for (let i = 0; i < Math.min(lines.length, Math.floor((n.h - padding * 2) / lineH)); i++) {
    ctx.fillText(lines[i], n.x + padding, n.y + padding + fontSize + i * lineH);
  }

  // Selection glow
  if (isSelected) {
    ctx.save();
    ctx.shadowColor = "rgba(255,200,0,0.6)";
    ctx.shadowBlur = 16;
    ctx.strokeStyle = "rgba(255,200,0,0.8)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(n.x - 2, n.y - 2, n.w + 4, n.h + 4, r + 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawTextNode(
  ctx: CanvasRenderingContext2D,
  n: CanvasNode,
  isSelected: boolean,
  textColor: string,
  text2Color: string,
  fontFamily: string,
) {
  const text = n.markdown ?? n.label ?? "";
  const r = 8;

  // Subtle background
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, n.h, r);
  ctx.fill();

  // Border
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Text icon top-left
  ctx.fillStyle = text2Color;
  ctx.font = `500 10px ${fontFamily}, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText("\u{1F4DD} Text", n.x + 8, n.y + 14);

  // Content
  ctx.fillStyle = textColor;
  ctx.font = `400 12px ${fontFamily}, sans-serif`;
  const padding = 8;
  const maxW = n.w - padding * 2;
  const lines = wrapText(ctx, text, maxW);
  const lineH = 16;
  const startY = n.y + 26;
  const maxLines = Math.floor((n.h - 30) / lineH);
  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    ctx.fillText(lines[i], n.x + padding, startY + i * lineH);
  }

  if (isSelected) {
    ctx.save();
    ctx.shadowColor = "rgba(100,180,255,0.5)";
    ctx.shadowBlur = 14;
    ctx.strokeStyle = "rgba(100,180,255,0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(n.x - 2, n.y - 2, n.w + 4, n.h + 4, r + 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawPortalNode(
  ctx: CanvasRenderingContext2D,
  n: CanvasNode,
  isSelected: boolean,
  _textColor: string,
  text2Color: string,
  surfaceColor: string,
  borderColor: string,
  fontFamily: string,
) {
  const r = 10;
  const portColor = "#30d158";

  // Background
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = surfaceColor;
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, n.h, r);
  ctx.fill();
  ctx.restore();

  // Header bar (browser chrome)
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, 28, [r, r, 0, 0]);
  ctx.fill();

  // Traffic lights
  const tlY = n.y + 14;
  const colors = ["#ff5f57", "#febc2e", "#28c840"];
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = colors[i];
    ctx.beginPath();
    ctx.arc(n.x + 16 + i * 16, tlY, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // URL
  const url = n.portalUrl ?? "about:blank";
  ctx.fillStyle = text2Color;
  ctx.font = `400 10px ${fontFamily}, sans-serif`;
  ctx.textAlign = "left";
  const urlDisplay = url.length > 35 ? url.slice(0, 35) + "\u2026" : url;
  ctx.fillText(urlDisplay, n.x + 68, n.y + 18);

  // Body — placeholder or screenshot indicator
  ctx.fillStyle = "rgba(255,255,255,0.02)";
  ctx.fillRect(n.x + 1, n.y + 28, n.w - 2, n.h - 29);

  // Globe icon centered
  ctx.fillStyle = text2Color + "40";
  ctx.font = `400 28px ${fontFamily}, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("\u{1F310}", n.x + n.w / 2, n.y + n.h / 2 + 10);

  // Status label
  ctx.fillStyle = text2Color + "50";
  ctx.font = `500 10px ${fontFamily}, sans-serif`;
  ctx.fillText("Zoom in to view", n.x + n.w / 2, n.y + n.h / 2 + 32);

  // Border
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, n.h, r);
  ctx.stroke();

  // Connection ports (top=in, bottom=out)
  drawItemPorts(ctx, n, portColor, surfaceColor, borderColor);

  if (isSelected) {
    ctx.save();
    ctx.shadowColor = "rgba(50,200,100,0.5)";
    ctx.shadowBlur = 16;
    ctx.strokeStyle = "rgba(50,200,100,0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(n.x - 2, n.y - 2, n.w + 4, n.h + 4, r + 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawFileNode(
  ctx: CanvasRenderingContext2D,
  n: CanvasNode,
  isSelected: boolean,
  textColor: string,
  text2Color: string,
  surfaceColor: string,
  borderColor: string,
  fontFamily: string,
  monoFamily: string,
) {
  const r = 8;

  // Background
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = surfaceColor;
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, n.h, r);
  ctx.fill();
  ctx.restore();

  // Header
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, 24, [r, r, 0, 0]);
  ctx.fill();

  // File icon + path
  const filePath = n.filePath ?? "untitled";
  const fileName = filePath.split("/").pop() ?? filePath;
  ctx.fillStyle = text2Color;
  ctx.font = `500 10px ${fontFamily}, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText("\u{1F4C4} " + fileName, n.x + 8, n.y + 16);

  // Code content
  const content = n.fileContent ?? "// No content loaded";
  ctx.fillStyle = textColor + "CC";
  ctx.font = `400 10px ${monoFamily}, monospace`;
  const padding = 8;
  const lineH = 14;
  const lines = content.split("\n");
  const maxLines = Math.floor((n.h - 32) / lineH);
  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    const lineNum = String(i + 1).padStart(3, " ");
    ctx.fillStyle = text2Color + "60";
    ctx.fillText(lineNum, n.x + padding, n.y + 36 + i * lineH);
    ctx.fillStyle = textColor + "CC";
    ctx.fillText(lines[i].slice(0, 60), n.x + padding + 28, n.y + 36 + i * lineH);
  }

  // Border
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, n.h, r);
  ctx.stroke();

  // Connection ports
  drawItemPorts(ctx, n, "#ff9f0a", surfaceColor, borderColor);

  if (isSelected) {
    ctx.save();
    ctx.shadowColor = "rgba(200,150,50,0.5)";
    ctx.shadowBlur = 14;
    ctx.strokeStyle = "rgba(200,150,50,0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(n.x - 2, n.y - 2, n.w + 4, n.h + 4, r + 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawLinkNode(
  ctx: CanvasRenderingContext2D,
  n: CanvasNode,
  isSelected: boolean,
  textColor: string,
  text2Color: string,
  surfaceColor: string,
  borderColor: string,
  fontFamily: string,
) {
  const r = 10;

  // Background
  ctx.fillStyle = surfaceColor;
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, n.h, r);
  ctx.fill();

  // Link icon
  ctx.fillStyle = "#5AC8FA";
  ctx.font = `400 20px ${fontFamily}, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("\u{1F517}", n.x + 24, n.y + n.h / 2 + 7);

  // Title
  ctx.fillStyle = textColor;
  ctx.font = `600 12px ${fontFamily}, sans-serif`;
  ctx.textAlign = "left";
  const title = n.linkTitle ?? n.label ?? "Link";
  ctx.fillText(title.slice(0, 30), n.x + 44, n.y + n.h / 2 - 2);

  // URL
  ctx.fillStyle = text2Color;
  ctx.font = `400 10px ${fontFamily}, sans-serif`;
  const url = n.linkUrl ?? "";
  ctx.fillText(url.slice(0, 40), n.x + 44, n.y + n.h / 2 + 12);

  // Border
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, n.h, r);
  ctx.stroke();

  // Connection ports
  drawItemPorts(ctx, n, "#5AC8FA", surfaceColor, borderColor);

  if (isSelected) {
    ctx.save();
    ctx.shadowColor = "rgba(90,200,250,0.5)";
    ctx.shadowBlur = 14;
    ctx.strokeStyle = "rgba(90,200,250,0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(n.x - 2, n.y - 2, n.w + 4, n.h + 4, r + 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawTerminalNode(
  ctx: CanvasRenderingContext2D,
  n: CanvasNode,
  isSelected: boolean,
  textColor: string,
  text2Color: string,
  _surfaceColor: string,
  _borderColor: string,
  fontFamily: string,
  monoFamily: string,
) {
  const r = 10;

  // Dark terminal background
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = "#0d1117";
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, n.h, r);
  ctx.fill();
  ctx.restore();

  // Header bar (macOS-like title bar)
  ctx.fillStyle = "#161b22";
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, 32, [r, r, 0, 0]);
  ctx.fill();

  // Traffic lights
  const tlY = n.y + 16;
  const colors = ["#ff5f57", "#febc2e", "#28c840"];
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = colors[i];
    ctx.beginPath();
    ctx.arc(n.x + 16 + i * 16, tlY, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Title
  const name = n.terminalName ?? n.terminalModel ?? "Agent";
  ctx.fillStyle = textColor + "CC";
  ctx.font = `600 11px ${fontFamily}, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(name, n.x + n.w / 2, n.y + 20);

  // Provider badge
  const provider = n.terminalProvider ?? "claude";
  ctx.fillStyle = "#30d158";
  ctx.font = `500 9px ${fontFamily}, sans-serif`;
  ctx.textAlign = "right";
  ctx.fillText("\u25CF " + provider, n.x + n.w - 10, n.y + 20);

  // Terminal body — show last messages
  const messages = n.terminalMessages ?? [];
  ctx.font = `400 11px ${monoFamily}, monospace`;
  ctx.textAlign = "left";
  const lineH = 15;
  const bodyY = n.y + 38;
  const maxLines = Math.floor((n.h - 70) / lineH);
  const visibleMsgs = messages.slice(-maxLines * 2);

  let lineIdx = 0;
  for (const msg of visibleMsgs) {
    if (lineIdx >= maxLines) break;
    const prefix = msg.role === "user" ? "> " : "  ";
    ctx.fillStyle = msg.role === "user" ? "#58a6ff" : "#c9d1d9";
    const text = prefix + msg.content.slice(0, 50);
    ctx.fillText(text, n.x + 10, bodyY + lineIdx * lineH);
    lineIdx++;
  }

  if (messages.length === 0) {
    ctx.fillStyle = text2Color + "40";
    ctx.font = `400 11px ${fontFamily}, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("Ready", n.x + n.w / 2, n.y + n.h / 2 + 4);
  }

  // Input bar at bottom
  ctx.fillStyle = "#0d1117";
  ctx.strokeStyle = "#30363d";
  ctx.lineWidth = 1;
  const inputH = 28;
  const inputY = n.y + n.h - inputH - 6;
  ctx.beginPath();
  ctx.roundRect(n.x + 8, inputY, n.w - 16, inputH, 6);
  ctx.fill();
  ctx.stroke();

  // Prompt symbol
  ctx.fillStyle = "#30d158";
  ctx.font = `600 12px ${monoFamily}, monospace`;
  ctx.textAlign = "left";
  ctx.fillText("$", n.x + 16, inputY + 18);

  // Blinking cursor
  const blinkOn = Math.sin(performance.now() / 500 * Math.PI) > 0;
  if (blinkOn) {
    ctx.fillStyle = "#58a6ff";
    ctx.fillRect(n.x + 28, inputY + 7, 1.5, 14);
  }

  // Border
  ctx.strokeStyle = isSelected ? "#58a6ff" : "#30363d";
  ctx.lineWidth = isSelected ? 2 : 1;
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, n.h, r);
  ctx.stroke();

  // Connection ports
  drawItemPorts(ctx, n, "#58a6ff", "#0d1117", "#30363d");

  // Selection glow
  if (isSelected) {
    ctx.save();
    ctx.shadowColor = "rgba(88,166,255,0.5)";
    ctx.shadowBlur = 18;
    ctx.strokeStyle = "rgba(88,166,255,0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(n.x - 2, n.y - 2, n.w + 4, n.h + 4, r + 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawObsidianNode(
  ctx: CanvasRenderingContext2D,
  n: CanvasNode,
  isSelected: boolean,
  textColor: string,
  text2Color: string,
  surfaceColor: string,
  borderColor: string,
  fontFamily: string,
  monoFamily: string,
) {
  const r = 8;
  const obsidianPurple = "#8b5cf6"; // matches Obsidian's brand purple

  // Background card with a slight purple wash so the kind is recognizable.
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = surfaceColor;
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, n.h, r);
  ctx.fill();
  ctx.restore();

  // Header
  ctx.fillStyle = "rgba(139,92,246,0.10)";
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, 24, [r, r, 0, 0]);
  ctx.fill();

  // Title bar: 📓 + note path + optional vault badge
  const noteName = (n.obsidianNotePath ?? n.label ?? "untitled").split("/").pop() ?? "untitled";
  ctx.fillStyle = obsidianPurple;
  ctx.font = `600 11px ${fontFamily}, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText("📓 " + noteName, n.x + 8, n.y + 16);

  if (n.obsidianVault) {
    ctx.fillStyle = text2Color;
    ctx.font = `500 9px ${fontFamily}, sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText(n.obsidianVault, n.x + n.w - 8, n.y + 16);
  }

  // Markdown preview — render heading lines bigger, regular lines smaller.
  // No real Markdown parser here; just simple line-prefix detection.
  const content = n.obsidianContent ?? "Pick a .md file in the modal to preview.";
  const padding = 10;
  const lineH = 14;
  const startY = n.y + 36;
  const maxLines = Math.floor((n.h - 32) / lineH);
  const lines = content.split("\n").slice(0, maxLines);
  ctx.textAlign = "left";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const y = startY + i * lineH;
    if (line.startsWith("# ")) {
      ctx.fillStyle = textColor;
      ctx.font = `700 12px ${fontFamily}, sans-serif`;
      ctx.fillText(line.slice(2).slice(0, 50), n.x + padding, y);
    } else if (line.startsWith("## ")) {
      ctx.fillStyle = textColor;
      ctx.font = `700 11px ${fontFamily}, sans-serif`;
      ctx.fillText(line.slice(3).slice(0, 55), n.x + padding, y);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      ctx.fillStyle = textColor + "CC";
      ctx.font = `400 10px ${fontFamily}, sans-serif`;
      ctx.fillText("• " + line.slice(2).slice(0, 55), n.x + padding + 4, y);
    } else if (/^\s*\[\[.+\]\]/.test(line)) {
      // Obsidian-style wikilink line
      ctx.fillStyle = obsidianPurple;
      ctx.font = `500 10px ${fontFamily}, sans-serif`;
      ctx.fillText(line.trim().slice(0, 60), n.x + padding, y);
    } else {
      ctx.fillStyle = textColor + "AA";
      ctx.font = `400 10px ${monoFamily}, monospace`;
      ctx.fillText(line.slice(0, 65), n.x + padding, y);
    }
  }

  // Border with the Obsidian accent
  ctx.strokeStyle = isSelected ? obsidianPurple : borderColor;
  ctx.lineWidth = isSelected ? 2 : 1;
  ctx.beginPath();
  ctx.roundRect(n.x, n.y, n.w, n.h, r);
  ctx.stroke();

  drawItemPorts(ctx, n, obsidianPurple, surfaceColor, borderColor);

  if (isSelected) {
    ctx.save();
    ctx.shadowColor = "rgba(139,92,246,0.5)";
    ctx.shadowBlur = 14;
    ctx.strokeStyle = "rgba(139,92,246,0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(n.x - 2, n.y - 2, n.w + 4, n.h + 4, r + 2);
    ctx.stroke();
    ctx.restore();
  }
}

/** Draw in/out connection ports for a canvas item */
function drawItemPorts(
  ctx: CanvasRenderingContext2D,
  n: CanvasNode,
  color: string,
  surfaceColor: string,
  borderColor: string,
) {
  // Input port (top center)
  const ip = portPos(n, "in");
  ctx.fillStyle = surfaceColor;
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(ip.x, ip.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Output port (bottom center)
  const op = portPos(n, "out");
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(op.x, op.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

// ─── Resize handles ────────────────────────────────────────────────────
import type { ResizeHandle } from "../../types/canvas";

const HANDLE_SIZE = 6;

/** Draw 8 resize handles (4 corners + 4 edges) around a node */
function drawResizeHandles(ctx: CanvasRenderingContext2D, n: CanvasNode, color: string) {
  const hs = HANDLE_SIZE;
  const positions = getHandlePositions(n);

  for (const { x, y, corner } of positions) {
    ctx.fillStyle = corner ? "#fff" : "rgba(255,255,255,0.7)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x - hs / 2, y - hs / 2, hs, hs, corner ? 2 : 1);
    ctx.fill();
    ctx.stroke();
  }
}

function getHandlePositions(n: CanvasNode): Array<{ x: number; y: number; handle: ResizeHandle; corner: boolean }> {
  const mx = n.x + n.w / 2;
  const my = n.y + n.h / 2;
  return [
    { x: n.x,       y: n.y,       handle: "nw" as ResizeHandle, corner: true },
    { x: mx,        y: n.y,       handle: "n"  as ResizeHandle, corner: false },
    { x: n.x + n.w, y: n.y,       handle: "ne" as ResizeHandle, corner: true },
    { x: n.x + n.w, y: my,        handle: "e"  as ResizeHandle, corner: false },
    { x: n.x + n.w, y: n.y + n.h, handle: "se" as ResizeHandle, corner: true },
    { x: mx,        y: n.y + n.h, handle: "s"  as ResizeHandle, corner: false },
    { x: n.x,       y: n.y + n.h, handle: "sw" as ResizeHandle, corner: true },
    { x: n.x,       y: my,        handle: "w"  as ResizeHandle, corner: false },
  ];
}

/** Hit-test resize handles on a selected node. Returns the handle or null. */
export function resizeHandleAt(
  canvasX: number,
  canvasY: number,
  n: CanvasNode,
  hitRadius = 8,
): ResizeHandle | null {
  const positions = getHandlePositions(n);
  for (const { x, y, handle } of positions) {
    const dx = canvasX - x;
    const dy = canvasY - y;
    if (dx * dx + dy * dy < hitRadius * hitRadius) return handle;
  }
  return null;
}

/** Word-wrap text into lines */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const test = current ? current + " " + word : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
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
