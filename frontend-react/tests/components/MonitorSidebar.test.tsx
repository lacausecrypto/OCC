import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MonitorSidebar } from "../../src/components/monitor/MonitorSidebar";
import { useServerStore } from "../../src/stores/server";
import { useMonitorStore } from "../../src/stores/monitor";
import { useCanvasExecStore } from "../../src/stores/canvasExec";
import type { ChainExecution } from "../../src/types/execution";

vi.mock("../../src/components/monitor/Monitor.module.css", () => ({
  default: {
    monHeader: "monHeader",
    monTitle: "monTitle",
    monStatus: "monStatus",
    statusDot: "statusDot",
    statusConnected: "statusConnected",
    statusReconnecting: "statusReconnecting",
    statusDisconnected: "statusDisconnected",
    connectRow: "connectRow",
    connectInput: "connectInput",
    btn: "btn",
    btnPrimary: "btnPrimary",
    quickStats: "quickStats",
    qsStat: "qsStat",
    qsDot: "qsDot",
    ctxBanner: "ctxBanner",
    ctxBannerIcon: "ctxBannerIcon",
    sectionTitle: "sectionTitle",
    sectionBadge: "sectionBadge",
    sectionClearBtn: "sectionClearBtn",
    // Include all css keys that child components might use
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
    timeline: "timeline",
    monOpts: "monOpts",
    monCheck: "monCheck",
    logFilters: "logFilters",
    logFilterSelect: "logFilterSelect",
    logSearch: "logSearch",
    logHeader: "logHeader",
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
    connectBtn: "connectBtn",
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

// Mock child components that are heavy or fetch data
const mockConnectSSE = vi.fn();
const mockDisconnectSSE = vi.fn();

vi.mock("../../src/hooks/useSSE", () => ({
  useSSE: () => ({
    sseStatus: "disconnected" as const,
    connectSSE: mockConnectSSE,
    disconnectSSE: mockDisconnectSSE,
  }),
}));

// Mock GateApprovalPanel to avoid fetch calls
vi.mock("../../src/components/monitor/GateApprovalPanel", () => ({
  GateApprovalPanel: () => <div data-testid="gate-panel" />,
}));

// Mock ExecResultModal
vi.mock("../../src/components/modals", () => ({
  ExecResultModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="exec-modal">
      <button onClick={onClose}>Close modal</button>
    </div>
  ),
}));

// Mock fetch for the monitor store connect
globalThis.fetch = vi.fn().mockResolvedValue({ ok: false });

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

describe("MonitorSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useServerStore.setState({
      occServerUrl: "http://localhost:4242",
      apiKey: null,
    });
    useMonitorStore.setState({
      executions: new Map(),
      activeExecId: null,
      events: [],
    });
    useCanvasExecStore.setState({ canvasExecId: null });
  });

  it("renders the Live Monitor header", () => {
    render(<MonitorSidebar />);
    expect(screen.getByText("Live Monitor")).toBeInTheDocument();
  });

  it("shows Disconnected status by default", () => {
    render(<MonitorSidebar />);
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });

  it("shows Connect button when disconnected", () => {
    render(<MonitorSidebar />);
    expect(screen.getByText("Connect")).toBeInTheDocument();
  });

  it("renders URL input with default server URL", () => {
    render(<MonitorSidebar />);
    const input = screen.getByPlaceholderText("http://localhost:4242");
    expect(input).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("http://localhost:4242");
  });

  it("calls connectSSE when Connect is clicked", () => {
    render(<MonitorSidebar />);
    fireEvent.click(screen.getByText("Connect"));
    expect(mockConnectSSE).toHaveBeenCalled();
  });

  it("shows Executions section title", () => {
    render(<MonitorSidebar />);
    expect(screen.getByText("Executions")).toBeInTheDocument();
  });

  it("shows Timeline section title", () => {
    render(<MonitorSidebar />);
    expect(screen.getByText("Timeline")).toBeInTheDocument();
  });

  it("shows execution count badge", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("exec-1", makeExec({ id: "exec-1" }));
    executions.set("exec-2", makeExec({ id: "exec-2" }));
    useMonitorStore.setState({ executions });

    render(<MonitorSidebar />);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows quick stats when executions exist", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("e1", makeExec({ id: "e1", status: "done" }));
    executions.set("e2", makeExec({ id: "e2", status: "running" }));
    executions.set("e3", makeExec({ id: "e3", status: "error" }));
    useMonitorStore.setState({ executions });

    render(<MonitorSidebar />);
    expect(screen.getByText("1 running")).toBeInTheDocument();
    expect(screen.getByText("1 done")).toBeInTheDocument();
    expect(screen.getByText("1 error")).toBeInTheDocument();
  });

  it("hides quick stats when no executions", () => {
    render(<MonitorSidebar />);
    expect(screen.queryByText("running")).not.toBeInTheDocument();
    expect(screen.queryByText(/done/)).not.toBeInTheDocument();
  });

  it("shows Clear button when executions exist", () => {
    const executions = new Map<string, ChainExecution>();
    executions.set("e1", makeExec({ id: "e1" }));
    useMonitorStore.setState({ executions });

    render(<MonitorSidebar />);
    // The Clear button in the Executions section
    const clearBtns = screen.getAllByText("Clear");
    expect(clearBtns.length).toBeGreaterThan(0);
  });

  it("renders gate approval panel", () => {
    render(<MonitorSidebar />);
    expect(screen.getByTestId("gate-panel")).toBeInTheDocument();
  });

  it("allows URL input change", () => {
    render(<MonitorSidebar />);
    const input = screen.getByPlaceholderText("http://localhost:4242");
    fireEvent.change(input, { target: { value: "http://example.com:8080" } });
    expect((input as HTMLInputElement).value).toBe("http://example.com:8080");
  });
});
