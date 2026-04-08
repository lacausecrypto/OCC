import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LogViewer } from "../../src/components/monitor/LogViewer";
import { useMonitorStore } from "../../src/stores/monitor";
import { useCanvasStore } from "../../src/stores/canvas";
import { useCanvasExecStore } from "../../src/stores/canvasExec";
import { useAppStore } from "../../src/stores/app";
import type { ExecutionEvent, ChainExecution } from "../../src/types/execution";

vi.mock("../../src/components/monitor/Monitor.module.css", () => ({
  default: {
    monOpts: "monOpts",
    monCheck: "monCheck",
    btn: "btn",
    logFilters: "logFilters",
    logFilterSelect: "logFilterSelect",
    logSearch: "logSearch",
    logHeader: "logHeader",
    sectionTitle: "sectionTitle",
    eventCount: "eventCount",
    log: "log",
    logEntry: "logEntry",
    logEntryClickable: "logEntryClickable",
    logEntryActive: "logEntryActive",
    logTime: "logTime",
    logType: "logType",
    logMsg: "logMsg",
    logGoIcon: "logGoIcon",
    logExecBadge: "logExecBadge",
    logExecutionStarted: "logExecutionStarted",
    logExecutionDone: "logExecutionDone",
    logExecutionError: "logExecutionError",
    logStepStarted: "logStepStarted",
    logStepDone: "logStepDone",
    logStepError: "logStepError",
    logStepOutput: "logStepOutput",
    logStepLog: "logStepLog",
    logStepCacheHit: "logStepCacheHit",
    logStepWaitingApproval: "logStepWaitingApproval",
  },
}));

function makeEvent(overrides: Partial<ExecutionEvent> & { type: string }): ExecutionEvent {
  return {
    executionId: "exec-1",
    ...overrides,
  } as ExecutionEvent;
}

