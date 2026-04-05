import { useMonitorStore } from "../../stores/monitor";
import { useCanvasStore } from "../../stores/canvas";
import { useCanvasExecStore } from "../../stores/canvasExec";
import { useAppStore } from "../../stores/app";
import type { StepResult } from "../../types/execution";
import styles from "./Monitor.module.css";

const DOT_CLASS: Record<string, string> = {
  running: styles.tlDotRunning,
  done: styles.tlDotDone,
  error: styles.tlDotError,
  pending: styles.tlDotPending,
  skipped: styles.tlDotSkipped,
  waiting: styles.tlDotWaiting,
};

function navigateToNode(stepId: string) {
  const canvasStore = useCanvasStore.getState();
  const execStore = useCanvasExecStore.getState();

  // Find the canvas node ID from the step→node mapping or direct match
  const nodeId = execStore.stepToNodeMap.get(stepId) ?? stepId;
  const node = canvasStore.nodes.get(nodeId);
  if (!node) return;

  // Center camera on the node
  const parentEl = document.querySelector("canvas")?.parentElement;
  const vw = parentEl?.clientWidth ?? 800;
  const vh = parentEl?.clientHeight ?? 600;
  useCanvasStore.setState({
    camera: {
      x: vw / 2 - node.x * 1 - node.w / 2,
      y: vh / 2 - node.y * 1 - node.h / 2,
      zoom: 1,
    },
    selection: new Set([nodeId]),
  });

  // Switch to canvas tab if not already there
  useAppStore.getState().setActiveTab("canvas");
}

export function Timeline() {
  const { executions, activeExecId } = useMonitorStore();

  const exec = activeExecId ? executions.get(activeExecId) : undefined;
  if (!exec?.steps) {
    return (
      <div className={styles.timeline}>
        <div className={styles.monEmpty} style={{ padding: 12 }}>
          Select an execution to view its timeline
        </div>
      </div>
    );
  }

  const steps = Object.entries(exec.steps) as [string, StepResult][];

  // Calculate running index for progress indicator
  const runningIdx = steps.findIndex(([, s]) => s.status === "running");

  return (
    <div className={styles.timeline}>
      {/* Chain/Pipeline name header */}
      <div className={styles.tlHeader}>
        <span className={styles.tlChainName}>{exec.chainName}</span>
        <span className={styles.tlStepCount}>
          {steps.filter(([, s]) => s.status === "done").length}/{steps.length}
        </span>
      </div>

      {steps.map(([stepId, step], idx) => {
        const dotClass = DOT_CLASS[step.status] ?? styles.tlDotPending;
        const isRunning = step.status === "running";
        const isClickable = true;

        let meta = step.status ?? "pending";
        if (step.durationMs) meta += ` \u00B7 ${(step.durationMs / 1000).toFixed(1)}s`;
        if (step.inputTokens)
          meta += ` \u00B7 ${step.inputTokens}\u2192${step.outputTokens ?? 0} tok`;
        if (step.error) meta += ` \u00B7 ${step.error.slice(0, 60)}`;

        return (
          <div
            key={stepId}
            className={`${styles.tlStep} ${isClickable ? styles.tlStepClickable : ""} ${isRunning ? styles.tlStepRunning : ""}`}
            onClick={() => navigateToNode(stepId)}
            title="Click to navigate to this step on the canvas"
          >
            {/* Connector line */}
            {idx > 0 && (
              <div
                className={styles.tlConnector}
                style={{
                  background: idx <= (runningIdx >= 0 ? runningIdx : steps.length)
                    ? "var(--m-accent)" : "var(--m-border)",
                }}
              />
            )}
            <div className={`${styles.tlDot} ${dotClass}`} />
            <div className={styles.tlInfo}>
              <div className={styles.tlLabel}>
                {stepId}
                <span className={styles.tlNav}>{"\u2192"}</span>
              </div>
              <div className={styles.tlMeta}>{meta}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
