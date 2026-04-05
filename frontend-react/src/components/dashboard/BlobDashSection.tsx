/**
 * BlobDashSection — BLOB sessions overview in the main Dashboard.
 * Shows session cards with stats, quick actions, and create button.
 */
import { useState, useEffect } from "react";
import { useBlobStore } from "../../stores/blob";
import { useAppStore } from "../../stores/app";
import type { BlobSession } from "../../types/blob";
import styles from "./Dashboard.module.css";

const INTERVAL_LABELS: Record<number, string> = {
  900000: "15min", 3600000: "1h", 21600000: "6h", 86400000: "24h",
};

export function BlobDashSection() {
  const sessions = useBlobStore((s) => s.sessions);
  const createSession = useBlobStore((s) => s.createSession);
  const deleteSession = useBlobStore((s) => s.deleteSession);
  const setActiveSession = useBlobStore((s) => s.setActiveSession);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Sync with backend
  const [backendSessions, setBackendSessions] = useState<BlobSession[]>([]);
  useEffect(() => {
    fetch("/blobs").then((r) => r.ok ? r.json() : [])
      .then((data) => { if (Array.isArray(data)) setBackendSessions(data); })
      .catch(() => {});
  }, []);

  // Merge — prefer backend data when available
  const allSessions = sessions.length > 0 ? sessions : backendSessions;

  const handleCreate = () => {
    if (!newName.trim()) return;
    const id = createSession(newName.trim());
    fetch("/blobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim() }),
    }).catch(() => {});
    setCreating(false);
    setNewName("");
    setActiveSession(id);
    setActiveTab("blob");
  };

  const handleOpen = (id: string) => {
    useAppStore.getState().openBlobSession(id);
  };

  const handleDelete = (id: string) => {
    if (confirmDelete !== id) { setConfirmDelete(id); setTimeout(() => setConfirmDelete(null), 3000); return; }
    deleteSession(id);
    fetch(`/blobs/${id}`, { method: "DELETE" }).catch(() => {});
    setConfirmDelete(null);
  };

  if (allSessions.length === 0 && !creating) return null;

  return (
    <>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>
          BLOB Sessions
          <span className={styles.sectionCount}>{allSessions.length}</span>
        </h2>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setCreating(true)}>
          + New BLOB
        </button>
      </div>

      {creating && (
        <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center" }}>
          <input
            className={styles.btn}
            style={{ flex: 1, padding: "6px 12px", border: "1px solid var(--m-border)", background: "var(--m-bg)", color: "var(--m-text)", borderRadius: "var(--m-radius)", outline: "none" }}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder="BLOB name..."
            autoFocus
          />
          <button className={styles.btn} onClick={() => setCreating(false)}>Cancel</button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleCreate} disabled={!newName.trim()}>Create</button>
        </div>
      )}

      <div className={styles.cardGrid}>
        {allSessions.map((s) => (
          <div key={s.id} className={styles.card} onClick={() => handleOpen(s.id)} style={{ cursor: "pointer" }}>
            <div className={styles.cardName}>
              <span>{"\u{1F9EC}"}</span>
              {s.name}
              {s.autonomous && (
                <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: "rgba(48,209,88,0.15)", color: "#30d158", marginLeft: 4 }}>
                  AUTO {INTERVAL_LABELS[s.autonomousIntervalMs ?? 0] ?? ""}
                </span>
              )}
            </div>
            {s.description && <div className={styles.cardDesc}>{s.description}</div>}
            <div className={styles.cardMeta}>
              <span className={styles.pill}>{s.nodeCount} nodes</span>
              <span className={styles.pill}>{s.edgeCount} edges</span>
              <span className={styles.pill}>{s.messageCount} msgs</span>
              {s.totalTokens > 0 && <span className={styles.pill}>{(s.totalTokens / 1000).toFixed(1)}k tok</span>}
            </div>
            <div className={styles.cardBottom}>
              <div className={styles.cardStatus}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.enabled ? "#30d158" : "var(--m-border)", flexShrink: 0 }} />
                {s.enabled ? "Active" : "Disabled"}
                {" · "}{new Date(s.updatedAt).toLocaleDateString()}
              </div>
              <div className={styles.cardActions}>
                <button className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} onClick={(e) => { e.stopPropagation(); handleOpen(s.id); }}>Open</button>
                <button className={`${styles.btn} ${styles.btnSmall}`} onClick={(e) => { e.stopPropagation(); handleDelete(s.id); }} style={confirmDelete === s.id ? { color: "var(--c-error)", borderColor: "var(--c-error)" } : {}}>
                  {confirmDelete === s.id ? "Confirm?" : "\u2716"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
