/**
 * GitGraph — Rich tree visualization of the BLOB graph.
 * Shows core → branches → steps with expandable outputs, fork indicators, stats.
 */
import { useMemo, useState } from "react";
import { useBlobStore } from "../../stores/blob";
import type { BlobNode, BlobEdge } from "../../types/blob";
import styles from "./Blob.module.css";

function cssVar(name: string, fb: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
}

function getBranchColors(): string[] {
  return [
    cssVar("--icon-green", "#30d158"),
    cssVar("--icon-blue", "#0a84ff"),
    cssVar("--icon-purple", "#bf5af2"),
    cssVar("--icon-orange", "#ff9f0a"),
    cssVar("--icon-red", "#ff375f"),
    cssVar("--icon-cyan", "#64d2ff"),
    cssVar("--m-accent", "#ffd60a"),
    "#ff6482", "#ac8e68", "#00c7be",
  ];
}

// ─── Build tree ────────────────────────────────────────────────────────────

interface TreeNode {
  node: BlobNode;
  children: TreeNode[];
  color: string;
  depth: number;
  edgeType?: string;
}

function buildTree(nodes: Map<string, BlobNode>, edges: Map<string, BlobEdge>, branchColors: string[]): TreeNode | null {
  const core = [...nodes.values()].find((n) => n.type === "core");
  if (!core) return null;

  const childrenOf = new Map<string, Array<{ to: string; type: string }>>();
  for (const e of edges.values()) {
    // Only add edge if the "from" node actually exists
    if (nodes.has(e.from)) {
      const list = childrenOf.get(e.from) ?? [];
      list.push({ to: e.to, type: e.type });
      childrenOf.set(e.from, list);
    }
  }

  // Find orphan fork nodes (edge.from doesn't exist) and attach to parent branch
  const reachable = new Set<string>();
  const queue = [core.id];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const e of childrenOf.get(id) ?? []) queue.push(e.to);
  }

  // Orphan forks: nodes that exist but aren't reachable via edges
  for (const [id, node] of nodes) {
    if (reachable.has(id) || node.type !== "fork") continue;
    // Attach to parent branch if it exists
    const parentBranchId = node.data.kind === "fork" ? node.data.parentBranchId : null;
    if (parentBranchId && nodes.has(parentBranchId)) {
      // Find last step of that branch to attach fork
      let attachTo = parentBranchId;
      const visited = new Set<string>();
      while (true) {
        visited.add(attachTo);
        const next = (childrenOf.get(attachTo) ?? []).find((e) => !visited.has(e.to));
        if (!next) break;
        attachTo = next.to;
      }
      const list = childrenOf.get(attachTo) ?? [];
      list.push({ to: id, type: "fork" });
      childrenOf.set(attachTo, list);
    } else {
      // Attach to core as fallback
      const list = childrenOf.get(core.id) ?? [];
      list.push({ to: id, type: "fork" });
      childrenOf.set(core.id, list);
    }
  }

  let colorIdx = 0;
  const visited2 = new Set<string>();

  function walk(id: string, depth: number, parentColor: string, edgeType?: string): TreeNode | null {
    if (visited2.has(id)) return null;
    visited2.add(id);
    const node = nodes.get(id);
    if (!node) return null;

    let color = parentColor;
    if (node.type === "branch" || node.type === "fork") {
      color = branchColors[colorIdx % branchColors.length];
      colorIdx++;
    }

    const childEdges = childrenOf.get(id) ?? [];
    const children = childEdges
      .map((e) => walk(e.to, depth + 1, color, e.type))
      .filter((c): c is TreeNode => c !== null);

    return { node, children, color, depth, edgeType };
  }

  return walk(core.id, 0, cssVar("--m-accent", "#ffd60a"));
}

// ─── Flatten ───────────────────────────────────────────────────────────────

interface FlatRow {
  node: BlobNode;
  depth: number;
  color: string;
  isLast: boolean;
  childCount: number;
  edgeType?: string;
  isForkEdge: boolean;
}

