import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CollapseButton } from "../../src/components/layout/CollapseButton";

// Mock CSS modules
vi.mock("../../src/components/layout/AppLayout.module.css", () => ({
  default: {
    collapseBtn: "collapseBtn",
    collapseBtnLeft: "collapseBtnLeft",
    collapseBtnRight: "collapseBtnRight",
    collapsedChevron: "collapsedChevron",
  },
}));

describe("CollapseButton", () => {
  it("renders a button", () => {
    render(<CollapseButton side="left" collapsed={false} onClick={vi.fn()} />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("renders SVG with polyline", () => {
    const { container } = render(
      <CollapseButton side="left" collapsed={false} onClick={vi.fn()} />,
    );
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(container.querySelector("polyline")).toBeInTheDocument();
  });

  it("uses left chevron points for left side", () => {
    const { container } = render(
      <CollapseButton side="left" collapsed={false} onClick={vi.fn()} />,
    );
    const polyline = container.querySelector("polyline");
    expect(polyline?.getAttribute("points")).toBe("15 6 9 12 15 18");
  });

  it("uses right chevron points for right side", () => {
    const { container } = render(
      <CollapseButton side="right" collapsed={false} onClick={vi.fn()} />,
    );
    const polyline = container.querySelector("polyline");
    expect(polyline?.getAttribute("points")).toBe("9 6 15 12 9 18");
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<CollapseButton side="left" collapsed={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("applies collapsed class when collapsed", () => {
    render(<CollapseButton side="left" collapsed={true} onClick={vi.fn()} />);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("collapsedChevron");
  });

  it("does not apply collapsed class when expanded", () => {
    render(<CollapseButton side="left" collapsed={false} onClick={vi.fn()} />);
    const btn = screen.getByRole("button");
    expect(btn.className).not.toContain("collapsedChevron");
  });

  it("applies title attribute when provided", () => {
    render(
      <CollapseButton side="left" collapsed={false} onClick={vi.fn()} title="Toggle" />,
    );
    expect(screen.getByTitle("Toggle")).toBeInTheDocument();
  });

  it("applies left-specific class for left side", () => {
    render(<CollapseButton side="left" collapsed={false} onClick={vi.fn()} />);
    expect(screen.getByRole("button").className).toContain("collapseBtnLeft");
  });

  it("applies right-specific class for right side", () => {
    render(<CollapseButton side="right" collapsed={false} onClick={vi.fn()} />);
    expect(screen.getByRole("button").className).toContain("collapseBtnRight");
  });
});
