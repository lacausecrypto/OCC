import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChainCard } from "../../src/components/dashboard/ChainCard";
import { useServerStore } from "../../src/stores/server";

vi.mock("../../src/components/dashboard/Dashboard.module.css", () => ({
  default: {
    card: "card", cardName: "cardName", cardDesc: "cardDesc",
    cardMeta: "cardMeta", pill: "pill", pillAccent: "pillAccent",
    cardBottom: "cardBottom", cardStatus: "cardStatus", statusDot: "statusDot",
    online: "online", cardActions: "cardActions", btn: "btn",
    btnPrimary: "btnPrimary", btnSmall: "btnSmall",
  },
}));

vi.mock("../../src/components/dashboard/stepColors", () => ({
  getStepTypeColors: () => ({
    agent: "#0a84ff", router: "#bf5af2", transform: "#5e5ce6",
  }),
}));

describe("ChainCard", () => {
  const chain = {
    name: "deep-researcher",
    description: "Multi-perspective research",
    stepCount: 5,
    steps: [
      { type: "agent", id: "s1", pre_tools: ["web_search"], tools: ["Read"] },
      { type: "router", id: "s2", pre_tools: [], tools: [] },
      { type: "agent", id: "s3", pre_tools: ["bash"], tools: ["Write", "Edit"] },
    ],
  };

  it("renders chain name", () => {
    render(<ChainCard chain={chain} onRun={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("deep-researcher")).toBeInTheDocument();
  });

  it("renders description", () => {
    render(<ChainCard chain={chain} onRun={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("Multi-perspective research")).toBeInTheDocument();
  });

  it("shows step count", () => {
    render(<ChainCard chain={chain} onRun={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("5 steps")).toBeInTheDocument();
  });

  it("shows pre-tool count", () => {
    render(<ChainCard chain={chain} onRun={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("2 pre-tools")).toBeInTheDocument();
  });

  it("shows tool count", () => {
    render(<ChainCard chain={chain} onRun={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("3 tools")).toBeInTheDocument();
  });

  it("renders step type pills", () => {
    render(<ChainCard chain={chain} onRun={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("agent")).toBeInTheDocument();
    expect(screen.getByText("router")).toBeInTheDocument();
  });

  it("calls onRun when Run clicked", () => {
    const onRun = vi.fn();
    render(<ChainCard chain={chain} onRun={onRun} onEdit={vi.fn()} />);
    fireEvent.click(screen.getByText("Run"));
    expect(onRun).toHaveBeenCalledWith("deep-researcher");
  });

  it("calls onEdit when Edit clicked", () => {
    const onEdit = vi.fn();
    render(<ChainCard chain={chain} onRun={vi.fn()} onEdit={onEdit} />);
    fireEvent.click(screen.getByText("Edit"));
    expect(onEdit).toHaveBeenCalledWith("deep-researcher");
  });

  it("shows offline status when server is offline", () => {
    useServerStore.setState({ serverOnline: false });
    render(<ChainCard chain={chain} onRun={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("offline")).toBeInTheDocument();
  });

  it("shows ready status when server is online", () => {
    useServerStore.setState({ serverOnline: true });
    render(<ChainCard chain={chain} onRun={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("ready")).toBeInTheDocument();
  });

  it("handles chain without description", () => {
    render(<ChainCard chain={{ name: "test", stepCount: 1 }} onRun={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("test")).toBeInTheDocument();
  });

  it("handles chain without steps array", () => {
    render(<ChainCard chain={{ name: "test", stepCount: 3 }} onRun={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("3 steps")).toBeInTheDocument();
    expect(screen.getByText("0 pre-tools")).toBeInTheDocument();
  });
});
