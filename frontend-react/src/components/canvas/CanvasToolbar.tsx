import { useCanvasStore } from "../../stores/canvas";
import { useAppStore } from "../../stores/app";
import { useServerStore } from "../../stores/server";
import { useMonitorStore } from "../../stores/monitor";
import { useCanvasExecStore } from "../../stores/canvasExec";
import { cancelExecution } from "../../api/executions";
import type { ActiveTool } from "../../types/canvas";
import styles from "./CanvasEditor.module.css";

const TOOLS: { id: ActiveTool; label: string }[] = [
  { id: "select", label: "Select" },
  { id: "pan", label: "Pan" },
  { id: "connect", label: "Connect" },
];

interface CanvasToolbarProps {
  onRun?: () => void;
  onNew?: () => void;
  onSave?: () => void;
}

export function CanvasToolbar({ onRun, onNew, onSave }: CanvasToolbarProps) {
  const { activeTool, setActiveTool, nodes } = useCanvasStore();
  const { pipelineName, pipelineViewMode, decomposeLayout, toggleDecompose, setDecomposeLayout } =
    useAppStore();
  const serverOnline = useServerStore((s) => s.serverOnline);
  const canvasExecId = useCanvasExecStore((s) => s.canvasExecId);

  // Check if there's a running execution on this canvas
  const executions = useMonitorStore((s) => s.executions);
  const runningExec = canvasExecId ? executions.get(canvasExecId) : undefined;
  const isRunning = runningExec?.status === "running";

  const isEmpty = nodes.size === 0;
  const showDecompose = !!pipelineName;
  const isDecomposed = pipelineViewMode === "decomposed";

  const handleStop = async () => {
    if (canvasExecId) {
      try { await cancelExecution(canvasExecId); } catch { /* ignore */ }
    }
  };

  return (
    <>
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={`${styles.tbtn} ${activeTool === t.id ? styles.tbtnActive : ""}`}
          onClick={() => setActiveTool(t.id)}
        >
          {t.label}
        </button>
      ))}

      <span className={styles.sep} />

      {/* Run / Stop */}
      {isEmpty ? (
        <button className={styles.tbtn} onClick={onNew} title="Create a new chain">
          + New
        </button>
      ) : isRunning ? (
        <button
          className={styles.tbtn}
          onClick={handleStop}
          title="Stop execution"
          style={{ color: "#ff375f" }}
        >
          {"\u25A0"} Stop
        </button>
      ) : (
        <button
          className={`${styles.tbtn} ${styles.tbtnActive}`}
          onClick={onRun}
          disabled={!serverOnline}
          title={serverOnline ? "Run chain" : "Server offline"}
          style={{ opacity: serverOnline ? 1 : 0.4 }}
        >
          {"\u25B6"} Run
        </button>
      )}

      {/* Save */}
      {!isEmpty && !pipelineName && (
        <button
          className={styles.tbtn}
          onClick={onSave}
          disabled={!serverOnline}
          title={serverOnline ? "Save chain (Ctrl+S)" : "Server offline"}
          style={{ opacity: serverOnline ? 1 : 0.4 }}
        >
          {"\uD83D\uDCBE"} Save
        </button>
      )}

      {showDecompose && (
        <>
          <span className={styles.sep} />
          <button
            className={`${styles.tbtn} ${isDecomposed ? styles.tbtnActive : ""}`}
            onClick={() => void toggleDecompose()}
          >
            {isDecomposed ? "Stages View" : "Decompose"}
          </button>
        </>
      )}

      {showDecompose && isDecomposed && (
        <>
          <span className={styles.sep} />
          <button
            className={`${styles.tbtn} ${decomposeLayout === "grid" ? styles.tbtnActive : ""}`}
            onClick={() => setDecomposeLayout("grid")}
          >
            Grid
          </button>
          <button
            className={`${styles.tbtn} ${decomposeLayout === "flow" ? styles.tbtnActive : ""}`}
            onClick={() => setDecomposeLayout("flow")}
          >
            Flow
          </button>
        </>
      )}
    </>
  );
}
