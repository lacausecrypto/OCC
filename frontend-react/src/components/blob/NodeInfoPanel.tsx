/**
 * NodeInfoPanel — shared detail panel for selected blob nodes.
 * Used in both Blob view and Graph view.
 */
import { useBlobStore } from "../../stores/blob";
import styles from "./Blob.module.css";

interface Props {
  nodeId: string;
  onClose: () => void;
  onExecute?: (nodeId: string) => void;
}

export function NodeInfoPanel({ nodeId, onClose, onExecute }: Props) {
  const node = useBlobStore((s) => s.nodes.get(nodeId));
  if (!node) return null;

  const d = node.data;

  return (
    <div className={styles.nodeInfo}>
      <button className={styles.nodeInfoClose} onClick={onClose}>{"\u2715"}</button>
      <div className={styles.nodeInfoType}>{node.type.toUpperCase()}</div>
      <div className={styles.nodeInfoLabel}>{node.label}</div>

      {/* Status */}
      <div className={styles.nodeInfoStatus} data-status={node.status}>
        {node.status === "idle" ? "\u23F8 Idle" : node.status === "running" ? "\u25B6 Running" : node.status === "done" ? "\u2713 Done" : node.status === "thinking" ? "\u2026 Thinking" : "\u2717 Error"}
      </div>

      {/* Step details */}
      {d.kind === "step" && (
        <>
          <div className={styles.nodeInfoSection}>
            <span className={styles.nodeInfoSectionTitle}>Prompt</span>
            <div className={styles.nodeInfoCode}>{d.prompt}</div>
          </div>
          {d.output && (
            <div className={styles.nodeInfoSection}>
              <span className={styles.nodeInfoSectionTitle}>Output</span>
              <div className={styles.nodeInfoCode}>{d.output.slice(0, 800)}{d.output.length > 800 ? "..." : ""}</div>
            </div>
          )}
          <div className={styles.nodeInfoStats}>
            {d.durationMs != null && <span>{(d.durationMs / 1000).toFixed(1)}s</span>}
            {d.inputTokens != null && <span>{d.inputTokens} in</span>}
            {d.outputTokens != null && <span>{d.outputTokens} out</span>}
            {d.stepType && <span>{d.stepType}</span>}
            {d.model && <span>{d.model}</span>}
          </div>
        </>
      )}

      {/* Branch details */}
      {d.kind === "branch" && (
        <div className={styles.nodeInfoSection}>
          <span className={styles.nodeInfoSectionTitle}>Topic</span>
          <div className={styles.nodeInfoMeta}>{d.topic}</div>
          {d.summary && <div className={styles.nodeInfoMeta}>{d.summary}</div>}
        </div>
      )}

      {/* Core — message count */}
      {d.kind === "core" && (
        <div className={styles.nodeInfoMeta}>{d.messages.length} messages</div>
      )}

      {/* Memory details */}
      {d.kind === "memory" && (
        <div className={styles.nodeInfoSection}>
          <span className={styles.nodeInfoSectionTitle}>Concept: {d.concept}</span>
          <ul className={styles.nodeInfoFacts}>
            {d.facts.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        </div>
      )}

      {/* Fork details */}
      {d.kind === "fork" && (
        <div className={styles.nodeInfoSection}>
          <span className={styles.nodeInfoSectionTitle}>Fork</span>
          <div className={styles.nodeInfoMeta}>From: {d.parentBranchId.slice(-12)}</div>
          <div className={styles.nodeInfoMeta}>Reason: {d.reason}</div>
        </div>
      )}

      {/* Actions */}
      {onExecute && d.kind === "step" && node.status === "idle" && (
        <button className={styles.nodeInfoBtn} onClick={() => onExecute(node.id)}>
          {"\u25B6"} Execute
        </button>
      )}
      {onExecute && d.kind === "step" && node.status === "done" && (
        <button className={styles.nodeInfoBtn} onClick={() => { useBlobStore.getState().updateNode(node.id, { status: "idle" }); onExecute(node.id); }}>
          {"\u21BA"} Re-run
        </button>
      )}
    </div>
  );
}
