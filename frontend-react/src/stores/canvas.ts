// ─── Canvas editor store ─────────────────────────────────────────────────────

import { create } from "zustand";
import type {
  CanvasNode,
  CanvasEdge,
  Camera,
  DragState,
  ActiveTool,
} from "../types/canvas";
import type { ChainDefinition, PipelineDefinition } from "../types/chain";

interface UndoSnapshot {
  nodes: Map<string, CanvasNode>;
  edges: Map<string, CanvasEdge>;
}

interface CanvasState {
  nodes: Map<string, CanvasNode>;
  edges: Map<string, CanvasEdge>;
  selection: Set<string>;
  /** Currently selected edge ID (null = no edge selected) */
  selectedEdgeId: string | null;
  camera: Camera;
  dragState: DragState;
  activeTool: ActiveTool;

  undoStack: UndoSnapshot[];
  redoStack: UndoSnapshot[];
  batchMode: boolean;

  // Node operations
  addNode: (node: CanvasNode) => void;
  updateNode: (id: string, patch: Partial<CanvasNode>) => void;
  removeNode: (id: string) => void;

  // Edge operations
  addEdge: (edge: CanvasEdge) => void;
  updateEdge: (id: string, patch: Partial<CanvasEdge>) => void;
  removeEdge: (id: string) => void;

  // Selection
  select: (ids: string[]) => void;
  selectEdge: (id: string | null) => void;
  clearSelection: () => void;
  removeSelected: () => void;

  // Camera
  setCamera: (camera: Partial<Camera>) => void;
  setDragState: (state: DragState) => void;
  setActiveTool: (tool: ActiveTool) => void;

  // Undo / Redo
  pushUndo: () => void;
  popUndo: () => void;
  popRedo: () => void;

  // Load from definition
  loadChainToCanvas: (def: ChainDefinition) => void;
  loadPipelineToCanvas: (def: PipelineDefinition) => void;

  // Reset
  clear: () => void;
}

let nextEdgeId = 1;

