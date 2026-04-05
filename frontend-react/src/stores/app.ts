/**
 * Global app actions store — bridges cross-component interactions.
 * Provides: tab switching, canvas loading, SSE auto-connect, execution tracking.
 */

import { create } from "zustand";
import { useCanvasStore } from "./canvas";
import { useServerStore } from "./server";
import { useCanvasExecStore } from "./canvasExec";
import { useMonitorStore } from "./monitor";
import { useAnnotationStore } from "./annotations";
import { fetchChainJson } from "../api/chains";
import { fetchPipelineJson } from "../api/pipelines";
import type { TabId } from "../components/layout/MainTabs";
import { useBlobStore } from "./blob";
import type { CanvasNode, CanvasEdge } from "../types/canvas";
import type { ChainStep, PipelineChainRef } from "../types/chain";
import { computeZoomToFit } from "../components/canvas/canvasRenderer";

let nextId = 1;
function uid() {
  return `s${nextId++}`;
}
function eid() {
  return `e${nextId++}`;
}

/** Switch to canvas tab and defer zoom-to-fit to next frame */
function switchToCanvasAndFit(setFn: (p: Partial<AppState>) => void): void {
  setFn({ activeTab: "canvas" });
  requestAnimationFrame(() => {
    const canvasEl = document.querySelector("canvas");
    if (canvasEl) {
      const parentW = canvasEl.parentElement?.clientWidth ?? 800;
      const parentH = canvasEl.parentElement?.clientHeight ?? 600;
      const cam = computeZoomToFit(useCanvasStore.getState().nodes, parentW, parentH);
      useCanvasStore.setState({ camera: cam });
    }
  });
}

interface DecomposeGroup {
  chain: string;
  order: number;
  isHeader: boolean;
}

interface AppState {
  activeTab: TabId;
  /** Name of the chain currently loaded in canvas (null if new/unsaved) */
  canvasChainName: string | null;
  pipelineName: string | null;
  pipelineViewMode: "stages" | "decomposed";
  decomposeLayout: "grid" | "flow";
  decomposeGroups: Map<string, DecomposeGroup>;
  canvasLoading: boolean;

  setActiveTab: (tab: TabId) => void;

  /** Load a chain into the canvas (fetches from server, switches tab) */
  loadChainToCanvas: (name: string, serverUrl?: string) => Promise<void>;

  /** Load a pipeline stages view into canvas */
  loadPipelineToCanvas: (name: string) => Promise<void>;

  /** Decompose a pipeline (expand all chains) */
  loadPipelineDecomposed: (name: string) => Promise<void>;

  /** Toggle decompose <-> stages */
  toggleDecompose: () => Promise<void>;

  /** Set decompose layout mode */
  setDecomposeLayout: (layout: "grid" | "flow") => void;

  /** Re-apply auto layout to current canvas nodes */
  autoLayout: () => void;

  /** Create a new blank chain with 3 template nodes */
  createNewChain: () => void;

  /** Execute and track: connect SSE, switch to canvas, set up execution tracking */
  startExecution: (executionId: string, name: string, type: "chain" | "pipeline") => Promise<void>;

  /** Open a BLOB session — switch to blob tab and load session */
  openBlobSession: (sessionId: string) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  activeTab: "dashboard",
  canvasChainName: null,
  pipelineName: null,
  pipelineViewMode: "stages",
  decomposeLayout: "grid",
  decomposeGroups: new Map(),
  canvasLoading: false,

  setActiveTab: (tab) => set({ activeTab: tab }),

