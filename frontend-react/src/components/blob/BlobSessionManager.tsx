/**
 * BlobSessionManager — create, list, manage BLOB sessions.
 * Uses Dashboard card styles for visual consistency.
 */
import { useState, useMemo, useEffect } from "react";
import { useBlobStore } from "../../stores/blob";
import { useAppStore } from "../../stores/app";
import type { BlobSession } from "../../types/blob";
import styles from "./Blob.module.css";
import dashStyles from "../dashboard/Dashboard.module.css";

const INTERVAL_PRESETS = [
  { label: "Every 15 min", ms: 900000 },
  { label: "Every hour", ms: 3600000 },
  { label: "Every 6 hours", ms: 21600000 },
  { label: "Every day", ms: 86400000 },
];

const INTERVAL_SHORT: Record<number, string> = {
  900000: "15m", 3600000: "1h", 21600000: "6h", 86400000: "24h",
};

type SortMode = "recent" | "name" | "nodes" | "tokens";
type FilterMode = "all" | "active" | "autonomous" | "disabled";

export function BlobSessionManager() {
  const sessions = useBlobStore((s) => s.sessions);
  const createSession = useBlobStore((s) => s.createSession);
  const deleteSession = useBlobStore((s) => s.deleteSession);
  const renameSession = useBlobStore((s) => s.renameSession);
  const toggleSession = useBlobStore((s) => s.toggleSession);
  const setAutonomous = useBlobStore((s) => s.setAutonomous);
  const setActiveSession = useBlobStore((s) => s.setActiveSession);
  const syncFromBackend = useBlobStore((s) => s.syncFromBackend);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  // Sync sessions from backend on mount
  useEffect(() => { syncFromBackend(); }, [syncFromBackend]);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortMode>("recent");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const name = newName.trim();
    const desc = newDesc.trim() || undefined;

    // Create on backend first to get canonical ID
    try {
      const res = await fetch("/blobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: desc }),
      });
      if (res.ok) {
        const backendSession = await res.json();
        // Sync from backend to pick up the new session
        await syncFromBackend();
        // Load it
        setActiveSession(backendSession.id);
        setActiveTab("blob");
        setCreating(false);
        setNewName("");
        setNewDesc("");
        return;
      }
    } catch { /* backend offline — fallback to local */ }

    // Fallback: create locally
    const id = createSession(name, desc);
    setCreating(false);
    setNewName("");
    setNewDesc("");
    setActiveSession(id);
    setActiveTab("blob");
  };

  const handleOpen = (id: string) => {
    setActiveSession(id);
    setActiveTab("blob");
  };

  const handleDelete = (id: string) => {
    if (confirmDelete !== id) { setConfirmDelete(id); setTimeout(() => setConfirmDelete(null), 3000); return; }
    deleteSession(id);
    fetch(`/blobs/${id}`, { method: "DELETE" }).catch(() => {});
    setConfirmDelete(null);
  };

  const formatDate = (iso: string) => {
    try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch { return iso; }
  };

  // Filter + Sort
  const filtered = useMemo(() => {
    let list = [...sessions];

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((s) => s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q));
    }

    // Filter
    switch (filterMode) {
      case "active": list = list.filter((s) => s.enabled && !s.autonomous); break;
      case "autonomous": list = list.filter((s) => s.autonomous); break;
      case "disabled": list = list.filter((s) => !s.enabled); break;
    }

    // Sort
    switch (sortBy) {
      case "recent": list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); break;
      case "name": list.sort((a, b) => a.name.localeCompare(b.name)); break;
      case "nodes": list.sort((a, b) => b.nodeCount - a.nodeCount); break;
      case "tokens": list.sort((a, b) => b.totalTokens - a.totalTokens); break;
    }

    return list;
  }, [sessions, searchQuery, filterMode, sortBy]);

  const autonomousCount = sessions.filter((s) => s.autonomous).length;
  const activeCount = sessions.filter((s) => s.enabled).length;

  return (
    <div className={styles.sessionManager}>
      {/* Header */}
      <div className={styles.smHeader}>
        <h1 className={styles.smTitle}>
          The Blob
          <span className={styles.smExpBadge}>EXPERIMENTAL</span>
        </h1>
        <p className={styles.smSubtitle}>Organic AI workflows that grow from conversation</p>
      </div>

      {/* Toolbar */}
      <div className={styles.smToolbar}>
        <input
          className={styles.smSearch}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search sessions..."
        />
        <div className={styles.smFilters}>
          {(["all", "active", "autonomous", "disabled"] as FilterMode[]).map((f) => (
            <button
              key={f}
              className={`${styles.smFilterBtn} ${filterMode === f ? styles.smFilterBtnActive : ""}`}
              onClick={() => setFilterMode(f)}
            >
              {f === "all" ? `All (${sessions.length})` : f === "active" ? `Active (${activeCount})` : f === "autonomous" ? `Auto (${autonomousCount})` : "Disabled"}
            </button>
          ))}
        </div>
        <select className={styles.smSortSelect} value={sortBy} onChange={(e) => setSortBy(e.target.value as SortMode)}>
          <option value="recent">Recent</option>
          <option value="name">Name</option>
          <option value="nodes">Nodes</option>
          <option value="tokens">Tokens</option>
        </select>
        <button className={`${dashStyles.btn} ${dashStyles.btnPrimary}`} onClick={() => setCreating(true)}>
          + New Session
        </button>
      </div>

      {/* Create form */}
      {creating && (
        <div className={styles.smCreateForm}>
          <input className={styles.smInput} value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleCreate()} placeholder="BLOB name..." autoFocus />
          <input className={styles.smInput} value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Description (optional)" />
          <div className={styles.smCreateActions}>
            <button className={dashStyles.btn} onClick={() => setCreating(false)}>Cancel</button>
            <button className={`${dashStyles.btn} ${dashStyles.btnPrimary}`} onClick={handleCreate} disabled={!newName.trim()}>Create</button>
          </div>
        </div>
      )}

      {/* Session grid — uses Dashboard card style */}
      <div className={styles.smGrid}>
        {filtered.length === 0 && !creating && (
          <div className={styles.smEmpty}>
            {searchQuery ? `No sessions matching "${searchQuery}"` : "No BLOB sessions yet. Create one to start growing organic workflows."}
          </div>
        )}

        {filtered.map((s: BlobSession) => (
          <div
            key={s.id}
            className={`${dashStyles.card} ${!s.enabled ? styles.smCardDisabled : ""}`}
            onClick={() => handleOpen(s.id)}
            style={{ cursor: "pointer" }}
          >
            {/* Name */}
            <div className={dashStyles.cardName}>
              {editingId === s.id ? (
                <input
                  className={styles.smInput}
                  defaultValue={s.name}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => { renameSession(s.id, e.target.value); setEditingId(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { renameSession(s.id, (e.target as HTMLInputElement).value); setEditingId(null); } }}
                  autoFocus
                  style={{ flex: 1 }}
                />
              ) : (
                <>
                  <span>{"\u{1F9EC}"}</span>
                  {s.name}
                  {s.autonomous && (
                    <span className={dashStyles.pillAccent} style={{ fontSize: 8 }}>
                      AUTO {INTERVAL_SHORT[s.autonomousIntervalMs ?? 0] ?? ""}
                    </span>
                  )}
                </>
              )}
            </div>

            {/* Description */}
            {s.description && <div className={dashStyles.cardDesc}>{s.description}</div>}

            {/* Meta pills */}
            <div className={dashStyles.cardMeta}>
              <span className={dashStyles.pill}>{s.nodeCount} nodes</span>
              <span className={dashStyles.pill}>{s.edgeCount} edges</span>
              <span className={dashStyles.pill}>{s.messageCount} msgs</span>
              {s.totalTokens > 0 && <span className={dashStyles.pill}>{(s.totalTokens / 1000).toFixed(1)}k tok</span>}
            </div>

            {/* Footer */}
            <div className={styles.smCardFooter}>
              <div className={dashStyles.cardStatus}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.enabled ? "#30d158" : "var(--m-border)", flexShrink: 0 }} />
                {s.enabled ? "Active" : "Disabled"} · {formatDate(s.updatedAt)}
              </div>
              <div className={styles.smCardActions} onClick={(e) => e.stopPropagation()}>
                <button className={`${dashStyles.btn} ${dashStyles.btnSmall} ${dashStyles.btnPrimary}`} onClick={() => handleOpen(s.id)}>Open</button>
                <button className={`${dashStyles.btn} ${dashStyles.btnSmall}`} onClick={() => setEditingId(s.id)} title="Rename">{"\u270E"}</button>
                <button className={`${dashStyles.btn} ${dashStyles.btnSmall}`} onClick={() => toggleSession(s.id)} title={s.enabled ? "Disable" : "Enable"}>
                  {s.enabled ? "\u23F8" : "\u25B6"}
                </button>
                <select
                  className={styles.smAutoSelect}
                  value={s.autonomous ? String(s.autonomousIntervalMs ?? 3600000) : "off"}
                  onChange={(e) => {
                    if (e.target.value === "off") setAutonomous(s.id, false);
                    else setAutonomous(s.id, true, parseInt(e.target.value));
                  }}
                  title="Autonomous mode"
                >
                  <option value="off">Manual</option>
                  {INTERVAL_PRESETS.map((p) => <option key={p.ms} value={p.ms}>{p.label}</option>)}
                </select>
                <button
                  className={`${dashStyles.btn} ${dashStyles.btnSmall}`}
                  onClick={() => handleDelete(s.id)}
                  style={confirmDelete === s.id ? { color: "var(--c-error)", borderColor: "var(--c-error)" } : {}}
                >
                  {confirmDelete === s.id ? "Sure?" : "\u2716"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
