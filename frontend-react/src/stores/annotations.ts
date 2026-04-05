/**
 * Annotation store — draw, text, shapes, arrows, images, sticky notes.
 * Annotations isolated per chain/pipeline. Supports paste/drop images.
 */
import { create } from "zustand";

export type AnnotationTool =
  | "none" | "select" | "pencil" | "line" | "arrow"
  | "rect" | "ellipse" | "text" | "sticky" | "eraser";

export interface Point { x: number; y: number; }

export interface Annotation {
  id: string;
  tool: AnnotationTool;
  points: Point[];
  x: number; y: number;
  w: number; h: number;
  text?: string;
  color: string;
  lineWidth: number;
  fontSize?: number;
  /** Base64 data URL for images */
  imageData?: string;
  /** Sticky note background color */
  stickyColor?: string;
}

interface AnnotationState {
  canvasKey: string;
  annotations: Annotation[];
  activeTool: AnnotationTool;
  activeColor: string;
  activeLineWidth: number;
  drawing: Annotation | null;
  /** Currently selected annotation ID (for move/resize) */
  selectedId: string | null;
  /** Drag offset for moving selected annotation */
  dragOffset: Point | null;
  /** Resize handle being dragged */
  resizeHandle: string | null;
  /** Undo history stack */
  undoStack: Annotation[][];

  setCanvasKey: (key: string) => void;
  setTool: (tool: AnnotationTool) => void;
  setColor: (color: string) => void;
  setLineWidth: (w: number) => void;

  startDraw: (point: Point) => void;
  continueDraw: (point: Point) => void;
  finishDraw: (text?: string) => void;
  cancelDraw: () => void;

  /** Add image annotation from paste/drop */
  addImage: (dataUrl: string, x: number, y: number, w: number, h: number) => void;
  /** Add sticky note */
  addSticky: (x: number, y: number) => void;

  /** Select annotation at point */
  selectAt: (point: Point) => string | null;
  /** Start moving selected annotation */
  startMove: (point: Point) => void;
  /** Continue moving */
  continueMove: (point: Point) => void;
  /** Start resizing selected annotation */
  startResize: (handle: string, point: Point) => void;
  /** Continue resizing */
  continueResize: (point: Point) => void;
  /** Finish move/resize */
  finishMoveResize: () => void;
  /** Deselect */
  deselect: () => void;
  /** Delete selected */
  deleteSelected: () => void;
  /** Update text of selected annotation */
  updateText: (text: string) => void;

  eraseAt: (point: Point, radius: number) => void;
  clearAll: () => void;
  undo: () => void;
}

const STORAGE_KEY = "occ-annotations-v2";

function loadAllFromStorage(): Record<string, Annotation[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupt */ }
  return {};
}
function saveAllToStorage(all: Record<string, Annotation[]>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch { /* full */ }
}
function loadForKey(key: string): Annotation[] {
  return loadAllFromStorage()[key] ?? [];
}
function saveForKey(key: string, annotations: Annotation[]): void {
  const all = loadAllFromStorage();
  if (annotations.length > 0) all[key] = annotations; else delete all[key];
  saveAllToStorage(all);
}

let nextAnnId = Date.now();

/** Hit-test: is point near an annotation? */
function hitTest(ann: Annotation, p: Point, threshold = 10): boolean {
  if (ann.tool === "pencil" || ann.tool === "line" || ann.tool === "arrow") {
    return ann.points.some((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) < threshold);
  }
  // Rect, ellipse, text, sticky, image — AABB test
  const ax = Math.min(ann.x, ann.x + ann.w);
  const ay = Math.min(ann.y, ann.y + ann.h);
  const aw = Math.abs(ann.w);
  const ah = Math.abs(ann.h);
  return p.x >= ax - threshold && p.x <= ax + aw + threshold && p.y >= ay - threshold && p.y <= ay + ah + threshold;
}