  // ─── Load chain into canvas ──────────────────────────────────
  loadChainToCanvas: async (name, serverUrl = useServerStore.getState().occServerUrl) => {
    if (get().canvasLoading) return;
    set({ canvasLoading: true, canvasChainName: name, pipelineName: null, pipelineViewMode: "stages" });

    // Switch annotations to this chain
    useAnnotationStore.getState().setCanvasKey(`chain:${name}`);

    // Clear canvas + execution state
    const cs = useCanvasStore.getState();
    cs.clear();
    useCanvasExecStore.getState().clearExecState();

    try {
      const data = await fetchChainJson(name, serverUrl);
      const steps = data.steps ?? [];
      if (steps.length === 0) return;

      const nodes = new Map<string, CanvasNode>();
      const edges = new Map<string, CanvasEdge>();
      const stepNodeMap: Record<string, string> = {};

      steps.forEach((step: ChainStep, i: number) => {
        const type = step.type ?? "agent";
        const label = step.label ?? step.id ?? `Step ${i + 1}`;
        const col = i % 3;
        const row = Math.floor(i / 3);
        const id = uid();
        const w = type === "router" || type === "gate" ? 200 : Math.max(220, Math.min(320, label.length * 7 + 80));
        const h = type === "router" ? 80 : type === "gate" ? 70 : 64;

        nodes.set(id, {
          id,
          x: 100 + col * 280,
          y: 100 + row * 170,
          w,
          h,
          type,
          label,
          model: step.model,
          preTools: step.pre_tools ?? [],
          tools: step.tools ?? [],
          outputVar: step.output_var ?? `step_${i}_out`,
          stepId: step.id ?? "",
          prompt: step.prompt ?? "",
          advanced: {
            retry: step.retry, fallback_models: step.fallback_models,
            timeout_ms: step.timeout_ms, cwd: step.cwd, cache: step.cache,
            output_schema: step.output_schema, output_must_contain: step.output_must_contain,
            output_must_not_contain: step.output_must_not_contain, output_max_length: step.output_max_length,
            context_strategy: step.context_strategy, early_exit_if: step.early_exit_if, condition: step.condition,
            timeout_hours: step.timeout_hours, on_timeout: step.on_timeout,
            gate_actions: step.gate_actions, gate_auto_approve_if: step.gate_auto_approve_if,
            gate_rejection_reason: step.gate_rejection_reason,
            routes: step.routes, default_route: step.default_route,
            input_var: step.input_var, criteria: step.criteria, on_fail: step.on_fail,
            max_retries: step.max_retries, retry_target: step.retry_target,
            eval_scoring: step.eval_scoring, eval_threshold: step.eval_threshold,
            operation: step.operation, json_path: step.json_path, regex: step.regex,
            template_str: step.template_str, truncate_limit: step.truncate_limit,
            items_var: step.items_var, max_parallel: step.max_parallel,
            loop_until: step.loop_until, loop_on_error: step.loop_on_error,
            inputs: step.inputs, strategy: step.strategy,
            browser_url: step.browser_url, browser_task: step.browser_task,
            browser_max_steps: step.browser_max_steps, browser_headless: step.browser_headless,
            browser_viewport: step.browser_viewport, browser_wait_ms: step.browser_wait_ms,
            browser_output_format: step.browser_output_format,
            subchain: step.subchain, subchain_input_map: step.subchain_input_map,
            debate_agents: step.debate_agents, debate_rounds: step.debate_rounds,
            debate_decision: step.debate_decision,
            webhook_url: step.webhook_url ?? step.url, webhook_method: step.webhook_method,
            webhook_headers: step.webhook_headers, webhook_body: step.webhook_body,
            webhook_timeout_ms: step.webhook_timeout_ms, webhook_retry: step.webhook_retry,
            guardrails: step.guardrails,
          },
        });
        stepNodeMap[step.id ?? `step_${i}`] = id;
      });

      // Wire edges — respect explicit depends_on DAG
      // Only fallback to sequential if NO step in the chain uses depends_on
      const hasAnyDeps = steps.some((s) => s.depends_on && s.depends_on.length > 0);

      steps.forEach((step: ChainStep, i: number) => {
        const targetId = stepNodeMap[step.id ?? `step_${i}`];
        if (!targetId) return;

        if (step.depends_on && step.depends_on.length > 0) {
          // Explicit dependencies
          for (const dep of step.depends_on) {
            const srcId = stepNodeMap[dep];
            if (srcId) {
              const edgeId = eid();
              edges.set(edgeId, { id: edgeId, from: srcId, to: targetId });
            }
          }
        } else if (!hasAnyDeps && i > 0) {
          // No depends_on anywhere → pure linear chain, connect sequentially
          const prevKey = steps[i - 1].id ?? `step_${i - 1}`;
          const srcId = stepNodeMap[prevKey];
          if (srcId) {
            const edgeId = eid();
            edges.set(edgeId, { id: edgeId, from: srcId, to: targetId });
          }
        }
        // If chain uses depends_on but this step has none → it's a root node (parallel start)
      });

      // Apply smart DAG layout
      applySimpleLayout(nodes, edges);
      useCanvasStore.setState({ nodes, edges, selection: new Set() });

      // Build step→node map for execution tracking
      const mapping: Record<string, string> = {};
      for (const [stepKey, nodeId] of Object.entries(stepNodeMap)) {
        mapping[stepKey] = nodeId;
      }
      useCanvasExecStore.getState().buildStepToNodeMap(mapping);

      switchToCanvasAndFit(set);
    } catch (err) {
      console.error("[OCC] loadCanvas failed:", err);
    } finally {
      set({ canvasLoading: false });
    }
  },

