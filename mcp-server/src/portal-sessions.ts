/**
 * Portal session manager — interactive headless-browser sessions for the
 * canvas Portal node ("solution 2").
 *
 * Lifecycle:
 *   1. Frontend POSTs /portal/session with { url, persistKey?, viewport? }
 *   2. We lazy-launch a shared Chromium process (Playwright) and create a new
 *      `BrowserContext` per session — the context owns the cookie jar, so each
 *      portal node = its own login session.
 *   3. The frontend opens two WebSockets:
 *        /portal/:id/screencast  (server → client, JPEG frames via CDP)
 *        /portal/:id/input       (client → server, mouse/keyboard events)
 *   4. When the session is closed (DELETE or idle timeout), we serialize the
 *      context's storageState to disk under `portal-sessions/{persistKey}.json`
 *      so the next session reusing the same persistKey starts already logged in.
 *
 * Failure mode: if Chromium isn't installed, the session creation rejects with
 * a clear message — the frontend then keeps the static iframe fallback.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, BrowserContext, Page, CDPSession } from "playwright-core";
import type { WebSocket } from "ws";
import { logger } from "./logger.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PortalViewport {
  width: number;
  height: number;
}

export interface PortalSession {
  id: string;
  /** Stable identifier the client uses to reuse cookies between sessions. */
  persistKey: string | null;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  viewport: PortalViewport;
  /** Cached URL — updated on every page.url() change. */
  currentUrl: string;
  /** When `screencastClients` is empty, we stop the CDP screencast to save CPU. */
  screencastClients: Set<WebSocket>;
  /** Single input client — extra connections are rejected to avoid race conditions. */
  inputClient: WebSocket | null;
  createdAt: number;
  lastActivityAt: number;
}

export interface CreateSessionOptions {
  url: string;
  persistKey?: string | null;
  viewport?: PortalViewport;
}

// ─── Configuration ──────────────────────────────────────────────────────────

const SESSION_DIR = process.env.PORTAL_SESSIONS_DIR
  ?? path.join(process.cwd(), "portal-sessions");

const IDLE_TIMEOUT_MS = parseInt(process.env.PORTAL_IDLE_TIMEOUT_MS ?? "1800000", 10); // 30 min
const MAX_SESSIONS = parseInt(process.env.PORTAL_MAX_SESSIONS ?? "10", 10);
const DEFAULT_VIEWPORT: PortalViewport = { width: 1280, height: 720 };

// ─── State ──────────────────────────────────────────────────────────────────

let sharedBrowser: Browser | null = null;
let browserStartingPromise: Promise<Browser> | null = null;
const sessions = new Map<string, PortalSession>();
let idleSweeper: NodeJS.Timeout | null = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureSessionDir(): void {
  try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch { /* race */ }
}

function persistFilePath(persistKey: string): string {
  // Safe filename: only alnum/dash/underscore. Anything else → hash.
  const safe = /^[a-zA-Z0-9_-]+$/.test(persistKey)
    ? persistKey
    : crypto.createHash("sha256").update(persistKey).digest("hex").slice(0, 32);
  return path.join(SESSION_DIR, `${safe}.json`);
}

