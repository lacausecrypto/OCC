// ─── Configurable keyboard shortcuts store ───────────────────────────────────
// All shortcuts are stored as serializable key combos and persisted to localStorage.
// Handlers read from this store instead of hardcoding keys.

import { create } from "zustand";

const STORAGE_KEY = "occ-keyboard-shortcuts";

// ─── Shortcut definition ─────────────────────────────────────────────────────

export interface KeyCombo {
  key: string;         // e.g. "z", "s", "g", "Delete", " ", "Escape", "+", "-", "0", "/"
  mod?: boolean;       // Cmd/Ctrl required
  shift?: boolean;     // Shift required
}

export type ShortcutAction =
  // Navigation
  | "nav.dashboard" | "nav.workflow" | "nav.blob" | "nav.settings"
  | "nav.toggleDesign" | "nav.toggleMonitor"
  // Canvas
  | "canvas.selectAll" | "canvas.undo" | "canvas.redo" | "canvas.save"
  | "canvas.copy" | "canvas.paste" | "canvas.duplicate"
  | "canvas.delete" | "canvas.deselect" | "canvas.pan"
  | "canvas.zoomIn" | "canvas.zoomOut" | "canvas.zoomFit"
  // BLOB
  | "blob.gitGraph" | "blob.knowledge" | "blob.promptEditor"
  | "blob.focusChat" | "blob.closeAll"
  // Global
  | "global.closeModal";

export interface ShortcutEntry {
  action: ShortcutAction;
  label: string;
  category: "Navigation" | "Workflow Canvas" | "The Blob" | "Global";
  combo: KeyCombo;
}

// ─── Default shortcuts ───────────────────────────────────────────────────────

export const DEFAULT_SHORTCUTS: ShortcutEntry[] = [
  // Navigation
  { action: "nav.dashboard",     label: "Dashboard",            category: "Navigation",       combo: { key: "1" } },
  { action: "nav.workflow",      label: "Workflow",              category: "Navigation",       combo: { key: "2" } },
  { action: "nav.blob",          label: "The Blob",             category: "Navigation",       combo: { key: "3" } },
  { action: "nav.settings",      label: "Settings",             category: "Navigation",       combo: { key: "4" } },
  { action: "nav.toggleDesign",  label: "Toggle Design Space",  category: "Navigation",       combo: { key: "[" } },
  { action: "nav.toggleMonitor", label: "Toggle Live Monitor",  category: "Navigation",       combo: { key: "]" } },
  // Canvas
  { action: "canvas.selectAll",  label: "Select All",           category: "Workflow Canvas",  combo: { key: "a", mod: true } },
  { action: "canvas.undo",       label: "Undo",                 category: "Workflow Canvas",  combo: { key: "z", mod: true } },
  { action: "canvas.redo",       label: "Redo",                 category: "Workflow Canvas",  combo: { key: "z", mod: true, shift: true } },
  { action: "canvas.save",       label: "Save Chain",           category: "Workflow Canvas",  combo: { key: "s", mod: true } },
  { action: "canvas.copy",       label: "Copy Nodes",           category: "Workflow Canvas",  combo: { key: "c", mod: true } },
  { action: "canvas.paste",      label: "Paste Nodes",          category: "Workflow Canvas",  combo: { key: "v", mod: true } },
  { action: "canvas.duplicate",  label: "Duplicate",            category: "Workflow Canvas",  combo: { key: "d", mod: true } },
  { action: "canvas.delete",     label: "Delete Selected",      category: "Workflow Canvas",  combo: { key: "Delete" } },
  { action: "canvas.deselect",   label: "Deselect All",         category: "Workflow Canvas",  combo: { key: "Escape" } },
  { action: "canvas.pan",        label: "Pan Mode (hold)",      category: "Workflow Canvas",  combo: { key: " " } },
  { action: "canvas.zoomIn",     label: "Zoom In",              category: "Workflow Canvas",  combo: { key: "=" } },
  { action: "canvas.zoomOut",    label: "Zoom Out",             category: "Workflow Canvas",  combo: { key: "-" } },
  { action: "canvas.zoomFit",    label: "Zoom to Fit",          category: "Workflow Canvas",  combo: { key: "0" } },
  // BLOB
  { action: "blob.gitGraph",     label: "Toggle Git Graph",     category: "The Blob",         combo: { key: "g" } },
  { action: "blob.knowledge",    label: "Toggle Knowledge",     category: "The Blob",         combo: { key: "k" } },
  { action: "blob.promptEditor", label: "Toggle Prompt Editor", category: "The Blob",         combo: { key: "p" } },
  { action: "blob.focusChat",    label: "Focus Chat",           category: "The Blob",         combo: { key: "/" } },
  { action: "blob.closeAll",     label: "Close All Panels",     category: "The Blob",         combo: { key: "Escape" } },
  // Global
  { action: "global.closeModal", label: "Close Modal",          category: "Global",           combo: { key: "Escape" } },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Check if a keyboard event matches a combo */
export function matchesCombo(e: KeyboardEvent, combo: KeyCombo): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (combo.mod && !mod) return false;
  if (!combo.mod && mod) return false;

  // Shift handling: only enforce shift mismatch for mod combos (Cmd+Z vs Cmd+Shift+Z)
  // For non-mod combos, ignore shift state because characters like & # @ require shift on some layouts
  if (combo.mod) {
    if (combo.shift && !e.shiftKey) return false;
    if (!combo.shift && e.shiftKey) return false;
  }

  // Match key (case-insensitive for letters)
  if (combo.key === "Delete") return e.key === "Delete" || e.key === "Backspace";
  return e.key.toLowerCase() === combo.key.toLowerCase();
}

