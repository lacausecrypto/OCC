// ─── SSE (Server-Sent Events) manager with auto-reconnect ───────────────────

import type { ExecutionEvent } from "../types/execution";

export type SSEStatus = "disconnected" | "connected" | "reconnecting";

export type SSEEventCallback = (event: ExecutionEvent) => void;
export type SSEStatusCallback = (status: SSEStatus) => void;

const RECONNECT_DELAY = 3000;

export class SSEManager {
  private eventSource: EventSource | null = null;
  private url: string = "";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_ATTEMPTS = 15;
  private static readonly MAX_RECONNECT_DELAY = 30000;

  onEvent: SSEEventCallback | null = null;
  onStatusChange: SSEStatusCallback | null = null;

  get status(): SSEStatus {
    if (!this.eventSource) return "disconnected";
    switch (this.eventSource.readyState) {
      case EventSource.OPEN:
        return "connected";
      case EventSource.CONNECTING:
        return "reconnecting";
      default:
        return "disconnected";
    }
  }

  connect(url: string): void {
    this.disconnect();
    this.url = url;
    this.shouldReconnect = true;
    this.createConnection();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.onStatusChange?.("disconnected");
  }

  private createConnection(): void {
    if (this.eventSource) {
      this.eventSource.close();
    }

    const es = new EventSource(this.url);
    this.eventSource = es;

    es.onopen = () => {
      this.reconnectAttempts = 0; // Reset on successful connection
      this.onStatusChange?.("connected");
    };

    es.onmessage = (msg) => {
      const data = msg.data;
      // Ignore heartbeat comments (empty data or just whitespace)
      if (!data || !data.trim()) return;
      try {
        const event = JSON.parse(data) as ExecutionEvent;
        this.onEvent?.(event);
      } catch {
        // Ignore unparseable messages (heartbeats etc.)
      }
    };

    es.onerror = () => {
      es.close();
      this.eventSource = null;
      if (this.shouldReconnect && this.reconnectAttempts < SSEManager.MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts++;
        // Exponential backoff: 3s, 6s, 12s, 24s, 30s (capped)
        const delay = Math.min(RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1), SSEManager.MAX_RECONNECT_DELAY);
        this.onStatusChange?.("reconnecting");
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (this.shouldReconnect) {
            this.createConnection();
          }
        }, delay);
      } else {
        this.onStatusChange?.("disconnected");
      }
    };
  }
}

/** Singleton SSE manager */
export const sseManager = new SSEManager();
