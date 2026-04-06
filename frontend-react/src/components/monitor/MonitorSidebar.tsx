import { useState } from "react";
import { createPortal } from "react-dom";
import { useSSE } from "../../hooks/useSSE";
import { useServerStore } from "../../stores/server";
import { useMonitorStore } from "../../stores/monitor";
import { useCanvasExecStore } from "../../stores/canvasExec";
import { ExecutionList } from "./ExecutionList";
import { Timeline } from "./Timeline";
import { LogViewer } from "./LogViewer";
import { GateApprovalPanel } from "./GateApprovalPanel";
import { ExecResultModal } from "../modals";
import styles from "./Monitor.module.css";

export function MonitorSidebar() {
  const { occServerUrl } = useServerStore();
  const { sseStatus, connectSSE, disconnectSSE } = useSSE();
  const [urlInput, setUrlInput] = useState(occServerUrl);
  const [modalExecId, setModalExecId] = useState<string | null>(null);

  const executions = useMonitorStore((s) => s.executions);
  const activeExecId = useMonitorStore((s) => s.activeExecId);
  const canvasExecId = useCanvasExecStore((s) => s.canvasExecId);
  const isConnected = sseStatus === "connected";
  const isReconnecting = sseStatus === "reconnecting";

  const statusDotClass = isConnected
    ? styles.statusConnected
    : isReconnecting
      ? styles.statusReconnecting
      : styles.statusDisconnected;

  const statusText = isConnected
    ? "Connected"
    : isReconnecting
      ? "Reconnecting..."
      : "Disconnected";

  // Quick stats
  const runningCount = [...executions.values()].filter((e) => e.status === "running").length;
  const doneCount = [...executions.values()].filter((e) => e.status === "done").length;
  const errorCount = [...executions.values()].filter((e) => e.status === "error").length;

  // Active exec info
  const activeExec = activeExecId ? executions.get(activeExecId) : undefined;
  const canvasExec = canvasExecId ? executions.get(canvasExecId) : undefined;
  const isViewingDifferentChain = canvasExecId && activeExecId && canvasExecId !== activeExecId;

  return (
    <>
      {/* Header */}
      <div className={styles.monHeader}>
        <span className={styles.monTitle}>Live Monitor</span>
        <div className={styles.monStatus}>
          <span className={`${styles.statusDot} ${statusDotClass}`} />
          <span>{statusText}</span>
        </div>
      </div>

      {/* Connect row */}
      <div className={styles.connectRow}>
        <input
          className={styles.connectInput}
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="http://localhost:4242"
        />
        {isConnected ? (
          <button className={styles.btn} onClick={disconnectSSE}>Stop</button>
        ) : (
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={connectSSE}>Connect</button>
        )}
      </div>

      {/* Quick stats bar */}
      {executions.size > 0 && (
        <div className={styles.quickStats}>
          {runningCount > 0 && (
            <span className={styles.qsStat}>
              <span className={styles.qsDot} style={{ background: "var(--m-accent)" }} />
              {runningCount} running
            </span>
          )}
          <span className={styles.qsStat}>
            <span className={styles.qsDot} style={{ background: "#30d158" }} />
            {doneCount} done
          </span>
          {errorCount > 0 && (
            <span className={styles.qsStat}>
              <span className={styles.qsDot} style={{ background: "#ff375f" }} />
              {errorCount} error
            </span>
          )}
        </div>
      )}

      {/* Context banner: only show when canvas has a RUNNING execution different from selected */}
      {isViewingDifferentChain && canvasExec && canvasExec.status === "running" && (
        <div className={styles.ctxBanner}>
          <span className={styles.ctxBannerIcon}>{"\u26A0"}</span>
          Running: <strong>{canvasExec.chainName}</strong>
          {activeExec && <> · Viewing: <strong>{activeExec.chainName}</strong></>}
        </div>
      )}

      {/* Gate approvals — auto-hides when empty */}
      <GateApprovalPanel />

      {/* Execution list */}
      <div className={styles.sectionTitle}>
        Executions
        <span className={styles.sectionBadge}>{executions.size}</span>
        {executions.size > 0 && (
          <button
            className={styles.sectionClearBtn}
            onClick={() => useMonitorStore.getState().clearExecutions()}
            title="Clear all executions"
          >
            Clear
          </button>
        )}
      </div>
      <ExecutionList onOpenExecModal={(id) => setModalExecId(id)} />

      {/* Timeline */}
      <div className={styles.sectionTitle}>
        Timeline
        {activeExec && (
          <span className={styles.sectionBadge}>{Object.keys(activeExec.steps ?? {}).length} steps</span>
        )}
      </div>
      <Timeline />

      {/* Log viewer (options + header + stream) */}
      <LogViewer />

      {/* Exec result modal — portal to body to escape sidebar overflow */}
      {modalExecId && createPortal(
        <ExecResultModal
          executionId={modalExecId}
          onClose={() => setModalExecId(null)}
        />,
        document.body,
      )}
    </>
  );
}