async function getSharedBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  if (browserStartingPromise) return browserStartingPromise;

  browserStartingPromise = (async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({
      headless: true,
      args: [
        // Stable cross-platform flags. We're inside a server process — no GPU,
        // no sandbox-hostile features. CDP screencast still works fine.
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
      ],
    });
    sharedBrowser = browser;
    browser.on("disconnected", () => {
      sharedBrowser = null;
      browserStartingPromise = null;
      // Drop all sessions — their context handles are now invalid.
      for (const [id, s] of sessions) {
        for (const ws of s.screencastClients) try { ws.close(); } catch { /* ignore */ }
        if (s.inputClient) try { s.inputClient.close(); } catch { /* ignore */ }
        sessions.delete(id);
      }
      logger.warn("portal", "Shared Chromium disconnected — all sessions dropped");
    });
    return browser;
  })();

  try {
    const browser = await browserStartingPromise;
    return browser;
  } finally {
    browserStartingPromise = null;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function createPortalSession(opts: CreateSessionOptions): Promise<PortalSession> {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`Max portal sessions (${MAX_SESSIONS}) reached. Close one before opening a new one.`);
  }

  const url = opts.url;
  if (!url || !/^https?:\/\//.test(url)) {
    throw new Error("Invalid URL — must start with http:// or https://");
  }

  const viewport = opts.viewport ?? DEFAULT_VIEWPORT;
  const persistKey = opts.persistKey?.trim() || null;

  let browser: Browser;
  try {
    browser = await getSharedBrowser();
  } catch (err) {
    throw new Error(
      `Failed to launch Chromium: ${(err as Error).message}. ` +
      `Run "npx playwright install chromium" inside mcp-server/ to install it.`,
    );
  }

  // Load cookies/localStorage from disk if a persistKey is provided.
  let storageState: string | undefined;
  if (persistKey) {
    const file = persistFilePath(persistKey);
    if (fs.existsSync(file)) {
      try {
        // Validate JSON — Playwright will throw a less helpful error otherwise.
        const raw = fs.readFileSync(file, "utf-8");
        JSON.parse(raw);
        storageState = file;
      } catch (err) {
        logger.warn("portal", `Corrupted storageState ${persistKey} — starting fresh`, { error: (err as Error).message });
      }
    }
  }

  const context = await browser.newContext({
    viewport,
    storageState,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    ignoreHTTPSErrors: false,
  });

  const page = await context.newPage();

  // Best-effort navigation. We don't reject if the page errors — the user can
  // still see the failure inside the screencast and retry from there.
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (err) {
    logger.warn("portal", `Initial navigation to ${url} failed`, { error: (err as Error).message });
  }

  const cdp = await context.newCDPSession(page);

  const id = crypto.randomBytes(12).toString("hex");
  const session: PortalSession = {
    id,
    persistKey,
    context,
    page,
    cdp,
    viewport,
    currentUrl: page.url(),
    screencastClients: new Set(),
    inputClient: null,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };

  // Track URL changes (sites navigate via pushState; we surface the current
  // URL to the frontend so the address bar stays accurate).
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      session.currentUrl = frame.url();
      // Notify clients so they can update their address bar.
      const msg = JSON.stringify({ type: "url", url: session.currentUrl });
      for (const ws of session.screencastClients) {
        try { ws.send(msg); } catch { /* ignore */ }
      }
    }
  });

  // If the page closes (crash, target close), drop the session.
  page.on("close", () => { void closePortalSession(id).catch(() => {}); });

  sessions.set(id, session);
  startIdleSweeper();

  logger.info("portal", `Session created`, { id, url, persistKey, viewport });
  return session;
}

export function getPortalSession(id: string): PortalSession | undefined {
  const s = sessions.get(id);
  if (s) s.lastActivityAt = Date.now();
  return s;
}

export function listPortalSessions(): Array<{
  id: string;
  url: string;
  persistKey: string | null;
  viewport: PortalViewport;
  screencastClients: number;
  hasInput: boolean;
  createdAt: number;
  lastActivityAt: number;
}> {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    url: s.currentUrl,
    persistKey: s.persistKey,
    viewport: s.viewport,
    screencastClients: s.screencastClients.size,
    hasInput: !!s.inputClient,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
  }));
}

export async function navigatePortalSession(id: string, url: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) throw new Error("Session not found");
  if (!/^https?:\/\//.test(url)) throw new Error("Invalid URL");
  s.lastActivityAt = Date.now();
  await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
}

export async function closePortalSession(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);

  // Persist storageState before tearing down context.
  if (s.persistKey) {
    try {
      ensureSessionDir();
      await s.context.storageState({ path: persistFilePath(s.persistKey) });
      logger.info("portal", `Saved storageState`, { persistKey: s.persistKey });
    } catch (err) {
      logger.warn("portal", `Failed to save storageState`, { persistKey: s.persistKey, error: (err as Error).message });
    }
  }

  // Close every active connection — clients will reconnect or drop.
  for (const ws of s.screencastClients) try { ws.close(1000, "session closed"); } catch { /* ignore */ }
  if (s.inputClient) try { s.inputClient.close(1000, "session closed"); } catch { /* ignore */ }

  // Stop screencast then close.
  try { await s.cdp.send("Page.stopScreencast"); } catch { /* may already be stopped */ }
  try { await s.cdp.detach(); } catch { /* ignore */ }
  try { await s.page.close(); } catch { /* may already be closed */ }
  try { await s.context.close(); } catch { /* may already be closed */ }
}

export async function closeAllPortalSessions(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.allSettled(ids.map(closePortalSession));
  if (sharedBrowser && sharedBrowser.isConnected()) {
    try { await sharedBrowser.close(); } catch { /* ignore */ }
  }
  sharedBrowser = null;
  if (idleSweeper) {
    clearInterval(idleSweeper);
    idleSweeper = null;
  }
}

// ─── Idle sweeper ───────────────────────────────────────────────────────────
// Reaps sessions that have had no client activity for IDLE_TIMEOUT_MS.
// Important so that abandoned tabs don't leak Chromium contexts.

function startIdleSweeper(): void {
  if (idleSweeper) return;
  idleSweeper = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      const idle = now - s.lastActivityAt;
      const noClients = s.screencastClients.size === 0 && !s.inputClient;
      if (noClients && idle > IDLE_TIMEOUT_MS) {
        logger.info("portal", `Reaping idle session`, { id: s.id, idleMs: idle });
        void closePortalSession(s.id).catch(() => {});
      }
    }
  }, 60_000);
  // Don't keep the process alive just for the sweeper.
  if (typeof idleSweeper.unref === "function") idleSweeper.unref();
}
