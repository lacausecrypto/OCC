/**
 * BlueprintPanel — glass overlay for managing saved blueprints.
 * Rename, delete (double-check), usage stats, paste into canvas.
 */
import { useState, useRef, useEffect } from "react";
import { useBlueprintStore } from "../../stores/blueprints";
import { useCanvasStore } from "../../stores/canvas";
import { screenToCanvas } from "./canvasRenderer";
import styles from "./CanvasEditor.module.css";

interface BlueprintPanelProps {
  onClose: () => void;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  align?: "center" | "left";
}

export function BlueprintPanel({ onClose, canvasRef, align = "center" }: BlueprintPanelProps) {
  const blueprints = useBlueprintStore((s) => s.blueprints);
  const pasteBlueprint = useBlueprintStore((s) => s.pasteBlueprint);
  const renameBlueprint = useBlueprintStore((s) => s.renameBlueprint);
  const deleteBlueprint = useBlueprintStore((s) => s.deleteBlueprint);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editRef.current) editRef.current.focus();
  }, [editingId]);

  const handlePaste = (bpId: string) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const cam = useCanvasStore.getState().camera;
    const cw = rect?.width ?? 800;
    const ch = rect?.height ?? 600;
    const center = screenToCanvas(cw / 2, ch / 2, cam);

    const state = useCanvasStore.getState();
    state.pushUndo();

    const result = pasteBlueprint(bpId, center.x, center.y);
    if (!result) return;

    for (const node of result.nodes) state.addNode(node);
    for (const edge of result.edges) state.addEdge(edge);

    // Select the pasted nodes
    useCanvasStore.setState({ selection: new Set(result.nodes.map((n) => n.id)) });
  };

  const handleRename = (id: string) => {
    if (editName.trim()) {
      renameBlueprint(id, editName.trim());
    }
    setEditingId(null);
  };

  const handleDelete = (id: string) => {
    if (confirmDeleteId === id) {
      deleteBlueprint(id);
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(id);
      // Auto-reset after 3s
      setTimeout(() => setConfirmDeleteId((cur) => (cur === id ? null : cur)), 3000);
    }
  };

  const sorted = [...blueprints].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className={styles.bpPanel} style={align === "left" ? { left: 16, transform: "none" } : undefined}>
      <div className={styles.bpHeader}>
        <span className={styles.bpTitle}>Blueprints</span>
        <span className={styles.bpCount}>{blueprints.length}</span>
        <button className={styles.bpClose} onClick={onClose} title="Close">
          {"\u2715"}
        </button>
      </div>

      <div className={styles.bpBody}>
        {sorted.length === 0 && (
          <div className={styles.bpEmpty}>
            No blueprints yet.
            <br />
            <span style={{ opacity: 0.6, fontSize: "0.85em" }}>
              Right-click selected steps → Save as Blueprint
            </span>
          </div>
        )}

        {sorted.map((bp) => (
          <div key={bp.id} className={styles.bpCard}>
            <div className={styles.bpCardTop}>
              {editingId === bp.id ? (
                <input
                  ref={editRef}
                  className={styles.bpNameInput}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={() => handleRename(bp.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRename(bp.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <span
                  className={styles.bpName}
                  onDoubleClick={() => {
                    setEditingId(bp.id);
                    setEditName(bp.name);
                  }}
                  title="Double-click to rename"
                >
                  {bp.name}
                </span>
              )}
            </div>

            <div className={styles.bpMeta}>
              <span>{bp.nodes.length} step{bp.nodes.length > 1 ? "s" : ""}</span>
              <span>{bp.edges.length} edge{bp.edges.length > 1 ? "s" : ""}</span>
              <span>Used {bp.usageCount}×</span>
            </div>

            <div className={styles.bpActions}>
              <button
                className={styles.bpBtn}
                onClick={() => handlePaste(bp.id)}
                title="Paste into canvas"
              >
                {"\u2398"} Paste
              </button>
              <button
                className={styles.bpBtn}
                onClick={() => {
                  setEditingId(bp.id);
                  setEditName(bp.name);
                }}
                title="Rename"
              >
                {"\u270E"}
              </button>
              <button
                className={`${styles.bpBtn} ${confirmDeleteId === bp.id ? styles.bpBtnDanger : ""}`}
                onClick={() => handleDelete(bp.id)}
                title={confirmDeleteId === bp.id ? "Click again to confirm" : "Delete"}
              >
                {confirmDeleteId === bp.id ? "Confirm?" : "\u2716"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
