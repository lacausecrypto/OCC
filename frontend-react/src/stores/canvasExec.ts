// ─── Canvas execution overlay store ──────────────────────────────────────────
// Maps SSE execution events to canvas node visual states.

import { create } from "zustand";
import { useCanvasStore } from "./canvas";
import type { ExecutionEvent } from "../types/execution";
import type { NodeExecState } from "../types/canvas";

interface CanvasExecState {
  nodeExecState: Map<string, NodeExecState>;
  stepToNodeMap: Map<string, string>;
  canvasExecId: string | null;

  handleEvent: (event: ExecutionEvent) => void;
  buildStepToNodeMap: (mapping: Record<string, string>) => void;
  clearExecState: () => void;
  setCanvasExecId: (id: string | null) => void;
}

export const useCanvasExecStore = create<CanvasExecState>((set, get) => ({
  nodeExecState: new Map(),
  stepToNodeMap: new Map(),
  canvasExecId: null,

  handleEvent: (event: ExecutionEvent) => {
    const { canvasExecId } = get();

    // Auto-set canvasExecId on first execution_started
    if (event.type === "execution_started" && !canvasExecId) {
      set({ canvasExecId: event.executionId });
    }

    // Filter: only process events for the active execution
    const activeId = get().canvasExecId;
    if (activeId && event.executionId !== activeId) return;
    // If no active exec set, accept all
    if (!activeId) return;

    // Auto-rebuild stepToNodeMap if empty (lazy — canvas may load after first events)
    let currentMap = get().stepToNodeMap;
    if (currentMap.size === 0) {
      const canvasNodes = useCanvasStore.getState().nodes;
      if (canvasNodes.size > 0) {
        const mapping = new Map<string, string>();
        for (const [nodeId, n] of canvasNodes) {
          if (n.stepId) mapping.set(n.stepId, nodeId);
          if (n.outputVar) mapping.set(n.outputVar, nodeId);
          const cleanLabel = (n.label || "").toLowerCase().replace(/\s+/g, "_");
          if (cleanLabel) mapping.set(cleanLabel, nodeId);
        }
        set({ stepToNodeMap: mapping });
        currentMap = mapping;
      }
    }

    // Events that carry a stepId
    if (!("stepId" in event)) {
      // execution_started, execution_done, execution_error have no stepId
      if (event.type === "execution_done" || event.type === "execution_error") {
        // Mark all pending nodes as done/error
        set((s) => {
          const nodeExecState = new Map(s.nodeExecState);
          const status = event.type === "execution_done" ? "done" : "error";
          for (const [nodeId, state] of nodeExecState) {
            if (state.status === "running") {
              nodeExecState.set(nodeId, {
                ...state,
                status,
                finishedAt: Date.now(),
              });
            }
          }
          return { nodeExecState };
        });
      }
      return;
    }

    const nodeId = currentMap.get(event.stepId) ?? event.stepId;

    set((s) => {
      const nodeExecState = new Map(s.nodeExecState);
      const prev = nodeExecState.get(nodeId) ?? {
        status: "pending" as const,
        output: [],
      };

      switch (event.type) {
        case "step_started":
          nodeExecState.set(nodeId, {
            ...prev,
            status: "running",
            startTime: Date.now(),
          });
          break;
        case "step_output": {
          const lines = (event.chunk || "").split("\n").filter((l: string) => l.trim());
          const newOutput = [...prev.output, ...lines].slice(-12);
          nodeExecState.set(nodeId, {
            ...prev,
            status: prev.status === "pending" ? "running" : prev.status,
            startTime: prev.startTime ?? Date.now(),
            output: newOutput,
          });
          break;
        }
        case "step_done":
          nodeExecState.set(nodeId, {
            ...prev,
            status: "done",
            finishedAt: Date.now(),
          });
          break;
        case "step_error":
          nodeExecState.set(nodeId, {
            ...prev,
            status: "error",
            output: [...prev.output, `ERROR: ${event.error}`].slice(-12),
            finishedAt: Date.now(),
          });
          break;
        case "step_log":
          nodeExecState.set(nodeId, {
            ...prev,
            output: [...prev.output, `[${event.level}] ${event.message}`].slice(-12),
          });
          break;
        case "step_cache_hit":
          nodeExecState.set(nodeId, {
            ...prev,
            output: [...prev.output, "[cache hit]"],
          });
          break;
        case "step_waiting_approval":
          nodeExecState.set(nodeId, {
            ...prev,
            output: [...prev.output, `[awaiting approval] ${event.prompt}`],
          });
          break;
        case "gate_action":
          nodeExecState.set(nodeId, {
            ...prev,
            output: [
              ...prev.output,
              `[gate: ${event.action}${event.reason ? " - " + event.reason : ""}]`,
            ],
          });
          break;
      }

      return { nodeExecState };
    });
  },

  buildStepToNodeMap: (mapping: Record<string, string>) => {
    set({ stepToNodeMap: new Map(Object.entries(mapping)) });
  },

  clearExecState: () =>
    set({
      nodeExecState: new Map(),
      canvasExecId: null,
      stepToNodeMap: new Map(),
    }),

  setCanvasExecId: (id) => set({ canvasExecId: id }),
}));
