import { describe, it, expect, beforeEach, vi } from "vitest";
import { useCanvasExecStore } from "../../src/stores/canvasExec";

// Mock canvas store with some nodes
vi.mock("../../src/stores/canvas", () => ({
  useCanvasStore: {
    getState: vi.fn(() => ({
      nodes: new Map(),
    })),
  },
}));

describe("useCanvasExecStore", () => {
  beforeEach(() => {
    useCanvasExecStore.getState().clearExecState();
    useCanvasExecStore.setState({ stepToNodeMap: new Map() });
  });

  it("has correct initial state", () => {
    const s = useCanvasExecStore.getState();
    expect(s.nodeExecState.size).toBe(0);
    expect(s.canvasExecId).toBeNull();
  });

  it("auto-sets canvasExecId on execution_started", () => {
    useCanvasExecStore.getState().handleEvent({
      type: "execution_started",
      executionId: "exec1",
      chainName: "c1",
      timestamp: new Date().toISOString(),
    });
    expect(useCanvasExecStore.getState().canvasExecId).toBe("exec1");
  });

  it("ignores events for different execution", () => {
    useCanvasExecStore.getState().setCanvasExecId("exec1");
    useCanvasExecStore.setState({ stepToNodeMap: new Map([["s1", "n1"]]) });

    useCanvasExecStore.getState().handleEvent({
      type: "step_started",
      executionId: "other-exec",
      stepId: "s1",
      timestamp: new Date().toISOString(),
    });
    expect(useCanvasExecStore.getState().nodeExecState.size).toBe(0);
  });

  it("tracks step_started", () => {
    useCanvasExecStore.getState().setCanvasExecId("exec1");
    useCanvasExecStore.setState({ stepToNodeMap: new Map([["s1", "n1"]]) });

    useCanvasExecStore.getState().handleEvent({
      type: "step_started",
      executionId: "exec1",
      stepId: "s1",
      timestamp: new Date().toISOString(),
    });
    const state = useCanvasExecStore.getState().nodeExecState.get("n1");
    expect(state?.status).toBe("running");
  });

  it("tracks step_done", () => {
    useCanvasExecStore.getState().setCanvasExecId("exec1");
    useCanvasExecStore.setState({ stepToNodeMap: new Map([["s1", "n1"]]) });

    useCanvasExecStore.getState().handleEvent({
      type: "step_started", executionId: "exec1", stepId: "s1",
      timestamp: new Date().toISOString(),
    });
    useCanvasExecStore.getState().handleEvent({
      type: "step_done", executionId: "exec1", stepId: "s1",
      durationMs: 100,
      timestamp: new Date().toISOString(),
    });
    const state = useCanvasExecStore.getState().nodeExecState.get("n1");
    expect(state?.status).toBe("done");
  });

  it("tracks step_error", () => {
    useCanvasExecStore.getState().setCanvasExecId("exec1");
    useCanvasExecStore.setState({ stepToNodeMap: new Map([["s1", "n1"]]) });

    useCanvasExecStore.getState().handleEvent({
      type: "step_error", executionId: "exec1", stepId: "s1", error: "fail",
      timestamp: new Date().toISOString(),
    });
    const state = useCanvasExecStore.getState().nodeExecState.get("n1");
    expect(state?.status).toBe("error");
    expect(state?.output).toContain("ERROR: fail");
  });

  it("tracks step_output", () => {
    useCanvasExecStore.getState().setCanvasExecId("exec1");
    useCanvasExecStore.setState({ stepToNodeMap: new Map([["s1", "n1"]]) });

    useCanvasExecStore.getState().handleEvent({
      type: "step_output", executionId: "exec1", stepId: "s1", chunk: "line1\nline2\n",
      timestamp: new Date().toISOString(),
    });
    const state = useCanvasExecStore.getState().nodeExecState.get("n1");
    expect(state?.output.length).toBeGreaterThan(0);
  });

  it("tracks step_cache_hit", () => {
    useCanvasExecStore.getState().setCanvasExecId("exec1");
    useCanvasExecStore.setState({ stepToNodeMap: new Map([["s1", "n1"]]) });

    useCanvasExecStore.getState().handleEvent({
      type: "step_cache_hit", executionId: "exec1", stepId: "s1",
      timestamp: new Date().toISOString(),
    });
    const state = useCanvasExecStore.getState().nodeExecState.get("n1");
    expect(state?.output).toContain("[cache hit]");
  });

  it("tracks step_waiting_approval", () => {
    useCanvasExecStore.getState().setCanvasExecId("exec1");
    useCanvasExecStore.setState({ stepToNodeMap: new Map([["s1", "n1"]]) });

    useCanvasExecStore.getState().handleEvent({
      type: "step_waiting_approval", executionId: "exec1", stepId: "s1",
      prompt: "approve?",
      timestamp: new Date().toISOString(),
    });
    const state = useCanvasExecStore.getState().nodeExecState.get("n1");
    expect(state?.output.some((l) => l.includes("awaiting approval"))).toBe(true);
  });

  it("tracks gate_action", () => {
    useCanvasExecStore.getState().setCanvasExecId("exec1");
    useCanvasExecStore.setState({ stepToNodeMap: new Map([["s1", "n1"]]) });

    useCanvasExecStore.getState().handleEvent({
      type: "gate_action", executionId: "exec1", stepId: "s1",
      action: "approved", reason: "looks good",
      timestamp: new Date().toISOString(),
    });
    const state = useCanvasExecStore.getState().nodeExecState.get("n1");
    expect(state?.output.some((l) => l.includes("gate: approved"))).toBe(true);
  });

  it("marks running nodes as done on execution_done", () => {
    useCanvasExecStore.getState().setCanvasExecId("exec1");
    useCanvasExecStore.setState({ stepToNodeMap: new Map([["s1", "n1"]]) });

    useCanvasExecStore.getState().handleEvent({
      type: "step_started", executionId: "exec1", stepId: "s1",
      timestamp: new Date().toISOString(),
    });
    useCanvasExecStore.getState().handleEvent({
      type: "execution_done", executionId: "exec1",
      result: "ok", durationMs: 500,
      timestamp: new Date().toISOString(),
    });
    const state = useCanvasExecStore.getState().nodeExecState.get("n1");
    expect(state?.status).toBe("done");
  });

  it("buildStepToNodeMap sets mapping", () => {
    useCanvasExecStore.getState().buildStepToNodeMap({ s1: "n1", s2: "n2" });
    const map = useCanvasExecStore.getState().stepToNodeMap;
    expect(map.get("s1")).toBe("n1");
    expect(map.get("s2")).toBe("n2");
  });

  it("clearExecState resets state", () => {
    useCanvasExecStore.getState().setCanvasExecId("exec1");
    useCanvasExecStore.getState().clearExecState();
    expect(useCanvasExecStore.getState().canvasExecId).toBeNull();
    expect(useCanvasExecStore.getState().nodeExecState.size).toBe(0);
  });

  it("uses stepId directly when no mapping exists", () => {
    useCanvasExecStore.getState().setCanvasExecId("exec1");
    // No stepToNodeMap, but canvasStore has no nodes either

    useCanvasExecStore.getState().handleEvent({
      type: "step_started", executionId: "exec1", stepId: "unmapped_step",
      timestamp: new Date().toISOString(),
    });
    // Should use stepId as nodeId fallback
    const state = useCanvasExecStore.getState().nodeExecState.get("unmapped_step");
    expect(state?.status).toBe("running");
  });
});