  // ─── Load pipeline stages view ───────────────────────────────
  loadPipelineToCanvas: async (name) => {
    if (get().canvasLoading) return;
    set({ canvasLoading: true, pipelineName: name, pipelineViewMode: "stages" });

    useAnnotationStore.getState().setCanvasKey(`pipeline:${name}`);

    const cs = useCanvasStore.getState();
    cs.clear();
    useCanvasExecStore.getState().clearExecState();

    try {
      const data = await fetchPipelineJson(name);
      const stages: PipelineChainRef[] = data.chains ?? [];
      if (stages.length === 0) return;

      const nodes = new Map<string, CanvasNode>();
      const edges = new Map<string, CanvasEdge>();
      const stageNodeMap: Record<string, string> = {};
      const cols = Math.min(stages.length, 4);

      stages.forEach((stage, i) => {
        const id = uid();
        nodes.set(id, {
          id,
          x: 100 + (i % cols) * 280,
          y: 100 + Math.floor(i / cols) * 140,
          w: 220,
          h: 80,
          type: "subchain",
          label: stage.label ?? stage.chain ?? `Stage ${i + 1}`,
          model: "pipeline-stage",
          preTools: [],
          tools: [],
          outputVar: stage.id ?? `stage_${i}`,
          stepId: stage.id ?? `stage_${i}`,
          prompt: `Chain: ${stage.chain ?? "?"}`,
        });
        stageNodeMap[stage.id ?? `stage_${i}`] = id;
      });

      // Wire edges
      stages.forEach((stage, i) => {
        const tid = stageNodeMap[stage.id ?? `stage_${i}`];
        const deps = stage.depends_on ?? (i > 0 ? [stages[i - 1].id ?? `stage_${i - 1}`] : []);
        for (const dep of deps) {
          const sid = stageNodeMap[dep];
          if (sid && tid) {
            const id = eid();
            edges.set(id, { id, from: sid, to: tid });
          }
        }
      });

      useCanvasStore.setState({ nodes, edges, selection: new Set() });
      set({ activeTab: "canvas" });

      requestAnimationFrame(() => {
        const canvas = document.querySelector("canvas");
        if (canvas) {
          const parentW = canvas.parentElement?.clientWidth ?? 800;
          const parentH = canvas.parentElement?.clientHeight ?? 600;
          const cam = computeZoomToFit(useCanvasStore.getState().nodes, parentW, parentH);
          useCanvasStore.setState({ camera: cam });
        }
      });
    } catch (err) {
      console.error("[OCC] loadCanvas failed:", err);
    } finally {
      set({ canvasLoading: false });
    }
  },

