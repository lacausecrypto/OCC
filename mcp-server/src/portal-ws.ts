/**
 * Portal WebSocket layer — mounts on the existing HTTP server, routes the
 * `upgrade` event by URL path, and bridges browser frames + input events
 * between the canvas Portal node and a Playwright session.
 *
 *   Server  → Client  /portal/:id/screencast    JPEG frames + url notifications
 *   Client  → Server  /portal/:id/input          mouse / keyboard / wheel
 *
 * Frame protocol (text JSON):
 *   { "type": "frame",  "data": "<base64 JPEG>", "viewport": { "w": ..., "h": ... } }
 *   { "type": "url",    "url":  "https://..." }
 *   { "type": "error",  "error": "..." }
 *
 * Input protocol (text JSON, client → server):
 *   { "type": "mousemove", "x": 0..1, "y": 0..1 }                   (normalized)
 *   { "type": "mousedown" | "mouseup", "x", "y", "button": "left" | "middle" | "right" }
 *   { "type": "wheel",     "x", "y", "deltaX", "deltaY" }
 *   { "type": "keydown" | "keyup", "key": "a" | "Enter" | ... }
 *   { "type": "type",      "text": "..." }                          (raw text input)
 *   { "type": "navigate",  "url": "..." }
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  getPortalSession,
  navigatePortalSession,
  type PortalSession,
} from "./portal-sessions.js";
import { logger } from "./logger.js";

// ─── Frame relay (CDP screencast) ───────────────────────────────────────────

/**
 * Start CDP screencast for a session. Idempotent — calling twice is fine.
 * The frame handler is registered once per session and forwards to every
 * connected screencast client.
 */
async function ensureScreencastStarted(session: PortalSession): Promise<void> {
  // Use a sentinel on the session object to avoid double-registering the
  // CDP listener if multiple clients connect.
  const tagged = session as PortalSession & { _screencastStarted?: boolean };
  if (tagged._screencastStarted) return;
  tagged._screencastStarted = true;

  session.cdp.on("Page.screencastFrame", async ({ data, sessionId, metadata }) => {
    // Ack first so Chromium keeps streaming; even if no clients are listening,
    // we still ack to avoid backpressure on the CDP side.
    try { await session.cdp.send("Page.screencastFrameAck", { sessionId }); } catch { /* may be detaching */ }

    if (session.screencastClients.size === 0) return;
    const w = metadata?.deviceWidth ?? session.viewport.width;
    const h = metadata?.deviceHeight ?? session.viewport.height;
    const msg = JSON.stringify({ type: "frame", data, viewport: { w, h } });
    for (const ws of session.screencastClients) {
      // Drop frames if a client is slow — never block the loop.
      if (ws.bufferedAmount > 5_000_000) continue; // 5 MB threshold
      try { ws.send(msg); } catch { /* will be cleaned by close handler */ }
    }
  });

  await session.cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 65,
    everyNthFrame: 1,
    maxWidth: session.viewport.width,
    maxHeight: session.viewport.height,
  });
}

async function stopScreencastIfIdle(session: PortalSession): Promise<void> {
  if (session.screencastClients.size > 0) return;
  const tagged = session as PortalSession & { _screencastStarted?: boolean };
  if (!tagged._screencastStarted) return;
  tagged._screencastStarted = false;
  try { await session.cdp.send("Page.stopScreencast"); } catch { /* may be detached */ }
}

// ─── Input dispatch ─────────────────────────────────────────────────────────

interface InputMessage {
  type: string;
  x?: number; y?: number;
  button?: "left" | "middle" | "right";
  deltaX?: number; deltaY?: number;
  key?: string;
  text?: string;
  url?: string;
  modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };
}

/** Convert normalized 0..1 coords to Chromium pixels, clamped to viewport. */
function denormalize(session: PortalSession, x?: number, y?: number): { x: number; y: number } {
  const nx = typeof x === "number" ? Math.max(0, Math.min(1, x)) : 0.5;
  const ny = typeof y === "number" ? Math.max(0, Math.min(1, y)) : 0.5;
  return {
    x: Math.round(nx * session.viewport.width),
    y: Math.round(ny * session.viewport.height),
  };
}