describe("LogViewer", () => {
  beforeEach(() => {
    useMonitorStore.setState({
      events: [],
      executions: new Map(),
      activeExecId: null,
    });
  });

  it("renders empty log with event count 0", () => {
    render(<LogViewer />);
    expect(screen.getByText("Events")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("renders execution_started events", () => {
    const events: ExecutionEvent[] = [
      makeEvent({ type: "execution_started", chainName: "my-chain", executionId: "exec-1" }),
    ];
    useMonitorStore.setState({ events });

    render(<LogViewer />);
    // Type label appears in both filter dropdown and log entry
    expect(screen.getAllByText(/EXEC START/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/my-chain/).length).toBeGreaterThanOrEqual(1);
  });

  it("renders step_started events", () => {
    const events: ExecutionEvent[] = [
      makeEvent({ type: "step_started", stepId: "step-1", label: "Research", executionId: "exec-1" }),
    ];
    useMonitorStore.setState({ events });

    render(<LogViewer />);
    expect(screen.getAllByText(/STEP START/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/step-1/)).toBeInTheDocument();
  });

  it("renders step_done events with duration", () => {
    const events: ExecutionEvent[] = [
      makeEvent({ type: "step_done", stepId: "step-1", durationMs: 2500, executionId: "exec-1" }),
    ];
    useMonitorStore.setState({ events });

    render(<LogViewer />);
    expect(screen.getAllByText(/STEP DONE/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/2\.5s/)).toBeInTheDocument();
  });

  it("renders step_error events", () => {
    const events: ExecutionEvent[] = [
      makeEvent({ type: "step_error", stepId: "step-1", error: "timeout", executionId: "exec-1" }),
    ];
    useMonitorStore.setState({ events });

    render(<LogViewer />);
    expect(screen.getAllByText(/STEP ERROR/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/timeout/)).toBeInTheDocument();
  });

  it("renders step_output events", () => {
    const events: ExecutionEvent[] = [
      makeEvent({ type: "step_output", stepId: "step-1", chunk: "Hello world", executionId: "exec-1" }),
    ];
    useMonitorStore.setState({ events });

    render(<LogViewer />);
    expect(screen.getAllByText(/OUTPUT/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Hello world/)).toBeInTheDocument();
  });

  it("renders step_log events", () => {
    const events: ExecutionEvent[] = [
      makeEvent({ type: "step_log", stepId: "step-1", message: "Processing data", level: "info", executionId: "exec-1" }),
    ];
    useMonitorStore.setState({ events });

    render(<LogViewer />);
    expect(screen.getAllByText(/LOG/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Processing data/)).toBeInTheDocument();
  });

  it("renders gate_action events", () => {
    const events: ExecutionEvent[] = [
      makeEvent({ type: "gate_action", stepId: "step-1", action: "approve", reason: "looks good", executionId: "exec-1" }),
    ];
    useMonitorStore.setState({ events });

    render(<LogViewer />);
    expect(screen.getAllByText(/GATE/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/looks good/)).toBeInTheDocument();
  });

  it("renders step_cache_hit events", () => {
    const events: ExecutionEvent[] = [
      makeEvent({ type: "step_cache_hit", stepId: "step-1", executionId: "exec-1" }),
    ];
    useMonitorStore.setState({ events });

    render(<LogViewer />);
    expect(screen.getAllByText(/CACHE HIT/).length).toBeGreaterThanOrEqual(1);
  });

  it("renders step_waiting_approval events", () => {
    const events: ExecutionEvent[] = [
      makeEvent({ type: "step_waiting_approval", stepId: "step-1", prompt: "approve?", executionId: "exec-1" }),
    ];
    useMonitorStore.setState({ events });

    render(<LogViewer />);
    expect(screen.getAllByText(/GATE WAIT/).length).toBeGreaterThanOrEqual(1);
  });

  it("shows event count", () => {
    const events: ExecutionEvent[] = [
      makeEvent({ type: "execution_started", chainName: "c1", executionId: "exec-1" }),
      makeEvent({ type: "step_started", stepId: "s1", executionId: "exec-1" }),
      makeEvent({ type: "step_done", stepId: "s1", durationMs: 100, executionId: "exec-1" }),
    ];
    useMonitorStore.setState({ events });

    render(<LogViewer />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("clears events on Clear button click", () => {
    const events: ExecutionEvent[] = [
      makeEvent({ type: "execution_started", chainName: "c1", executionId: "exec-1" }),
    ];
    useMonitorStore.setState({ events });

    render(<LogViewer />);
    fireEvent.click(screen.getByText("Clear"));
    expect(useMonitorStore.getState().events).toHaveLength(0);
  });

  it("toggles auto-scroll checkbox", () => {
    render(<LogViewer />);
    const label = screen.getByText("Auto");
    // The checkbox is inside the label element
    const checkbox = label.closest("label")?.querySelector("input[type='checkbox']") as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it("toggles timestamps checkbox", () => {
    render(<LogViewer />);
    const label = screen.getByText("Time");
    expect(label).toBeInTheDocument();
  });

  it("filters events by execution ID", () => {
    const events: ExecutionEvent[] = [
      makeEvent({ type: "execution_started", chainName: "c1", executionId: "exec-1" }),
      makeEvent({ type: "execution_started", chainName: "c2", executionId: "exec-2" }),
    ];
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", {
      id: "exec-1", chainName: "c1", status: "done",
      input: {}, steps: {}, startedAt: "",
    });
    executions.set("exec-2", {
      id: "exec-2", chainName: "c2", status: "done",
      input: {}, steps: {}, startedAt: "",
    });
    useMonitorStore.setState({ events, executions });

    render(<LogViewer />);

    // Filter by exec-1
    const selectEl = screen.getByTitle("Filter by execution");
    fireEvent.change(selectEl, { target: { value: "exec-1" } });

    // Should show filtered count
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("filters events by type", () => {
    const events: ExecutionEvent[] = [
      makeEvent({ type: "execution_started", chainName: "c1", executionId: "exec-1" }),
      makeEvent({ type: "step_started", stepId: "s1", executionId: "exec-1" }),
      makeEvent({ type: "step_done", stepId: "s1", durationMs: 100, executionId: "exec-1" }),
    ];
    useMonitorStore.setState({ events });

    render(<LogViewer />);

    const typeSelect = screen.getByTitle("Filter by event type");
    fireEvent.change(typeSelect, { target: { value: "step_started" } });

    expect(screen.getByText("1/3")).toBeInTheDocument();
  });

  it("filters events by search query", () => {
    const events: ExecutionEvent[] = [
      makeEvent({ type: "step_output", stepId: "s1", chunk: "hello world", executionId: "exec-1" }),
      makeEvent({ type: "step_output", stepId: "s2", chunk: "goodbye moon", executionId: "exec-1" }),
    ];
    useMonitorStore.setState({ events });

    render(<LogViewer />);

    const searchInput = screen.getByPlaceholderText("Search...");
    fireEvent.change(searchInput, { target: { value: "hello" } });

    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("shows BLOB badge for blob execution events", () => {
    const events: ExecutionEvent[] = [
      makeEvent({ type: "execution_started", chainName: "c1", executionId: "blob_123" }),
    ];
    useMonitorStore.setState({ events });

    render(<LogViewer />);
    expect(screen.getByText("BLOB")).toBeInTheDocument();
  });

  it("limits visible events to last 100", () => {
    const events: ExecutionEvent[] = [];
    for (let i = 0; i < 120; i++) {
      events.push(makeEvent({
        type: "step_output",
        stepId: `s${i}`,
        chunk: `output-${i}`,
        executionId: "exec-1",
      }));
    }
    useMonitorStore.setState({ events });

    render(<LogViewer />);
    // Total event count should show 120
    expect(screen.getByText("120")).toBeInTheDocument();
    // But only last 100 are rendered - check that early ones are not visible
    expect(screen.queryByText(/output-0$/)).not.toBeInTheDocument();
    expect(screen.getByText(/output-119/)).toBeInTheDocument();
  });
});
