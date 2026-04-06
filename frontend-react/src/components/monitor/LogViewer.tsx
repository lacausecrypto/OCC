import { useRef, useEffect, useState, useMemo } from "react";
import { useMonitorStore } from "../../stores/monitor";
import { useCanvasStore } from "../../stores/canvas";
import { useCanvasExecStore } from "../../stores/canvasExec";
import { useAppStore } from "../../stores/app";
import { esc } from "../../utils/escape";
import type { ExecutionEvent } from "../../types/execution";
import styles from "./Monitor.module.css";

/* ─── Labels & colors matching original HTML ─── */
const TYPE_LABELS: Record<string, string> = {
  execution_started: "\u25B6 EXEC START",
  execution_done: "\u2713 EXEC DONE",
  execution_error: "\u2717 EXEC ERROR",
  step_started: "\u25B8 STEP START",
  step_done: "\u2713 STEP DONE",
  step_error: "\u2717 STEP ERROR",
  step_output: "  OUTPUT",
  step_log: "  LOG",
  step_cache_hit: "\u21BA CACHE HIT",
  step_waiting_approval: "\u23F8 GATE WAIT",
  gate_action: "\u26A1 GATE",
};

const LOG_COLORS: Record<string, string> = {
  execution_started: "var(--m-accent)",
  execution_done: "#30d158",
  execution_error: "#ff375f",
  step_started: "#64d2ff",
  step_done: "#30d158",
  step_error: "#ff375f",
  step_output: "#ffd60a",
  step_log: "var(--c-purple)",
  step_cache_hit: "#30d158",
  step_waiting_approval: "#ff9f0a",
  gate_action: "#ff9f0a",
};

const LOG_ENTRY_CLASS: Record<string, string> = {
  execution_started: styles.logExecutionStarted,
  execution_done: styles.logExecutionDone,
  execution_error: styles.logExecutionError,
  step_started: styles.logStepStarted,
  step_done: styles.logStepDone,
  step_error: styles.logStepError,
  step_output: styles.logStepOutput,
  step_log: styles.logStepLog,
  step_cache_hit: styles.logStepCacheHit,
  step_waiting_approval: styles.logStepWaitingApproval,
};

const EVENT_TYPES_FOR_FILTER = [
  "execution_started", "execution_done", "execution_error",
  "step_started", "step_done", "step_error",
  "step_output", "step_log",
  "step_cache_hit", "step_waiting_approval", "gate_action",
];

function getStepId(ev: ExecutionEvent): string | null {
  if ("stepId" in ev) return ev.stepId;
  return null;
}

function formatEventMessage(ev: ExecutionEvent): string {
  switch (ev.type) {
    case "step_output":
      return `${esc(ev.stepId)}: ${esc(ev.chunk.slice(0, 120))}`;
    case "step_log":
      return `${esc(ev.stepId)} [${esc(ev.level)}]: ${esc(ev.message)}`;
    case "step_started":
      return `${esc(ev.stepId)} "${esc(ev.label ?? "")}"`;
    case "step_done":
      return `${esc(ev.stepId)} (${ev.durationMs ? (ev.durationMs / 1000).toFixed(1) + "s" : "?"})`;
    case "step_error":
      return `${esc(ev.stepId)}: ${esc(ev.error)}`;
    case "execution_started":
      return `${esc(ev.chainName)} \u2192 ${esc(ev.executionId)}`;
    case "execution_done":
      return `${esc(ev.executionId)} (${ev.durationMs ? (ev.durationMs / 1000).toFixed(1) + "s" : "?"})`;
    case "execution_error":
      return `${esc(ev.executionId)}: ${esc(ev.error)}`;
    case "step_waiting_approval":
      return `${esc(ev.stepId)}: waiting for human approval`;
    case "step_cache_hit":
      return `${esc(ev.stepId)}: cache hit`;
    case "gate_action":
      return `${esc(ev.stepId)}: ${esc(ev.action)}${ev.reason ? ` (${esc(ev.reason)})` : ""}`;
    default:
      return JSON.stringify(ev).slice(0, 150);
  }
}

function navigateToNode(stepId: string) {
  const canvasStore = useCanvasStore.getState();
  const execStore = useCanvasExecStore.getState();
  const nodeId = execStore.stepToNodeMap.get(stepId) ?? stepId;
  const node = canvasStore.nodes.get(nodeId);
  if (!node) return;

  const parentEl = document.querySelector("canvas")?.parentElement;
  const vw = parentEl?.clientWidth ?? 800;
  const vh = parentEl?.clientHeight ?? 600;
  useCanvasStore.setState({
    camera: {
      x: vw / 2 - node.x - node.w / 2,
      y: vh / 2 - node.y - node.h / 2,
      zoom: 1,
    },
    selection: new Set([nodeId]),
  });
  useAppStore.getState().setActiveTab("canvas");
}

