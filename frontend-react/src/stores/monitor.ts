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

    // Load recent executions from backend (SSE only captures live events)
    fetch("/executions?limit=30")
      .then((r) => r.ok ? r.json() : [])
      .then((data: ChainExecution[]) => {
        if (!Array.isArray(data)) return;
        set((s) => {
          const executions = new Map(s.executions);
          for (const ex of data) {
            if (!executions.has(ex.id)) {
              executions.set(ex.id, ex);
            }
          }
          return { executions };
        });
      })
      .catch(() => {});
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
      const now = Date.now();

      // ── Auto-cleanup: keep only last 200 events (not 2000) ──
      const MAX_DISPLAY_EVENTS = 200;
      const freshEvents = s.events.slice(-MAX_DISPLAY_EVENTS);

      // Append event
      const events = [...freshEvents, event];

      // ── Auto-cleanup: purge finished executions older than 10 minutes ──
      const executions = new Map(s.executions);
      if (executions.size > 15) {
        const TEN_MIN = 600000;
        for (const [id, exec] of executions) {
          if (exec.status !== "running" && exec.finishedAt && now - new Date(exec.finishedAt).getTime() > TEN_MIN) {
            executions.delete(id);
          }
          if (executions.size <= 8) break; // keep at least 8
        }
      }

      // ── Auto-cleanup: mark stale "running" executions as error (> 5 min) ──
      const FIVE_MIN = 300000;
      for (const [, exec] of executions) {
        if (exec.status === "running" && exec.startedAt && now - new Date(exec.startedAt).getTime() > FIVE_MIN) {
          exec.status = "error" as ExecutionStatus;
          exec.error = "Stale execution — no events received for 5+ minutes";
          exec.finishedAt = new Date().toISOString();
        }
      }

      // (cleanup already done above)

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
