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
