/**
 * Persisted Settings collapse state — pure helpers (no React).
 *
 * Lives in localStorage under `occ-settings-collapsed` as a sparse
 * `{ [id]: true }` map of collapsed sections. Open sections are absent.
 * Bulk operations broadcast a `occ:settings-collapse` window event so every
 * mounted CollapsibleSection updates without a remount.
 */
import { useState, useEffect, useCallback } from "react";

export const COLLAPSED_KEY = "occ-settings-collapsed";

export const ALL_SECTION_IDS = [
  "server", "execution", "providers", "ollama", "huggingface", "toolsecurity",
  "queue", "schedules", "mcp", "system-prompts", "interface", "paths", "storage",
  "email", "about", "tokens", "models", "blob", "data", "shortcuts",
] as const;

function readCollapsed(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}"); }
  catch { return {}; }
}
function writeCollapsed(next: Record<string, boolean>): void {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch { /* quota */ }
}

export function useSectionCollapsed(id: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed()[id] === true);
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string; collapsed: boolean }>).detail;
      if (!detail) return;
      if (detail.id === "*" || detail.id === id) setCollapsed(detail.collapsed);
    };
    window.addEventListener("occ:settings-collapse", onChange);
    return () => window.removeEventListener("occ:settings-collapse", onChange);
  }, [id]);
  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      const all = readCollapsed();
      if (next) all[id] = true; else delete all[id];
      writeCollapsed(all);
      return next;
    });
  }, [id]);
  return [collapsed, toggle];
}

export function collapseAll(): void {
  const all: Record<string, boolean> = {};
  for (const id of ALL_SECTION_IDS) all[id] = true;
  writeCollapsed(all);
  window.dispatchEvent(new CustomEvent("occ:settings-collapse", { detail: { id: "*", collapsed: true } }));
}

export function expandAll(): void {
  writeCollapsed({});
  window.dispatchEvent(new CustomEvent("occ:settings-collapse", { detail: { id: "*", collapsed: false } }));
}
