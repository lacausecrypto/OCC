import { useCallback, useEffect, useRef } from "react";
import { useCanvasStore } from "../../stores/canvas";
import { useAnnotationStore } from "../../stores/annotations";
import { useShortcutStore } from "../../stores/shortcuts";
import { screenToCanvas, nodeAt, computeZoomToFit, resizeHandleAt } from "./canvasRenderer";
import { edgeAt, controlPointAt } from "./connectionHit";
import type { CanvasNode, CanvasEdge } from "../../types/canvas";

// Module-level clipboard (avoids re-renders)
let clipboard: { nodes: CanvasNode[]; edges: CanvasEdge[] } | null = null;

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

      // Right-click (or any non-primary button) belongs to onContextMenu.
      // Without this guard, a right-click on empty canvas armed a `box`
      // drag state and a right-click on a node armed a `node` drag —
      // the context menu opened over a phantom box-select rectangle and
      // the node would shift if the mouse moved before pointer-up.
      if (e.button !== 0) {
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

      // Check resize handle on selected nodes first
      {
        const c = screenToCanvas(sx, sy, state.camera);
        for (const selId of state.selection) {
          const selNode = state.nodes.get(selId);
          if (!selNode) continue;
          const handle = resizeHandleAt(c.x, c.y, selNode);
          if (handle) {
            useCanvasStore.setState({
              dragState: {
                type: "resize",
                resizeNodeId: selId,
                resizeHandle: handle,
                resizeOrigin: { x: selNode.x, y: selNode.y, w: selNode.w, h: selNode.h },
                sx, sy, mx: sx, my: sy,
              },
            });
            return;
          }
        }
      }

      // Select tool (default)
      const hit = nodeAt(sx, sy, state.camera, state.nodes);
      if (hit) {
        // Select node (deselect any edge)
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
          selectedEdgeId: null,
          dragState: { type: "node", offsets, sx, sy, mx: sx, my: sy },
        });
      } else {
        const c = screenToCanvas(sx, sy, state.camera);

        // Check control point hit on selected edge
        if (state.selectedEdgeId) {
          const selectedEdge = state.edges.get(state.selectedEdgeId);
          if (selectedEdge) {
            const cpHit = controlPointAt(c.x, c.y, selectedEdge, state.nodes);
            if (cpHit) {
              useCanvasStore.setState({
                dragState: {
                  type: "controlPoint",
                  edgeId: state.selectedEdgeId,
                  cpHandle: cpHit.handle,
                  cpOriginX: c.x,
                  cpOriginY: c.y,
                  sx, sy, mx: sx, my: sy,
                },
              });
              return;
            }
          }
        }

        // Check edge hit
        const edgeHit = edgeAt(c.x, c.y, state.edges, state.nodes);
        if (edgeHit) {
          useCanvasStore.setState({
            selectedEdgeId: edgeHit,
            selection: new Set(),
            dragState: { type: "none" },
          });
          return;
        }

        // Empty space → box select (deselect edge too)
        if (!e.shiftKey) useCanvasStore.setState({ selection: new Set(), selectedEdgeId: null });
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
        const gridSize = 20;
        const snap = !e.shiftKey; // default snap; hold shift for free move
        for (const [id, off] of ds.offsets) {
          const n = nodes.get(id);
          if (n) {
            let nx = c.x + off.dx;
            let ny = c.y + off.dy;
            if (snap) {
              nx = Math.round(nx / gridSize) * gridSize;
              ny = Math.round(ny / gridSize) * gridSize;
            }
            nodes.set(id, { ...n, x: nx, y: ny });
          }
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
      } else if (ds.type === "controlPoint" && ds.edgeId && ds.cpHandle) {
        const sx2 = e.clientX - rect.left;
        const sy2 = e.clientY - rect.top;
        const c = screenToCanvas(sx2, sy2, state.camera);
        const dx = c.x - (ds.cpOriginX ?? c.x);
        const dy = c.y - (ds.cpOriginY ?? c.y);
        const edge = state.edges.get(ds.edgeId);
        if (edge) {
          const prevOffset = ds.cpHandle === "cp1" ? (edge.cp1 ?? { dx: 0, dy: 0 }) : (edge.cp2 ?? { dx: 0, dy: 0 });
          useCanvasStore.getState().updateEdge(ds.edgeId, {
            [ds.cpHandle]: { dx: prevOffset.dx + dx, dy: prevOffset.dy + dy },
          });
          // Update origin so delta is incremental
          useCanvasStore.setState({
            dragState: { ...ds, cpOriginX: c.x, cpOriginY: c.y },
          });
        }
      } else if (ds.type === "connect") {
        useCanvasStore.setState({
          dragState: {
            ...ds,
            mx: e.clientX - rect.left,
            my: e.clientY - rect.top,
          },
        });
      } else if (ds.type === "resize" && ds.resizeNodeId && ds.resizeHandle && ds.resizeOrigin) {
        const sx2 = e.clientX - rect.left;
        const sy2 = e.clientY - rect.top;
        const c = screenToCanvas(sx2, sy2, state.camera);
        const startC = screenToCanvas(ds.sx!, ds.sy!, state.camera);
        const deltaX = c.x - startC.x;
        const deltaY = c.y - startC.y;
        const o = ds.resizeOrigin;
        const handle = ds.resizeHandle;
        const gridSize = 20;
        const snap = !e.shiftKey;

        let nx = o.x, ny = o.y, nw = o.w, nh = o.h;

        // Apply deltas based on which handle
        if (handle.includes("e")) nw = o.w + deltaX;
        if (handle.includes("w")) { nx = o.x + deltaX; nw = o.w - deltaX; }
        if (handle.includes("s")) nh = o.h + deltaY;
        if (handle.includes("n")) { ny = o.y + deltaY; nh = o.h - deltaY; }

        // Min sizes
        const minW = 60, minH = 32;
        if (nw < minW) { if (handle.includes("w")) nx = o.x + o.w - minW; nw = minW; }
        if (nh < minH) { if (handle.includes("n")) ny = o.y + o.h - minH; nh = minH; }

        // Snap to grid
        if (snap) {
          nx = Math.round(nx / gridSize) * gridSize;
          ny = Math.round(ny / gridSize) * gridSize;
          nw = Math.round(nw / gridSize) * gridSize;
          nh = Math.round(nh / gridSize) * gridSize;
          if (nw < minW) nw = minW;
          if (nh < minH) nh = minH;
        }

        const n = state.nodes.get(ds.resizeNodeId);
        if (n) {
          const nodes = new Map(state.nodes);
          nodes.set(ds.resizeNodeId, { ...n, x: nx, y: ny, w: nw, h: nh });
          useCanvasStore.setState({ nodes });
        }
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

      if (ds.type === "controlPoint") {
        state.pushUndo();
      } else if (ds.type === "node") {
        state.pushUndo();
      } else if (ds.type === "resize") {
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
      const tagName = (e.target as HTMLElement)?.tagName;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tagName)) return;

      const { matches } = useShortcutStore.getState();

      if (matches(e, "canvas.pan")) {
        e.preventDefault();
        spaceRef.current = true;
      }
      if (matches(e, "canvas.delete")) {
        const store = useCanvasStore.getState();
        if (store.selectedEdgeId) {
          store.pushUndo();
          store.removeEdge(store.selectedEdgeId);
        } else {
          store.removeSelected();
        }
      }
      if (matches(e, "canvas.selectAll")) {
        e.preventDefault();
        const ids = [...useCanvasStore.getState().nodes.keys()];
        useCanvasStore.setState({ selection: new Set(ids) });
      }

      // Redo: must be checked BEFORE Undo (redo has shift, undo doesn't)
      if (matches(e, "canvas.redo")) {
        e.preventDefault();
        useCanvasStore.getState().popRedo();
      } else if (matches(e, "canvas.undo")) {
        e.preventDefault();
        useCanvasStore.getState().popUndo();
      }

      if (matches(e, "canvas.save")) {
        e.preventDefault();
        // Dispatch custom event for save — handled by CanvasEditor
        window.dispatchEvent(new CustomEvent("occ-canvas-save"));
      }

      // Duplicate
      if (matches(e, "canvas.duplicate")) {
        e.preventDefault();
        const state = useCanvasStore.getState();
        const sel = state.selection;
        if (sel.size === 0) return;

        state.pushUndo();

        const oldToNew = new Map<string, string>();
        const newNodes: CanvasNode[] = [];
        let i = 0;
        for (const id of sel) {
          const node = state.nodes.get(id);
          if (!node) continue;
          const newId = `s${Date.now()}_${i}`;
          oldToNew.set(id, newId);
          newNodes.push({ ...node, id: newId, x: node.x + 30, y: node.y + 30 });
          i++;
        }

        // Duplicate edges between selected nodes
        const newEdges: CanvasEdge[] = [];
        for (const edge of state.edges.values()) {
          if (oldToNew.has(edge.from) && oldToNew.has(edge.to)) {
            newEdges.push({
              id: `e${Date.now()}_${newEdges.length}`,
              from: oldToNew.get(edge.from)!,
              to: oldToNew.get(edge.to)!,
            });
          }
        }

        for (const n of newNodes) state.addNode(n);
        for (const ed of newEdges) state.addEdge(ed);
        useCanvasStore.setState({ selection: new Set(newNodes.map((n) => n.id)) });
      }

      // Copy
      if (matches(e, "canvas.copy")) {
        const state = useCanvasStore.getState();
        const sel = state.selection;
        if (sel.size === 0) return;

        const nodes: CanvasNode[] = [];
        for (const id of sel) {
          const node = state.nodes.get(id);
          if (node) nodes.push({ ...node });
        }
        const selSet = sel;
        const edges: CanvasEdge[] = [];
        for (const edge of state.edges.values()) {
          if (selSet.has(edge.from) && selSet.has(edge.to)) {
            edges.push({ ...edge });
          }
        }
        clipboard = { nodes, edges };
      }

      // Paste
      if (matches(e, "canvas.paste")) {
        // Don't interfere with annotation image paste
        if (useAnnotationStore.getState().activeTool !== "none") return;
        if (!clipboard || clipboard.nodes.length === 0) return;

        e.preventDefault();
        const state = useCanvasStore.getState();
        state.pushUndo();

        const oldToNew = new Map<string, string>();
        const newNodes: CanvasNode[] = [];
        let i = 0;
        for (const node of clipboard.nodes) {
          const newId = `s${Date.now()}_${i}`;
          oldToNew.set(node.id, newId);
          newNodes.push({ ...node, id: newId, x: node.x + 40, y: node.y + 40 });
          i++;
        }

        const newEdges: CanvasEdge[] = [];
        for (const edge of clipboard.edges) {
          const newFrom = oldToNew.get(edge.from);
          const newTo = oldToNew.get(edge.to);
          if (newFrom && newTo) {
            newEdges.push({
              id: `e${Date.now()}_${newEdges.length}`,
              from: newFrom,
              to: newTo,
            });
          }
        }

        for (const n of newNodes) state.addNode(n);
        for (const ed of newEdges) state.addEdge(ed);
        useCanvasStore.setState({ selection: new Set(newNodes.map((n) => n.id)) });
      }

      // Zoom in
      if (matches(e, "canvas.zoomIn")) {
        e.preventDefault();
        const state = useCanvasStore.getState();
        const newZoom = clamp(state.camera.zoom * 1.4, 0.15, 5);
        useCanvasStore.setState({ camera: { ...state.camera, zoom: newZoom } });
      }

      // Zoom out
      if (matches(e, "canvas.zoomOut")) {
        e.preventDefault();
        const state = useCanvasStore.getState();
        const newZoom = clamp(state.camera.zoom * 0.7, 0.15, 5);
        useCanvasStore.setState({ camera: { ...state.camera, zoom: newZoom } });
      }

      // Zoom to fit
      if (matches(e, "canvas.zoomFit")) {
        e.preventDefault();
        const canvas = canvasRef.current;
        if (!canvas) return;
        const parentW = canvas.parentElement?.clientWidth ?? 800;
        const parentH = canvas.parentElement?.clientHeight ?? 600;
        const state = useCanvasStore.getState();
        const cam = computeZoomToFit(state.nodes, parentW, parentH);
        useCanvasStore.setState({ camera: cam });
      }

      if (matches(e, "canvas.deselect")) {
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
  }, [canvasRef]);

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
