import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExecutionList } from "../../src/components/monitor/ExecutionList";
import { useMonitorStore } from "../../src/stores/monitor";
import { useAppStore } from "../../src/stores/app";
import { useCanvasExecStore } from "../../src/stores/canvasExec";
import type { ChainExecution } from "../../src/types/execution";

vi.mock("../../src/components/monitor/Monitor.module.css", () => ({
  default: {
    execList: "execList",
    monEmpty: "monEmpty",
    execCard: "execCard",
    execCardActive: "execCardActive",
    execCardOnCanvas: "execCardOnCanvas",
    execHeader: "execHeader",
    execName: "execName",
    execBadge: "execBadge",
    execTags: "execTags",
    execTagCanvas: "execTagCanvas",
    execTagPipeline: "execTagPipeline",
    execTagChain: "execTagChain",
    execId: "execId",
    execSteps: "execSteps",
    execStep: "execStep",
    execProgress: "execProgress",
    execProgressFill: "execProgressFill",
    execFooter: "execFooter",
    execStat: "execStat",
    elapsedLive: "elapsedLive",
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

describe("ExecutionList", () => {
  beforeEach(() => {
    useMonitorStore.setState({
      executions: new Map(),
      activeExecId: null,
    });
    useAppStore.setState({ pipelineName: null });
    useCanvasExecStore.setState({ canvasExecId: null });
  });

  it("renders empty state when no executions", () => {
    render(<ExecutionList />);
    expect(
      screen.getByText("No active executions. Run a chain to see it here."),
    ).toBeInTheDocument();
  });

  it("renders execution cards", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({ id: "exec-1", chainName: "my-chain" }));
    useMonitorStore.setState({ executions });

    render(<ExecutionList />);
    expect(screen.getByText("my-chain")).toBeInTheDocument();
    expect(screen.getByText("exec-1")).toBeInTheDocument();
  });

  it("shows step counts in footer", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({
      id: "exec-1",
      steps: {
        s1: { stepId: "s1", status: "done" },
        s2: { stepId: "s2", status: "running" },
      },
    }));
    useMonitorStore.setState({ executions });

    render(<ExecutionList />);
    expect(screen.getByText("1/2 steps")).toBeInTheDocument();
  });

  it("shows status badge", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({ id: "exec-1", status: "running" }));
    useMonitorStore.setState({ executions });

    render(<ExecutionList />);
    // Status icon + text
    expect(screen.getByText(/running/)).toBeInTheDocument();
  });

  it("shows error badge for errored execution", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({ id: "exec-1", status: "error" }));
    useMonitorStore.setState({ executions });

    render(<ExecutionList />);
    expect(screen.getByText(/error/)).toBeInTheDocument();
  });

  it("shows error message when present", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({
      id: "exec-1",
      status: "error",
      error: "Something went wrong",
    }));
    useMonitorStore.setState({ executions });

    render(<ExecutionList />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("truncates long error messages", () => {
    const longError = "A".repeat(200);
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({
      id: "exec-1",
      status: "error",
      error: longError,
    }));
    useMonitorStore.setState({ executions });

    render(<ExecutionList />);
    expect(screen.getByText(/\.\.\.$/)).toBeInTheDocument();
  });

  it("sets active execution on click", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({ id: "exec-1", chainName: "click-chain" }));
    useMonitorStore.setState({ executions });

    render(<ExecutionList />);
    fireEvent.click(screen.getByText("click-chain"));
    expect(useMonitorStore.getState().activeExecId).toBe("exec-1");
  });

  it("calls onOpenExecModal on double-click", () => {
    const onOpen = vi.fn();
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({ id: "exec-1", chainName: "dbl-chain" }));
    useMonitorStore.setState({ executions });

    render(<ExecutionList onOpenExecModal={onOpen} />);
    fireEvent.doubleClick(screen.getByText("dbl-chain"));
    expect(onOpen).toHaveBeenCalledWith("exec-1");
  });

  it("shows ON CANVAS tag when execution matches canvasExecId", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({ id: "exec-1" }));
    useMonitorStore.setState({ executions });
    useCanvasExecStore.setState({ canvasExecId: "exec-1" });

    render(<ExecutionList />);
    expect(screen.getByText("ON CANVAS")).toBeInTheDocument();
  });

  it("shows CHAIN tag when no pipelineName", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({ id: "exec-1" }));
    useMonitorStore.setState({ executions });
    useAppStore.setState({ pipelineName: null });

    render(<ExecutionList />);
    expect(screen.getByText("CHAIN")).toBeInTheDocument();
  });

  it("shows PIPELINE tag when chainName matches pipelineName", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({ id: "exec-1", chainName: "my-pipeline" }));
    useMonitorStore.setState({ executions });
    useAppStore.setState({ pipelineName: "my-pipeline" });

    render(<ExecutionList />);
    expect(screen.getByText("PIPELINE")).toBeInTheDocument();
  });

  it("shows BLOB tag for blob executions", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("blob_abc", makeExec({ id: "blob_abc", chainName: "blob-chain" }));
    useMonitorStore.setState({ executions });

    render(<ExecutionList />);
    expect(screen.getByText("BLOB")).toBeInTheDocument();
  });

  it("shows token counts when present", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({
      id: "exec-1",
      steps: {
        s1: { stepId: "s1", status: "done", inputTokens: 1500, outputTokens: 500 },
      },
    }));
    useMonitorStore.setState({ executions });

    render(<ExecutionList />);
    expect(screen.getByText(/1,500/)).toBeInTheDocument();
    expect(screen.getByText(/500/)).toBeInTheDocument();
  });

  it("shows duration for completed executions", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({
      id: "exec-1",
      status: "done",
      durationMs: 3500,
    }));
    useMonitorStore.setState({ executions });

    render(<ExecutionList />);
    expect(screen.getByText("3.5s")).toBeInTheDocument();
  });

  it("sorts executions newest first", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("old", makeExec({
      id: "old",
      chainName: "old-chain",
      startedAt: "2025-01-01T00:00:00Z",
    }));
    executions.set("new", makeExec({
      id: "new",
      chainName: "new-chain",
      startedAt: "2025-01-02T00:00:00Z",
    }));
    useMonitorStore.setState({ executions });

    render(<ExecutionList />);
    const names = screen.getAllByText(/chain/).map((el) => el.textContent);
    expect(names[0]).toBe("new-chain");
  });

  it("limits display to 10 executions", () => {
    const executions = new Map<string, ChainExecution>();
    for (let i = 0; i < 12; i++) {
      executions.set(`exec-${i}`, makeExec({
        id: `exec-${i}`,
        chainName: `chain-${i}`,
        startedAt: `2025-01-01T00:${String(i).padStart(2, "0")}:00Z`,
      }));
    }
    useMonitorStore.setState({ executions });

    render(<ExecutionList />);
    // Should show exactly 10 exec IDs
    const ids = screen.getAllByText(/^exec-/);
    expect(ids.length).toBe(10);
  });

  it("shows elapsed timer for running executions", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({
      id: "exec-1",
      status: "running",
      startedAt: new Date(Date.now() - 5000).toISOString(),
    }));
    useMonitorStore.setState({ executions });

    render(<ExecutionList />);
    // The timer should render some seconds value
    expect(screen.getByText(/\ds/)).toBeInTheDocument();
  });
});
