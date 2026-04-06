import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
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
  onHistory?: () => void;
  historyActive?: boolean;
}

// ─── Chain readiness validation ──────────────────────────────────────────────

interface ReadinessCheck {
  label: string;
  ok: boolean;
}

function useChainReadiness(): { ready: boolean; checks: ReadinessCheck[] } {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const serverOnline = useServerStore((s) => s.serverOnline);

  const nodeList = [...nodes.values()];

  const checks: ReadinessCheck[] = [
    { label: "Server online", ok: serverOnline },
    { label: "At least 1 step", ok: nodeList.length >= 1 },
    { label: "All steps have a prompt", ok: nodeList.length > 0 && nodeList.every((n) => n.prompt && n.prompt.trim() && !n.prompt.startsWith("TODO")) },
    { label: "All steps have an output variable", ok: nodeList.length > 0 && nodeList.every((n) => !!n.outputVar) },
    { label: "No disconnected steps (all wired)", ok: nodeList.length <= 1 || (() => {
      // Check that every non-root node has at least one incoming edge
      const hasIncoming = new Set<string>();
      const hasOutgoing = new Set<string>();
      for (const e of edges.values()) { hasIncoming.add(e.to); hasOutgoing.add(e.from); }
      // Root nodes: no incoming. Leaf nodes: no outgoing. Middle: both.
      // Valid if: at most 1 node has no incoming (the root), unless parallel roots
      const orphans = nodeList.filter((n) => !hasIncoming.has(n.id) && !hasOutgoing.has(n.id));
      return orphans.length <= 1; // Allow 1 orphan (single-node chain) but not multiple disconnected
    })() },
  ];

  return { ready: checks.every((c) => c.ok), checks };
}

// ─── Tooltip bubble ─────────────────────────────────────────────────────────

