// ─── Live monitor store (SSE events, executions) ────────────────────────────

import { create } from "zustand";
import { sseManager } from "../api/sse";
import { useCanvasExecStore } from "./canvasExec";
import type { SSEStatus } from "../api/sse";
import type { ExecutionEvent, ChainExecution, ExecutionStatus } from "../types/execution";

const MAX_EVENTS = 2000;
const MAX_LOG_DOM = 2000;

interface MonitorState {
  sseStatus: SSEStatus;
  events: ExecutionEvent[];
  executions: Map<string, ChainExecution>;
  activeExecId: string | null;
  /** Timestamp of last clear — events before this are dropped */
  _clearTimestamp: string | null;

  connect: (url: string) => void;
  disconnect: () => void;
  handleEvent: (event: ExecutionEvent) => void;
  setActiveExecId: (id: string | null) => void;
  clearEvents: () => void;
  clearExecutions: () => void;
}

export const useMonitorStore = create<MonitorState>((set, get) => ({
  sseStatus: "disconnected",
  events: [],
  executions: new Map(),
  activeExecId: null,
  _clearTimestamp: null,

  connect: (url: string) => {
    sseManager.onStatusChange = (status) => set({ sseStatus: status });
    sseManager.onEvent = (event) => get().handleEvent(event);
    sseManager.connect(url);
  },

  disconnect: () => {
    sseManager.disconnect();
    set({ sseStatus: "disconnected" });
  },

  handleEvent: (event: ExecutionEvent) => {
    // Assign timestamp if missing
    if (!event.timestamp) event.timestamp = new Date().toISOString();
    // Drop events that occurred before the last clear
    const clearTs = get()._clearTimestamp;
    if (clearTs && event.timestamp <= clearTs) return;

    set((s) => {
      // Cleanup old executions (> 2 hours)
      const TWO_HOURS = 7200000;
      const now = Date.now();

      // Age-based cleanup: filter out events older than 2 hours
      const freshEvents = s.events.filter(
        (e) => !e.timestamp || (now - new Date(e.timestamp).getTime()) <= TWO_HOURS,
      );

      // Append event, trim to MAX_EVENTS
      const events =
        freshEvents.length >= MAX_EVENTS
          ? [...freshEvents.slice(freshEvents.length - MAX_LOG_DOM + 1), event]
          : [...freshEvents, event];

      const executions = new Map(s.executions);

      // Cleanup old finished executions (> 2 hours)
      for (const [id, exec] of executions) {
        if (exec.finishedAt && (now - new Date(exec.finishedAt).getTime()) > TWO_HOURS) {
          executions.delete(id);
        }
      }

      switch (event.type) {
        case "execution_started": {
          const exec: ChainExecution = {
            id: event.executionId,
            chainName: event.chainName,
            status: "running",
            input: {},
            steps: {},
            startedAt: new Date().toISOString(),
          };
          executions.set(event.executionId, exec);
          break;
        }
        case "step_started": {
          const exec = executions.get(event.executionId);
          if (exec) {
            exec.steps[event.stepId] = {
              stepId: event.stepId,
              status: "running",
              startedAt: new Date().toISOString(),
            };
          }
          break;
        }
        case "step_output": {
          const exec = executions.get(event.executionId);
          if (exec && exec.steps[event.stepId]) {
            const step = exec.steps[event.stepId];
            step.output = (step.output ?? "") + event.chunk;
          }
          break;
        }
        case "step_done": {
          const exec = executions.get(event.executionId);
          if (exec && exec.steps[event.stepId]) {
            const step = exec.steps[event.stepId];
            step.status = "done";
            step.durationMs = event.durationMs;
            step.inputTokens = event.inputTokens;
            step.outputTokens = event.outputTokens;
            step.finishedAt = new Date().toISOString();
          }
          break;
        }
        case "step_error": {
          const exec = executions.get(event.executionId);
          if (exec && exec.steps[event.stepId]) {
            exec.steps[event.stepId].status = "error";
            exec.steps[event.stepId].error = event.error;
          }
          break;
        }
        case "execution_done": {
          const exec = executions.get(event.executionId);
          if (exec) {
            exec.status = "done" as ExecutionStatus;
            exec.result = event.result;
            exec.durationMs = event.durationMs;
            exec.finishedAt = new Date().toISOString();
          }
          break;
        }
        case "execution_error": {
          const exec = executions.get(event.executionId);
          if (exec) {
            exec.status = "error" as ExecutionStatus;
            exec.error = event.error;
            exec.finishedAt = new Date().toISOString();
          }
          break;
        }
      }

      // Forward to canvas exec store for live node overlays
      useCanvasExecStore.getState().handleEvent(event);

      return { events, executions };
    });
  },

  setActiveExecId: (id) => set({ activeExecId: id }),

  clearEvents: () => set({ events: [] }),

  clearExecutions: () => {
    // Record a timestamp — ignore all events that occurred BEFORE this moment
    const clearTimestamp = new Date().toISOString();
    set({
      executions: new Map(),
      events: [],
      activeExecId: null,
      _clearTimestamp: clearTimestamp,
    });
    useCanvasExecStore.getState().clearExecState();
  },
}));

export { MAX_EVENTS, MAX_LOG_DOM };
