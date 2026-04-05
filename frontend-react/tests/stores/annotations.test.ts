import { describe, it, expect, beforeEach } from "vitest";
import { useAnnotationStore } from "../../src/stores/annotations";

describe("useAnnotationStore", () => {
  beforeEach(() => {
    useAnnotationStore.setState({
      canvasKey: "_default",
      annotations: [],
      activeTool: "none",
      activeColor: "#0a84ff",
      activeLineWidth: 2,
      drawing: null,
      selectedId: null,
      dragOffset: null,
      resizeHandle: null,
      undoStack: [],
    });
  });

  it("has correct initial state", () => {
    const s = useAnnotationStore.getState();
    expect(s.canvasKey).toBe("_default");
    expect(s.annotations).toEqual([]);
    expect(s.activeTool).toBe("none");
    expect(s.activeColor).toBe("#0a84ff");
    expect(s.activeLineWidth).toBe(2);
  });

  describe("tool management", () => {
    it("setTool changes active tool", () => {
      useAnnotationStore.getState().setTool("pencil");
      expect(useAnnotationStore.getState().activeTool).toBe("pencil");
    });

    it("setTool clears drawing and selection", () => {
      useAnnotationStore.setState({ selectedId: "ann1" });
      useAnnotationStore.getState().setTool("rect");
      expect(useAnnotationStore.getState().selectedId).toBeNull();
      expect(useAnnotationStore.getState().drawing).toBeNull();
    });

    it("setColor changes active color", () => {
      useAnnotationStore.getState().setColor("#ff0000");
      expect(useAnnotationStore.getState().activeColor).toBe("#ff0000");
    });

    it("setLineWidth changes line width", () => {
      useAnnotationStore.getState().setLineWidth(5);
      expect(useAnnotationStore.getState().activeLineWidth).toBe(5);
    });
  });

  describe("drawing", () => {
    it("startDraw creates a drawing annotation", () => {
      useAnnotationStore.getState().setTool("pencil");
      useAnnotationStore.getState().startDraw({ x: 10, y: 20 });
      const d = useAnnotationStore.getState().drawing;
      expect(d).not.toBeNull();
      expect(d?.tool).toBe("pencil");
      expect(d?.points).toEqual([{ x: 10, y: 20 }]);
    });

    it("startDraw does nothing when tool is none", () => {
      useAnnotationStore.getState().setTool("none");
      useAnnotationStore.getState().startDraw({ x: 10, y: 20 });
      expect(useAnnotationStore.getState().drawing).toBeNull();
    });

    it("startDraw does nothing when tool is eraser", () => {
      useAnnotationStore.getState().setTool("eraser");
      useAnnotationStore.getState().startDraw({ x: 10, y: 20 });
      expect(useAnnotationStore.getState().drawing).toBeNull();
    });

    it("continueDraw appends points for pencil", () => {
      useAnnotationStore.getState().setTool("pencil");
      useAnnotationStore.getState().startDraw({ x: 0, y: 0 });
      useAnnotationStore.getState().continueDraw({ x: 10, y: 10 });
      useAnnotationStore.getState().continueDraw({ x: 20, y: 20 });
      expect(useAnnotationStore.getState().drawing?.points).toHaveLength(3);
    });

    it("continueDraw updates w/h for rect", () => {
      useAnnotationStore.getState().setTool("rect");
      useAnnotationStore.getState().startDraw({ x: 10, y: 10 });
      useAnnotationStore.getState().continueDraw({ x: 110, y: 60 });
      const d = useAnnotationStore.getState().drawing;
      expect(d?.w).toBe(100);
      expect(d?.h).toBe(50);
    });

    it("finishDraw adds annotation and pushes undo", () => {
      useAnnotationStore.getState().setTool("pencil");
      useAnnotationStore.getState().startDraw({ x: 0, y: 0 });
      useAnnotationStore.getState().continueDraw({ x: 10, y: 10 });
      useAnnotationStore.getState().continueDraw({ x: 20, y: 20 });
      useAnnotationStore.getState().finishDraw();
      expect(useAnnotationStore.getState().annotations).toHaveLength(1);
      expect(useAnnotationStore.getState().undoStack).toHaveLength(1);
      expect(useAnnotationStore.getState().drawing).toBeNull();
    });

    it("finishDraw rejects too-short pencil strokes", () => {
      useAnnotationStore.getState().setTool("pencil");
      useAnnotationStore.getState().startDraw({ x: 0, y: 0 });
      useAnnotationStore.getState().continueDraw({ x: 1, y: 1 });
      useAnnotationStore.getState().finishDraw();
      expect(useAnnotationStore.getState().annotations).toHaveLength(0);
    });

    it("finishDraw rejects too-small rectangles", () => {
      useAnnotationStore.getState().setTool("rect");
      useAnnotationStore.getState().startDraw({ x: 10, y: 10 });
      useAnnotationStore.getState().continueDraw({ x: 12, y: 12 });
      useAnnotationStore.getState().finishDraw();
      expect(useAnnotationStore.getState().annotations).toHaveLength(0);
    });

    it("cancelDraw clears drawing", () => {
      useAnnotationStore.getState().setTool("pencil");
      useAnnotationStore.getState().startDraw({ x: 0, y: 0 });
      useAnnotationStore.getState().cancelDraw();
      expect(useAnnotationStore.getState().drawing).toBeNull();
    });
  });

  describe("addImage", () => {
    it("adds image annotation", () => {
      useAnnotationStore.getState().addImage("data:image/png;base64,...", 10, 20, 100, 80);
      expect(useAnnotationStore.getState().annotations).toHaveLength(1);
      expect(useAnnotationStore.getState().annotations[0].imageData).toBe("data:image/png;base64,...");
    });

    it("selects the new image annotation", () => {
      useAnnotationStore.getState().addImage("data:...", 0, 0, 50, 50);
      expect(useAnnotationStore.getState().selectedId).toBeTruthy();
    });
  });

  describe("addSticky", () => {
    it("adds sticky note annotation", () => {
      useAnnotationStore.getState().addSticky(50, 50);
      expect(useAnnotationStore.getState().annotations).toHaveLength(1);
      const ann = useAnnotationStore.getState().annotations[0];
      expect(ann.tool).toBe("sticky");
      expect(ann.stickyColor).toBeTruthy();
      expect(ann.w).toBe(180);
      expect(ann.h).toBe(120);
    });
  });

  describe("selection", () => {
    it("selectAt finds annotations (AABB hit test)", () => {
      useAnnotationStore.getState().addImage("data:...", 10, 10, 100, 100);
      const id = useAnnotationStore.getState().selectAt({ x: 50, y: 50 });
      expect(id).toBeTruthy();
      expect(useAnnotationStore.getState().selectedId).toBe(id);
    });

    it("selectAt returns null for empty area", () => {
      useAnnotationStore.getState().addImage("data:...", 10, 10, 100, 100);
      const id = useAnnotationStore.getState().selectAt({ x: 500, y: 500 });
      expect(id).toBeNull();
    });

    it("deselect clears selection", () => {
      useAnnotationStore.setState({ selectedId: "ann1" });
      useAnnotationStore.getState().deselect();
      expect(useAnnotationStore.getState().selectedId).toBeNull();
    });
  });

  describe("deleteSelected", () => {
    it("removes selected annotation", () => {
      useAnnotationStore.getState().addSticky(0, 0);
      const id = useAnnotationStore.getState().annotations[0].id;
      useAnnotationStore.setState({ selectedId: id });
      useAnnotationStore.getState().deleteSelected();
      expect(useAnnotationStore.getState().annotations).toHaveLength(0);
      expect(useAnnotationStore.getState().selectedId).toBeNull();
    });

    it("does nothing when nothing selected", () => {
      useAnnotationStore.getState().addSticky(0, 0);
      // addSticky auto-selects, so deselect first
      useAnnotationStore.getState().deselect();
      useAnnotationStore.getState().deleteSelected();
      expect(useAnnotationStore.getState().annotations).toHaveLength(1);
    });
  });

  describe("updateText", () => {
    it("updates text of selected annotation", () => {
      useAnnotationStore.getState().addSticky(0, 0);
      const id = useAnnotationStore.getState().annotations[0].id;
      useAnnotationStore.setState({ selectedId: id });
      useAnnotationStore.getState().updateText("Hello");
      expect(useAnnotationStore.getState().annotations[0].text).toBe("Hello");
    });
  });

  describe("eraseAt", () => {
    it("removes annotations near point", () => {
      useAnnotationStore.getState().addSticky(50, 50);
      useAnnotationStore.getState().eraseAt({ x: 55, y: 55 }, 20);
      expect(useAnnotationStore.getState().annotations).toHaveLength(0);
    });
  });

  describe("clearAll", () => {
    it("removes all annotations", () => {
      useAnnotationStore.getState().addSticky(0, 0);
      useAnnotationStore.getState().addSticky(100, 100);
      useAnnotationStore.getState().clearAll();
      expect(useAnnotationStore.getState().annotations).toHaveLength(0);
    });
  });

  describe("undo", () => {
    it("restores previous state", () => {
      useAnnotationStore.getState().addSticky(0, 0);
      expect(useAnnotationStore.getState().annotations).toHaveLength(1);
      useAnnotationStore.getState().undo();
      expect(useAnnotationStore.getState().annotations).toHaveLength(0);
    });

    it("does nothing with empty undo stack", () => {
      useAnnotationStore.getState().undo();
      expect(useAnnotationStore.getState().annotations).toHaveLength(0);
    });
  });

  describe("canvasKey", () => {
    it("setCanvasKey switches annotation context", () => {
      useAnnotationStore.getState().addSticky(0, 0);
      useAnnotationStore.getState().setCanvasKey("chain:test");
      expect(useAnnotationStore.getState().canvasKey).toBe("chain:test");
      expect(useAnnotationStore.getState().annotations).toHaveLength(0);
      expect(useAnnotationStore.getState().undoStack).toHaveLength(0);
    });
  });
});
