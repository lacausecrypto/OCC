/**
 * GraphView — Obsidian-like force-directed graph view.
 * Clean, interactive, with edge labels, gradient links, hover details,
 * cluster grouping, and smooth physics.
 */
import { useRef, useEffect, useCallback, useState } from "react";
import { useBlobStore } from "../../stores/blob";
import type { BlobNode, BlobEdge } from "../../types/blob";
import { NodeInfoPanel } from "./NodeInfoPanel";
import styles from "./Blob.module.css";

// ─── Theme-aware colors ────────────────────────────────────────────────────

function css(name: string, fb: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
}

function parseRgb(color: string): [number, number, number] {
  if (color.startsWith("#")) {
    const hex = color.length === 4
      ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
      : color;
    return [parseInt(hex.slice(1, 3), 16) || 0, parseInt(hex.slice(3, 5), 16) || 0, parseInt(hex.slice(5, 7), 16) || 0];
  }
  const m = color.match(/(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/);
  if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
  return [128, 128, 128];
}

function luminance(color: string): number {
  const [r, g, b] = parseRgb(color);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function hexToRgba(color: string, alpha: number): string {
  const [r, g, b] = parseRgb(color);
  return `rgba(${r},${g},${b},${alpha})`;
}

function getColors() {
  return {
    core: css("--m-accent", "#ffd60a"),
    branch: css("--icon-green", "#30d158"),
    step: css("--icon-blue", "#0a84ff"),
    fork: css("--icon-purple", "#bf5af2"),
    memory: css("--icon-orange", "#ff9f0a"),
    input: css("--icon-cyan", "#64d2ff"),
    output: css("--icon-green", "#30d158"),
    text: css("--m-text", "#f5f5f7"),
    text2: css("--m-text2", "#86868b"),
    bg: css("--m-bg", "#0d0d0d"),
    border: css("--m-border", "#333"),
    font: css("--m-font", "-apple-system, BlinkMacSystemFont, sans-serif"),
    success: css("--c-success", "#30d158"),
    error: css("--c-error", "#ff375f"),
    warning: css("--c-warning", "#ff9f0a"),
  };
}

const NODE_R: Record<string, number> = {
  core: 32, branch: 22, step: 15, fork: 13, memory: 12, input: 10, output: 10,
};

// ─── Force simulation ──────────────────────────────────────────────────────

interface SimNode {
  id: string;
  x: number; y: number;
  vx: number; vy: number;
  radius: number;
  pinned: boolean;
  node: BlobNode;
}

function runForces(nodes: SimNode[], edges: Map<string, BlobEdge>) {
  const REPULSION = 6000;
  const DAMPING = 0.85;
  const CENTER = 0.0002;

  // Desired edge lengths per type
  const edgeLen = (fromType: string, toType: string): number => {
    if (fromType === "core") return 160;
    if (fromType === "branch" && toType === "step") return 80;
    if (toType === "fork") return 100;
    return 100;
  };

  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  for (const a of nodes) {
    if (a.pinned) continue;
    let fx = 0, fy = 0;

    // Repulsion
    for (const b of nodes) {
      if (a.id === b.id) continue;
      const dx = a.x - b.x, dy = a.y - b.y;
      const distSq = Math.max(dx * dx + dy * dy, 100);
      const dist = Math.sqrt(distSq);
      const f = REPULSION / distSq;
      fx += (dx / dist) * f;
      fy += (dy / dist) * f;
    }

    // Center gravity
    fx -= a.x * CENTER;
    fy -= a.y * CENTER;

    a.vx = (a.vx + fx) * DAMPING;
    a.vy = (a.vy + fy) * DAMPING;
  }

  // Springs
  for (const [, e] of edges) {
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to) continue;
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    const target = edgeLen(from.node.type, to.node.type);
    const k = 0.005;
    const f = (dist - target) * k;
    const fx = (dx / dist) * f, fy = (dy / dist) * f;
    if (!from.pinned) { from.vx += fx; from.vy += fy; }
    if (!to.pinned) { to.vx -= fx; to.vy -= fy; }
  }

  // Apply
  for (const n of nodes) {
    if (n.pinned) continue;
    n.x += n.vx;
    n.y += n.vy;
  }
}

// ─── Render ────────────────────────────────────────────────────────────────

function render(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  simNodes: SimNode[],
  edges: Map<string, BlobEdge>,
  cam: { x: number; y: number; zoom: number },
  hovered: string | null,
  selected: string | null,
  t: number,
) {
  const dpr = window.devicePixelRatio || 1;
  const pw = canvas.parentElement?.clientWidth ?? 0;
  const ph = canvas.parentElement?.clientHeight ?? 0;
  if (pw < 10 || ph < 10) return;

  if (canvas.width !== pw * dpr || canvas.height !== ph * dpr) {
    canvas.width = pw * dpr;
    canvas.height = ph * dpr;
    canvas.style.width = `${pw}px`;
    canvas.style.height = `${ph}px`;
  }

  const C = getColors();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, pw, ph);

  ctx.save();
  ctx.translate(pw / 2 + cam.x, ph / 2 + cam.y);
  ctx.scale(cam.zoom, cam.zoom);

  // ─── Grid dots ─────────────────────────────────────────────
  const gs = 50;
  const sx = Math.floor((-pw / 2 - cam.x) / cam.zoom / gs) * gs;
  const sy = Math.floor((-ph / 2 - cam.y) / cam.zoom / gs) * gs;
  const isDark = luminance(C.bg) < 0.45;
  ctx.fillStyle = isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.05)";
  for (let gx = sx; gx < sx + pw / cam.zoom + gs * 2; gx += gs) {
    for (let gy = sy; gy < sy + ph / cam.zoom + gs * 2; gy += gs) {
      ctx.beginPath();
      ctx.arc(gx, gy, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const byId = new Map(simNodes.map((n) => [n.id, n]));

  // ─── Edges ─────────────────────────────────────────────────
  for (const [, e] of edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;

    const hl = hovered === from.id || hovered === to.id || selected === from.id || selected === to.id;
    const fromC = C[from.node.type as keyof typeof C] ?? C.step;
    const toC = C[to.node.type as keyof typeof C] ?? C.step;
    const isFork = e.type === "fork";

    // Gradient edge
    const grad = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
    const edgeAlpha = hl ? 0.8 : isDark ? 0.3 : 0.45;
    grad.addColorStop(0, hexToRgba(fromC, edgeAlpha));
    grad.addColorStop(1, hexToRgba(toC, edgeAlpha));

    ctx.beginPath();
    // Bezier curve — slight organic bend
    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
    const px = -(to.y - from.y) * 0.08, py = (to.x - from.x) * 0.08;
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(mx + px, my + py, to.x, to.y);
    ctx.strokeStyle = grad;
    ctx.lineWidth = hl ? 2.5 : isFork ? 1 : 1.5;
    if (isFork) ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrow head
    const angle = Math.atan2(to.y - (my + py), to.x - (mx + px));
    const ar = to.radius + 4;
    const ax = to.x - Math.cos(angle) * ar;
    const ay = to.y - Math.sin(angle) * ar;
    const aSize = hl ? 7 : 5;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax - Math.cos(angle - 0.4) * aSize, ay - Math.sin(angle - 0.4) * aSize);
    ctx.lineTo(ax - Math.cos(angle + 0.4) * aSize, ay - Math.sin(angle + 0.4) * aSize);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(toC, hl ? 0.7 : isDark ? 0.35 : 0.5);
    ctx.fill();

  }

  // ─── Nodes ─────────────────────────────────────────────────
  for (const sn of simNodes) {
    const r = sn.radius;
    const color = C[sn.node.type as keyof typeof C] ?? C.step;
    const isH = hovered === sn.id;
    const isS = selected === sn.id;
    const isActive = sn.node.status === "running" || sn.node.status === "thinking";
    const isDone = sn.node.status === "done";
    const isError = sn.node.status === "error";

    // Outer glow
    if (isH || isS || isActive) {
      const gr = r + (isActive ? 14 + Math.sin(t * 0.004) * 4 : 10);
      const glow = ctx.createRadialGradient(sn.x, sn.y, r * 0.5, sn.x, sn.y, gr);
      glow.addColorStop(0, hexToRgba(color, 0.25));
      glow.addColorStop(1, "transparent");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(sn.x, sn.y, gr, 0, Math.PI * 2);
      ctx.fill();
    }

    // Node fill — glass-like with inner gradient
    const fillGrad = ctx.createRadialGradient(sn.x - r * 0.3, sn.y - r * 0.3, 0, sn.x, sn.y, r);
    const fillHi = isDone ? 0.9 : isDark ? 0.5 : 0.65;
    const fillLo = isDone ? 0.6 : isDark ? 0.15 : 0.3;
    fillGrad.addColorStop(0, hexToRgba(color, fillHi));
    fillGrad.addColorStop(1, hexToRgba(color, fillLo));
    ctx.beginPath();
    ctx.arc(sn.x, sn.y, r, 0, Math.PI * 2);
    ctx.fillStyle = fillGrad;
    ctx.fill();

    // Border
    ctx.strokeStyle = hexToRgba(color, isS ? 1 : isH ? 0.8 : isDark ? 0.5 : 0.7);
    ctx.lineWidth = isS ? 2.5 : isH ? 2 : 1;
    ctx.stroke();

    // Status indicator — subtle border change only
    if (isError) {
      ctx.beginPath();
      ctx.arc(sn.x, sn.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = C.error;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Icon inside core
    if (sn.node.type === "core") {
      ctx.font = `${r * 0.8}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = C.bg;
      ctx.fillText("\u{1F9EC}", sn.x, sn.y);
    }

    // Fork icon
    if (sn.node.type === "fork") {
      ctx.font = `bold ${r * 0.9}px ${C.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = C.text;
      ctx.fillText("\u2442", sn.x, sn.y + 1);
    }

    // Label
    ctx.shadowColor = isDark ? "rgba(0,0,0,0.9)" : "rgba(255,255,255,0.9)";
    ctx.shadowBlur = 3;
    const fontSize = sn.node.type === "core" ? 11 : sn.node.type === "branch" ? 9 : 7;
    ctx.font = `600 ${fontSize}px ${C.font}`;
    ctx.fillStyle = C.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const label = sn.node.type === "core" ? "BLOB" :
      sn.node.label.length > 22 ? sn.node.label.slice(0, 20) + "\u2026" : sn.node.label;
    ctx.fillText(label, sn.x, sn.y + r + 6);

    // Type badge below label
    if (sn.node.type !== "core") {
      ctx.font = `700 5px ${C.font}`;
      ctx.fillStyle = hexToRgba(color, isDark ? 0.7 : 0.9);
      ctx.fillText(sn.node.type.toUpperCase(), sn.x, sn.y + r + 6 + fontSize + 2);
    }
    ctx.shadowBlur = 0;

    // Done checkmark
    if (isDone && sn.node.type === "step") {
      ctx.font = `bold ${r * 0.7}px ${C.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = C.bg;
      ctx.fillText("\u2713", sn.x, sn.y);
    }
  }

  // ─── Tooltip on hover ──────────────────────────────────────
  if (hovered) {
    const sn = byId.get(hovered);
    if (sn) {
      const d = sn.node.data;
      const lines: string[] = [];
      lines.push(`${sn.node.type.toUpperCase()}: ${sn.node.label}`);
      lines.push(`Status: ${sn.node.status}`);
      if (d.kind === "step") {
        if (d.stepType) lines.push(`Type: ${d.stepType}`);
        if (d.durationMs != null) lines.push(`Duration: ${(d.durationMs / 1000).toFixed(1)}s`);
        if (d.inputTokens != null) lines.push(`Tokens: ${d.inputTokens} in / ${d.outputTokens ?? 0} out`);
        if (d.output) lines.push(`Output: ${d.output.slice(0, 80)}${d.output.length > 80 ? "\u2026" : ""}`);
      }
      if (d.kind === "branch") lines.push(`Topic: ${d.topic}`);
      if (d.kind === "fork") lines.push(`Reason: ${d.reason}`);

      const tipX = sn.x + sn.radius + 12;
      const tipY = sn.y - 10;
      const padding = 8;
      ctx.font = `400 9px ${C.font}`;

      const maxW = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const tipW = maxW + padding * 2;
      const tipH = lines.length * 14 + padding * 2;

      // Background
      ctx.fillStyle = isDark ? "rgba(30,30,30,0.92)" : "rgba(250,250,250,0.95)";
      ctx.strokeStyle = C.border;
      ctx.lineWidth = 0.5;
      const br = 6;
      ctx.beginPath();
      ctx.roundRect(tipX, tipY, tipW, tipH, br);
      ctx.fill();
      ctx.stroke();

      // Text
      ctx.fillStyle = C.text;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      lines.forEach((line, i) => {
        if (i === 0) ctx.font = `600 9px ${C.font}`;
        else ctx.font = `400 9px ${C.font}`;
        ctx.fillStyle = i === 0 ? C.text : C.text2;
        ctx.fillText(line, tipX + padding, tipY + padding + i * 14);
      });
    }
  }

  ctx.restore();
}

// ─── Component ─────────────────────────────────────────────────────────────

export function GraphView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef(0);
  const simRef = useRef<SimNode[]>([]);
  const camRef = useRef({ x: 0, y: 0, zoom: 1 });
  const dragRef = useRef<{ type: "pan" | "node"; sx: number; sy: number; cx: number; cy: number; nodeId?: string } | null>(null);

  const nodes = useBlobStore((s) => s.nodes);
  const edges = useBlobStore((s) => s.edges);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // Sync store → sim
  useEffect(() => {
    const cur = simRef.current;
    const curIds = new Set(cur.map((n) => n.id));
    const storeIds = new Set(nodes.keys());

    for (const [id, node] of nodes) {
      if (!curIds.has(id)) {
        simRef.current.push({
          id,
          x: node.x || (Math.random() - 0.5) * 300,
          y: node.y || (Math.random() - 0.5) * 300,
          vx: 0, vy: 0,
          radius: NODE_R[node.type] ?? 10,
          pinned: false,
          node,
        });
      } else {
        const sn = cur.find((s) => s.id === id);
        if (sn) { sn.node = node; sn.radius = NODE_R[node.type] ?? 10; }
      }
    }
    simRef.current = simRef.current.filter((sn) => storeIds.has(sn.id));
  }, [nodes]);

  // Animation
  useEffect(() => {
    let running = true;
    const loop = () => {
      if (!running) return;
      const c = canvasRef.current;
      if (c) {
        const ctx = c.getContext("2d");
        if (ctx) {
          runForces(simRef.current, edges);
          render(ctx, c, simRef.current, edges, camRef.current, hovered, selected, performance.now());
        }
      }
      animRef.current = requestAnimationFrame(loop);
    };
    loop();
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, [edges, hovered, selected]);

  // Hit test
  const hitTest = useCallback((cx: number, cy: number): string | null => {
    const c = canvasRef.current;
    if (!c) return null;
    const rect = c.getBoundingClientRect();
    const cam = camRef.current;
    const mx = (cx - rect.left - rect.width / 2 - cam.x) / cam.zoom;
    const my = (cy - rect.top - rect.height / 2 - cam.y) / cam.zoom;
    for (let i = simRef.current.length - 1; i >= 0; i--) {
      const sn = simRef.current[i];
      const dx = mx - sn.x, dy = my - sn.y;
      if (dx * dx + dy * dy < (sn.radius + 8) * (sn.radius + 8)) return sn.id;
    }
    return null;
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const hit = hitTest(e.clientX, e.clientY);
    if (hit) {
      const sn = simRef.current.find((n) => n.id === hit);
      if (sn) {
        sn.pinned = true;
        dragRef.current = { type: "node", sx: e.clientX, sy: e.clientY, cx: sn.x, cy: sn.y, nodeId: hit };
        setSelected(hit);
      }
    } else {
      const cam = camRef.current;
      dragRef.current = { type: "pan", sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
      setSelected(null);
    }
  }, [hitTest]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) {
      setHovered(hitTest(e.clientX, e.clientY));
      return;
    }
    const dx = e.clientX - dragRef.current.sx;
    const dy = e.clientY - dragRef.current.sy;
    if (dragRef.current.type === "pan") {
      camRef.current = { ...camRef.current, x: dragRef.current.cx + dx, y: dragRef.current.cy + dy };
    } else if (dragRef.current.nodeId) {
      const sn = simRef.current.find((n) => n.id === dragRef.current!.nodeId);
      if (sn) {
        sn.x = dragRef.current.cx + dx / camRef.current.zoom;
        sn.y = dragRef.current.cy + dy / camRef.current.zoom;
        sn.vx = 0; sn.vy = 0;
      }
    }
  }, [hitTest]);

  const onPointerUp = useCallback(() => {
    if (dragRef.current?.type === "node" && dragRef.current.nodeId) {
      const sn = simRef.current.find((n) => n.id === dragRef.current!.nodeId);
      if (sn) sn.pinned = false;
    }
    dragRef.current = null;
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const f = e.deltaY > 0 ? 0.92 : 1.08;
    camRef.current = { ...camRef.current, zoom: Math.max(0.15, Math.min(5, camRef.current.zoom * f)) };
  }, []);

  return (
    <>
      <canvas
        ref={canvasRef}
        className={styles.blobCanvas}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      />
      {selected && nodes.get(selected) && (
        <NodeInfoPanel nodeId={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
