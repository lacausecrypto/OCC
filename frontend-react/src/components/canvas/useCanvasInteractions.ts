import { useCallback, useEffect, useRef } from "react";
import { useCanvasStore } from "../../stores/canvas";
import { screenToCanvas, nodeAt, computeZoomToFit } from "./canvasRenderer";

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Hook that handles all canvas interactions:
 * pointer down/move/up, wheel zoom, keyboard shortcuts, double-click.
 */
export function useCanvasInteractions(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
) {
  const spaceRef = useRef(false);

  const getRect = useCallback((): DOMRect | null => {
    return canvasRef.current?.getBoundingClientRect() ?? null;
  }, [canvasRef]);

  // ─── Pointer Down ──────────────────────────────────────────────
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const rect = getRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const state = useCanvasStore.getState();

      // Middle-click or space → pan
      if (e.button === 1 || spaceRef.current || state.activeTool === "pan") {
        useCanvasStore.setState({
          dragState: { type: "pan", lastX: e.clientX, lastY: e.clientY },
        });
        return;
      }

      // Connect tool
      if (state.activeTool === "connect") {
        const hit = nodeAt(sx, sy, state.camera, state.nodes);
        if (hit) {
          useCanvasStore.setState({
            dragState: { type: "connect", fromId: hit, mx: e.clientX - rect.left, my: e.clientY - rect.top },
          });
        }
        return;
      }

      // Select tool (default)
      const hit = nodeAt(sx, sy, state.camera, state.nodes);
      if (hit) {
        // Select node
        let sel = new Set(state.selection);
        if (e.shiftKey) {
          if (sel.has(hit)) sel.delete(hit);
          else sel.add(hit);
        } else if (!sel.has(hit)) {
          sel = new Set([hit]);
        }

        // Build drag offsets for all selected nodes
        const c = screenToCanvas(sx, sy, state.camera);
        const offsets = new Map<string, { dx: number; dy: number }>();
        for (const id of sel) {
          const n = state.nodes.get(id);
          if (n) offsets.set(id, { dx: n.x - c.x, dy: n.y - c.y });
        }

        useCanvasStore.setState({
          selection: sel,
          dragState: { type: "node", offsets, sx, sy, mx: sx, my: sy },
        });
      } else {
        // Empty space → box select
        if (!e.shiftKey) useCanvasStore.setState({ selection: new Set() });
        useCanvasStore.setState({
          dragState: {
            type: "box",
            sx: e.clientX - rect.left,
            sy: e.clientY - rect.top,
            mx: e.clientX - rect.left,
            my: e.clientY - rect.top,
          },
        });
      }
    },
    [getRect],
  );

  // ─── Pointer Move ──────────────────────────────────────────────
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const rect = getRect();
      if (!rect) return;
      const state = useCanvasStore.getState();
      const ds = state.dragState;

      if (ds.type === "pan" && ds.lastX !== undefined) {
        const dx = e.clientX - ds.lastX;
        const dy = e.clientY - ds.lastY!;
        useCanvasStore.setState({
          camera: { ...state.camera, x: state.camera.x + dx, y: state.camera.y + dy },
          dragState: { ...ds, lastX: e.clientX, lastY: e.clientY },
        });
      } else if (ds.type === "node" && ds.offsets) {
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const c = screenToCanvas(sx, sy, state.camera);
        const nodes = new Map(state.nodes);
        for (const [id, off] of ds.offsets) {
          const n = nodes.get(id);
          if (n) nodes.set(id, { ...n, x: c.x + off.dx, y: c.y + off.dy });
        }
        useCanvasStore.setState({ nodes });
      } else if (ds.type === "box") {
        useCanvasStore.setState({
          dragState: {
            ...ds,
            mx: e.clientX - rect.left,
            my: e.clientY - rect.top,
          },
        });
      } else if (ds.type === "connect") {
        useCanvasStore.setState({
          dragState: {
            ...ds,
            mx: e.clientX - rect.left,
            my: e.clientY - rect.top,
          },
        });
      }
    },
    [getRect],
  );

  // ─── Pointer Up ────────────────────────────────────────────────
  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const rect = getRect();
      if (!rect) return;
      const state = useCanvasStore.getState();
      const ds = state.dragState;

      if (ds.type === "node") {
        state.pushUndo();
      } else if (ds.type === "box" && ds.sx !== undefined && ds.mx !== undefined) {
        // Box select: find nodes inside box
        const cam = state.camera;
        const s = screenToCanvas(ds.sx, ds.sy!, cam);
        const m = screenToCanvas(ds.mx, ds.my!, cam);
        const bx = Math.min(s.x, m.x), by = Math.min(s.y, m.y);
        const bw = Math.abs(m.x - s.x), bh = Math.abs(m.y - s.y);
        const sel = new Set(state.selection);
        for (const [id, n] of state.nodes) {
          if (n.x + n.w > bx && n.x < bx + bw && n.y + n.h > by && n.y < by + bh) {
            sel.add(id);
          }
        }
        useCanvasStore.setState({ selection: sel });
      } else if (ds.type === "connect" && ds.fromId) {
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const hit = nodeAt(sx, sy, state.camera, state.nodes);
        if (hit && hit !== ds.fromId) {
          // Check no duplicate edge
          const exists = [...state.edges.values()].some(
            (ed) => ed.from === ds.fromId && ed.to === hit,
          );
          if (!exists) {
            state.pushUndo();
            const edgeId = `e${Date.now()}`;
            state.addEdge({ id: edgeId, from: ds.fromId, to: hit });
          }
        }
      }

      useCanvasStore.setState({ dragState: { type: "none" } });
    },
    [getRect],
  );

  // ─── Pointer Cancel (lost focus, pointer lost) ─────────────────
  const onPointerCancel = useCallback(() => {
    useCanvasStore.setState({ dragState: { type: "none" } });
  }, []);

  // ─── Wheel zoom ────────────────────────────────────────────────
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = getRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const state = useCanvasStore.getState();
      const factor = e.deltaY < 0 ? 1.25 : 0.8;
      const newZoom = clamp(state.camera.zoom * factor, 0.15, 5);
      useCanvasStore.setState({
        camera: {
          zoom: newZoom,
          x: mx - (mx - state.camera.x) * (newZoom / state.camera.zoom),
          y: my - (my - state.camera.y) * (newZoom / state.camera.zoom),
        },
      });
    },
    [getRect],
  );

  // ─── Keyboard shortcuts ────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't capture if focused on input/textarea
      if (["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName)) return;

      if (e.key === " ") {
        e.preventDefault();
        spaceRef.current = true;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        useCanvasStore.getState().removeSelected();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "a") {
        e.preventDefault();
        const ids = [...useCanvasStore.getState().nodes.keys()];
        useCanvasStore.setState({ selection: new Set(ids) });
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        useCanvasStore.getState().popUndo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        // Dispatch custom event for save — handled by CanvasEditor
        window.dispatchEvent(new CustomEvent("occ-canvas-save"));
      }
      if (e.key === "Escape") {
        useCanvasStore.setState({ selection: new Set() });
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " ") spaceRef.current = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // ─── Zoom controls ────────────────────────────────────────────
  const zoomIn = useCallback(() => {
    const state = useCanvasStore.getState();
    const newZoom = clamp(state.camera.zoom * 1.4, 0.15, 5);
    useCanvasStore.setState({ camera: { ...state.camera, zoom: newZoom } });
  }, []);

  const zoomOut = useCallback(() => {
    const state = useCanvasStore.getState();
    const newZoom = clamp(state.camera.zoom * 0.7, 0.15, 5);
    useCanvasStore.setState({ camera: { ...state.camera, zoom: newZoom } });
  }, []);

  const zoomToFit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parentW = canvas.parentElement?.clientWidth ?? 800;
    const parentH = canvas.parentElement?.clientHeight ?? 600;
    const state = useCanvasStore.getState();
    const cam = computeZoomToFit(state.nodes, parentW, parentH);
    useCanvasStore.setState({ camera: cam });
  }, [canvasRef]);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onWheel,
    zoomIn,
    zoomOut,
    zoomToFit,
  };
}
