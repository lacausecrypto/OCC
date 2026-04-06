/**
 * VersionPanel — git-like version history panel for chains/pipelines.
 * Glass-styled panel inside the canvas editor.
 * Features: timeline view, diff view, restore, delete, compare.
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import { useAppStore } from "../../stores/app";
import { fetchVersions, fetchVersion, deleteVersion, restoreVersion } from "../../api/versions";
import type { VersionMeta } from "../../api/versions";
import styles from "./CanvasEditor.module.css";

// ─── Diff algorithm (LCS-based, no external lib) ────────────────────────────

interface DiffLine {
  type: "add" | "remove" | "same";
  content: string;
}

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  // LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack
  const stack: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: "same", content: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: "add", content: newLines[j - 1] });
      j--;
    } else {
      stack.push({ type: "remove", content: oldLines[i - 1] });
      i--;
    }
  }
  return stack.reverse();
}

// ─── Time formatting ─────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

// ─── Main component ──────────────────────────────────────────────────────────

interface VersionPanelProps {
  onClose: () => void;
  onRestored?: () => void;
}

type PanelTab = "history" | "diff";

export function VersionPanel({ onClose, onRestored }: VersionPanelProps) {
  const canvasChainName = useAppStore((s) => s.canvasChainName);
  const pipelineName = useAppStore((s) => s.pipelineName);

  const entityType = pipelineName ? "pipeline" as const : "chain" as const;
  const entityName = pipelineName ?? canvasChainName;

  const [tab, setTab] = useState<PanelTab>("history");
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Diff state
  const [diffA, setDiffA] = useState<number | null>(null);
  const [diffB, setDiffB] = useState<number | null>(null);
  const [diffLines, setDiffLines] = useState<DiffLine[] | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  // Confirm states
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);

  // ─── Load versions ───────────────────────────────────────────

  const loadVersions = useCallback(async () => {
    if (!entityName) return;
    setLoading(true);
    try {
      const resp = await fetchVersions(entityType, entityName);
      setVersions(resp.versions);
      setTotal(resp.total);
    } catch { /* ignore */ }
    setLoading(false);
  }, [entityType, entityName]);

  useEffect(() => { void loadVersions(); }, [loadVersions]);

  // ─── Diff loading ────────────────────────────────────────────

  useEffect(() => {
    if (!entityName || diffA === null || diffB === null || diffA === diffB) {
      setDiffLines(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    Promise.all([
      fetchVersion(entityType, entityName, diffA),
      fetchVersion(entityType, entityName, diffB),
    ]).then(([vA, vB]) => {
      if (!cancelled) {
        setDiffLines(computeDiff(vA.yamlContent, vB.yamlContent));
        setTab("diff");
      }
    }).catch(() => {}).finally(() => { if (!cancelled) setDiffLoading(false); });
    return () => { cancelled = true; };
  }, [entityType, entityName, diffA, diffB]);

  // ─── Handlers ────────────────────────────────────────────────

  const handleRestore = async (vNum: number) => {
    if (!entityName) return;
    try {
      await restoreVersion(entityType, entityName, vNum);
      setConfirmRestore(null);
      await loadVersions();
      onRestored?.();
    } catch { /* ignore */ }
  };

  const handleDelete = async (vNum: number) => {
    if (!entityName) return;
    try {
      await deleteVersion(entityType, entityName, vNum);
      setConfirmDelete(null);
      await loadVersions();
    } catch { /* ignore */ }
  };

  const handleCompare = (vNum: number) => {
    // Compare with the version right after it (or latest)
    const idx = versions.findIndex((v) => v.versionNumber === vNum);
    const other = idx > 0 ? versions[idx - 1].versionNumber : versions[0]?.versionNumber;
    if (other && other !== vNum) {
      setDiffA(vNum);
      setDiffB(other);
    }
  };

  // ─── Diff stats ──────────────────────────────────────────────

  const diffStats = useMemo(() => {
    if (!diffLines) return null;
    const added = diffLines.filter((l) => l.type === "add").length;
    const removed = diffLines.filter((l) => l.type === "remove").length;
    return { added, removed };
  }, [diffLines]);

  // ─── Render ──────────────────────────────────────────────────

  if (!entityName) {
    return (
      <div className={styles.versionPanel}>
        <div className={styles.bpHeader}>
          <span className={styles.bpTitle}>History</span>
          <button className={styles.bpClose} onClick={onClose}>{"\u2715"}</button>
        </div>
        <div className={styles.bpEmpty}>Save a chain first to see version history.</div>
      </div>
    );
  }

  return (
    <div className={styles.versionPanel}>
      {/* Header */}
      <div className={styles.bpHeader}>
        <span className={styles.bpTitle}>History</span>
        <span className={styles.bpCount}>{total}</span>
        <button className={styles.bpClose} onClick={onClose}>{"\u2715"}</button>
      </div>

      {/* Tabs */}
      <div className={styles.vpTabs}>
        <button className={`${styles.vpTab} ${tab === "history" ? styles.vpTabActive : ""}`} onClick={() => setTab("history")}>
          Timeline
        </button>
        <button className={`${styles.vpTab} ${tab === "diff" ? styles.vpTabActive : ""}`} onClick={() => setTab("diff")}>
          Diff {diffA !== null && diffB !== null ? `v${diffA} \u2194 v${diffB}` : ""}
        </button>
      </div>

      {/* Body */}
      <div className={styles.bpBody}>
        {loading && <div className={styles.bpEmpty}>Loading...</div>}

        {tab === "history" && !loading && (
          <div className={styles.vpTimeline}>
            {versions.length === 0 && <div className={styles.bpEmpty}>No versions yet. Save to create the first one.</div>}
            {versions.map((v, i) => {
              const isLatest = i === 0;
              const isRestore = v.message?.startsWith("Restored from");
              const prevSteps = i < versions.length - 1 ? versions[i + 1].stepCount : null;
              const delta = v.stepCount != null && prevSteps != null ? v.stepCount - prevSteps : null;

              return (
                <div key={v.versionNumber} className={styles.vpRow}>
                  <div className={`${styles.vpDot} ${isLatest ? styles.vpDotLatest : ""} ${isRestore ? styles.vpDotRestore : ""}`} />
                  <div className={styles.vpInfo}>
                    <span className={styles.vpVersion}>v{v.versionNumber}</span>
                    <span className={styles.vpTime}>{timeAgo(v.createdAt)}</span>
                    {v.stepCount != null && <span style={{ fontSize: 10, opacity: 0.5 }}>{v.stepCount} steps</span>}
                    {delta != null && delta !== 0 && (
                      <span className={`${styles.vpDelta} ${delta > 0 ? styles.vpDeltaUp : styles.vpDeltaDown}`}>
                        {delta > 0 ? `+${delta}` : delta}
                      </span>
                    )}
                  </div>
                  {v.message && <div className={styles.vpMessage}>{v.message}</div>}

                  {/* Actions */}
                  <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                    {!isLatest && (
                      confirmRestore === v.versionNumber ? (
                        <>
                          <button className={`${styles.bpBtn} ${styles.bpBtnDanger}`} onClick={() => handleRestore(v.versionNumber)}>Confirm</button>
                          <button className={styles.bpBtn} onClick={() => setConfirmRestore(null)}>Cancel</button>
                        </>
                      ) : (
                        <button className={styles.bpBtn} onClick={() => setConfirmRestore(v.versionNumber)}>Restore</button>
                      )
                    )}
                    <button className={styles.bpBtn} onClick={() => handleCompare(v.versionNumber)}>Compare</button>
                    {versions.length > 1 && (
                      confirmDelete === v.versionNumber ? (
                        <>
                          <button className={`${styles.bpBtn} ${styles.bpBtnDanger}`} onClick={() => handleDelete(v.versionNumber)}>Confirm</button>
                          <button className={styles.bpBtn} onClick={() => setConfirmDelete(null)}>Cancel</button>
                        </>
                      ) : (
                        <button className={`${styles.bpBtn} ${styles.bpBtnDanger}`} onClick={() => setConfirmDelete(v.versionNumber)}>Delete</button>
                      )
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === "diff" && (
          <div>
            {/* Version selectors */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, fontSize: 11 }}>
              <select className={styles.vpDiffSelect} value={diffA ?? ""} onChange={(e) => setDiffA(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Select version A</option>
                {versions.map((v) => <option key={v.versionNumber} value={v.versionNumber}>v{v.versionNumber} — {timeAgo(v.createdAt)}</option>)}
              </select>
              <span style={{ color: "var(--m-text2)" }}>{"\u2194"}</span>
              <select className={styles.vpDiffSelect} value={diffB ?? ""} onChange={(e) => setDiffB(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Select version B</option>
                {versions.map((v) => <option key={v.versionNumber} value={v.versionNumber}>v{v.versionNumber} — {timeAgo(v.createdAt)}</option>)}
              </select>
            </div>

            {/* Diff stats */}
            {diffStats && (
              <div style={{ display: "flex", gap: 12, fontSize: 11, marginBottom: 8, color: "var(--m-text2)" }}>
                <span style={{ color: "var(--c-success)" }}>+{diffStats.added} added</span>
                <span style={{ color: "var(--c-error)" }}>-{diffStats.removed} removed</span>
              </div>
            )}

            {/* Diff output */}
            {diffLoading && <div className={styles.bpEmpty}>Computing diff...</div>}
            {!diffLoading && diffLines && (
              <div style={{ maxHeight: 400, overflowY: "auto", borderRadius: 8, border: "1px solid var(--m-border)" }}>
                {diffLines.map((line, idx) => (
                  <div
                    key={idx}
                    className={`${styles.vpDiffLine} ${
                      line.type === "add" ? styles.vpDiffAdd :
                      line.type === "remove" ? styles.vpDiffRemove :
                      styles.vpDiffSame
                    }`}
                  >
                    <span style={{ display: "inline-block", width: 14, textAlign: "center", opacity: 0.5, marginRight: 4 }}>
                      {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
                    </span>
                    {line.content}
                  </div>
                ))}
              </div>
            )}
            {!diffLoading && !diffLines && diffA === null && (
              <div className={styles.bpEmpty}>Select two versions to compare.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
