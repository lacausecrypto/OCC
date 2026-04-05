import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContextMenu, type ContextMenuItem } from "../../src/components/canvas/ContextMenu";

vi.mock("../../src/components/canvas/CanvasEditor.module.css", () => ({
  default: {
    ctxMenu: "ctxMenu", ctxItem: "ctxItem", ctxSep: "ctxSep",
    ctxIcon: "ctxIcon", ctxArrow: "ctxArrow", ctxDisabled: "ctxDisabled",
    ctxSubmenu: "ctxSubmenu",
  },
}));

describe("ContextMenu", () => {
  const items: (ContextMenuItem | "---")[] = [
    { label: "Delete", action: vi.fn(), icon: "🗑" },
    "---",
    { label: "Duplicate", action: vi.fn() },
    { label: "Disabled Item", action: vi.fn(), disabled: true },
  ];

  it("renders menu items", () => {
    render(<ContextMenu x={100} y={100} items={items} onClose={vi.fn()} />);
    expect(screen.getByText("Delete")).toBeInTheDocument();
    expect(screen.getByText("Duplicate")).toBeInTheDocument();
    expect(screen.getByText("Disabled Item")).toBeInTheDocument();
  });

  it("renders separator", () => {
    const { container } = render(
      <ContextMenu x={100} y={100} items={items} onClose={vi.fn()} />,
    );
    expect(container.querySelector(".ctxSep")).toBeInTheDocument();
  });

  it("renders icons", () => {
    render(<ContextMenu x={100} y={100} items={items} onClose={vi.fn()} />);
    expect(screen.getByText("🗑")).toBeInTheDocument();
  });

  it("calls action and onClose when item clicked", () => {
    const onClose = vi.fn();
    const action = vi.fn();
    const testItems: ContextMenuItem[] = [{ label: "Action", action }];
    render(<ContextMenu x={0} y={0} items={testItems} onClose={onClose} />);
    fireEvent.click(screen.getByText("Action"));
    expect(action).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call action on disabled item click", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={items} onClose={onClose} />);
    fireEvent.click(screen.getByText("Disabled Item"));
    expect((items[3] as ContextMenuItem).action).not.toHaveBeenCalled();
  });

  it("shows submenu arrow for items with sub", () => {
    const withSub: ContextMenuItem[] = [
      { label: "Parent", sub: [{ label: "Child", action: vi.fn() }] },
    ];
    render(<ContextMenu x={0} y={0} items={withSub} onClose={vi.fn()} />);
    expect(screen.getByText("▸")).toBeInTheDocument();
  });

  it("positions menu within viewport", () => {
    const { container } = render(
      <ContextMenu x={99999} y={99999} items={items} onClose={vi.fn()} />,
    );
    const menu = container.querySelector(".ctxMenu") as HTMLElement;
    const left = parseInt(menu.style.left);
    const top = parseInt(menu.style.top);
    expect(left).toBeLessThanOrEqual(window.innerWidth);
    expect(top).toBeLessThanOrEqual(window.innerHeight);
  });
});