/** Format a combo for display */
export function formatCombo(combo: KeyCombo): string {
  const parts: string[] = [];
  if (combo.mod) parts.push("\u2318"); // Cmd symbol
  if (combo.shift) parts.push("\u21E7"); // Shift symbol
  const keyDisplay: Record<string, string> = {
    "Delete": "Del",
    "Backspace": "Del",
    "Escape": "Esc",
    " ": "Space",
    "=": "+",
  };
  parts.push(keyDisplay[combo.key] ?? combo.key.toUpperCase());
  return parts.join("");
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface ShortcutState {
  shortcuts: ShortcutEntry[];
  getCombo: (action: ShortcutAction) => KeyCombo;
  matches: (e: KeyboardEvent, action: ShortcutAction) => boolean;
  setCombo: (action: ShortcutAction, combo: KeyCombo) => void;
  resetAll: () => void;
}

function loadShortcuts(): ShortcutEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SHORTCUTS.map((s) => ({ ...s }));
    const saved = JSON.parse(raw) as Array<{ action: string; combo: KeyCombo }>;
    // Merge saved combos into defaults (handles new actions added in updates)
    return DEFAULT_SHORTCUTS.map((def) => {
      const override = saved.find((s) => s.action === def.action);
      return override ? { ...def, combo: override.combo } : { ...def };
    });
  } catch {
    return DEFAULT_SHORTCUTS.map((s) => ({ ...s }));
  }
}

function saveShortcuts(shortcuts: ShortcutEntry[]) {
  const toSave = shortcuts.map((s) => ({ action: s.action, combo: s.combo }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
}

export const useShortcutStore = create<ShortcutState>((set, get) => ({
  shortcuts: loadShortcuts(),

  getCombo: (action) => {
    const entry = get().shortcuts.find((s) => s.action === action);
    return entry?.combo ?? { key: "" };
  },

  matches: (e, action) => {
    const combo = get().getCombo(action);
    return matchesCombo(e, combo);
  },

  setCombo: (action, combo) => {
    const shortcuts = get().shortcuts.map((s) =>
      s.action === action ? { ...s, combo } : s,
    );
    set({ shortcuts });
    saveShortcuts(shortcuts);
  },

  resetAll: () => {
    const shortcuts = DEFAULT_SHORTCUTS.map((s) => ({ ...s }));
    set({ shortcuts });
    localStorage.removeItem(STORAGE_KEY);
  },
}));
