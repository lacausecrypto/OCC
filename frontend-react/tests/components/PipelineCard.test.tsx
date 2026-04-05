import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PipelineCard } from "../../src/components/dashboard/PipelineCard";

vi.mock("../../src/components/dashboard/Dashboard.module.css", () => ({
  default: {
    card: "card", cardName: "cardName", cardDesc: "cardDesc",
    cardMeta: "cardMeta", pill: "pill", pillPipeline: "pillPipeline",
    pillAccent: "pillAccent", cardBottom: "cardBottom", cardStatus: "cardStatus",
    statusDot: "statusDot", online: "online", cardActions: "cardActions",
    btn: "btn", btnPrimary: "btnPrimary", btnSmall: "btnSmall",
  },
}));

describe("PipelineCard", () => {
  const pipeline = {
    name: "full-security-review",
    description: "End-to-end security pipeline",
    chainCount: 3,
    chains: ["research", "audit", "report"],
  };

  it("renders pipeline name", () => {
    render(<PipelineCard pipeline={pipeline} onRun={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("full-security-review")).toBeInTheDocument();
  });

  it("renders pipeline badge", () => {
    render(<PipelineCard pipeline={pipeline} onRun={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("pipeline")).toBeInTheDocument();
  });

  it("renders description", () => {
    render(<PipelineCard pipeline={pipeline} onRun={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("End-to-end security pipeline")).toBeInTheDocument();
  });

  it("renders chain name pills", () => {
    render(<PipelineCard pipeline={pipeline} onRun={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("research")).toBeInTheDocument();
    expect(screen.getByText("audit")).toBeInTheDocument();
    expect(screen.getByText("report")).toBeInTheDocument();
  });

  it("shows stage count", () => {
    render(<PipelineCard pipeline={pipeline} onRun={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText("3 stages")).toBeInTheDocument();
  });

  it("calls onRun with pipeline name", () => {
    const onRun = vi.fn();
    render(<PipelineCard pipeline={pipeline} onRun={onRun} onEdit={vi.fn()} />);
    fireEvent.click(screen.getByText("Run"));
    expect(onRun).toHaveBeenCalledWith("full-security-review");
  });

  it("calls onEdit with pipeline name", () => {
    const onEdit = vi.fn();
    render(<PipelineCard pipeline={pipeline} onRun={vi.fn()} onEdit={onEdit} />);
    fireEvent.click(screen.getByText("Edit"));
    expect(onEdit).toHaveBeenCalledWith("full-security-review");
  });

  it("handles pipeline without chains array", () => {
    render(
      <PipelineCard
        pipeline={{ name: "test", chainCount: 2 }}
        onRun={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByText("2 stages")).toBeInTheDocument();
  });
});