  // ─── Decompose pipeline ──────────────────────────────────────
  loadPipelineDecomposed: async (name) => {
    if (get().canvasLoading) return;
    set({ canvasLoading: true, pipelineName: name, pipelineViewMode: "decomposed" });

    useAnnotationStore.getState().setCanvasKey(`pipeline-decomposed:${name}`);

    const cs = useCanvasStore.getState();
    cs.clear();
    useCanvasExecStore.getState().clearExecState();

    try {
      const data = await fetchPipelineJson(name);
      const stages: PipelineChainRef[] = data.chains ?? [];
      if (stages.length === 0) return;

      // Fetch ALL chain definitions in parallel
      const chainDataMap: Record<string, ChainStep[]> = {};
      const fetches = stages
        .filter((s) => s.chain)
        .map(async (stage) => {
          try {
            const chainData = await fetchChainJson(stage.chain, useServerStore.getState().occServerUrl);
            if (chainData.steps) chainDataMap[stage.chain] = chainData.steps;
          } catch {
            /* skip */
          }
        });
      await Promise.all(fetches);

      const nodes = new Map<string, CanvasNode>();
      const edges = new Map<string, CanvasEdge>();
      const groups = new Map<string, DecomposeGroup>();
      const stageFirstNodeIds: Record<string, string> = {};
      const stageLastNodeIds: Record<string, string> = {};
      let globalOrder = 0;

      for (let si = 0; si < stages.length; si++) {
        const stage = stages[si];
        const chainName = stage.chain ?? `stage_${si}`;

        // Header node
        const headerId = uid();
        nodes.set(headerId, {
          id: headerId,
          x: 0,
          y: 0,
          w: 220,
          h: 50,
          type: "subchain",
          label: stage.label ?? chainName,
          model: "pipeline-stage",
          preTools: [],
          tools: [],
          outputVar: stage.id ?? `stage_${si}`,
          stepId: stage.id ?? `stage_${si}`,
          prompt: stage.condition ? `Condition: ${stage.condition}` : "",
        });
        groups.set(headerId, { chain: chainName, order: globalOrder++, isHeader: true });
        stageFirstNodeIds[stage.id ?? `stage_${si}`] = headerId;

        const chainSteps = chainDataMap[chainName] ?? [];
        let prevNodeId = headerId;

        for (let i = 0; i < chainSteps.length; i++) {
          const step = chainSteps[i];
          const type = step.type ?? "agent";
          const label = step.label ?? step.id ?? `${type} ${i + 1}`;
          const nodeId = uid();
          const w = type === "router" || type === "gate" ? 200 : Math.max(220, Math.min(320, label.length * 7 + 80));
          const h = type === "router" ? 80 : type === "gate" ? 70 : 64;

          nodes.set(nodeId, {
            id: nodeId,
            x: 0,
            y: 0,
            w,
            h,
            type,
            label,
            model: step.model,
            preTools: step.pre_tools ?? [],
            tools: step.tools ?? [],
            outputVar: step.output_var ?? `${chainName}_step${i}`,
            stepId: step.id ?? "",
            prompt: step.prompt ?? "",
            advanced: {
              retry: step.retry, fallback_models: step.fallback_models,
              timeout_ms: step.timeout_ms, cwd: step.cwd, cache: step.cache,
              context_strategy: step.context_strategy, early_exit_if: step.early_exit_if,
              condition: step.condition,
              timeout_hours: step.timeout_hours, on_timeout: step.on_timeout,
              gate_actions: step.gate_actions, gate_auto_approve_if: step.gate_auto_approve_if,
              routes: step.routes, default_route: step.default_route,
              input_var: step.input_var, criteria: step.criteria, on_fail: step.on_fail,
              operation: step.operation, json_path: step.json_path,
              items_var: step.items_var, max_parallel: step.max_parallel,
              inputs: step.inputs, strategy: step.strategy,
              browser_url: step.browser_url, browser_task: step.browser_task,
              browser_max_steps: step.browser_max_steps, browser_headless: step.browser_headless,
              subchain: step.subchain, subchain_input_map: step.subchain_input_map,
              debate_agents: step.debate_agents, debate_rounds: step.debate_rounds,
              debate_decision: step.debate_decision,
              webhook_url: step.webhook_url ?? step.url, webhook_method: step.webhook_method,
              webhook_headers: step.webhook_headers, webhook_body: step.webhook_body,
              guardrails: step.guardrails,
            },
          });

          groups.set(nodeId, { chain: chainName, order: globalOrder++, isHeader: false });

          // Edges
          if (step.depends_on && step.depends_on.length > 0) {
            // Wire to explicit deps (within chain — would need stepNodeMap)
            // Fallback: wire to previous
            const edgeId = eid();
            edges.set(edgeId, { id: edgeId, from: prevNodeId, to: nodeId });
          } else {
            const edgeId = eid();
            edges.set(edgeId, { id: edgeId, from: prevNodeId, to: nodeId });
          }
          prevNodeId = nodeId;
        }
        stageLastNodeIds[stage.id ?? `stage_${si}`] = prevNodeId;
      }

      // Inter-stage dependencies
      stages.forEach((stage, i) => {
        const firstId = stageFirstNodeIds[stage.id ?? `stage_${i}`];
        const deps = stage.depends_on ?? [];
        for (const dep of deps) {
          const lastId = stageLastNodeIds[dep];
          if (lastId && firstId) {
            const id = eid();
            edges.set(id, { id, from: lastId, to: firstId });
          }
        }
      });

      useCanvasStore.setState({ nodes, edges, selection: new Set() });
      set({ decomposeGroups: groups });

      // Apply layout based on current mode
      const layout = get().decomposeLayout;
      if (layout === "flow") {
        applyFlowLayout(nodes, edges, groups);
      } else {
        applySimpleLayout(nodes, edges);
      }
      useCanvasStore.setState({ nodes: new Map(nodes) });

      set({ activeTab: "canvas" });

      requestAnimationFrame(() => {
        const canvas = document.querySelector("canvas");
        if (canvas) {
          const parentW = canvas.parentElement?.clientWidth ?? 800;
          const parentH = canvas.parentElement?.clientHeight ?? 600;
          const cam = computeZoomToFit(useCanvasStore.getState().nodes, parentW, parentH);
          useCanvasStore.setState({ camera: cam });
        }
      });
    } catch {
      // decompose failed
    } finally {
      set({ canvasLoading: false });
    }
  },

