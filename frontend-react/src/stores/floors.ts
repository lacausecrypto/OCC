/**
 * Floor system — isolated workspaces within the canvas.
 * Each floor has its own nodes, edges, annotations, and camera.
 * The canvas store always reflects the active floor.
 *
 * Architecture: floors store manages FloorData snapshots.
 * On switch: save current canvas → load target floor into canvas store.
 * This keeps the canvas store API completely unchanged.
 */

import { create } from "zustand";
import type { CanvasNode, CanvasEdge, Camera } from "../types/canvas";
import type { Annotation } from "./annotations";
import { useCanvasStore } from "./canvas";
import { useAnnotationStore } from "./annotations";

// ─── Types ──────────────────────────────────────────────────────────────

export interface FloorData {
  id: string;
  name: string;
  color: string;
  /** Snapshot of canvas state when floor was last active */
  nodes: Map<string, CanvasNode>;
  edges: Map<string, CanvasEdge>;
  camera: Camera;
  annotations: Annotation[];
  createdAt: number;
}

/**
 * Transition state for Maestri-style spatial zoom.
 * "idle" = normal view. "zooming-out" = canvas shrinking to show floor cards.
 * "overview" = all floors visible as cards. "zooming-in" = target floor expanding.
 */
export type FloorTransition = "idle" | "zooming-out" | "overview" | "zooming-in";

interface FloorsState {
  floors: Map<string, FloorData>;
  activeFloorId: string;
  overviewOpen: boolean;
  /** Spatial zoom transition state */
  transition: FloorTransition;
  /** Target floor ID during transition */
  transitionTargetId: string | null;
  /** Continuous scale value (1.0 = full, ~0.18 = overview) */
  transitionScale: number;
  /** Continuous X offset in overview (to center on target floor) */
  transitionOffsetX: number;

  /** Whether the stack view is open (persistent, interactive) */
  stackViewOpen: boolean;

  // Actions
  createFloor: (name?: string) => string;
  deleteFloor: (id: string) => void;
  renameFloor: (id: string, name: string) => void;
  switchFloor: (id: string) => void;
  setOverviewOpen: (open: boolean) => void;
  /** Toggle the interactive stack view (animates in/out) */
  toggleStackView: () => void;
  /** Select a floor from the stack view and zoom in */
  selectFromStack: (id: string) => void;
  /** Save current canvas state into the active floor snapshot */
  saveActiveFloor: () => void;
  /** Get all floor data for overview rendering */
  getFloorList: () => FloorData[];
}

// ─── Default floor colors (rotating) ────────────────────────────────────

const FLOOR_COLORS = [
  "#0a84ff", // blue
  "#30d158", // green
  "#ff9f0a", // orange
  "#bf5af2", // purple
  "#ff375f", // red
  "#64d2ff", // cyan
  "#ffd60a", // yellow
  "#ff6482", // pink
];

let floorColorIdx = 0;
function nextFloorColor(): string {
  const c = FLOOR_COLORS[floorColorIdx % FLOOR_COLORS.length];
  floorColorIdx++;
  return c;
}

// ─── Persistence ────────────────────────────────────────────────────────

const STORAGE_KEY = "occ-floors";

function serializeFloors(floors: Map<string, FloorData>): string {
  const arr = [...floors.values()].map((f) => ({
    ...f,
    nodes: [...f.nodes.entries()],
    edges: [...f.edges.entries()],
  }));
  return JSON.stringify(arr);
}

function deserializeFloors(json: string): Map<string, FloorData> {
  try {
    const arr = JSON.parse(json) as Array<Record<string, unknown>>;
    const map = new Map<string, FloorData>();
    for (const raw of arr) {
      const f: FloorData = {
        id: raw.id as string,
        name: raw.name as string,
        color: raw.color as string,
        nodes: new Map(raw.nodes as Array<[string, CanvasNode]>),
        edges: new Map(raw.edges as Array<[string, CanvasEdge]>),
        camera: raw.camera as Camera,
        annotations: (raw.annotations as Annotation[]) ?? [],
        createdAt: raw.createdAt as number,
      };
      map.set(f.id, f);
    }
    return map;
  } catch {
    return new Map();
  }
}

