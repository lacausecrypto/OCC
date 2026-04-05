/**
 * Renders annotations: drawings, text, shapes, arrows, images, sticky notes.
 * Supports selection handles for move/resize.
 */
import type { Camera } from "../../types/canvas";
import type { Annotation, Point } from "../../stores/annotations";

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// Image cache to avoid re-decoding base64 every frame
const imageCache = new Map<string, HTMLImageElement>();

function getImage(dataUrl: string): HTMLImageElement | null {
  if (imageCache.has(dataUrl)) return imageCache.get(dataUrl)!;
  const img = new Image();
  img.src = dataUrl;
  imageCache.set(dataUrl, img);
  return img.complete ? img : null;
}

function drawArrowhead(ctx: CanvasRenderingContext2D, from: Point, to: Point, size: number): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(angle - 0.4), to.y - size * Math.sin(angle - 0.4));
  ctx.lineTo(to.x - size * Math.cos(angle + 0.4), to.y - size * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fill();
}

function drawAnnotation(ctx: CanvasRenderingContext2D, ann: Annotation): void {
  ctx.strokeStyle = ann.color;
  ctx.fillStyle = ann.color;
  ctx.lineWidth = ann.lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // ─── Image ────────────────────────────────────────────────────
  if (ann.imageData) {
    const img = getImage(ann.imageData);
    if (img) {
      ctx.drawImage(img, ann.x, ann.y, ann.w, ann.h);
    } else {
      // Loading placeholder
      ctx.fillStyle = "rgba(128,128,128,0.2)";
      ctx.fillRect(ann.x, ann.y, ann.w, ann.h);
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.font = `12px ${cssVar("--m-font", "system-ui")}`;
      ctx.textAlign = "center";
      ctx.fillText("Loading...", ann.x + ann.w / 2, ann.y + ann.h / 2);
    }
    // Border
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.strokeRect(ann.x, ann.y, ann.w, ann.h);
    return;
  }

  // ─── Sticky note ──────────────────────────────────────────────
  if (ann.stickyColor) {
    const x = ann.x, y = ann.y, w = ann.w, h = ann.h;
    // Shadow
    ctx.shadowColor = "rgba(0,0,0,0.2)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    // Background
    ctx.fillStyle = ann.stickyColor;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    // Fold corner
    ctx.fillStyle = "rgba(0,0,0,0.08)";
    ctx.beginPath();
    ctx.moveTo(x + w - 16, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + 16);
    ctx.closePath();
    ctx.fill();
    // Text
    if (ann.text) {
      ctx.fillStyle = "rgba(0,0,0,0.8)";
      ctx.font = `${ann.fontSize ?? 13}px ${cssVar("--m-font", "system-ui")}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const lines = ann.text.split("\n");
      const lineH = (ann.fontSize ?? 13) * 1.4;
      for (let i = 0; i < lines.length && (i + 1) * lineH < h - 8; i++) {
        ctx.fillText(lines[i].slice(0, Math.floor(w / 7)), x + 8, y + 8 + i * lineH);
      }
    } else {
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.font = `11px ${cssVar("--m-font", "system-ui")}`;
      ctx.textAlign = "center";
      ctx.fillText("Double-click to edit", x + w / 2, y + h / 2);
    }
    return;
  }

  switch (ann.tool) {
    case "pencil": {
      if (ann.points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(ann.points[0].x, ann.points[0].y);
      for (let i = 1; i < ann.points.length; i++) {
        if (i < ann.points.length - 1) {
          const xc = (ann.points[i].x + ann.points[i + 1].x) / 2;
          const yc = (ann.points[i].y + ann.points[i + 1].y) / 2;
          ctx.quadraticCurveTo(ann.points[i].x, ann.points[i].y, xc, yc);
        } else {
          ctx.lineTo(ann.points[i].x, ann.points[i].y);
        }
      }
      ctx.stroke();
      break;
    }
    case "line": {
      if (ann.points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(ann.points[0].x, ann.points[0].y);
      ctx.lineTo(ann.points[1].x, ann.points[1].y);
      ctx.stroke();
      break;
    }
    case "arrow": {
      if (ann.points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(ann.points[0].x, ann.points[0].y);
      ctx.lineTo(ann.points[1].x, ann.points[1].y);
      ctx.stroke();
      drawArrowhead(ctx, ann.points[0], ann.points[1], 10 + ann.lineWidth * 2);
      break;
    }
    case "rect": {
      const x = Math.min(ann.x, ann.x + ann.w);
      const y = Math.min(ann.y, ann.y + ann.h);
      const w = Math.abs(ann.w); const h = Math.abs(ann.h);
      ctx.globalAlpha = 0.08;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeRect(x, y, w, h);
      break;
    }
    case "ellipse": {
      const cx = ann.x + ann.w / 2; const cy = ann.y + ann.h / 2;
      const rx = Math.abs(ann.w / 2); const ry = Math.abs(ann.h / 2);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.globalAlpha = 0.08;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.stroke();
      break;
    }
    case "text": {
      const fontSize = ann.fontSize ?? 16;
      ctx.font = `${fontSize}px ${cssVar("--m-font", "system-ui")}`;
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      const lines = (ann.text ?? "Text").split("\n");
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], ann.x, ann.y + i * (fontSize * 1.3));
      }
      break;
    }
  }
}

/** Draw selection handles around selected annotation */
function drawSelectionHandles(ctx: CanvasRenderingContext2D, ann: Annotation): void {
  const x = Math.min(ann.x, ann.x + ann.w);
  const y = Math.min(ann.y, ann.y + ann.h);
  const w = Math.abs(ann.w) || 100;
  const h = Math.abs(ann.h) || 30;

  // Selection outline
  ctx.strokeStyle = cssVar("--m-accent", "#0a84ff");
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
  ctx.setLineDash([]);

  // Resize handle (bottom-right)
  const hs = 8;
  ctx.fillStyle = cssVar("--m-accent", "#0a84ff");
  ctx.fillRect(x + w - hs / 2, y + h - hs / 2, hs, hs);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + w - hs / 2, y + h - hs / 2, hs, hs);
}

export function renderAnnotations(
  ctx: CanvasRenderingContext2D,
  _cam: Camera,
  annotations: Annotation[],
  drawing: Annotation | null,
  selectedId?: string | null,
): void {
  for (const ann of annotations) {
    drawAnnotation(ctx, ann);
    if (selectedId && ann.id === selectedId) {
      drawSelectionHandles(ctx, ann);
    }
  }
  if (drawing) {
    ctx.globalAlpha = 0.7;
    drawAnnotation(ctx, drawing);
    ctx.globalAlpha = 1;
  }
}

export function drawEraserCursor(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  ctx.strokeStyle = cssVar("--c-error", "#ff375f"); ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
}
