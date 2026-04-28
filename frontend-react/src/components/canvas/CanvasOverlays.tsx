/**
 * HTML overlay system for canvas portal nodes.
 *
 * Renders an iframe pointing at the backend `/portal?url=…` proxy, which
 * fetches the page server-side and strips X-Frame-Options / CSP so it can
 * be embedded. This is a read-only, anonymous view — no cookies, no JS
 * cross-origin requests, no login.
 *
 * The interactive (Playwright + WebSocket screencast) variant was removed
 * after extensive testing: anti-bot systems on sites like X.com / Cloudflare
 * Turnstile detect headless mode at the binary level (window.outerHeight,
 * WebGL renderer, audio fingerprint, …) and the workarounds (real Chrome
 * headed off-screen) introduced platform-specific UX issues that didn't
 * outweigh the benefit. For sites that need a real session, users can open
 * them externally via the "Open in browser" fallback.
 */
import { useState, useMemo, useCallback } from "react";
import { useCanvasStore } from "../../stores/canvas";
import type { CanvasNode } from "../../types/canvas";
import styles from "./CanvasEditor.module.css";

const MIN_ZOOM_FOR_OVERLAY = 0.4;

function PortalOverlayItem({ node, camera }: { node: CanvasNode; camera: { x: number; y: number; zoom: number } }) {
  const [loadError, setLoadError] = useState(false);
  const url = node.portalUrl ?? "";
  const proxyUrl = url ? `/portal?url=${encodeURIComponent(url)}` : "";

  const handleOpenExternal = useCallback(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  }, [url]);
  const handleRetry = useCallback(() => setLoadError(false), []);

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
          <div className={styles.portalFallbackIcon}>{"🚫"}</div>
          <div className={styles.portalFallbackText}>Failed to load page</div>
          <div className={styles.portalFallbackUrl}>{url}</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className={styles.portalFallbackBtn} onClick={handleRetry}>
              Retry {"↻"}
            </button>
            <button className={styles.portalFallbackBtn} onClick={handleOpenExternal}>
              Open in browser {"↗"}
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