function loadFromStorage(): Map<string, FloorData> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return deserializeFloors(raw);
  } catch { /* ignore */ }
  return new Map();
}

function saveToStorage(floors: Map<string, FloorData>): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializeFloors(floors));
  } catch { /* quota exceeded — ignore */ }
}

// ─── Create default "Main" floor ────────────────────────────────────────

function createDefaultFloor(): FloorData {
  return {
    id: "main",
    name: "Main",
    color: FLOOR_COLORS[0],
    nodes: new Map(),
    edges: new Map(),
    camera: { x: 0, y: 0, zoom: 1 },
    annotations: [],
    createdAt: Date.now(),
  };
}

// ─── Initial state ──────────────────────────────────────────────────────

const stored = loadFromStorage();
const initialFloors = stored.size > 0 ? stored : new Map([["main", createDefaultFloor()]]);

// ─── Store ──────────────────────────────────────────────────────────────

export const useFloorsStore = create<FloorsState>((set, get) => ({
  floors: initialFloors,
  activeFloorId: "main",
  overviewOpen: false,
  stackViewOpen: false,
  transition: "idle" as FloorTransition,
  transitionTargetId: null,
  transitionScale: 1,
  transitionOffsetX: 0,

  createFloor: (name) => {
    const id = `floor_${Date.now()}`;
    const floor: FloorData = {
      id,
      name: name ?? `Floor ${get().floors.size + 1}`,
      color: nextFloorColor(),
      nodes: new Map(),
      edges: new Map(),
      camera: { x: 0, y: 0, zoom: 1 },
      annotations: [],
      createdAt: Date.now(),
    };

    // Save current floor first
    get().saveActiveFloor();

    const floors = new Map(get().floors);
    floors.set(id, floor);
    set({ floors });
    saveToStorage(floors);

    // Switch to the new floor
    get().switchFloor(id);

    return id;
  },

  deleteFloor: (id) => {
    const { floors, activeFloorId } = get();
    if (floors.size <= 1) return; // Can't delete last floor
    if (id === "main") return; // Can't delete main floor

    const newFloors = new Map(floors);
    newFloors.delete(id);
    set({ floors: newFloors });
    saveToStorage(newFloors);

    // If deleting the active floor, switch to main
    if (activeFloorId === id) {
      get().switchFloor("main");
    }
  },

  renameFloor: (id, name) => {
    const floors = new Map(get().floors);
    const floor = floors.get(id);
    if (!floor) return;
    floors.set(id, { ...floor, name });
    set({ floors });
    saveToStorage(floors);
  },

  switchFloor: (id) => {
    const { floors, activeFloorId, transition } = get();
    if (id === activeFloorId || transition !== "idle") return;
    const target = floors.get(id);
    if (!target) return;

    // Save current floor
    get().saveActiveFloor();

    set({ transition: "zooming-out", transitionTargetId: id });

    // ── Spring animation: scale 1.0 → OVERVIEW → 1.0 ──
    const OVERVIEW_SCALE = 0.15;
    const K = 85;   // stiffness
    const D = 17;   // damping (slightly underdamped for bounce)

    let scale = 1.0, scaleV = 0;
    let phase: "out" | "hold" | "in" = "out";
    let holdFrames = 0;
    let lastTime = performance.now();

    const tick = () => {
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.033);
      lastTime = now;

      if (phase === "out") {
        scaleV += (-K * (scale - OVERVIEW_SCALE) - D * scaleV) * dt;
        scale += scaleV * dt;
        set({ transitionScale: scale, transitionOffsetX: 0 });

        if (Math.abs(scale - OVERVIEW_SCALE) < 0.008 && Math.abs(scaleV) < 0.3) {
          scale = OVERVIEW_SCALE;
          scaleV = 0;
          set({ transition: "overview", transitionScale: scale });

          // Swap data while at overview scale
          useCanvasStore.setState({
            nodes: new Map(target.nodes), edges: new Map(target.edges),
            camera: { ...target.camera }, selection: new Set(),
            selectedEdgeId: null, undoStack: [], redoStack: [],
            dragState: { type: "none" },
          });
          useAnnotationStore.setState({
            annotations: [...target.annotations], selectedId: null, drawing: null,
          });
          set({ activeFloorId: id });
          phase = "hold";
          holdFrames = 18; // ~300ms to see the stack
        }
      } else if (phase === "hold") {
        holdFrames--;
        if (holdFrames <= 0) {
          phase = "in";
          scaleV = 0;
          set({ transition: "zooming-in" });
        }
      } else {
        scaleV += (-K * (scale - 1.0) - D * scaleV) * dt;
        scale += scaleV * dt;
        set({ transitionScale: scale, transitionOffsetX: 0 });

        if (Math.abs(scale - 1.0) < 0.005 && Math.abs(scaleV) < 0.2) {
          set({ transition: "idle", transitionScale: 1, transitionOffsetX: 0, transitionTargetId: null });
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },

  setOverviewOpen: (open) => set({ overviewOpen: open }),

  toggleStackView: () => {
    const { stackViewOpen, transition } = get();
    if (transition !== "idle" && !stackViewOpen) return;

    if (!stackViewOpen) {
      // Open: save floor + animate to overview scale
      get().saveActiveFloor();
      set({ stackViewOpen: true, transition: "zooming-out" });

      const K = 85, D = 17, TARGET = 0.15;
      let scale = 1.0, v = 0, last = performance.now();
      const tick = () => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, 0.033);
        last = now;
        v += (-K * (scale - TARGET) - D * v) * dt;
        scale += v * dt;
        set({ transitionScale: scale, transitionOffsetX: 0 });
        if (Math.abs(scale - TARGET) < 0.008 && Math.abs(v) < 0.3) {
          set({ transition: "overview", transitionScale: TARGET });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } else {
      // Close: zoom back in
      set({ transition: "zooming-in" });
      const K = 85, D = 17;
      let scale = get().transitionScale, v = 0, last = performance.now();
      const tick = () => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, 0.033);
        last = now;
        v += (-K * (scale - 1.0) - D * v) * dt;
        scale += v * dt;
        set({ transitionScale: scale, transitionOffsetX: 0 });
        if (Math.abs(scale - 1.0) < 0.005 && Math.abs(v) < 0.2) {
          set({ transition: "idle", transitionScale: 1, transitionOffsetX: 0, stackViewOpen: false });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  },

  selectFromStack: (id) => {
    const { activeFloorId, floors, stackViewOpen } = get();
    if (!stackViewOpen) return;
    const target = floors.get(id);
    if (!target) return;

    // If same floor, just close stack view
    if (id === activeFloorId) {
      get().toggleStackView();
      return;
    }

    // Swap data then zoom in
    get().saveActiveFloor();
    useCanvasStore.setState({
      nodes: new Map(target.nodes), edges: new Map(target.edges),
      camera: { ...target.camera }, selection: new Set(),
      selectedEdgeId: null, undoStack: [], redoStack: [],
      dragState: { type: "none" },
    });
    useAnnotationStore.setState({
      annotations: [...target.annotations], selectedId: null, drawing: null,
    });
    set({ activeFloorId: id, transition: "zooming-in", transitionTargetId: id });

    const K = 85, D = 17;
    let scale = get().transitionScale, v = 0, last = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.033);
      last = now;
      v += (-K * (scale - 1.0) - D * v) * dt;
      scale += v * dt;
      set({ transitionScale: scale, transitionOffsetX: 0 });
      if (Math.abs(scale - 1.0) < 0.005 && Math.abs(v) < 0.2) {
        set({ transition: "idle", transitionScale: 1, transitionOffsetX: 0, stackViewOpen: false, transitionTargetId: null });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },

  saveActiveFloor: () => {
    const { floors, activeFloorId } = get();
    const canvas = useCanvasStore.getState();
    const annotations = useAnnotationStore.getState().annotations;

    const current = floors.get(activeFloorId);
    if (!current) return;

    const updated: FloorData = {
      ...current,
      nodes: new Map(canvas.nodes),
      edges: new Map(canvas.edges),
      camera: { ...canvas.camera },
      annotations: [...annotations],
    };

    const newFloors = new Map(floors);
    newFloors.set(activeFloorId, updated);
    set({ floors: newFloors });
    saveToStorage(newFloors);
  },

  getFloorList: () => [...get().floors.values()],
}));

// Auto-save active floor periodically (every 30s)
setInterval(() => {
  useFloorsStore.getState().saveActiveFloor();
}, 30000);