export const useAnnotationStore = create<AnnotationState>((set, get) => ({
  canvasKey: "_default",
  annotations: loadForKey("_default"),
  activeTool: "none",
  activeColor: "#0a84ff",
  activeLineWidth: 2,
  drawing: null,
  selectedId: null,
  dragOffset: null,
  resizeHandle: null,
  undoStack: [],

  setCanvasKey: (key) => {
    const { canvasKey, annotations } = get();
    saveForKey(canvasKey, annotations);
    set({ canvasKey: key, annotations: loadForKey(key), drawing: null, selectedId: null, undoStack: [] });
  },

  setTool: (tool) => set({ activeTool: tool, drawing: null, selectedId: null }),
  setColor: (color) => set({ activeColor: color }),
  setLineWidth: (w) => set({ activeLineWidth: w }),

  startDraw: (point) => {
    const { activeTool, activeColor, activeLineWidth } = get();
    if (activeTool === "none" || activeTool === "eraser" || activeTool === "select") return;
    if (activeTool === "sticky") { get().addSticky(point.x, point.y); return; }
    set({
      drawing: {
        id: `ann_${nextAnnId++}`, tool: activeTool, points: [point],
        x: point.x, y: point.y, w: 0, h: 0,
        color: activeColor, lineWidth: activeLineWidth, fontSize: 16,
      },
      selectedId: null,
    });
  },

  continueDraw: (point) => {
    const { drawing } = get();
    if (!drawing) return;
    if (drawing.tool === "pencil") {
      set({ drawing: { ...drawing, points: [...drawing.points, point] } });
    } else if (drawing.tool === "line" || drawing.tool === "arrow") {
      set({ drawing: { ...drawing, points: [drawing.points[0], point] } });
    } else {
      set({ drawing: { ...drawing, w: point.x - drawing.x, h: point.y - drawing.y } });
    }
  },

  finishDraw: (text) => {
    const { drawing, annotations, undoStack } = get();
    if (!drawing) return;
    if (drawing.tool === "pencil" && drawing.points.length < 3) { set({ drawing: null }); return; }
    if ((drawing.tool === "rect" || drawing.tool === "ellipse") && Math.abs(drawing.w) < 5 && Math.abs(drawing.h) < 5) { set({ drawing: null }); return; }
    if ((drawing.tool === "line" || drawing.tool === "arrow") && drawing.points.length < 2) { set({ drawing: null }); return; }

    const final = { ...drawing };
    if (final.tool === "text") final.text = text ?? "Text";
    if (final.w < 0) { final.x += final.w; final.w = -final.w; }
    if (final.h < 0) { final.y += final.h; final.h = -final.h; }

    set({ annotations: [...annotations, final], drawing: null, undoStack: [...undoStack, annotations] });
  },

  cancelDraw: () => set({ drawing: null }),

  // ─── Image paste/drop ─────────────────────────────────────────
  addImage: (dataUrl, x, y, w, h) => {
    const { annotations, undoStack } = get();
    const ann: Annotation = {
      id: `ann_${nextAnnId++}`, tool: "rect",
      points: [], x, y, w, h,
      color: "transparent", lineWidth: 0, imageData: dataUrl,
    };
    set({ annotations: [...annotations, ann], undoStack: [...undoStack, annotations], selectedId: ann.id });
  },

  // ─── Sticky note ──────────────────────────────────────────────
  addSticky: (x, y) => {
    const { annotations, undoStack, activeColor } = get();
    const colors = ["#ffd60a", "#ff9f0a", "#30d158", "#0a84ff", "#bf5af2", "#ff375f"];
    const stickyColor = colors[annotations.filter((a) => a.stickyColor).length % colors.length];
    const ann: Annotation = {
      id: `ann_${nextAnnId++}`, tool: "sticky",
      points: [], x, y, w: 180, h: 120,
      color: activeColor, lineWidth: 0, fontSize: 13,
      text: "", stickyColor,
    };
    set({ annotations: [...annotations, ann], undoStack: [...undoStack, annotations], selectedId: ann.id });
  },

  // ─── Selection + Move + Resize ────────────────────────────────
  selectAt: (point) => {
    const { annotations } = get();
    // Reverse order (topmost first)
    for (let i = annotations.length - 1; i >= 0; i--) {
      if (hitTest(annotations[i], point)) {
        set({ selectedId: annotations[i].id });
        return annotations[i].id;
      }
    }
    set({ selectedId: null });
    return null;
  },

  startMove: (point) => {
    const { selectedId, annotations } = get();
    if (!selectedId) return;
    const ann = annotations.find((a) => a.id === selectedId);
    if (!ann) return;
    set({ dragOffset: { x: point.x - ann.x, y: point.y - ann.y } });
  },

  continueMove: (point) => {
    const { selectedId, dragOffset, annotations } = get();
    if (!selectedId || !dragOffset) return;
    set({
      annotations: annotations.map((a) =>
        a.id === selectedId ? { ...a, x: point.x - dragOffset.x, y: point.y - dragOffset.y } : a,
      ),
    });
  },

  startResize: (handle) => {
    set({ resizeHandle: handle });
  },

  continueResize: (point) => {
    const { selectedId, resizeHandle, annotations } = get();
    if (!selectedId || !resizeHandle) return;
    set({
      annotations: annotations.map((a) => {
        if (a.id !== selectedId) return a;
        // Bottom-right resize
        if (resizeHandle === "br") return { ...a, w: Math.max(30, point.x - a.x), h: Math.max(20, point.y - a.y) };
        return a;
      }),
    });
  },

  finishMoveResize: () => {
    const { annotations, undoStack } = get();
    set({ dragOffset: null, resizeHandle: null, undoStack: [...undoStack, annotations] });
  },

  deselect: () => set({ selectedId: null }),

  deleteSelected: () => {
    const { selectedId, annotations, undoStack } = get();
    if (!selectedId) return;
    set({
      annotations: annotations.filter((a) => a.id !== selectedId),
      selectedId: null,
      undoStack: [...undoStack, annotations],
    });
  },

  updateText: (text) => {
    const { selectedId, annotations } = get();
    if (!selectedId) return;
    set({ annotations: annotations.map((a) => a.id === selectedId ? { ...a, text } : a) });
  },

  eraseAt: (point, radius) => {
    const { annotations, undoStack } = get();
    const before = annotations;
    const after = annotations.filter((ann) => !hitTest(ann, point, radius));
    if (after.length < before.length) {
      set({ annotations: after, undoStack: [...undoStack, before] });
    }
  },

  clearAll: () => {
    const { annotations, undoStack } = get();
    set({ annotations: [], drawing: null, selectedId: null, undoStack: [...undoStack, annotations] });
  },

  undo: () => {
    const { undoStack } = get();
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    set({ annotations: prev, undoStack: undoStack.slice(0, -1), selectedId: null, drawing: null });
  },
}));

useAnnotationStore.subscribe((state) => { saveForKey(state.canvasKey, state.annotations); });
