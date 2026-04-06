import { useEffect, useRef, useCallback } from "react";
import { useCanvasStore } from "../../stores/canvas";
import { useCanvasExecStore } from "../../stores/canvasExec";
import { useAnnotationStore } from "../../stores/annotations";
import { renderCanvas, renderMinimap } from "./canvasRenderer";

/**
 * Hook that drives the canvas rendering loop via requestAnimationFrame.
 * Reads state from Zustand stores (outside React) for perf.
 */
export function useCanvasRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  minimapRef: React.RefObject<HTMLCanvasElement | null>,
) {
  const animRef = useRef(0);
  const lastRenderRef = useRef(0);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const state = useCanvasStore.getState();
    const execState = useCanvasExecStore.getState();
    const annState = useAnnotationStore.getState();

    renderCanvas(
      ctx,
      canvas,
      state.camera,
      state.nodes,
      state.edges,
      state.selection,
      state.dragState,
      execState.nodeExecState,
      annState.annotations,
      annState.drawing,
      annState.selectedId,
    );

    // Minimap
    const mmCanvas = minimapRef.current;
    if (mmCanvas) {
      const mmCtx = mmCanvas.getContext("2d");
      if (mmCtx) {
        const parentW = canvas.parentElement?.clientWidth ?? 800;
        const parentH = canvas.parentElement?.clientHeight ?? 600;
        renderMinimap(mmCtx, mmCanvas, state.camera, state.nodes, parentW, parentH);
      }
    }
  }, [canvasRef, minimapRef]);

  // Animation loop: throttled to ~60fps but also re-renders on store changes
  useEffect(() => {
    let running = true;

    const loop = () => {
      if (!running) return;
      const now = performance.now();
      if (now - lastRenderRef.current >= 16) {
        lastRenderRef.current = now;
        render();
      }
      animRef.current = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      running = false;
      cancelAnimationFrame(animRef.current);
    };
  }, [render]);

  // Also subscribe to store changes for immediate re-render
  useEffect(() => {
    const unsub1 = useCanvasStore.subscribe(() => render());
    const unsub2 = useCanvasExecStore.subscribe(() => render());
    const unsub3 = useAnnotationStore.subscribe(() => render());
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [render]);

  // Re-render when container resizes (sidebar open/close transitions)
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas?.parentElement;
    if (!container) return;

    const ro = new ResizeObserver(() => {
      render();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [canvasRef, render]);

  return { render };
}