  // Toggle decompose ↔ stages
  toggleDecompose: async () => {
    const { pipelineName, pipelineViewMode } = get();
    if (!pipelineName) return;
    if (pipelineViewMode === "stages") {
      await get().loadPipelineDecomposed(pipelineName);
    } else {
      await get().loadPipelineToCanvas(pipelineName);
    }
  },

  setDecomposeLayout: (layout) => {
    set({ decomposeLayout: layout });
    // Re-apply layout with correct algorithm
    const nodes = useCanvasStore.getState().nodes;
    const edges = useCanvasStore.getState().edges;
    const groups = get().decomposeGroups;
    if (layout === "flow") {
      applyFlowLayout(nodes, edges, groups);
    } else {
      applySimpleLayout(nodes, edges);
    }
    useCanvasStore.setState({ nodes: new Map(nodes) });

    // Zoom to fit after layout
    requestAnimationFrame(() => {
      const canvasEl = document.querySelector("canvas");
      if (canvasEl) {
        const parentW = canvasEl.parentElement?.clientWidth ?? 800;
        const parentH = canvasEl.parentElement?.clientHeight ?? 600;
        const cam = computeZoomToFit(useCanvasStore.getState().nodes, parentW, parentH);
        useCanvasStore.setState({ camera: cam });
      }
    });
  },

  // ─── Auto layout current canvas ───────────────────────────────
  autoLayout: () => {
    const nodes = useCanvasStore.getState().nodes;
    const edges = useCanvasStore.getState().edges;
    if (nodes.size === 0) return;

    const groups = get().decomposeGroups;
    if (get().decomposeLayout === "flow" && groups.size > 0) {
      applyFlowLayout(nodes, edges, groups);
    } else {
      applySimpleLayout(nodes, edges);
    }
    useCanvasStore.setState({ nodes: new Map(nodes) });

    requestAnimationFrame(() => {
      const canvasEl = document.querySelector("canvas");
      if (canvasEl) {
        const parentW = canvasEl.parentElement?.clientWidth ?? 800;
        const parentH = canvasEl.parentElement?.clientHeight ?? 600;
        const cam = computeZoomToFit(useCanvasStore.getState().nodes, parentW, parentH);
        useCanvasStore.setState({ camera: cam });
      }
    });
  },

  // ─── Create new blank chain ──────────────────────────────────
  createNewChain: () => {
    useAnnotationStore.getState().setCanvasKey(`new-chain:${Date.now()}`);
    const cs = useCanvasStore.getState();
    cs.clear();
    useCanvasExecStore.getState().clearExecState();
    set({ canvasChainName: null, pipelineName: null, pipelineViewMode: "stages", activeTab: "canvas" });

    const n1 = uid(), n2 = uid(), n3 = uid();
    const e1 = eid(), e2 = eid();
    const nodes = new Map<string, CanvasNode>();
    const edges = new Map<string, CanvasEdge>();

    nodes.set(n1, { id: n1, x: 100, y: 100, w: 220, h: 64, type: "agent", label: "Input Processing", preTools: [], tools: [], outputVar: n1 + "_out", stepId: n1, prompt: "Process the input for: {input.topic}" });
    nodes.set(n2, { id: n2, x: 400, y: 100, w: 220, h: 64, type: "agent", label: "Main Task", preTools: [], tools: [], outputVar: n2 + "_out", stepId: n2, prompt: "Based on the processed input, perform the main task." });
    nodes.set(n3, { id: n3, x: 700, y: 100, w: 220, h: 64, type: "agent", label: "Output", preTools: [], tools: [], outputVar: "final_output", stepId: n3, prompt: "Compile and format the final output." });
    edges.set(e1, { id: e1, from: n1, to: n2 });
    edges.set(e2, { id: e2, from: n2, to: n3 });

    useCanvasStore.setState({ nodes, edges, selection: new Set() });
    cs.pushUndo();
  },

