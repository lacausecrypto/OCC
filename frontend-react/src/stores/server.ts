// ─── Server connection store ─────────────────────────────────────────────────

import { create } from "zustand";

interface ServerState {
  occServerUrl: string;
  serverOnline: boolean;
  apiKey: string | null;

  setServerUrl: (url: string) => void;
  setApiKey: (key: string | null) => void;
  checkHealth: () => Promise<boolean>;
}

export const useServerStore = create<ServerState>((set) => ({
  occServerUrl: "http://localhost:4242",
  serverOnline: false,
  apiKey: null,

  setServerUrl: (url: string) => set({ occServerUrl: url }),

  setApiKey: (key: string | null) => set({ apiKey: key }),

  checkHealth: async () => {
    try {
      // Use relative URL — goes through Vite proxy in dev, same-origin in prod
      const res = await fetch("/health", {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json();
        const online = !!data.ok || data.status === "ok";
        set({ serverOnline: online });
        return online;
      }
    } catch {
      // Server unreachable
    }
    set({ serverOnline: false });
    return false;
  },
}));
