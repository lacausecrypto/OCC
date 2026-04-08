import { describe, it, expect, beforeEach } from "vitest";
import {
  useShortcutStore,
  DEFAULT_SHORTCUTS,
  matchesCombo,
  formatCombo,
  type KeyCombo,
  type ShortcutAction,
} from "../../src/stores/shortcuts";

function makeKeyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("useShortcutStore", () => {
  beforeEach(() => {
    useShortcutStore.getState().resetAll();
    localStorage.clear();
  });

  describe("initial state", () => {
    it("loads default shortcuts", () => {
      const s = useShortcutStore.getState();
      expect(s.shortcuts.length).toBe(DEFAULT_SHORTCUTS.length);
    });

    it("has all expected actions", () => {
      const actions = useShortcutStore.getState().shortcuts.map((s) => s.action);
      expect(actions).toContain("nav.dashboard");
      expect(actions).toContain("canvas.undo");
      expect(actions).toContain("blob.gitGraph");
      expect(actions).toContain("global.closeModal");
    });
  });

  describe("getCombo", () => {
    it("returns combo for a known action", () => {
      const combo = useShortcutStore.getState().getCombo("nav.dashboard");
      expect(combo.key).toBe("1");
    });

    it("returns empty key for unknown action", () => {
      const combo = useShortcutStore.getState().getCombo("nonexistent.action" as ShortcutAction);
      expect(combo.key).toBe("");
    });

    it("returns mod combo for canvas.undo", () => {
      const combo = useShortcutStore.getState().getCombo("canvas.undo");
      expect(combo.key).toBe("z");
      expect(combo.mod).toBe(true);
    });

    it("returns shift+mod combo for canvas.redo", () => {
      const combo = useShortcutStore.getState().getCombo("canvas.redo");
      expect(combo.key).toBe("z");
      expect(combo.mod).toBe(true);
      expect(combo.shift).toBe(true);
    });
  });

  describe("setCombo", () => {
    it("changes combo for an action", () => {
      useShortcutStore.getState().setCombo("nav.dashboard", { key: "d", mod: true });
      const combo = useShortcutStore.getState().getCombo("nav.dashboard");
      expect(combo.key).toBe("d");
      expect(combo.mod).toBe(true);
    });

    it("persists to localStorage", () => {
      useShortcutStore.getState().setCombo("nav.dashboard", { key: "x" });
      const raw = localStorage.getItem("occ-keyboard-shortcuts");
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      const entry = parsed.find((s: any) => s.action === "nav.dashboard");
      expect(entry.combo.key).toBe("x");
    });

    it("only affects the targeted action", () => {
      const originalWorkflow = useShortcutStore.getState().getCombo("nav.workflow");
      useShortcutStore.getState().setCombo("nav.dashboard", { key: "x" });
      const afterWorkflow = useShortcutStore.getState().getCombo("nav.workflow");
      expect(afterWorkflow.key).toBe(originalWorkflow.key);
    });
  });

  describe("resetAll", () => {
    it("restores all defaults", () => {
      useShortcutStore.getState().setCombo("nav.dashboard", { key: "x" });
      useShortcutStore.getState().resetAll();
      const combo = useShortcutStore.getState().getCombo("nav.dashboard");
      expect(combo.key).toBe("1");
    });

    it("removes localStorage entry", () => {
      useShortcutStore.getState().setCombo("nav.dashboard", { key: "x" });
      expect(localStorage.getItem("occ-keyboard-shortcuts")).toBeTruthy();
      useShortcutStore.getState().resetAll();
      expect(localStorage.getItem("occ-keyboard-shortcuts")).toBeNull();
    });
  });

  describe("matches", () => {
    it("matches simple key", () => {
      const e = makeKeyEvent({ key: "1" });
      expect(useShortcutStore.getState().matches(e, "nav.dashboard")).toBe(true);
    });

    it("does not match wrong key", () => {
      const e = makeKeyEvent({ key: "9" });
      expect(useShortcutStore.getState().matches(e, "nav.dashboard")).toBe(false);
    });

    it("matches mod combo", () => {
      const e = makeKeyEvent({ key: "z", metaKey: true });
      expect(useShortcutStore.getState().matches(e, "canvas.undo")).toBe(true);
    });

    it("matches mod+shift combo", () => {
      const e = makeKeyEvent({ key: "z", metaKey: true, shiftKey: true });
      expect(useShortcutStore.getState().matches(e, "canvas.redo")).toBe(true);
    });

    it("does not match undo when shift is pressed", () => {
      const e = makeKeyEvent({ key: "z", metaKey: true, shiftKey: true });
      expect(useShortcutStore.getState().matches(e, "canvas.undo")).toBe(false);
    });

    it("does not match mod combo without mod key", () => {
      const e = makeKeyEvent({ key: "z" });
      expect(useShortcutStore.getState().matches(e, "canvas.undo")).toBe(false);
    });
  });
});