export function LogViewer() {
  const { events, executions, activeExecId, clearEvents } = useMonitorStore();
  const logRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [filterExecId, setFilterExecId] = useState<string | "all">("all");
  const [filterType, setFilterType] = useState<string | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Timestamps: track when each event was received
  const [timestamps, setTimestamps] = useState<string[]>([]);
  const prevEventCountRef = useRef(0);
  useEffect(() => {
    if (events.length > prevEventCountRef.current) {
      const now = new Date().toLocaleTimeString();
      setTimestamps(prev => {
        const next = [...prev];
        while (next.length < events.length) next.push(now);
        return next;
      });
    } else if (events.length === 0 && prevEventCountRef.current > 0) {
      setTimestamps([]);
    }
    prevEventCountRef.current = events.length;
  }, [events.length]);

  // Build list of unique execution IDs for filter dropdown
  const execIds = useMemo(() => {
    const ids = new Set<string>();
    for (const ev of events) {
      if (ev.executionId) ids.add(ev.executionId);
    }
    return [...ids];
  }, [events]);

  // Filter events
  const filteredEvents = useMemo(() => {
    let filtered = events;
    if (filterExecId !== "all") {
      filtered = filtered.filter((ev) => ev.executionId === filterExecId);
    }
    if (filterType !== "all") {
      filtered = filtered.filter((ev) => ev.type === filterType);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter((ev) => {
        const msg = formatEventMessage(ev).toLowerCase();
        return msg.includes(q);
      });
    }
    return filtered;
  }, [events, filterExecId, filterType, searchQuery]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [filteredEvents.length, autoScroll]);

  // Only render last 100 entries for readability
  const visibleEvents = filteredEvents.slice(-100);
  // Get exec names for the dropdown
  const getExecName = (id: string) => {
    const exec = executions.get(id);
    return exec ? `${exec.chainName} (${(id ?? "").slice(0, 8)})` : (id ?? "").slice(0, 12);
  };

  return (
    <>
      {/* Options row */}
      <div className={styles.monOpts}>
        <label className={styles.monCheck}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          Auto
        </label>
        <label className={styles.monCheck}>
          <input
            type="checkbox"
            checked={showTimestamps}
            onChange={(e) => setShowTimestamps(e.target.checked)}
          />
          Time
        </label>
        <button
          className={styles.btn}
          style={{ padding: "2px 6px", fontSize: "10px", marginLeft: "auto" }}
          onClick={clearEvents}
        >
          Clear
        </button>
      </div>

      {/* Filter row */}
      <div className={styles.logFilters}>
        <select
          className={styles.logFilterSelect}
          value={filterExecId}
          onChange={(e) => setFilterExecId(e.target.value)}
          title="Filter by execution"
        >
          <option value="all">All executions</option>
          {execIds.map((id) => (
            <option key={id} value={id}>{getExecName(id)}</option>
          ))}
        </select>
        <select
          className={styles.logFilterSelect}
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          title="Filter by event type"
        >
          <option value="all">All types</option>
          {EVENT_TYPES_FOR_FILTER.map((t) => (
            <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>
          ))}
        </select>
        <input
          className={styles.logSearch}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search..."
        />
      </div>

      {/* Log header */}
      <div className={styles.logHeader}>
        <span className={styles.sectionTitle} style={{ padding: 0 }}>
          Events
        </span>
        <span className={styles.eventCount}>
          {filteredEvents.length !== events.length
            ? `${filteredEvents.length}/${events.length}`
            : events.length}
        </span>
      </div>

      {/* Log stream */}
      <div ref={logRef} className={styles.log}>
        {visibleEvents.map((ev, i) => {
          const globalIdx = events.indexOf(ev);
          const entryClass = LOG_ENTRY_CLASS[ev.type] ?? "";
          const label = TYPE_LABELS[ev.type] ?? ev.type;
          const color = LOG_COLORS[ev.type] ?? "var(--m-text2)";
          const stepId = getStepId(ev);
          const isClickable = !!stepId;

          // Check if this event belongs to the active execution
          const isActiveExec = ev.executionId === activeExecId;

          return (
            <div
              key={`${globalIdx}-${i}`}
              className={`${styles.logEntry} ${entryClass} ${isClickable ? styles.logEntryClickable : ""} ${isActiveExec ? styles.logEntryActive : ""}`}
              onClick={isClickable ? () => navigateToNode(stepId!) : undefined}
              title={isClickable ? `Click to navigate to ${stepId} on canvas` : undefined}
            >
              {showTimestamps && (
                <span className={styles.logTime}>
                  {timestamps[globalIdx] ?? ""}
                </span>
              )}
              {/* Execution chain name badge for events not in active exec */}
              {!isActiveExec && ev.type === "execution_started" && (
                <span className={styles.logExecBadge}>
                  {esc((ev as { chainName: string }).chainName)}
                </span>
              )}
              <span className={styles.logType} style={{ color }}>
                {label}
              </span>
              {ev.executionId?.startsWith("blob_") && (
                <span style={{ fontSize: 9, padding: "1px 4px", borderRadius: 3, background: "#8b5cf6", color: "#fff", marginRight: 4, fontWeight: 600, letterSpacing: 0.5 }}>BLOB</span>
              )}
              <span className={styles.logMsg}>
                {formatEventMessage(ev)}
              </span>
              {isClickable && (
                <span className={styles.logGoIcon} title="Go to step">{"\u2192"}</span>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