function ReadinessTooltip({ checks, visible, anchorRef }: {
  checks: ReadinessCheck[];
  visible: boolean;
  anchorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (visible && anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 8, left: rect.left + rect.width / 2 });
    }
  }, [visible, anchorRef]);

  if (!visible) return null;

  const allOk = checks.every((c) => c.ok);
  const failCount = checks.filter((c) => !c.ok).length;

  return createPortal(
    <div style={{
      position: "fixed",
      top: pos.top,
      left: pos.left,
      transform: "translateX(-50%)",
      background: "var(--glass-bg, rgba(30,30,32,0.82))",
      backdropFilter: "var(--glass-blur, blur(24px))",
      WebkitBackdropFilter: "var(--glass-blur, blur(24px))",
      border: "1px solid var(--glass-border, rgba(255,255,255,0.08))",
      borderRadius: "var(--m-radius, 14px)",
      boxShadow: "var(--glass-shadow, 0 8px 32px rgba(0,0,0,0.4))",
      padding: 0,
      minWidth: 250,
      zIndex: 9999,
      pointerEvents: "none",
      overflow: "hidden",
    }}>
      {/* Arrow */}
      <div style={{
        position: "absolute", top: -5, left: "50%", transform: "translateX(-50%) rotate(45deg)",
        width: 10, height: 10,
        background: "var(--glass-bg, rgba(30,30,32,0.82))",
        borderTop: "1px solid var(--glass-border, rgba(255,255,255,0.08))",
        borderLeft: "1px solid var(--glass-border, rgba(255,255,255,0.08))",
      }} />

      {/* Header */}
      <div style={{
        padding: "8px 14px",
        borderBottom: "1px solid var(--glass-border, rgba(255,255,255,0.06))",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--m-text2)", letterSpacing: 0.8, textTransform: "uppercase" }}>
          Chain Readiness
        </span>
        <span style={{
          fontSize: 9, fontWeight: 600, padding: "2px 7px", borderRadius: 6,
          background: allOk ? "rgba(48,209,88,0.15)" : "rgba(255,55,95,0.12)",
          color: allOk ? "#30d158" : "#ff375f",
        }}>
          {allOk ? "Ready" : `${failCount} issue${failCount > 1 ? "s" : ""}`}
        </span>
      </div>

      {/* Checks */}
      <div style={{ padding: "8px 10px" }}>
        {checks.map((c, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "4px 6px",
            borderRadius: 8,
            background: !c.ok ? "rgba(255,55,95,0.06)" : "transparent",
            marginBottom: 2,
          }}>
            <div style={{
              width: 18, height: 18, borderRadius: 9,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: c.ok ? "rgba(48,209,88,0.15)" : "rgba(255,55,95,0.12)",
              flexShrink: 0,
            }}>
              <span style={{ fontSize: 10, color: c.ok ? "#30d158" : "#ff375f", lineHeight: 1 }}>
                {c.ok ? "\u2713" : "\u2717"}
              </span>
            </div>
            <span style={{
              fontSize: 11,
              color: c.ok ? "var(--m-text2, rgba(255,255,255,0.45))" : "var(--m-text, rgba(255,255,255,0.9))",
              fontWeight: c.ok ? 400 : 600,
            }}>
              {c.label}
            </span>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

// ─── Main toolbar ───────────────────────────────────────────────────────────

export function CanvasToolbar({ onRun, onNew, onSave, onHistory, historyActive }: CanvasToolbarProps) {
  const { activeTool, setActiveTool, nodes } = useCanvasStore();
  const { pipelineName, pipelineViewMode, decomposeLayout, toggleDecompose, setDecomposeLayout } =
    useAppStore();
  const serverOnline = useServerStore((s) => s.serverOnline);
  const canvasExecId = useCanvasExecStore((s) => s.canvasExecId);

  const executions = useMonitorStore((s) => s.executions);
  const runningExec = canvasExecId ? executions.get(canvasExecId) : undefined;
  const isRunning = runningExec?.status === "running";

  const isEmpty = nodes.size === 0;
  const showDecompose = !!pipelineName;
  const isDecomposed = pipelineViewMode === "decomposed";

  const { ready, checks } = useChainReadiness();
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runBtnRef = useRef<HTMLDivElement>(null);

  // Auto-hide tooltip after 3s
  useEffect(() => {
    if (tooltipVisible) {
      const t = setTimeout(() => setTooltipVisible(false), 3000);
      return () => clearTimeout(t);
    }
  }, [tooltipVisible]);

  const handleRunClick = () => {
    if (ready) {
      onRun?.();
    } else {
      setTooltipVisible(true);
    }
  };

  const handleRunHover = () => {
    if (!ready && !isEmpty) {
      tooltipTimer.current = setTimeout(() => setTooltipVisible(true), 400);
    }
  };

  const handleRunLeave = () => {
    if (tooltipTimer.current) { clearTimeout(tooltipTimer.current); tooltipTimer.current = null; }
    setTooltipVisible(false);
  };

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

      {/* Run / Stop / New */}
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
        <div ref={runBtnRef} style={{ position: "relative", display: "inline-flex" }}
          onMouseEnter={handleRunHover}
          onMouseLeave={handleRunLeave}
        >
          <button
            className={`${styles.tbtn} ${ready ? styles.tbtnActive : ""}`}
            onClick={handleRunClick}
            style={{ opacity: ready ? 1 : 0.4, cursor: ready ? "pointer" : "default" }}
          >
            {"\u25B6"} Run
          </button>
          <ReadinessTooltip checks={checks} visible={tooltipVisible && !ready} anchorRef={runBtnRef} />
        </div>
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

      {/* History */}
      {!isEmpty && (useAppStore.getState().canvasChainName || pipelineName) && (
        <button
          className={`${styles.tbtn} ${historyActive ? styles.tbtnActive : ""}`}
          onClick={onHistory}
          disabled={!serverOnline}
          title="Version history"
          style={{ opacity: serverOnline ? 1 : 0.4 }}
        >
          {"\uD83D\uDD52"} History
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