describe("matchesCombo", () => {
  it("matches simple key press", () => {
    const combo: KeyCombo = { key: "a" };
    expect(matchesCombo(makeKeyEvent({ key: "a" }), combo)).toBe(true);
  });

  it("is case insensitive for letters", () => {
    const combo: KeyCombo = { key: "a" };
    expect(matchesCombo(makeKeyEvent({ key: "A" }), combo)).toBe(true);
  });

  it("matches Cmd/Ctrl modifier", () => {
    const combo: KeyCombo = { key: "s", mod: true };
    expect(matchesCombo(makeKeyEvent({ key: "s", metaKey: true }), combo)).toBe(true);
    expect(matchesCombo(makeKeyEvent({ key: "s", ctrlKey: true }), combo)).toBe(true);
  });

  it("rejects when mod required but not pressed", () => {
    const combo: KeyCombo = { key: "s", mod: true };
    expect(matchesCombo(makeKeyEvent({ key: "s" }), combo)).toBe(false);
  });

  it("rejects when mod pressed but not required", () => {
    const combo: KeyCombo = { key: "1" };
    expect(matchesCombo(makeKeyEvent({ key: "1", metaKey: true }), combo)).toBe(false);
  });

  it("matches shift in mod combos", () => {
    const combo: KeyCombo = { key: "z", mod: true, shift: true };
    expect(matchesCombo(makeKeyEvent({ key: "z", metaKey: true, shiftKey: true }), combo)).toBe(true);
  });

  it("rejects shift mismatch in mod combos", () => {
    const combo: KeyCombo = { key: "z", mod: true, shift: true };
    expect(matchesCombo(makeKeyEvent({ key: "z", metaKey: true, shiftKey: false }), combo)).toBe(false);
  });

  it("matches Delete key including Backspace", () => {
    const combo: KeyCombo = { key: "Delete" };
    expect(matchesCombo(makeKeyEvent({ key: "Delete" }), combo)).toBe(true);
    expect(matchesCombo(makeKeyEvent({ key: "Backspace" }), combo)).toBe(true);
  });

  it("ignores shift state for non-mod combos", () => {
    const combo: KeyCombo = { key: "1" };
    // Shift+1 should still match "1" for non-mod combos (layout-dependent characters)
    expect(matchesCombo(makeKeyEvent({ key: "1", shiftKey: true }), combo)).toBe(true);
  });

  it("matches Escape key", () => {
    const combo: KeyCombo = { key: "Escape" };
    expect(matchesCombo(makeKeyEvent({ key: "Escape" }), combo)).toBe(true);
  });

  it("matches space key", () => {
    const combo: KeyCombo = { key: " " };
    expect(matchesCombo(makeKeyEvent({ key: " " }), combo)).toBe(true);
  });
});

describe("formatCombo", () => {
  it("formats simple key", () => {
    expect(formatCombo({ key: "a" })).toBe("A");
  });

  it("formats mod combo", () => {
    const result = formatCombo({ key: "s", mod: true });
    expect(result).toContain("\u2318");
    expect(result).toContain("S");
  });

  it("formats shift+mod combo", () => {
    const result = formatCombo({ key: "z", mod: true, shift: true });
    expect(result).toContain("\u2318");
    expect(result).toContain("\u21E7");
    expect(result).toContain("Z");
  });

  it("formats Delete key", () => {
    expect(formatCombo({ key: "Delete" })).toBe("Del");
  });

  it("formats Escape key", () => {
    expect(formatCombo({ key: "Escape" })).toBe("Esc");
  });

  it("formats Space key", () => {
    expect(formatCombo({ key: " " })).toBe("Space");
  });

  it("formats = as +", () => {
    expect(formatCombo({ key: "=" })).toBe("+");
  });
});
