import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CanvasZoom } from "../../src/components/canvas/CanvasZoom";
import { useCanvasExecStore } from "../../src/stores/canvasExec";

vi.mock("../../src/components/canvas/CanvasEditor.module.css", () => ({
  default: { zoomControls: "zoomControls", zbtn: "zbtn" },
}));

vi.mock("../../src/stores/canvas", () => ({
  useCanvasStore: { getState: () => ({ nodes: new Map() }) },
}));

describe("CanvasZoom", () => {
  beforeEach(() => {
    useCanvasExecStore.getState().clearExecState();
  });

  it("renders zoom in, zoom out, and fit buttons", () => {
    render(<CanvasZoom onZoomIn={vi.fn()} onZoomOut={vi.fn()} onZoomFit={vi.fn()} />);
    expect(screen.getByText("+")).toBeInTheDocument();
    expect(screen.getByText("−")).toBeInTheDocument();
    expect(screen.getByText("Fit")).toBeInTheDocument();
  });

  it("calls onZoomIn when + clicked", () => {
    const onZoomIn = vi.fn();
    render(<CanvasZoom onZoomIn={onZoomIn} onZoomOut={vi.fn()} onZoomFit={vi.fn()} />);
    fireEvent.click(screen.getByText("+"));
    expect(onZoomIn).toHaveBeenCalledOnce();
  });

  it("calls onZoomOut when − clicked", () => {
    const onZoomOut = vi.fn();
    render(<CanvasZoom onZoomIn={vi.fn()} onZoomOut={onZoomOut} onZoomFit={vi.fn()} />);
    fireEvent.click(screen.getByText("−"));
    expect(onZoomOut).toHaveBeenCalledOnce();
  });

  it("calls onZoomFit when Fit clicked", () => {
    const onZoomFit = vi.fn();
    render(<CanvasZoom onZoomIn={vi.fn()} onZoomOut={vi.fn()} onZoomFit={onZoomFit} />);
    fireEvent.click(screen.getByText("Fit"));
    expect(onZoomFit).toHaveBeenCalledOnce();
  });

  it("does not show Clear button when no exec state", () => {
    render(<CanvasZoom onZoomIn={vi.fn()} onZoomOut={vi.fn()} onZoomFit={vi.fn()} />);
    expect(screen.queryByText("Clear")).not.toBeInTheDocument();
  });

  it("shows Clear button when exec state exists", () => {
    useCanvasExecStore.setState({
      nodeExecState: new Map([["n1", { status: "done", output: [] }]]),
      canvasExecId: "exec1",
    });
    render(<CanvasZoom onZoomIn={vi.fn()} onZoomOut={vi.fn()} onZoomFit={vi.fn()} />);
    expect(screen.getByText("Clear")).toBeInTheDocument();
  });

  it("clears exec state when Clear clicked", () => {
    useCanvasExecStore.setState({
      nodeExecState: new Map([["n1", { status: "done", output: [] }]]),
      canvasExecId: "exec1",
    });
    render(<CanvasZoom onZoomIn={vi.fn()} onZoomOut={vi.fn()} onZoomFit={vi.fn()} />);
    fireEvent.click(screen.getByText("Clear"));
    expect(useCanvasExecStore.getState().nodeExecState.size).toBe(0);
  });
});
