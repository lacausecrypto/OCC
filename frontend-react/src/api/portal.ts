/**
 * Portal API — wrapper around the interactive portal endpoints. The static
 * `/portal?url=…` proxy used by the read-only iframe overlay does not go
 * through here.
 */

export interface PortalSessionInfo {
  sessionId: string;
  url: string;
  viewport: { width: number; height: number };
  persistKey: string | null;
}

export async function createPortalSession(opts: {
  url: string;
  persistKey?: string;
  viewport?: { width: number; height: number };
}): Promise<PortalSessionInfo> {
  const res = await fetch("/portal/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function navigatePortalSession(sessionId: string, url: string): Promise<void> {
  const res = await fetch(`/portal/session/${sessionId}/navigate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
}

export async function closePortalSession(sessionId: string): Promise<void> {
  // Close is best-effort — if it fails, the backend's idle sweeper will
  // reclaim the session eventually.
  await fetch(`/portal/session/${sessionId}`, { method: "DELETE" }).catch(() => {});
}

/**
 * Build the WebSocket URL for a portal channel. Goes through the same
 * Vite proxy / origin as the REST API.
 */
export function portalWsUrl(sessionId: string, channel: "screencast" | "input"): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/portal/${sessionId}/${channel}`;
}

export interface PortalSnapshot {
  sessionId: string;
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/**
 * Take a live DOM snapshot of an interactive portal session. Returns null
 * if no matching session is running (e.g. portal in static mode, or the
 * user hasn't opened the canvas yet so the Playwright context isn't alive).
 */
export async function getPortalSnapshot(opts: {
  persistKey?: string;
  sessionId?: string;
}): Promise<PortalSnapshot | null> {
  const params = new URLSearchParams();
  if (opts.persistKey) params.set("persistKey", opts.persistKey);
  if (opts.sessionId) params.set("sessionId", opts.sessionId);
  if ([...params.keys()].length === 0) return null;
  try {
    const res = await fetch(`/portal/snapshot?${params.toString()}`);
    if (!res.ok) return null;
    return (await res.json()) as PortalSnapshot;
  } catch {
    return null;
  }
}
