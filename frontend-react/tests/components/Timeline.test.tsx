import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Timeline } from "../../src/components/monitor/Timeline";
import { useMonitorStore } from "../../src/stores/monitor";
import { useCanvasStore } from "../../src/stores/canvas";
import { useCanvasExecStore } from "../../src/stores/canvasExec";
import { useAppStore } from "../../src/stores/app";
import type { ChainExecution } from "../../src/types/execution";

vi.mock("../../src/components/monitor/Monitor.module.css", () => ({
  default: {
    timeline: "timeline",
    monEmpty: "monEmpty",
    tlHeader: "tlHeader",
    tlChainName: "tlChainName",
    tlStepCount: "tlStepCount",
    tlStep: "tlStep",
    tlStepClickable: "tlStepClickable",
    tlStepRunning: "tlStepRunning",
    tlConnector: "tlConnector",
    tlDot: "tlDot",
    tlDotRunning: "tlDotRunning",
    tlDotDone: "tlDotDone",
    tlDotError: "tlDotError",
    tlDotPending: "tlDotPending",
    tlDotSkipped: "tlDotSkipped",
    tlDotWaiting: "tlDotWaiting",
    tlInfo: "tlInfo",
    tlLabel: "tlLabel",
    tlNav: "tlNav",
    tlMeta: "tlMeta",
  },
}));

function makeExec(overrides: Partial<ChainExecution> & { id: string }): ChainExecution {
  return {
    chainName: "test-chain",
    status: "done",
    input: {},
    steps: {},
    startedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("Timeline", () => {
  beforeEach(() => {
    useMonitorStore.setState({
      executions: new Map(),
      activeExecId: null,
    });
    useCanvasStore.setState({
      nodes: new Map(),
      camera: { x: 0, y: 0, zoom: 1 },
      selection: new Set(),
    });
    useCanvasExecStore.setState({
      stepToNodeMap: new Map(),
      canvasExecId: null,
    });
  });

  it("renders empty state when no active execution", () => {
    render(<Timeline />);
    expect(
      screen.getByText("Select an execution to view its timeline"),
    ).toBeInTheDocument();
  });

  it("renders empty state when active exec has no steps", () => {
    const executions = new Map<string, ChainExecution>();
    // steps is undefined (not even an empty object)
    const exec = makeExec({ id: "exec-1" });
    delete (exec as Record<string, unknown>).steps;
    executions.set("exec-1", exec);
    useMonitorStore.setState({ executions, activeExecId: "exec-1" });

    render(<Timeline />);
    expect(
      screen.getByText("Select an execution to view its timeline"),
    ).toBeInTheDocument();
  });

  it("renders timeline steps for active execution", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({
      id: "exec-1",
      chainName: "my-chain",
      steps: {
        research: { stepId: "research", status: "done", durationMs: 1200 },
        analyze: { stepId: "analyze", status: "running" },
        summarize: { stepId: "summarize", status: "pending" },
      },
    }));
    useMonitorStore.setState({ executions, activeExecId: "exec-1" });

    render(<Timeline />);
    expect(screen.getByText("my-chain")).toBeInTheDocument();
    expect(screen.getByText("research")).toBeInTheDocument();
    expect(screen.getByText("analyze")).toBeInTheDocument();
    expect(screen.getByText("summarize")).toBeInTheDocument();
  });

  it("shows step count (done/total)", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({
      id: "exec-1",
      steps: {
        s1: { stepId: "s1", status: "done" },
        s2: { stepId: "s2", status: "done" },
        s3: { stepId: "s3", status: "running" },
      },
    }));
    useMonitorStore.setState({ executions, activeExecId: "exec-1" });

    render(<Timeline />);
    expect(screen.getByText("2/3")).toBeInTheDocument();
  });

  it("shows duration in step meta", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({
      id: "exec-1",
      steps: {
        s1: { stepId: "s1", status: "done", durationMs: 3500 },
      },
    }));
    useMonitorStore.setState({ executions, activeExecId: "exec-1" });

    render(<Timeline />);
    expect(screen.getByText(/3\.5s/)).toBeInTheDocument();
  });

  it("shows token info in step meta", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({
      id: "exec-1",
      steps: {
        s1: { stepId: "s1", status: "done", inputTokens: 1000, outputTokens: 500 },
      },
    }));
    useMonitorStore.setState({ executions, activeExecId: "exec-1" });

    render(<Timeline />);
    expect(screen.getByText(/1000/)).toBeInTheDocument();
    expect(screen.getByText(/500/)).toBeInTheDocument();
  });

  it("shows error in step meta", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({
      id: "exec-1",
      steps: {
        s1: { stepId: "s1", status: "error", error: "API rate limit exceeded" },
      },
    }));
    useMonitorStore.setState({ executions, activeExecId: "exec-1" });

    render(<Timeline />);
    expect(screen.getByText(/API rate limit exceeded/)).toBeInTheDocument();
  });

  it("navigates to canvas node on step click", () => {
    const nodes = new Map();
    nodes.set("node-1", { x: 100, y: 200, w: 150, h: 80, label: "research" });
    useCanvasStore.setState({ nodes });

    const stepToNodeMap = new Map();
    stepToNodeMap.set("research", "node-1");
    useCanvasExecStore.setState({ stepToNodeMap });

    const setActiveTab = vi.fn();
    useAppStore.setState({ setActiveTab });

    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({
      id: "exec-1",
      steps: {
        research: { stepId: "research", status: "done" },
      },
    }));
    useMonitorStore.setState({ executions, activeExecId: "exec-1" });

    render(<Timeline />);
    fireEvent.click(screen.getByText("research"));

    // Should have updated canvas camera and selection
    const canvasState = useCanvasStore.getState();
    expect(canvasState.selection.has("node-1")).toBe(true);
  });

  it("renders navigation arrow for each step", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({
      id: "exec-1",
      steps: {
        s1: { stepId: "s1", status: "done" },
      },
    }));
    useMonitorStore.setState({ executions, activeExecId: "exec-1" });

    render(<Timeline />);
    // The arrow character is rendered
    expect(screen.getByText("\u2192")).toBeInTheDocument();
  });

  it("renders connector lines between steps", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({
      id: "exec-1",
      steps: {
        s1: { stepId: "s1", status: "done" },
        s2: { stepId: "s2", status: "running" },
        s3: { stepId: "s3", status: "pending" },
      },
    }));
    useMonitorStore.setState({ executions, activeExecId: "exec-1" });

    const { container } = render(<Timeline />);
    // Connector divs should exist for steps after the first
    const connectors = container.querySelectorAll(".tlConnector");
    expect(connectors.length).toBe(2);
  });
});
