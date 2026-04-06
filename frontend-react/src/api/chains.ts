// ─── Chain API functions ─────────────────────────────────────────────────────

import { api } from "./client";
import type { ChainDefinition } from "../types/chain";

export interface ChainListItem {
  name: string;
  description?: string;
  version?: string;
  stepCount?: number;
  /** Step details returned by GET /chains */
  steps?: { type?: string; id?: string; pre_tools?: string[]; tools?: string[] }[];
  error?: string;
}

export interface ChainStats {
  totalExecutions: number;
  avgDurationMs: number;
  successRate: number;
  lastRun?: string;
}

/** List all chains */
export function fetchChains(): Promise<ChainListItem[]> {
  return api.get<ChainListItem[]>("/chains");
}

/** Get raw YAML for a chain */
export function fetchChainYaml(name: string): Promise<string> {
  return api.get<string>(`/chains/${encodeURIComponent(name)}`);
}

/** Get parsed JSON via the /yaml-to-json proxy endpoint */
export async function fetchChainJson(
  name: string,
  serverUrl = "http://localhost:4242",
): Promise<ChainDefinition> {
  const url = `/yaml-to-json?url=${encodeURIComponent(serverUrl + "/chains/" + name)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`yaml-to-json failed: ${res.status}`);
  return res.json() as Promise<ChainDefinition>;
}

/** Save (create or update) a chain — auto-creates a version */
export function saveChain(
  name: string,
  yaml: string,
  versionMessage?: string,
): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>(`/chains/${encodeURIComponent(name)}`, {
    yaml,
    versionMessage,
  });
}

/** Delete a chain */
export function deleteChain(name: string): Promise<void> {
  return api.delete<void>(`/chains/${encodeURIComponent(name)}`);
}

/** Get execution stats for a chain */
export function fetchChainStats(name: string): Promise<ChainStats> {
  return api.get<ChainStats>(`/chains/${encodeURIComponent(name)}/stats`);
}
