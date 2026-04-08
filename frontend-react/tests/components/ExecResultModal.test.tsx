import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../src/components/modals/Modal.module.css", () => ({
  default: {
    overlay: "overlay",
    modal: "modal",
    execModal: "execModal",
    header: "header",
    headerTitle: "headerTitle",
    closeBtn: "closeBtn",
    execTabs: "execTabs",
    execTab: "execTab",
    execTabActive: "execTabActive",
    execContent: "execContent",
    execActions: "execActions",
    emptyState: "emptyState",
    resultText: "resultText",
    rendered: "rendered",
    stepCard: "stepCard",
    stepCardError: "stepCardError",
    stepHeader: "stepHeader",
    stepStatus: "stepStatus",
    stepName: "stepName",
    stepMeta: "stepMeta",
    stepOutput: "stepOutput",
    stepErrorMsg: "stepErrorMsg",
    stepSeparator: "stepSeparator",
    footerInfo: "footerInfo",
    btn: "btn",
  },
}));

const mockFetchExecution = vi.fn();

vi.mock("../../src/api/executions", () => ({
  fetchExecution: (...args: unknown[]) => mockFetchExecution(...args),
}));

vi.mock("../../src/utils/markdown", () => ({
  mdToHtml: (md: string) => `<p>${md}</p>`,
}));

vi.mock("../../src/utils/escape", () => ({
  esc: (s: unknown) => String(s ?? ""),
}));

const mockExecutions = new Map();

vi.mock("../../src/stores/server", () => ({
  useServerStore: () => ({ serverOnline: true }),
}));

vi.mock("../../src/stores/monitor", () => ({
  useMonitorStore: () => ({ executions: mockExecutions }),
}));