  // ─── Start execution tracking ────────────────────────────────
  startExecution: async (executionId, name, type) => {
    // Auto-connect SSE
    const monitorState = useMonitorStore.getState();
    if (monitorState.sseStatus !== "connected") {
      monitorState.connect("/events");
    }

    // Load chain/pipeline FIRST (await it), THEN set execution tracking
    if (type === "chain") {
      await get().loadChainToCanvas(name);
    } else {
      await get().loadPipelineToCanvas(name);
    }

    // Now canvas has nodes — set execution ID so SSE events get processed
    useCanvasExecStore.getState().setCanvasExecId(executionId);
  },

  openBlobSession: (sessionId) => {
    useBlobStore.getState().setActiveSession(sessionId);
    set({ activeTab: "blob" });
  },
}));

/**
 * Smart DAG layout with:
 * - Topological ranking (Kahn's algorithm + longest path)
 * - Barycenter ordering to minimize edge crossings
 * - Spacing that accounts for mini terminal SSE (100px below each node)
 * - Horizontal centering per row
 */
function applySimpleLayout(
  nodes: Map<string, CanvasNode>,
  edges: Map<string, CanvasEdge>,
): void {
  if (nodes.size === 0) return;

  // ─── Step 1: Build adjacency ─────────────────────────────────
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const n of nodes.keys()) {
    children.set(n, []);
    parents.set(n, []);
    inDeg.set(n, 0);
  }
  for (const e of edges.values()) {
    children.get(e.from)?.push(e.to);
    parents.get(e.to)?.push(e.from);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }

  // ─── Step 2: Topological rank (longest path from roots) ──────
  const rank = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, deg] of inDeg) {
    if (deg === 0) { queue.push(id); rank.set(id, 0); }
  }
  // Handle cycles: assign rank 0 to unranked
  if (queue.length === 0) {
    for (const id of nodes.keys()) { rank.set(id, 0); queue.push(id); break; }
  }

  const visited = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const curRank = rank.get(cur) ?? 0;
    for (const child of children.get(cur) ?? []) {
      const newRank = curRank + 1;
      if (newRank > (rank.get(child) ?? -1)) rank.set(child, newRank);
      const d = (inDeg.get(child) ?? 1) - 1;
      inDeg.set(child, d);
      if (d <= 0) queue.push(child);
    }
  }
  // Assign rank 0 to any unranked (disconnected)
  for (const id of nodes.keys()) {
    if (!rank.has(id)) rank.set(id, 0);
  }

  // ─── Step 3: Group by rank ───────────────────────────────────
  const rows = new Map<number, string[]>();
  for (const [id, r] of rank) {
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r)!.push(id);
  }

  // ─── Step 4: Barycenter ordering (3 passes to reduce crossings) ─
  const sortedRanks = [...rows.keys()].sort((a, b) => a - b);
  for (let pass = 0; pass < 3; pass++) {
    // Top-down pass
    for (const r of sortedRanks) {
      const ids = rows.get(r)!;
      if (r === 0) continue;
      ids.sort((a, b) => {
        const pa = parents.get(a) ?? [];
        const pb = parents.get(b) ?? [];
        const prevRow = rows.get(r - 1) ?? [];
        const posA = pa.length > 0 ? pa.reduce((s, p) => s + prevRow.indexOf(p), 0) / pa.length : 999;
        const posB = pb.length > 0 ? pb.reduce((s, p) => s + prevRow.indexOf(p), 0) / pb.length : 999;
        return posA - posB;
      });
    }
    // Bottom-up pass
    for (const r of [...sortedRanks].reverse()) {
      const ids = rows.get(r)!;
      const nextRow = rows.get(r + 1);
      if (!nextRow) continue;
      ids.sort((a, b) => {
        const ca = children.get(a) ?? [];
        const cb = children.get(b) ?? [];
        const posA = ca.length > 0 ? ca.reduce((s, c) => s + nextRow.indexOf(c), 0) / ca.length : 999;
        const posB = cb.length > 0 ? cb.reduce((s, c) => s + nextRow.indexOf(c), 0) / cb.length : 999;
        return posA - posB;
      });
    }
  }

  // ─── Step 5: Position nodes ──────────────────────────────────
  // Generous spacing to accommodate mini terminal (80px) below each node
  const gapX = 60;
  const terminalSpace = 90; // space for SSE mini terminal below node
  const padTop = 80;

  for (const r of sortedRanks) {
    const ids = rows.get(r)!;

    // Calculate row height: max node height in this row + terminal space
    let maxH = 0;
    for (const id of ids) {
      maxH = Math.max(maxH, nodes.get(id)?.h ?? 64);
    }
    const rowY = padTop + sortedRanks.indexOf(r) * (maxH + terminalSpace + 30);

    // Center horizontally
    let totalW = 0;
    for (const id of ids) {
      totalW += (nodes.get(id)?.w ?? 220) + gapX;
    }
    totalW -= gapX; // remove trailing gap
    let x = -totalW / 2;

    for (const id of ids) {
      const n = nodes.get(id);
      if (n) {
        n.x = x;
        n.y = rowY;
        x += n.w + gapX;
      }
    }
  }
}