export const useCanvasStore = create<CanvasState>((set, get) => ({
  nodes: new Map(),
  edges: new Map(),
  selection: new Set(),
  selectedEdgeId: null,
  camera: { x: 0, y: 0, zoom: 1 },
  dragState: { type: "none" },
  activeTool: "select",
  undoStack: [],
  redoStack: [],
  batchMode: false,

  addNode: (node) =>
    set((s) => {
      const nodes = new Map(s.nodes);
      nodes.set(node.id, node);
      return { nodes };
    }),

  updateNode: (id, patch) =>
    set((s) => {
      const existing = s.nodes.get(id);
      if (!existing) return s;
      const nodes = new Map(s.nodes);
      nodes.set(id, { ...existing, ...patch });
      return { nodes };
    }),

  removeNode: (id) =>
    set((s) => {
      const nodes = new Map(s.nodes);
      nodes.delete(id);
      // Remove edges connected to this node
      const edges = new Map(s.edges);
      for (const [eid, edge] of edges) {
        if (edge.from === id || edge.to === id) edges.delete(eid);
      }
      const selection = new Set(s.selection);
      selection.delete(id);
      return { nodes, edges, selection };
    }),

  addEdge: (edge) =>
    set((s) => {
      const edges = new Map(s.edges);
      // Auto-classify: terminal-to-terminal edges default to "delegate"
      // (bidirectional agent-to-agent calling). All other edges stay
      // "context" (one-way prompt enrichment) which matches the legacy
      // behavior. Caller can override by passing `kind` explicitly.
      let resolved = edge;
      if (edge.kind === undefined) {
        const fromNode = s.nodes.get(edge.from);
        const toNode = s.nodes.get(edge.to);
        const isTerminalEdge =
          fromNode?.kind === "terminal" && toNode?.kind === "terminal";
        resolved = { ...edge, kind: isTerminalEdge ? "delegate" : "context" };
      }
      edges.set(resolved.id, resolved);
      return { edges };
    }),

  updateEdge: (id, patch) =>
    set((s) => {
      const existing = s.edges.get(id);
      if (!existing) return s;
      const edges = new Map(s.edges);
      edges.set(id, { ...existing, ...patch });
      return { edges };
    }),

  removeEdge: (id) =>
    set((s) => {
      const edges = new Map(s.edges);
      edges.delete(id);
      const selectedEdgeId = s.selectedEdgeId === id ? null : s.selectedEdgeId;
      return { edges, selectedEdgeId };
    }),

  select: (ids) => set({ selection: new Set(ids), selectedEdgeId: null }),
  selectEdge: (id) => set({ selectedEdgeId: id, selection: new Set() }),
  clearSelection: () => set({ selection: new Set(), selectedEdgeId: null }),

  removeSelected: () => {
    const { selection, pushUndo } = get();
    if (selection.size === 0) return;
    pushUndo();
    set((s) => {
      const nodes = new Map(s.nodes);
      const edges = new Map(s.edges);
      for (const id of s.selection) {
        nodes.delete(id);
        for (const [eid, edge] of edges) {
          if (edge.from === id || edge.to === id) edges.delete(eid);
        }
      }
      return { nodes, edges, selection: new Set<string>() };
    });
  },

  setCamera: (partial) =>
    set((s) => ({ camera: { ...s.camera, ...partial } })),

  setDragState: (dragState) => set({ dragState }),
  setActiveTool: (activeTool) => set({ activeTool }),

  pushUndo: () =>
    set((s) => ({
      undoStack: [
        ...s.undoStack.slice(-49),
        {
          nodes: new Map(s.nodes),
          edges: new Map(s.edges),
        },
      ],
      redoStack: [],
    })),

  popUndo: () =>
    set((s) => {
      if (s.undoStack.length === 0) return s;
      const snapshot = s.undoStack[s.undoStack.length - 1];
      return {
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [
          ...s.redoStack,
          { nodes: new Map(s.nodes), edges: new Map(s.edges) },
        ],
        nodes: new Map(snapshot.nodes),
        edges: new Map(snapshot.edges),
        selection: new Set<string>(),
      };
    }),

  popRedo: () =>
    set((s) => {
      if (s.redoStack.length === 0) return s;
      const snapshot = s.redoStack[s.redoStack.length - 1];
      return {
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [
          ...s.undoStack,
          { nodes: new Map(s.nodes), edges: new Map(s.edges) },
        ],
        nodes: new Map(snapshot.nodes),
        edges: new Map(snapshot.edges),
        selection: new Set<string>(),
      };
    }),

  loadChainToCanvas: (def) => {
    const { pushUndo } = get();
    pushUndo();

    const nodes = new Map<string, CanvasNode>();
    const edges = new Map<string, CanvasEdge>();
    const spacing = 250;

    // Restore canvas-only items (portals, sticky notes, terminals, file
    // viewers, link bookmarks, free text, obsidian links). These were written
    // by canvasToYaml under `canvas_items:` — we trust the persisted geometry
    // and field set. Items load BEFORE steps so step nodes don't end up
    // stacked on top of restored portals.
    const canvasItems = (def as { canvas_items?: Array<Record<string, unknown>> }).canvas_items;
    if (Array.isArray(canvasItems)) {
      for (const raw of canvasItems) {
        if (!raw || typeof raw !== "object") continue;
        const id = typeof raw.id === "string" ? raw.id : null;
        if (!id) continue;
        // Spread blindly — CanvasNode is a wide union, and any future field
        // the canvas adds will round-trip without us touching this code.
        nodes.set(id, raw as unknown as CanvasNode);
      }
    }

    def.steps.forEach((step, idx) => {
      const node: CanvasNode = {
        id: step.id,
        x: 100 + (idx % 4) * spacing,
        y: 100 + Math.floor(idx / 4) * 200,
        w: 200,
        h: 100,
        type: step.type ?? "agent",
        label: step.label ?? step.id,
        model: step.model,
        preTools: step.pre_tools ?? [],
        tools: step.tools ?? [],
        outputVar: step.output_var,
        stepId: step.id,
        prompt: step.prompt,
        advanced: {
          retry: step.retry,
          fallback_models: step.fallback_models,
          timeout_ms: step.timeout_ms,
          cwd: step.cwd,
          cache: step.cache,
          output_schema: step.output_schema,
          output_must_contain: step.output_must_contain,
          output_must_not_contain: step.output_must_not_contain,
          output_max_length: step.output_max_length,
          context_strategy: step.context_strategy,
          early_exit_if: step.early_exit_if,
          condition: step.condition,
          // Gate
          timeout_hours: step.timeout_hours,
          on_timeout: step.on_timeout,
          gate_actions: step.gate_actions,
          gate_auto_approve_if: step.gate_auto_approve_if,
          gate_rejection_reason: step.gate_rejection_reason,
          // Router
          routes: step.routes,
          default_route: step.default_route,
          // Evaluator
          input_var: step.input_var,
          criteria: step.criteria,
          on_fail: step.on_fail,
          max_retries: step.max_retries,
          retry_target: step.retry_target,
          eval_scoring: step.eval_scoring,
          eval_threshold: step.eval_threshold,
          // Transform
          operation: step.operation,
          json_path: step.json_path,
          regex: step.regex,
          template_str: step.template_str,
          truncate_limit: step.truncate_limit,
          // Loop
          items_var: step.items_var,
          max_parallel: step.max_parallel,
          loop_until: step.loop_until,
          loop_on_error: step.loop_on_error,
          // Merge
          inputs: step.inputs,
          strategy: step.strategy,
          // Browser
          browser_url: step.browser_url,
          browser_task: step.browser_task,
          browser_max_steps: step.browser_max_steps,
          browser_headless: step.browser_headless,
          browser_viewport: step.browser_viewport,
          browser_wait_ms: step.browser_wait_ms,
          browser_output_format: step.browser_output_format,
          // Subchain
          subchain: step.subchain,
          subchain_input_map: step.subchain_input_map,
          // Debate
          debate_agents: step.debate_agents,
          debate_rounds: step.debate_rounds,
          debate_decision: step.debate_decision,
          // Webhook
          webhook_url: step.webhook_url ?? step.url,
          webhook_method: step.webhook_method,
          webhook_headers: step.webhook_headers,
          webhook_body: step.webhook_body,
          webhook_timeout_ms: step.webhook_timeout_ms,
          webhook_retry: step.webhook_retry,
          // Guardrails
          guardrails: step.guardrails,
        },
      };
      nodes.set(node.id, node);

      // Create edges from depends_on
      if (step.depends_on) {
        for (const dep of step.depends_on) {
          const edgeId = `e${nextEdgeId++}`;
          edges.set(edgeId, { id: edgeId, from: dep, to: step.id });
        }
      }
    });

    set({ nodes, edges, selection: new Set() });
  },

  loadPipelineToCanvas: (def) => {
    const { pushUndo } = get();
    pushUndo();

    const nodes = new Map<string, CanvasNode>();
    const edges = new Map<string, CanvasEdge>();
    const spacing = 300;

    def.chains.forEach((ref, idx) => {
      const node: CanvasNode = {
        id: ref.id,
        x: 100 + (idx % 3) * spacing,
        y: 100 + Math.floor(idx / 3) * 200,
        w: 220,
        h: 110,
        type: "subchain",
        label: ref.label ?? ref.chain,
        preTools: [],
        tools: [],
        outputVar: ref.id,
        stepId: ref.id,
        prompt: `Pipeline chain: ${ref.chain}`,
      };
      nodes.set(node.id, node);

      if (ref.depends_on) {
        for (const dep of ref.depends_on) {
          const edgeId = `e${nextEdgeId++}`;
          edges.set(edgeId, { id: edgeId, from: dep, to: ref.id });
        }
      }
    });

    set({ nodes, edges, selection: new Set() });
  },

  clear: () =>
    set({
      nodes: new Map(),
      edges: new Map(),
      selection: new Set(),
      selectedEdgeId: null,
      undoStack: [],
      redoStack: [],
    }),
}));
