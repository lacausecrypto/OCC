/**
 * HTML overlay system for canvas portal nodes.
 * Positions iframes over the canvas in sync with the camera.
 *
 * Uses the backend /portal proxy endpoint to serve pages without
 * X-Frame-Options / CSP restrictions that would block direct embedding.
 * Falls back to a "blocked" UI with an "Open in browser" button.
 */
import { useState, useMemo, useCallback } from "react";
import { useCanvasStore } from "../../stores/canvas";
import type { CanvasNode } from "../../types/canvas";
import styles from "./CanvasEditor.module.css";

const MIN_ZOOM_FOR_OVERLAY = 0.4;

function PortalOverlayItem({ node, camera }: { node: CanvasNode; camera: { x: number; y: number; zoom: number } }) {
  const [loadError, setLoadError] = useState(false);
  const url = node.portalUrl ?? "";

  // Proxied URL that strips X-Frame-Options
  const proxyUrl = url ? `/portal?url=${encodeURIComponent(url)}` : "";

  const handleOpenExternal = useCallback(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  }, [url]);

  const handleRetry = useCallback(() => {
    setLoadError(false);
  }, []);

  // Screen positioning — body area below header bar.
  // Outer wrapper sits at the on-screen rectangle (zoom-clipped).
  // The iframe inside is rendered at the node's NATIVE pixel size and then
  // transform-scaled to match canvas zoom — otherwise sites with responsive
  // layouts (e.g. GitHub) reflow into a mobile view when the iframe shrinks
  // at low zoom, which is what the user reported as "weird zoom on canvas
  // items": the terminal overlay scales its font with zoom, but the portal
  // iframe was sized at 100% of the wrapper so its content kept native size
  // and reflowed instead of zooming together with the rest of the canvas.
  const headerH = 28 * camera.zoom;
  const screenX = node.x * camera.zoom + camera.x;
  const screenY = node.y * camera.zoom + camera.y + headerH;
  const screenW = node.w * camera.zoom;
  const screenH = (node.h - 28) * camera.zoom;
  const nativeW = node.w;
  const nativeH = node.h - 28;

  return (
    <div
      style={{
        position: "absolute",
        left: screenX,
        top: screenY,
        width: screenW,
        height: screenH,
        overflow: "hidden",
        borderRadius: `0 0 ${10 * camera.zoom}px ${10 * camera.zoom}px`,
        pointerEvents: "none",
        willChange: "transform",
      }}
    >
      {loadError ? (
        <div
          className={styles.portalFallback}
          style={{ pointerEvents: "auto" }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className={styles.portalFallbackIcon}>{"\uD83D\uDEAB"}</div>
          <div className={styles.portalFallbackText}>Failed to load page</div>
          <div className={styles.portalFallbackUrl}>{url}</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className={styles.portalFallbackBtn} onClick={handleRetry}>
              Retry {"\u21BB"}
            </button>
            <button className={styles.portalFallbackBtn} onClick={handleOpenExternal}>
              Open in browser {"\u2197"}
            </button>
          </div>
        </div>
      ) : (
        <iframe
          src={proxyUrl}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          style={{
            width: nativeW,
            height: nativeH,
            border: "none",
            background: "#1a1a1e",
            pointerEvents: "auto",
            transform: `scale(${camera.zoom})`,
            transformOrigin: "0 0",
          }}
          title={`Portal: ${url}`}
          onError={() => setLoadError(true)}
        />
      )}
    </div>
  );
}

export function CanvasOverlays() {
  const nodes = useCanvasStore((s) => s.nodes);
  const camera = useCanvasStore((s) => s.camera);

  const overlayNodes = useMemo(() => {
    if (camera.zoom < MIN_ZOOM_FOR_OVERLAY) return [];
    const result: CanvasNode[] = [];
    for (const n of nodes.values()) {
      if (n.kind === "portal" && n.portalUrl) result.push(n);
    }
    return result;
  }, [nodes, camera.zoom]);

  if (overlayNodes.length === 0) return null;

  return (
    <>
      {overlayNodes.map((n) => (
        <PortalOverlayItem key={n.id} node={n} camera={camera} />
      ))}
    </>
  );
}