import { ExecResultModal } from "../../src/components/modals/ExecResultModal";
import type { ChainExecution } from "../../src/types/execution";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeExecution(overrides: Partial<ChainExecution> = {}): ChainExecution {
  return {
    id: "exec-001",
    chainName: "test-chain",
    status: "done",
    input: {},
    steps: {
      step1: {
        stepId: "step1",
        status: "done",
        output: "Step 1 output text",
        durationMs: 1200,
        inputTokens: 100,
        outputTokens: 50,
      },
    },
    result: "Final result text",
    startedAt: "2025-01-01T00:00:00Z",
    finishedAt: "2025-01-01T00:00:01Z",
    durationMs: 1200,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ExecResultModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecutions.clear();
    // Mock clipboard
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    // Mock URL.createObjectURL / revokeObjectURL
    globalThis.URL.createObjectURL = vi.fn(() => "blob:test");
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it("shows loading state before data arrives", () => {
    mockFetchExecution.mockReturnValue(new Promise(() => {}));
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("calls onClose when close button clicked (loading state)", () => {
    mockFetchExecution.mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    render(<ExecResultModal executionId="exec-001" onClose={onClose} />);
    fireEvent.click(screen.getByText("\u00d7"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders execution data after fetch", async () => {
    const exec = makeExecution();
    mockFetchExecution.mockResolvedValue(exec);
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("test-chain")).toBeInTheDocument();
    });
    expect(screen.getByText("exec-001")).toBeInTheDocument();
  });

  it("shows step data on Steps tab", async () => {
    const exec = makeExecution();
    mockFetchExecution.mockResolvedValue(exec);
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("step1")).toBeInTheDocument();
    });
    expect(screen.getByText("Step 1 output text")).toBeInTheDocument();
  });

  it("shows Steps tab count", async () => {
    mockFetchExecution.mockResolvedValue(makeExecution());
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Steps (1)")).toBeInTheDocument();
    });
  });

  it("shows duration in footer", async () => {
    mockFetchExecution.mockResolvedValue(makeExecution({ durationMs: 3500 }));
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/3\.5s/)).toBeInTheDocument();
    });
  });

  it("shows token totals", async () => {
    mockFetchExecution.mockResolvedValue(makeExecution());
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      // Token display: "100→50 tok (150)"
      expect(screen.getByText(/100.*50 tok.*150/)).toBeInTheDocument();
    });
  });

  it("switches to Raw Result tab", async () => {
    mockFetchExecution.mockResolvedValue(makeExecution());
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("test-chain")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Raw Result"));
    expect(screen.getByText("Final result text")).toBeInTheDocument();
  });

  it("switches to Rendered tab", async () => {
    mockFetchExecution.mockResolvedValue(makeExecution({ result: "**bold**" }));
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("test-chain")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Rendered"));
    // mdToHtml mock wraps in <p> tags
    await waitFor(() => {
      expect(screen.getByText("**bold**")).toBeInTheDocument();
    });
  });

  it("shows 'No output.' on Raw Result tab when no result", async () => {
    mockFetchExecution.mockResolvedValue(
      makeExecution({ result: undefined, steps: {} }),
    );
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("test-chain")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Raw Result"));
    expect(screen.getByText("No output.")).toBeInTheDocument();
  });

  it("shows 'No step data available.' when steps are empty", async () => {
    mockFetchExecution.mockResolvedValue(makeExecution({ steps: {} }));
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("No step data available.")).toBeInTheDocument();
    });
  });

  it("shows 'No output to render.' on Rendered tab when no output", async () => {
    mockFetchExecution.mockResolvedValue(
      makeExecution({ result: undefined, steps: {} }),
    );
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("test-chain")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Rendered"));
    expect(screen.getByText("No output to render.")).toBeInTheDocument();
  });

  it("shows step error message", async () => {
    mockFetchExecution.mockResolvedValue(
      makeExecution({
        steps: {
          step1: {
            stepId: "step1",
            status: "error",
            error: "Something went wrong",
          },
        },
      }),
    );
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/Something went wrong/)).toBeInTheDocument();
    });
  });

  it("handles Copy button click", async () => {
    mockFetchExecution.mockResolvedValue(makeExecution());
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Copy")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Copy"));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Final result text");
    });
    await waitFor(() => {
      expect(screen.getByText("Copied!")).toBeInTheDocument();
    });
  });

  it("renders Download .md button", async () => {
    mockFetchExecution.mockResolvedValue(makeExecution());
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Download .md")).toBeInTheDocument();
    });
  });

  it("renders Open as HTML button", async () => {
    mockFetchExecution.mockResolvedValue(makeExecution());
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Open as HTML")).toBeInTheDocument();
    });
  });

  it("falls back to monitor store when fetch fails", async () => {
    const exec = makeExecution();
    mockExecutions.set("exec-001", exec);
    mockFetchExecution.mockRejectedValue(new Error("offline"));
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("test-chain")).toBeInTheDocument();
    });
  });

  it("shows status icon for done execution", async () => {
    mockFetchExecution.mockResolvedValue(makeExecution({ status: "done" }));
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      // checkmark icon for done
      expect(screen.getByText("\u2713")).toBeInTheDocument();
    });
  });

  it("shows status icon for error execution", async () => {
    mockFetchExecution.mockResolvedValue(makeExecution({ status: "error" }));
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      // X icon for error
      expect(screen.getByText("\u2717")).toBeInTheDocument();
    });
  });

  it("shows step duration and token info", async () => {
    mockFetchExecution.mockResolvedValue(makeExecution());
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      // "done · 1.2s · 100→50 tok"
      expect(screen.getByText(/done.*1\.2s.*100.*50 tok/)).toBeInTheDocument();
    });
  });

  it("formats JSON output in steps", async () => {
    mockFetchExecution.mockResolvedValue(
      makeExecution({
        steps: {
          step1: {
            stepId: "step1",
            status: "done",
            output: '{"key":"value"}',
          },
        },
      }),
    );
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      // JSON is pretty-printed
      expect(screen.getByText(/"key": "value"/)).toBeInTheDocument();
    });
  });

  it("calls onClose when close button clicked (loaded state)", async () => {
    mockFetchExecution.mockResolvedValue(makeExecution());
    const onClose = vi.fn();
    render(<ExecResultModal executionId="exec-001" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText("test-chain")).toBeInTheDocument();
    });
    // There are two close buttons but we get the one in loaded state
    const closeBtns = screen.getAllByText("\u00d7");
    fireEvent.click(closeBtns[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows execution status when no duration", async () => {
    mockFetchExecution.mockResolvedValue(
      makeExecution({ durationMs: undefined, status: "running" }),
    );
    render(<ExecResultModal executionId="exec-001" onClose={vi.fn()} />);
    await waitFor(() => {
      // Footer shows status when no duration
      expect(screen.getByText("running")).toBeInTheDocument();
    });
  });
});