/**
 * Flow/swim-lane layout: each chain gets its own vertical column.
 * Nodes are ordered top-to-bottom within each column by their group order.
 */
function applyFlowLayout(
  nodes: Map<string, CanvasNode>,
  edges: Map<string, CanvasEdge>,
  groups: Map<string, DecomposeGroup>,
): void {
  void edges; // not used directly — ordering comes from groups

  // Group nodes by chain name
  const chainNodes = new Map<string, string[]>();
  const chainOrder = new Map<string, number>(); // track first appearance order for column sorting
  let firstOrder = 0;

  for (const [nodeId, group] of groups) {
    if (!chainNodes.has(group.chain)) {
      chainNodes.set(group.chain, []);
      chainOrder.set(group.chain, firstOrder++);
    }
    chainNodes.get(group.chain)!.push(nodeId);
  }

  // Also include nodes not in any group (shouldn't happen but safety)
  for (const nodeId of nodes.keys()) {
    if (!groups.has(nodeId)) {
      if (!chainNodes.has("_ungrouped")) chainNodes.set("_ungrouped", []);
      chainNodes.get("_ungrouped")!.push(nodeId);
    }
  }

  // Sort chains by their first appearance order
  const sortedChains = [...chainNodes.keys()].sort(
    (a, b) => (chainOrder.get(a) ?? 999) - (chainOrder.get(b) ?? 999),
  );

  // Sort nodes within each chain by group order
  for (const chain of sortedChains) {
    const ids = chainNodes.get(chain)!;
    ids.sort((a, b) => (groups.get(a)?.order ?? 0) - (groups.get(b)?.order ?? 0));
  }

  // Calculate column widths (max node width per chain)
  const colWidths = new Map<string, number>();
  for (const chain of sortedChains) {
    let maxW = 0;
    for (const id of chainNodes.get(chain)!) {
      maxW = Math.max(maxW, nodes.get(id)?.w ?? 200);
    }
    colWidths.set(chain, maxW);
  }

  // Position columns side by side
  const gapX = 60;
  const terminalSpace = 100; // space for SSE mini terminal below each node
  const padTop = 60;
  const padLeft = 40;

  let colX = padLeft;
  for (const chain of sortedChains) {
    const colW = colWidths.get(chain) ?? 200;
    const ids = chainNodes.get(chain)!;
    let y = padTop;

    for (const id of ids) {
      const n = nodes.get(id);
      if (n) {
        n.x = colX + (colW - n.w) / 2;
        n.y = y;
        y += n.h + terminalSpace;
      }
    }

    colX += colW + gapX;
  }
}