async function dispatchInput(session: PortalSession, msg: InputMessage): Promise<void> {
  const mouse = session.page.mouse;
  const kb = session.page.keyboard;

  switch (msg.type) {
    case "mousemove": {
      const { x, y } = denormalize(session, msg.x, msg.y);
      await mouse.move(x, y);
      return;
    }
    case "mousedown": {
      const { x, y } = denormalize(session, msg.x, msg.y);
      await mouse.move(x, y);
      await mouse.down({ button: msg.button ?? "left" });
      return;
    }
    case "mouseup": {
      const { x, y } = denormalize(session, msg.x, msg.y);
      await mouse.move(x, y);
      await mouse.up({ button: msg.button ?? "left" });
      return;
    }
    case "click": {
      const { x, y } = denormalize(session, msg.x, msg.y);
      await mouse.click(x, y, { button: msg.button ?? "left" });
      return;
    }
    case "wheel": {
      const { x, y } = denormalize(session, msg.x, msg.y);
      await mouse.move(x, y);
      await mouse.wheel(msg.deltaX ?? 0, msg.deltaY ?? 0);
      return;
    }
    case "keydown": {
      if (typeof msg.key === "string") await kb.down(msg.key);
      return;
    }
    case "keyup": {
      if (typeof msg.key === "string") await kb.up(msg.key);
      return;
    }
    case "type": {
      if (typeof msg.text === "string") await kb.insertText(msg.text);
      return;
    }
    case "navigate": {
      if (typeof msg.url === "string") await navigatePortalSession(session.id, msg.url);
      return;
    }
    case "back": {
      await session.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      return;
    }
    case "forward": {
      await session.page.goForward({ waitUntil: "domcontentloaded" }).catch(() => {});
      return;
    }
    case "reload": {
      await session.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      return;
    }
    default:
      // Unknown event — ignore silently to keep the channel forward-compatible.
      return;
  }
}

// ─── Upgrade routing ────────────────────────────────────────────────────────

const SCREENCAST_RE = /^\/portal\/([a-f0-9]{16,})\/screencast\/?$/;
const INPUT_RE      = /^\/portal\/([a-f0-9]{16,})\/input\/?$/;

const wssScreencast = new WebSocketServer({ noServer: true });
const wssInput = new WebSocketServer({ noServer: true });

function reject(socket: Socket, code: number, msg: string): void {
  try {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  } catch { /* ignore */ }
}

/**
 * Mount the portal WebSocket handlers on the given HTTP server. Call once
 * after `app.listen()`. The function is idempotent — repeated calls overwrite
 * the previous listener.
 */
export function attachPortalWebSockets(server: HttpServer): void {
  // Remove any prior listener (defensive — happens during HMR).
  for (const l of server.listeners("upgrade")) server.removeListener("upgrade", l as never);

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = req.url ?? "";
    const screencastMatch = url.match(SCREENCAST_RE);
    const inputMatch = url.match(INPUT_RE);

    if (screencastMatch) {
      const sessionId = screencastMatch[1];
      const session = getPortalSession(sessionId);
      if (!session) return reject(socket, 404, "Session not found");

      wssScreencast.handleUpgrade(req, socket, head, (ws) => {
        handleScreencastConnection(ws, session);
      });
      return;
    }

    if (inputMatch) {
      const sessionId = inputMatch[1];
      const session = getPortalSession(sessionId);
      if (!session) return reject(socket, 404, "Session not found");
      if (session.inputClient && session.inputClient.readyState === session.inputClient.OPEN) {
        return reject(socket, 409, "Input channel already in use");
      }

      wssInput.handleUpgrade(req, socket, head, (ws) => {
        handleInputConnection(ws, session);
      });
      return;
    }

    // Not ours — leave the socket alone so other upgrade handlers (if any) get a chance.
    // Express has no upgrade listener of its own, so dropping is safe.
    socket.destroy();
  });
}

// ─── Connection handlers ────────────────────────────────────────────────────

function handleScreencastConnection(ws: WebSocket, session: PortalSession): void {
  session.screencastClients.add(ws);
  session.lastActivityAt = Date.now();

  // Send the current URL so the address bar paints immediately.
  try { ws.send(JSON.stringify({ type: "url", url: session.currentUrl })); } catch { /* ignore */ }

  void ensureScreencastStarted(session).catch((err) => {
    logger.warn("portal-ws", "Failed to start screencast", { id: session.id, error: (err as Error).message });
    try { ws.send(JSON.stringify({ type: "error", error: (err as Error).message })); } catch { /* ignore */ }
  });

  ws.on("close", () => {
    session.screencastClients.delete(ws);
    void stopScreencastIfIdle(session);
  });
  ws.on("error", () => {
    session.screencastClients.delete(ws);
    void stopScreencastIfIdle(session);
  });
}

function handleInputConnection(ws: WebSocket, session: PortalSession): void {
  session.inputClient = ws;
  session.lastActivityAt = Date.now();

  ws.on("message", (data) => {
    session.lastActivityAt = Date.now();
    let msg: InputMessage;
    try {
      msg = JSON.parse(data.toString()) as InputMessage;
    } catch { return; }
    // Fire-and-forget; if dispatch throws, we log but keep the channel open.
    dispatchInput(session, msg).catch((err) => {
      logger.warn("portal-ws", "Input dispatch failed", { id: session.id, type: msg.type, error: (err as Error).message });
    });
  });
  ws.on("close", () => {
    if (session.inputClient === ws) session.inputClient = null;
  });
  ws.on("error", () => {
    if (session.inputClient === ws) session.inputClient = null;
  });
}
