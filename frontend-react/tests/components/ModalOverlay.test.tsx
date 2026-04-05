import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModalOverlay } from "../../src/components/modals/ModalOverlay";

vi.mock("../../src/components/modals/Modal.module.css", () => ({
  default: { overlay: "overlay" },
}));

describe("ModalOverlay", () => {
  it("renders children", () => {
    render(
      <ModalOverlay onClose={vi.fn()}>
        <div>Modal Content</div>
      </ModalOverlay>,
    );
    expect(screen.getByText("Modal Content")).toBeInTheDocument();
  });

  it("calls onClose when Escape key pressed", () => {
    const onClose = vi.fn();
    render(
      <ModalOverlay onClose={onClose}>
        <div>Content</div>
      </ModalOverlay>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when overlay (not children) clicked", () => {
    const onClose = vi.fn();
    const { container } = render(
      <ModalOverlay onClose={onClose}>
        <div>Content</div>
      </ModalOverlay>,
    );
    // Click on the overlay div itself (not the child)
    fireEvent.click(container.querySelector(".overlay")!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose when children clicked", () => {
    const onClose = vi.fn();
    render(
      <ModalOverlay onClose={onClose}>
        <div>Content</div>
      </ModalOverlay>,
    );
    fireEvent.click(screen.getByText("Content"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("removes event listener on unmount", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(
      <ModalOverlay onClose={vi.fn()}>
        <div>X</div>
      </ModalOverlay>,
    );
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    removeSpy.mockRestore();
  });
});
