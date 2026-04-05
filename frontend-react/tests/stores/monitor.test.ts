import { describe, it, expect, beforeEach, vi } from "vitest";
import { useMonitorStore, MAX_EVENTS } from "../../src/stores/monitor";
import type { ExecutionEvent } from "../../src/types/execution";

// Mock canvasExec store
vi.mock("../../src/stores/canvasExec", () => ({
  useCanvasExecStore: {
    getState: () => ({
      handleEvent: vi.fn(),
      clearExecState: vi.fn(),
    }),
  },
}));

// Mock SSE manager
vi.mock("../../src/api/sse", () => ({
  sseManager: {
    onStatusChange: null,
    onEvent: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}));

describe("useMonitorStore", () => {
  beforeEach(() => {
    useMonitorStore.setState({
      sseStatus: "disconnected",
      events: [],
      executions: new Map(),
      activeExecId: null,
      _clearTimestamp: null,
    });
  });

  it("has correct initial state", () => {
    const s = useMonitorStore.getState();
    expect(s.sseStatus).toBe("disconnected");
    expect(s.events).toEqual([]);
    expect(s.executions.size).toBe(0);
    expect(s.activeExecId).toBeNull();
  });

  describe("handleEvent", () => {
    it("adds execution on execution_started", () => {
      const event: ExecutionEvent = {
        type: "execution_started",
        executionId: "exec1",
        chainName: "test-chain",
        timestamp: new Date().toISOString(),
      };
      useMonitorStore.getState().handleEvent(event);
      const exec = useMonitorStore.getState().executions.get("exec1");
      expect(exec).toBeDefined();
      expect(exec?.chainName).toBe("test-chain");
      expect(exec?.status).toBe("running");
    });

    it("updates step on step_started", () => {
      // First create execution
      useMonitorStore.getState().handleEvent({
        type: "execution_started",
        executionId: "e1",
        chainName: "c1",
        timestamp: new Date().toISOString(),
      });
      // Then start step
      useMonitorStore.getState().handleEvent({
        type: "step_started",
        executionId: "e1",
        stepId: "s1",
        timestamp: new Date().toISOString(),
      });
      const exec = useMonitorStore.getState().executions.get("e1");
      expect(exec?.steps["s1"]).toBeDefined();
      expect(exec?.steps["s1"].status).toBe("running");
    });

    it("appends output on step_output", () => {
      useMonitorStore.getState().handleEvent({
        type: "execution_started", executionId: "e1", chainName: "c1",
        timestamp: new Date().toISOString(),
      });
      useMonitorStore.getState().handleEvent({
        type: "step_started", executionId: "e1", stepId: "s1",
        timestamp: new Date().toISOString(),
      });
      useMonitorStore.getState().handleEvent({
        type: "step_output", executionId: "e1", stepId: "s1", chunk: "hello ",
        timestamp: new Date().toISOString(),
      });
      useMonitorStore.getState().handleEvent({
        type: "step_output", executionId: "e1", stepId: "s1", chunk: "world",
        timestamp: new Date().toISOString(),
      });
      const step = useMonitorStore.getState().executions.get("e1")?.steps["s1"];
      expect(step?.output).toBe("hello world");
    });

    it("marks step done with duration and tokens", () => {
      useMonitorStore.getState().handleEvent({
        type: "execution_started", executionId: "e1", chainName: "c1",
        timestamp: new Date().toISOString(),
      });
      useMonitorStore.getState().handleEvent({
        type: "step_started", executionId: "e1", stepId: "s1",
        timestamp: new Date().toISOString(),
      });
      useMonitorStore.getState().handleEvent({
        type: "step_done", executionId: "e1", stepId: "s1",
        durationMs: 1234, inputTokens: 100, outputTokens: 50,
        timestamp: new Date().toISOString(),
      });
      const step = useMonitorStore.getState().executions.get("e1")?.steps["s1"];
      expect(step?.status).toBe("done");
      expect(step?.durationMs).toBe(1234);
      expect(step?.inputTokens).toBe(100);
      expect(step?.outputTokens).toBe(50);
    });

    it("marks step error", () => {
      useMonitorStore.getState().handleEvent({
        type: "execution_started", executionId: "e1", chainName: "c1",
        timestamp: new Date().toISOString(),
      });
      useMonitorStore.getState().handleEvent({
        type: "step_started", executionId: "e1", stepId: "s1",
        timestamp: new Date().toISOString(),
      });
      useMonitorStore.getState().handleEvent({
        type: "step_error", executionId: "e1", stepId: "s1", error: "boom",
        timestamp: new Date().toISOString(),
      });
      const step = useMonitorStore.getState().executions.get("e1")?.steps["s1"];
      expect(step?.status).toBe("error");
      expect(step?.error).toBe("boom");
    });

    it("marks execution done", () => {
      useMonitorStore.getState().handleEvent({
        type: "execution_started", executionId: "e1", chainName: "c1",
        timestamp: new Date().toISOString(),
      });
      useMonitorStore.getState().handleEvent({
        type: "execution_done", executionId: "e1", result: "All done!",
        durationMs: 5000,
        timestamp: new Date().toISOString(),
      });
      const exec = useMonitorStore.getState().executions.get("e1");
      expect(exec?.status).toBe("done");
      expect(exec?.result).toBe("All done!");
      expect(exec?.durationMs).toBe(5000);
    });

    it("marks execution error", () => {
      useMonitorStore.getState().handleEvent({
        type: "execution_started", executionId: "e1", chainName: "c1",
        timestamp: new Date().toISOString(),
      });
      useMonitorStore.getState().handleEvent({
        type: "execution_error", executionId: "e1", error: "fatal",
        timestamp: new Date().toISOString(),
      });
      const exec = useMonitorStore.getState().executions.get("e1");
      expect(exec?.status).toBe("error");
      expect(exec?.error).toBe("fatal");
    });

    it("assigns timestamp if missing", () => {
      const event: ExecutionEvent = {
        type: "execution_started",
        executionId: "e1",
        chainName: "c1",
      };
      useMonitorStore.getState().handleEvent(event);
      expect(event.timestamp).toBeTruthy();
    });

    it("trims events to MAX_EVENTS", () => {
      // Add many events
      for (let i = 0; i < MAX_EVENTS + 100; i++) {
        useMonitorStore.getState().handleEvent({
          type: "execution_started",
          executionId: `e${i}`,
          chainName: "c",
          timestamp: new Date().toISOString(),
        });
      }
      expect(useMonitorStore.getState().events.length).toBeLessThanOrEqual(MAX_EVENTS + 1);
    });

    it("drops events before clearTimestamp", () => {
      const oldTimestamp = "2020-01-01T00:00:00.000Z";
      useMonitorStore.setState({ _clearTimestamp: new Date().toISOString() });
      useMonitorStore.getState().handleEvent({
        type: "execution_started",
        executionId: "old",
        chainName: "c1",
        timestamp: oldTimestamp,
      });
      expect(useMonitorStore.getState().executions.has("old")).toBe(false);
    });
  });

  describe("actions", () => {
    it("setActiveExecId sets active execution", () => {
      useMonitorStore.getState().setActiveExecId("e1");
      expect(useMonitorStore.getState().activeExecId).toBe("e1");
    });

    it("clearEvents empties events", () => {
      useMonitorStore.getState().handleEvent({
        type: "execution_started", executionId: "e1", chainName: "c1",
        timestamp: new Date().toISOString(),
      });
      useMonitorStore.getState().clearEvents();
      expect(useMonitorStore.getState().events).toEqual([]);
    });

    it("clearExecutions resets all execution state", () => {
      useMonitorStore.getState().handleEvent({
        type: "execution_started", executionId: "e1", chainName: "c1",
        timestamp: new Date().toISOString(),
      });
      useMonitorStore.getState().clearExecutions();
      expect(useMonitorStore.getState().executions.size).toBe(0);
      expect(useMonitorStore.getState().events).toEqual([]);
      expect(useMonitorStore.getState().activeExecId).toBeNull();
      expect(useMonitorStore.getState()._clearTimestamp).toBeTruthy();
    });
  });
});
