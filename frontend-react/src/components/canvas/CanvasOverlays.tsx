/**
 * HTML overlay system for canvas portal nodes.
 *
 * Two render paths:
 *   - "static"      — backend /portal proxy renders the page once (no JS,
 *                     no cookies). Cheap, anonymous, breaks on SPAs.
 *   - "interactive" — backend Playwright session streams JPEG frames over
 *                     WebSocket; mouse/keyboard events go back over a second
 *                     WebSocket. Real session, supports login.
 *
 * Coordinate system: the canvas overlay sits at native pixel size and is
 * `transform: scale(camera.zoom)`-ed. Pointer events arrive in canvas-overlay
 * coordinates; we normalize to 0..1 of viewport before sending to the
 * backend so the Playwright viewport size is the single source of truth.
 */
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useCanvasStore } from "../../stores/canvas";
import type { CanvasNode } from "../../types/canvas";
import { createPortalSession, closePortalSession, navigatePortalSession, portalWsUrl } from "../../api/portal";
import styles from "./CanvasEditor.module.css";

const MIN_ZOOM_FOR_OVERLAY = 0.4;

// ─── Static mode (existing iframe + /portal proxy) ────────────────────────

function StaticPortalOverlayItem({ node, camera }: { node: CanvasNode; camera: { x: number; y: number; zoom: number } }) {
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

// ─── Interactive mode (Playwright + screencast) ───────────────────────────

interface FrameMessage {
  type: "frame";
  data: string;          // base64 JPEG
  viewport: { w: number; h: number };
}
interface UrlMessage {
  type: "url";
  url: string;
}
interface ErrorMessage {
  type: "error";
  error: string;
}
type ServerMessage = FrameMessage | UrlMessage | ErrorMessage;

/**
 * Translate a DOM-level keyboard event to the key name Playwright expects.
 * Most printable keys are passed through as-is; named keys (Enter, Backspace,
 * arrows, modifiers) match Playwright's vocabulary directly.
 */
function toPlaywrightKey(e: KeyboardEvent): string {
  return e.key;
}

function InteractivePortalOverlayItem({ node, camera }: { node: CanvasNode; camera: { x: number; y: number; zoom: number } }) {
  const persistKey = node.portalPersistKey ?? node.id;
  const updateNode = useCanvasStore((s) => s.updateNode);

  // The URL the session is BOUND to — captured once on mount. We do NOT
  // recreate the session when the page navigates (which is what was killing
  // the X.com login flow: every redirect inside the auth funnel was reported
  // as a new url, the node.portalUrl was updated, the effect re-ran, and the
  // session was torn down with the half-typed input).
  // The component is keyed by `node.id` in the parent, so a fresh node always
  // remounts. To re-bind to a new URL, the user navigates via the address
  // bar (uses navigatePortalSession on the existing session, no remount).
  const initialUrl = useRef(node.portalUrl ?? "").current;

  const [status, setStatus] = useState<"idle" | "starting" | "live" | "error" | "closed">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState<string>(initialUrl);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const screencastRef = useRef<WebSocket | null>(null);
  const inputRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastUrlRef = useRef<string>(initialUrl);
  const viewportRef = useRef({ w: 1280, h: 720 });
  const focusedRef = useRef(false);

  const HEADER_H = 28;
  const TOOLBAR_H = 32;
  const nativeW = node.w;
  const nativeH = node.h - HEADER_H - TOOLBAR_H;

  // ── Lifecycle: create session ONCE per node, close on unmount ─────────────
  useEffect(() => {
    if (!initialUrl) return;
    let cancelled = false;
    setStatus("starting");
    setErrorMsg(null);

    (async () => {
      try {
        const info = await createPortalSession({
          url: initialUrl,
          persistKey,
          viewport: { width: nativeW, height: Math.max(360, nativeH) },
        });
        if (cancelled) {
          // The component unmounted while we were creating — clean up.
          await closePortalSession(info.sessionId);
          return;
        }
        sessionIdRef.current = info.sessionId;
        setAddressDraft(info.url);
        lastUrlRef.current = info.url;
        viewportRef.current = { w: info.viewport.width, h: info.viewport.height };

        // Screencast WS
        const sc = new WebSocket(portalWsUrl(info.sessionId, "screencast"));
        screencastRef.current = sc;
        sc.onopen = () => setStatus("live");
        sc.onmessage = (ev) => {
          let msg: ServerMessage;
          try { msg = JSON.parse(ev.data) as ServerMessage; } catch { return; }
          if (msg.type === "frame") {
            viewportRef.current = { w: msg.viewport.w, h: msg.viewport.h };
            const cv = canvasRef.current;
            if (!cv) return;
            const img = new Image();
            img.onload = () => {
              if (cv.width !== msg.viewport.w || cv.height !== msg.viewport.h) {
                cv.width = msg.viewport.w;
                cv.height = msg.viewport.h;
              }
              const ctx = cv.getContext("2d");
              if (ctx) ctx.drawImage(img, 0, 0);
            };
            img.src = `data:image/jpeg;base64,${msg.data}`;
          } else if (msg.type === "url") {
            // Display-only update — do NOT write back to node.portalUrl
            // (that would change the effect's dep and tear down the session).
            // The latest URL is captured in lastUrlRef and persisted to the
            // node only at unmount, so it survives reload as a bookmark.
            setAddressDraft(msg.url);
            lastUrlRef.current = msg.url;
          } else if (msg.type === "error") {
            setStatus("error");
            setErrorMsg(msg.error);
          }
        };
        sc.onclose = () => setStatus((s) => (s === "live" ? "closed" : s));
        sc.onerror = () => { setStatus("error"); setErrorMsg("Screencast connection failed"); };

        // Input WS
        const ic = new WebSocket(portalWsUrl(info.sessionId, "input"));
        inputRef.current = ic;
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setErrorMsg((err as Error).message);
        }
      }
    })();

    return () => {
      cancelled = true;
      try { screencastRef.current?.close(); } catch { /* ignore */ }
      try { inputRef.current?.close(); } catch { /* ignore */ }
      const sid = sessionIdRef.current;
      if (sid) void closePortalSession(sid);
      // Save the last visited URL as the node's bookmark so a reload reopens
      // where the user left off. Avoid clobbering a user-intentional URL with
      // login-flow detours: only persist if it's still on the same origin.
      const last = lastUrlRef.current;
      if (last && last !== initialUrl) {
        try {
          const sameOrigin = new URL(last).origin === new URL(initialUrl).origin;
          if (sameOrigin) updateNode(node.id, { portalUrl: last });
        } catch { /* invalid URL — ignore */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount-only — see initialUrl comment above

  // ── Pointer + key forwarding ──────────────────────────────────────────────

  const send = useCallback((msg: object) => {
    const ws = inputRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }, []);

  const normCoords = useCallback((e: React.PointerEvent | React.MouseEvent | React.WheelEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return { x, y };
  }, []);

  const buttonName = (n: number): "left" | "middle" | "right" => (n === 1 ? "middle" : n === 2 ? "right" : "left");

  // Keyboard listener — only active while the canvas is "focused" (clicked into).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!focusedRef.current) return;
      // Don't swallow browser shortcuts that the user expects to keep working
      // on the OCC frontend itself (Cmd+R, Cmd+T). Forward only when modifiers
      // are NOT cmd/ctrl, OR the key is a printable character.
      e.preventDefault();
      send({ type: "keydown", key: toPlaywrightKey(e) });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!focusedRef.current) return;
      e.preventDefault();
      send({ type: "keyup", key: toPlaywrightKey(e) });
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [send]);

  // ── Address bar / nav bar handlers ───────────────────────────────────────

  const submitAddress = useCallback(async () => {
    let target = addressDraft.trim();
    if (!target) return;
    if (!/^https?:\/\//.test(target)) target = "https://" + target;
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await navigatePortalSession(sid, target);
      // The user explicitly typed this URL — safe to bookmark on the node.
      updateNode(node.id, { portalUrl: target });
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  }, [addressDraft, node.id, updateNode]);

  // ── Layout ────────────────────────────────────────────────────────────────

  const screenX = node.x * camera.zoom + camera.x;
  const screenY = node.y * camera.zoom + camera.y + HEADER_H * camera.zoom;
  const screenW = node.w * camera.zoom;
  const screenH = (node.h - HEADER_H) * camera.zoom;

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
      {/* Native-sized inner stack, scaled up to match the canvas zoom */}
      <div
        style={{
          width: node.w,
          height: node.h - HEADER_H,
          transform: `scale(${camera.zoom})`,
          transformOrigin: "0 0",
          background: "#1a1a1e",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Toolbar — back / forward / reload + address bar */}
        <div
          style={{
            height: TOOLBAR_H,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 8px",
            background: "rgba(0,0,0,0.4)",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            pointerEvents: "auto",
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => send({ type: "back" })}
            title="Back"
            style={navBtn}
          >{"←"}</button>
          <button
            type="button"
            onClick={() => send({ type: "forward" })}
            title="Forward"
            style={navBtn}
          >{"→"}</button>
          <button
            type="button"
            onClick={() => send({ type: "reload" })}
            title="Reload"
            style={navBtn}
          >{"↻"}</button>
          <input
            type="text"
            value={addressDraft}
            onChange={(e) => setAddressDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                void submitAddress();
              }
            }}
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 11,
              padding: "3px 8px",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 4,
              color: "#fff",
              outline: "none",
              fontFamily: "var(--m-font-mono, monospace)",
            }}
          />
          <span
            style={{
              fontSize: 9,
              color: status === "live" ? "#30d158" : status === "error" ? "#ff375f" : "#86868b",
              padding: "2px 6px",
              borderRadius: 3,
              background: "rgba(255,255,255,0.06)",
              fontWeight: 600,
              textTransform: "uppercase",
            }}
            title={errorMsg ?? status}
          >
            {status === "starting" ? "..." : status === "live" ? "live" : status === "error" ? "err" : status}
          </span>
        </div>

        {/* Live canvas — pointer events forwarded as input messages */}
        {status === "error" ? (
          <div
            className={styles.portalFallback}
            style={{ pointerEvents: "auto", flex: 1 }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className={styles.portalFallbackIcon}>{"🚫"}</div>
            <div className={styles.portalFallbackText}>{errorMsg ?? "Session failed"}</div>
            <div className={styles.portalFallbackUrl}>{url}</div>
            <button
              className={styles.portalFallbackBtn}
              onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
            >
              Open in browser {"↗"}
            </button>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            tabIndex={0}
            style={{
              flex: 1,
              width: "100%",
              height: "100%",
              display: "block",
              pointerEvents: "auto",
              cursor: focusedRef.current ? "default" : "pointer",
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as HTMLCanvasElement).focus();
              focusedRef.current = true;
              const { x, y } = normCoords(e);
              send({ type: "mousedown", x, y, button: buttonName(e.button) });
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              const { x, y } = normCoords(e);
              send({ type: "mouseup", x, y, button: buttonName(e.button) });
            }}
            onPointerMove={(e) => {
              if (e.buttons === 0 && !focusedRef.current) return; // skip hover-only when not focused
              const { x, y } = normCoords(e);
              send({ type: "mousemove", x, y });
            }}
            onWheel={(e) => {
              // We don't preventDefault here — the canvas should still be
              // scroll-isolated by the parent's overflow:hidden.
              const { x, y } = normCoords(e);
              send({ type: "wheel", x, y, deltaX: e.deltaX, deltaY: e.deltaY });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              const { x, y } = normCoords(e);
              send({ type: "click", x, y, button: "right" });
            }}
            onBlur={() => { focusedRef.current = false; }}
          />
        )}
      </div>
    </div>
  );
}

const navBtn: React.CSSProperties = {
  width: 22, height: 22,
  display: "flex", alignItems: "center", justifyContent: "center",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 4,
  color: "#fff",
  fontSize: 12,
  cursor: "pointer",
  flexShrink: 0,
};

// ─── Wrapper that picks the right mode ─────────────────────────────────────

function PortalOverlayItem({ node, camera }: { node: CanvasNode; camera: { x: number; y: number; zoom: number } }) {
  const mode = node.portalMode ?? "static";
  if (mode === "interactive") {
    return <InteractivePortalOverlayItem node={node} camera={camera} />;
  }
  return <StaticPortalOverlayItem node={node} camera={camera} />;
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
