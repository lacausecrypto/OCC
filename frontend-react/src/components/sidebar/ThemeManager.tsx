import { useState, useCallback, useEffect, useRef } from "react";
import { useDesignStore } from "../../stores/design";
import type { SavedTheme, DesignPreset } from "../../types/design";
import { hsl } from "../../utils/color";
import styles from "./Sidebar.module.css";

const STORAGE_KEY = "occ-saved-themes";

function loadThemes(): SavedTheme[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function persistThemes(themes: SavedTheme[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(themes));
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Read store state without subscribing (no re-renders) */
function getStoreSnap() {
  return useDesignStore.getState();
}

export function ThemeManager() {
  const [open, setOpen] = useState(false);
  const [themes, setThemes] = useState<SavedTheme[]>(loadThemes);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEditingId(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSave = useCallback(() => {
    const { presets, blendX, blendY } = getStoreSnap();
    const theme: SavedTheme = {
      id: genId(),
      name: `Theme ${themes.length + 1}`,
      createdAt: Date.now(),
      presets: presets.map((p: DesignPreset) => ({ ...p })),
      blendX,
      blendY,
    };
    const next = [theme, ...themes];
    setThemes(next);
    persistThemes(next);
    setEditingId(theme.id);
    setEditName(theme.name);
  }, [themes]);

  const handleLoad = useCallback((theme: SavedTheme) => {
    const store = getStoreSnap();
    // Set all 4 presets directly in store state (bypasses auto-applyBlend)
    useDesignStore.setState({
      presets: theme.presets.map((p: DesignPreset) => ({ ...p })),
      blendX: theme.blendX,
      blendY: theme.blendY,
    });
    // Single applyBlend at the end
    store.applyBlend();
    setOpen(false);
  }, []);

  const handleDelete = useCallback((id: string) => {
    const next = themes.filter(t => t.id !== id);
    setThemes(next);
    persistThemes(next);
  }, [themes]);

  const handleRename = useCallback((id: string, name: string) => {
    const trimmed = name.trim() || "Untitled";
    const next = themes.map(t => t.id === id ? { ...t, name: trimmed } : t);
    setThemes(next);
    persistThemes(next);
    setEditingId(null);
  }, [themes]);

  const handleOverwrite = useCallback((id: string) => {
    const { presets, blendX, blendY } = getStoreSnap();
    const next = themes.map(t => t.id === id ? {
      ...t,
      presets: presets.map((p: DesignPreset) => ({ ...p })),
      blendX,
      blendY,
    } : t);
    setThemes(next);
    persistThemes(next);
  }, [themes]);

  return (
    <div className={styles.themeManagerWrap} ref={menuRef}>
      <button
        className={styles.ctrlBtn}
        onClick={() => setOpen(!open)}
        title="Saved themes"
      >
        <span className={styles.ctrlBtnIcon}>{"\u2726"}</span>
        <span>Themes</span>
        {themes.length > 0 && (
          <span className={styles.themesBadge}>{themes.length}</span>
        )}
      </button>

      {open && (
        <div className={styles.themeMenu}>
          {/* Save current */}
          <button className={styles.themeMenuSave} onClick={handleSave}>
            + Save current theme
          </button>

          {themes.length === 0 && (
            <div className={styles.themeMenuEmpty}>No saved themes</div>
          )}

          {/* Theme list */}
          <div className={styles.themeMenuList}>
            {themes.map(theme => {
              const isEditing = editingId === theme.id;
              const accent = theme.presets[0]?.accent ?? [211, 100, 50];
              const bg = theme.presets[0]?.bg ?? [0, 0, 5];

              return (
                <div key={theme.id} className={styles.themeMenuItem}>
                  <div className={styles.themeMenuDots}>
                    <span style={{ background: hsl(bg[0], bg[1], bg[2]) }} />
                    <span style={{ background: hsl(accent[0], accent[1], accent[2]) }} />
                  </div>

                  <div className={styles.themeMenuName}>
                    {isEditing ? (
                      <input
                        className={styles.themeMenuInput}
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") handleRename(theme.id, editName);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        onBlur={() => handleRename(theme.id, editName)}
                        autoFocus
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      <span
                        className={styles.themeMenuLabel}
                        onClick={() => handleLoad(theme)}
                        title="Click to load"
                      >
                        {theme.name}
                      </span>
                    )}
                  </div>

                  <div className={styles.themeMenuActions}>
                    <button
                      title="Rename"
                      onClick={e => { e.stopPropagation(); setEditingId(theme.id); setEditName(theme.name); }}
                    >{"\u270E"}</button>
                    <button
                      title="Overwrite with current"
                      onClick={e => { e.stopPropagation(); handleOverwrite(theme.id); }}
                    >{"\u21BB"}</button>
                    <button
                      title="Delete"
                      onClick={e => { e.stopPropagation(); handleDelete(theme.id); }}
                    >{"\u2715"}</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
