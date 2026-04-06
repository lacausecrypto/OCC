import { useMemo, useEffect, useState } from "react";
import { useMonitorStore } from "../../stores/monitor";
import { useAppStore } from "../../stores/app";
import { useCanvasExecStore } from "../../stores/canvasExec";
import { esc } from "../../utils/escape";
import type { ChainExecution, StepResult } from "../../types/execution";
import styles from "./Monitor.module.css";

function stepColor(status: string): string {
  switch (status) {
    case "done": return "#30d158";
    case "error": return "#ff375f";
    case "running": return "var(--m-accent)";
    case "waiting": return "#ff9f0a";
    default: return "var(--m-border)";
  }
}

function execStatusIcon(status: string): string {
  switch (status) {
    case "done": return "\u2713";
    case "error": return "\u2717";
    case "running": return "\u25B6";
    default: return "\u23F8";
  }
}

function execStatusColor(status: string): string {
  switch (status) {
    case "done": return "#30d158";
    case "error": return "#ff375f";
    case "running": return "var(--m-accent)";
    default: return "var(--m-text2)";
  }
}

/** Live elapsed timer for running executions */
function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const [elapsed, setElapsed] = useState("");
  useEffect(() => {
    const start = new Date(startedAt).getTime();
    const tick = () => {
      const ms = Date.now() - start;
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      setElapsed(m > 0 ? `${m}m ${s % 60}s` : `${s}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return <span className={styles.elapsedLive}>{elapsed}</span>;
}

interface ExecutionListProps {
  onOpenExecModal?: (execId: string) => void;
}

export function ExecutionList({ onOpenExecModal }: ExecutionListProps) {
  const { executions, activeExecId, setActiveExecId } = useMonitorStore();
  const pipelineName = useAppStore((s) => s.pipelineName);
  const canvasExecId = useCanvasExecStore((s) => s.canvasExecId);

  const sorted = useMemo(() => {
    return [...executions.values()].sort((a, b) =>
      (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
    );
  }, [executions]);

  if (sorted.length === 0) {
    return (
      <div className={styles.execList}>
        <div className={styles.monEmpty}>
          No active executions. Run a chain to see it here.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.execList}>
      {sorted.slice(0, 10).map((ex: ChainExecution) => {
        const steps = Object.values(ex.steps ?? {}) as StepResult[];
        const doneCount = steps.filter((s) => s.status === "done").length;
        const errorCount = steps.filter((s) => s.status === "error").length;
        const totalCount = steps.length;
        const progress = totalCount > 0 ? (doneCount + errorCount) / totalCount : 0;
        const isOnCanvas = ex.id === canvasExecId;
        const isActive = ex.id === activeExecId;

        // Token totals
        const totalInputTokens = steps.reduce((sum, s) => sum + (s.inputTokens ?? 0), 0);
        const totalOutputTokens = steps.reduce((sum, s) => sum + (s.outputTokens ?? 0), 0);

        return (
          <div
            key={ex.id}
            className={`${styles.execCard} ${isActive ? styles.execCardActive : ""} ${isOnCanvas ? styles.execCardOnCanvas : ""}`}
            onClick={() => setActiveExecId(ex.id)}
            onDoubleClick={() => onOpenExecModal?.(ex.id)}
            title="Click to select · Double-click for details"
          >
            {/* Header row: chain name + status badge */}
            <div className={styles.execHeader}>
              <div className={styles.execName}>
                {ex.id.startsWith("blob_") && <span style={{ fontSize: 10, marginRight: 4 }}>🧬</span>}
                {esc(ex.chainName ?? "?")}
              </div>
              <span
                className={styles.execBadge}
                style={{ background: execStatusColor(ex.status), color: "#fff" }}
              >
                {execStatusIcon(ex.status)} {ex.status}
              </span>
            </div>

            {/* Chain/Pipeline tag + on-canvas indicator */}
            <div className={styles.execTags}>
              {isOnCanvas && (
                <span className={styles.execTagCanvas} title="Currently displayed on canvas">
                  ON CANVAS
                </span>
              )}
              {pipelineName && ex.chainName === pipelineName && (
                <span className={styles.execTagPipeline}>PIPELINE</span>
              )}
              {ex.id.startsWith("blob_") ? (
                <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "#8b5cf6", color: "#fff", fontWeight: 600, letterSpacing: 0.5 }}>BLOB</span>
              ) : !pipelineName ? (
                <span className={styles.execTagChain}>CHAIN</span>
              ) : null}
            </div>

            {/* ID */}
            <div className={styles.execId}>{esc(ex.id)}</div>

            {/* Step indicators */}
            <div className={styles.execSteps}>
              {steps.map((s) => (
                <div
                  key={s.stepId}
                  className={styles.execStep}
                  style={{ background: stepColor(s.status) }}
                  title={`${esc(s.stepId)}: ${s.status}${s.durationMs ? ` (${(s.durationMs / 1000).toFixed(1)}s)` : ""}`}
                />
              ))}
            </div>

            {/* Progress bar */}
            {totalCount > 0 && (
              <div className={styles.execProgress}>
                <div
                  className={styles.execProgressFill}
                  style={{
                    width: `${progress * 100}%`,
                    background: errorCount > 0 ? "#ff375f" : "#30d158",
                  }}
                />
              </div>
            )}

            {/* Footer: stats */}
            <div className={styles.execFooter}>
              <span className={styles.execStat}>
                {doneCount}/{totalCount} steps
              </span>
              {totalInputTokens > 0 && (
                <span className={styles.execStat}>
                  {totalInputTokens.toLocaleString()}\u2192{totalOutputTokens.toLocaleString()} tok
                </span>
              )}
              {ex.status === "running" && ex.startedAt ? (
                <ElapsedTimer startedAt={ex.startedAt} />
              ) : ex.durationMs ? (
                <span className={styles.execStat}>
                  {(ex.durationMs / 1000).toFixed(1)}s
                </span>
              ) : null}
            </div>

            {/* Error message */}
            {ex.error && (
              <div style={{
                fontSize: 10, lineHeight: 1.3, padding: "4px 8px", marginTop: 4,
                background: "rgba(255, 55, 95, 0.08)", borderRadius: 6,
                color: "#ff375f", wordBreak: "break-word",
                border: "1px solid rgba(255, 55, 95, 0.15)",
              }}>
                {esc(ex.error.length > 120 ? ex.error.slice(0, 120) + "..." : ex.error)}
              </div>
            )}
          </div>
        );
      })}

    </div>
  );
}
