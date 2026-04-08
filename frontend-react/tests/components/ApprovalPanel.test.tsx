import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GateApprovalPanel } from "../../src/components/monitor/GateApprovalPanel";
import { useServerStore } from "../../src/stores/server";

vi.mock("../../src/components/monitor/Monitor.module.css", () => ({
  default: {
    connectBtn: "connectBtn",
  },
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function makeApproval(overrides: Record<string, unknown> = {}) {
  return {
    executionId: "exec-1",
    stepId: "step-1",
    chainName: "test-chain",
    title: "Approve deployment",
    description: "This will deploy to production",
    createdAt: new Date().toISOString(),
    actions: ["approve", "reject"],
    ...overrides,
  };
}

describe("GateApprovalPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useServerStore.setState({
      occServerUrl: "http://localhost:4242",
      apiKey: null,
    });
    // Default: return empty approvals
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
  });

  it("renders nothing when no approvals and not loading", async () => {
    const { container } = render(<GateApprovalPanel />);
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
    // After loading completes with empty array, should render nothing
    await waitFor(() => {
      expect(container.innerHTML).toBe("");
    });
  });

  it("renders approvals when present", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([makeApproval()]),
    });

    render(<GateApprovalPanel />);
    await waitFor(() => {
      expect(screen.getByText("Approve deployment")).toBeInTheDocument();
    });
    expect(screen.getByText("Pending Approvals (1)")).toBeInTheDocument();
    expect(screen.getByText("This will deploy to production")).toBeInTheDocument();
  });

  it("shows chain and step info", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([makeApproval()]),
    });

    render(<GateApprovalPanel />);
    await waitFor(() => {
      expect(screen.getByText(/test-chain/)).toBeInTheDocument();
      expect(screen.getByText(/step-1/)).toBeInTheDocument();
    });
  });

  it("shows default title when no title provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([makeApproval({ title: undefined })]),
    });

    render(<GateApprovalPanel />);
    await waitFor(() => {
      expect(screen.getByText("Gate: step-1")).toBeInTheDocument();
    });
  });

  it("renders approve and reject buttons", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([makeApproval()]),
    });

    render(<GateApprovalPanel />);
    await waitFor(() => {
      expect(screen.getByText("Approve")).toBeInTheDocument();
      expect(screen.getByText("Reject")).toBeInTheDocument();
    });
  });

  it("calls approve endpoint on Approve click", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([makeApproval()]),
      })
      .mockResolvedValueOnce({ ok: true });

    render(<GateApprovalPanel />);
    await waitFor(() => {
      expect(screen.getByText("Approve")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => {
      const calls = mockFetch.mock.calls;
      const approveCall = calls.find(
        (c: unknown[]) => typeof c[0] === "string" && c[0].includes("/approve/"),
      );
      expect(approveCall).toBeDefined();
      expect(approveCall![1].method).toBe("POST");
      const body = JSON.parse(approveCall![1].body);
      expect(body.action).toBe("approve");
    });
  });

  it("calls reject endpoint with reason on Reject click", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([makeApproval()]),
      })
      .mockResolvedValueOnce({ ok: true });

    render(<GateApprovalPanel />);
    await waitFor(() => {
      expect(screen.getByText("Reject")).toBeInTheDocument();
    });

    // Type a reason
    const input = screen.getByPlaceholderText("Rejection reason (optional)...");
    fireEvent.change(input, { target: { value: "Not ready" } });

    fireEvent.click(screen.getByText("Reject"));

    await waitFor(() => {
      const calls = mockFetch.mock.calls;
      const rejectCall = calls.find(
        (c: unknown[]) => typeof c[0] === "string" && c[0].includes("/approve/"),
      );
      expect(rejectCall).toBeDefined();
      const body = JSON.parse(rejectCall![1].body);
      expect(body.action).toBe("reject");
      expect(body.reason).toBe("Not ready");
    });
  });

  it("removes approval from list after successful action", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([makeApproval()]),
      })
      .mockResolvedValueOnce({ ok: true });

    render(<GateApprovalPanel />);
    await waitFor(() => {
      expect(screen.getByText("Approve deployment")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => {
      expect(screen.queryByText("Approve deployment")).not.toBeInTheDocument();
    });
  });

  it("shows Refresh button that re-fetches approvals", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([makeApproval()]),
    });

    render(<GateApprovalPanel />);
    await waitFor(() => {
      expect(screen.getByText("Refresh")).toBeInTheDocument();
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([makeApproval(), makeApproval({ stepId: "step-2", title: "Second gate" })]),
    });

    fireEvent.click(screen.getByText("Refresh"));
    await waitFor(() => {
      expect(screen.getByText("Pending Approvals (2)")).toBeInTheDocument();
    });
  });

  it("shows Expired label for expired approvals", async () => {
    const pastDate = new Date(Date.now() - 60000).toISOString();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([makeApproval({ expiresAt: pastDate })]),
    });

    render(<GateApprovalPanel />);
    await waitFor(() => {
      expect(screen.getByText("Expired")).toBeInTheDocument();
    });
  });

  it("sends Authorization header when apiKey is set", async () => {
    useServerStore.setState({ apiKey: "my-secret-key" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    render(<GateApprovalPanel />);
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    const call = mockFetch.mock.calls[0];
    expect(call[1].headers.Authorization).toBe("Bearer my-secret-key");
  });

  it("handles fetch error gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const { container } = render(<GateApprovalPanel />);
    await waitFor(() => {
      // Should not crash, just render empty
      expect(container.querySelector("[style]")).toBeNull();
    });
  });

  it("shows time ago for recent approvals", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([makeApproval({ createdAt: new Date().toISOString() })]),
    });

    render(<GateApprovalPanel />);
    await waitFor(() => {
      expect(screen.getByText("just now")).toBeInTheDocument();
    });
  });
});