function flattenTree(tree: TreeNode, collapsedIds: Set<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  function walk(t: TreeNode, isLast: boolean) {
    rows.push({
      node: t.node,
      depth: t.depth,
      color: t.color,
      isLast,
      childCount: t.children.length,
      edgeType: t.edgeType,
      isForkEdge: t.edgeType === "fork",
    });
    // Skip children if collapsed
    if (collapsedIds.has(t.node.id)) return;
    t.children.forEach((child, i) => walk(child, i === t.children.length - 1));
  }
  walk(tree, true);
  return rows;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

function getStatusBadge(): Record<string, { label: string; bg: string; fg: string }> {
  const success = cssVar("--c-success", "#30d158");
  const error = cssVar("--c-error", "#ff375f");
  const warning = cssVar("--c-warning", "#ff9f0a");
  const accent = cssVar("--m-accent", "#0a84ff");
  const mix = (c: string) => `color-mix(in srgb, ${c} 15%, transparent)`;
  return {
    idle: { label: "idle", bg: `color-mix(in srgb, var(--m-text2) 12%, transparent)`, fg: cssVar("--m-text2", "#86868b") },
    thinking: { label: "thinking", bg: mix(warning), fg: warning },
    running: { label: "running", bg: mix(accent), fg: accent },
    done: { label: "done", bg: mix(success), fg: success },
    error: { label: "error", bg: mix(error), fg: error },
  };
}

// ─── Component ─────────────────────────────────────────────────────────────

export function GitGraph({ onClose }: { onClose: () => void }) {
  const nodes = useBlobStore((s) => s.nodes);
  const edges = useBlobStore((s) => s.edges);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"all" | "done" | "running" | "idle">("all");

  const branchColors = useMemo(() => getBranchColors(), []);
  const tree = useMemo(() => buildTree(nodes, edges, branchColors), [nodes, edges, branchColors]);
  const rows = useMemo(() => tree ? flattenTree(tree, collapsed) : [], [tree, collapsed]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Totals
  const totals = useMemo(() => {
    let branches = 0, steps = 0, done = 0, forks = 0, inputTok = 0, outputTok = 0, durationMs = 0;
    for (const r of rows) {
      if (r.node.type === "branch") branches++;
      if (r.node.type === "step") steps++;
      if (r.node.type === "fork") forks++;
      if (r.node.status === "done") done++;
      if (r.node.data.kind === "step") {
        inputTok += r.node.data.inputTokens ?? 0;
        outputTok += r.node.data.outputTokens ?? 0;
        durationMs += r.node.data.durationMs ?? 0;
      }
    }
    return { branches, steps, done, forks, inputTok, outputTok, totalTok: inputTok + outputTok, durationMs };
  }, [rows]);

  return (
    <div className={styles.gitPanel}>
      {/* Header */}
      <div className={styles.gitHeader}>
        <div className={styles.gitTitle}>
          Graph
          <span className={styles.gitStats}>
            {totals.branches}b · {totals.steps}s · {totals.done}/{totals.steps} done
            {totals.forks > 0 && <> · {totals.forks}f</>}
            {" "} · {formatTokens(totals.totalTok)} tok · {formatDuration(totals.durationMs)}
          </span>
        </div>
        <button className={styles.gitCloseBtn} onClick={onClose}>{"\u2715"}</button>
      </div>

        {/* Toolbar */}
        <div className={styles.gitToolbar}>
          <div className={styles.gitFilters}>
            {(["all", "done", "running", "idle"] as const).map((f) => (
              <button
                key={f}
                className={`${styles.gitFilterBtn} ${filter === f ? styles.gitFilterBtnActive : ""}`}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <div className={styles.gitActions}>
            <button className={styles.gitActionBtn} onClick={() => setCollapsed(new Set())} title="Expand all">Expand all</button>
            <button className={styles.gitActionBtn} onClick={() => {
              const branchIds = rows.filter((r) => r.node.type === "branch" || r.node.type === "core").map((r) => r.node.id);
              setCollapsed(new Set(branchIds));
            }} title="Collapse branches">Collapse all</button>
            <button className={styles.gitActionBtn} onClick={() => {
              const allIds = rows.filter((r) => r.node.data.kind === "step" && (r.node.data as { output?: string }).output).map((r) => r.node.id);
              setExpanded((prev) => prev.size > 0 ? new Set() : new Set(allIds));
            }} title="Toggle outputs">
              {expanded.size > 0 ? "Hide outputs" : "Show outputs"}
            </button>
          </div>
        </div>

        {/* Body */}
        <div className={styles.gitBody}>
          {rows.length === 0 ? (
            <div className={styles.gitEmpty}>No nodes yet.</div>
          ) : (
            <div className={styles.gitGraph}>
              {rows.filter((row) => {
                if (filter === "all") return true;
                if (row.node.type === "core" || row.node.type === "branch") return true; // always show structure
                return row.node.status === filter;
              }).map((row) => {
                const d = row.node.data;
                const indent = row.depth * 22;
                const statusBadges = getStatusBadge();
                const sb = statusBadges[row.node.status] ?? statusBadges.idle;
                const hasOutput = d.kind === "step" && d.output && d.output.length > 0;
                const isExpanded = expanded.has(row.node.id);
                const isFork = row.node.type === "fork";
                const isCollapsible = row.childCount > 0 && (row.node.type === "branch" || row.node.type === "core");
                const isCollapsed = collapsed.has(row.node.id);

                return (
                  <div key={row.node.id} className={styles.gitRow}>
                    {/* Tree lines */}
                    <div className={styles.gitTree} style={{ width: indent + 22 }}>
                      {row.depth > 0 && (
                        <svg width={indent + 22} height={isExpanded ? 32 : 32} className={styles.gitSvg}>
                          <line
                            x1={indent - 8} y1={0}
                            x2={indent - 8} y2={row.isLast ? 16 : 32}
                            stroke={row.color} strokeWidth={1.5} opacity={0.5}
                            strokeDasharray={row.isForkEdge ? "4 3" : "none"}
                          />
                          <line
                            x1={indent - 8} y1={16}
                            x2={indent + 8} y2={16}
                            stroke={row.color} strokeWidth={1.5} opacity={0.5}
                            strokeDasharray={row.isForkEdge ? "4 3" : "none"}
                          />
                        </svg>
                      )}
                      <div
                        className={styles.gitDot}
                        style={{
                          left: indent + 5,
                          background: row.node.status === "done" ? row.color : isFork ? `${row.color}60` : "transparent",
                          borderColor: row.color,
                          width: row.node.type === "core" ? 12 : row.node.type === "branch" ? 10 : isFork ? 10 : 8,
                          height: row.node.type === "core" ? 12 : row.node.type === "branch" ? 10 : isFork ? 10 : 8,
                          borderStyle: isFork ? "dashed" : "solid",
                        }}
                      />
                    </div>

                    {/* Content */}
                    <div className={styles.gitInfo} style={{ flex: 1 }}>
                      {/* Main line */}
                      <div
                        className={styles.gitNodeLabel}
                        style={{ cursor: hasOutput ? "pointer" : "default" }}
                        onClick={() => hasOutput && toggleExpand(row.node.id)}
                      >
                        {isCollapsible && (
                          <span
                            className={styles.gitCollapseBtn}
                            onClick={(e) => { e.stopPropagation(); toggleCollapse(row.node.id); }}
                          >
                            {isCollapsed ? "\u25B6" : "\u25BC"}
                          </span>
                        )}
                        <span className={styles.gitNodeType} style={{ color: row.color }}>
                          {isFork ? "FORK" : row.node.type}
                        </span>
                        <span className={styles.gitNodeName}>{row.node.label}</span>
                        {isCollapsed && <span className={styles.gitCollapsedHint}>({row.childCount})</span>}
                        <span className={styles.gitBadge} style={{ background: sb.bg, color: sb.fg }}>
                          {sb.label}
                        </span>
                        {hasOutput && (
                          <span className={styles.gitExpandIcon}>{isExpanded ? "\u25BE" : "\u25B8"}</span>
                        )}
                      </div>

                      {/* Meta line */}
                      <div className={styles.gitNodeMeta}>
                        {d.kind === "step" && d.stepType && <span className={styles.gitTag}>{d.stepType}</span>}
                        {d.kind === "step" && d.durationMs != null && <span>{formatDuration(d.durationMs)}</span>}
                        {d.kind === "step" && d.inputTokens != null && (
                          <span>{formatTokens(d.inputTokens)} in · {formatTokens(d.outputTokens ?? 0)} out</span>
                        )}
                        {d.kind === "branch" && <span>{row.childCount} steps</span>}
                        {d.kind === "fork" && <span>from {d.parentBranchId.slice(-8)} · {d.reason}</span>}
                      </div>

                      {/* Expanded output */}
                      {isExpanded && hasOutput && d.kind === "step" && (
                        <div className={styles.gitOutput}>
                          {d.output}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
  );
}
