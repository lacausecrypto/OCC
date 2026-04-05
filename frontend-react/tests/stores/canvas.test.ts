import { describe, it, expect, beforeEach } from "vitest";
import { useCanvasStore } from "../../src/stores/canvas";
import type { CanvasNode } from "../../src/types/canvas";

function makeNode(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    x: 0, y: 0, w: 200, h: 100,
    type: "agent",
    label: id,
    preTools: [],
    tools: [],
    outputVar: `${id}_out`,
    stepId: id,
    prompt: "test prompt",
    ...overrides,
  };
}

describe("useCanvasStore", () => {
  beforeEach(() => {
    useCanvasStore.getState().clear();
  });

  it("starts with empty state", () => {
    const s = useCanvasStore.getState();
    expect(s.nodes.size).toBe(0);
    expect(s.edges.size).toBe(0);
    expect(s.selection.size).toBe(0);
    expect(s.camera).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  // Node operations
  describe("nodes", () => {
    it("addNode adds a node", () => {
      useCanvasStore.getState().addNode(makeNode("n1"));
      expect(useCanvasStore.getState().nodes.size).toBe(1);
      expect(useCanvasStore.getState().nodes.get("n1")?.label).toBe("n1");
    });

    it("updateNode patches node properties", () => {
      useCanvasStore.getState().addNode(makeNode("n1"));
      useCanvasStore.getState().updateNode("n1", { label: "Updated" });
      expect(useCanvasStore.getState().nodes.get("n1")?.label).toBe("Updated");
    });

    it("updateNode does nothing for non-existent node", () => {
      useCanvasStore.getState().updateNode("ghost", { label: "X" });
      expect(useCanvasStore.getState().nodes.size).toBe(0);
    });

    it("removeNode removes node and connected edges", () => {
      useCanvasStore.getState().addNode(makeNode("n1"));
      useCanvasStore.getState().addNode(makeNode("n2"));
      useCanvasStore.getState().addEdge({ id: "e1", from: "n1", to: "n2" });
      useCanvasStore.getState().removeNode("n1");
      expect(useCanvasStore.getState().nodes.size).toBe(1);
      expect(useCanvasStore.getState().edges.size).toBe(0);
    });

    it("removeNode removes node from selection", () => {
      useCanvasStore.getState().addNode(makeNode("n1"));
      useCanvasStore.getState().select(["n1"]);
      useCanvasStore.getState().removeNode("n1");
      expect(useCanvasStore.getState().selection.size).toBe(0);
    });
  });

  // Edge operations
  describe("edges", () => {
    it("addEdge adds an edge", () => {
      useCanvasStore.getState().addEdge({ id: "e1", from: "n1", to: "n2" });
      expect(useCanvasStore.getState().edges.size).toBe(1);
    });

    it("removeEdge removes an edge", () => {
      useCanvasStore.getState().addEdge({ id: "e1", from: "n1", to: "n2" });
      useCanvasStore.getState().removeEdge("e1");
      expect(useCanvasStore.getState().edges.size).toBe(0);
    });
  });

  // Selection
  describe("selection", () => {
    it("select sets selection", () => {
      useCanvasStore.getState().select(["n1", "n2"]);
      expect(useCanvasStore.getState().selection.size).toBe(2);
    });

    it("clearSelection empties selection", () => {
      useCanvasStore.getState().select(["n1"]);
      useCanvasStore.getState().clearSelection();
      expect(useCanvasStore.getState().selection.size).toBe(0);
    });

    it("removeSelected removes selected nodes and their edges", () => {
      useCanvasStore.getState().addNode(makeNode("n1"));
      useCanvasStore.getState().addNode(makeNode("n2"));
      useCanvasStore.getState().addNode(makeNode("n3"));
      useCanvasStore.getState().addEdge({ id: "e1", from: "n1", to: "n2" });
      useCanvasStore.getState().addEdge({ id: "e2", from: "n2", to: "n3" });
      useCanvasStore.getState().select(["n2"]);
      useCanvasStore.getState().removeSelected();
      expect(useCanvasStore.getState().nodes.size).toBe(2);
      expect(useCanvasStore.getState().edges.size).toBe(0);
      expect(useCanvasStore.getState().selection.size).toBe(0);
    });

    it("removeSelected does nothing when nothing selected", () => {
      useCanvasStore.getState().addNode(makeNode("n1"));
      useCanvasStore.getState().removeSelected();
      expect(useCanvasStore.getState().nodes.size).toBe(1);
    });
  });

  // Camera
  describe("camera", () => {
    it("setCamera updates camera", () => {
      useCanvasStore.getState().setCamera({ x: 100, zoom: 2 });
      const cam = useCanvasStore.getState().camera;
      expect(cam.x).toBe(100);
      expect(cam.zoom).toBe(2);
      expect(cam.y).toBe(0); // unchanged
    });
  });

  // Tools
  describe("tools", () => {
    it("setActiveTool changes active tool", () => {
      useCanvasStore.getState().setActiveTool("connect");
      expect(useCanvasStore.getState().activeTool).toBe("connect");
    });

    it("setDragState changes drag state", () => {
      useCanvasStore.getState().setDragState({ type: "node", nodeId: "n1", offsetX: 0, offsetY: 0 });
      expect(useCanvasStore.getState().dragState.type).toBe("node");
    });
  });

  // Undo/Redo
  describe("undo/redo", () => {
    it("pushUndo saves current state", () => {
      useCanvasStore.getState().addNode(makeNode("n1"));
      useCanvasStore.getState().pushUndo();
      expect(useCanvasStore.getState().undoStack.length).toBe(1);
    });

    it("popUndo restores previous state", () => {
      useCanvasStore.getState().addNode(makeNode("n1"));
      useCanvasStore.getState().pushUndo();
      useCanvasStore.getState().addNode(makeNode("n2"));
      expect(useCanvasStore.getState().nodes.size).toBe(2);
      useCanvasStore.getState().popUndo();
      expect(useCanvasStore.getState().nodes.size).toBe(1);
    });

    it("popRedo restores undone state", () => {
      useCanvasStore.getState().addNode(makeNode("n1"));
      useCanvasStore.getState().pushUndo();
      useCanvasStore.getState().addNode(makeNode("n2"));
      useCanvasStore.getState().popUndo();
      expect(useCanvasStore.getState().nodes.size).toBe(1);
      useCanvasStore.getState().popRedo();
      expect(useCanvasStore.getState().nodes.size).toBe(2);
    });

    it("popUndo on empty stack does nothing", () => {
      useCanvasStore.getState().addNode(makeNode("n1"));
      useCanvasStore.getState().popUndo();
      expect(useCanvasStore.getState().nodes.size).toBe(1);
    });

    it("popRedo on empty stack does nothing", () => {
      useCanvasStore.getState().popRedo();
      expect(useCanvasStore.getState().nodes.size).toBe(0);
    });

    it("pushUndo limits stack to 50", () => {
      for (let i = 0; i < 55; i++) {
        useCanvasStore.getState().pushUndo();
      }
      expect(useCanvasStore.getState().undoStack.length).toBeLessThanOrEqual(50);
    });

    it("pushUndo clears redo stack", () => {
      useCanvasStore.getState().pushUndo();
      useCanvasStore.getState().popUndo();
      expect(useCanvasStore.getState().redoStack.length).toBe(1);
      useCanvasStore.getState().pushUndo();
      expect(useCanvasStore.getState().redoStack.length).toBe(0);
    });
  });

  // Load chain
  describe("loadChainToCanvas", () => {
    it("loads chain steps as nodes with edges", () => {
      useCanvasStore.getState().loadChainToCanvas({
        name: "test",
        steps: [
          { id: "s1", type: "agent", label: "Step 1", prompt: "p1", output_var: "s1_out" },
          { id: "s2", type: "router", label: "Step 2", prompt: "p2", output_var: "s2_out", depends_on: ["s1"] },
        ],
        output: "s2_out",
      });
      expect(useCanvasStore.getState().nodes.size).toBe(2);
      expect(useCanvasStore.getState().edges.size).toBe(1);
    });

    it("creates nodes for each step", () => {
      useCanvasStore.getState().loadChainToCanvas({
        name: "linear",
        steps: [
          { id: "a", prompt: "p", output_var: "a_out" },
          { id: "b", prompt: "p", output_var: "b_out" },
          { id: "c", prompt: "p", output_var: "c_out" },
        ],
        output: "c_out",
      });
      expect(useCanvasStore.getState().nodes.size).toBe(3);
    });
  });

  // Load pipeline
  describe("loadPipelineToCanvas", () => {
    it("loads pipeline chains as subchain nodes", () => {
      useCanvasStore.getState().loadPipelineToCanvas({
        name: "test-pipeline",
        chains: [
          { id: "c1", chain: "chain-a", inputs: {} },
          { id: "c2", chain: "chain-b", inputs: {}, depends_on: ["c1"] },
        ],
        output: "c2",
      });
      expect(useCanvasStore.getState().nodes.size).toBe(2);
      expect(useCanvasStore.getState().edges.size).toBe(1);
    });
  });

  // Clear
  describe("clear", () => {
    it("resets everything", () => {
      useCanvasStore.getState().addNode(makeNode("n1"));
      useCanvasStore.getState().addEdge({ id: "e1", from: "n1", to: "n2" });
      useCanvasStore.getState().pushUndo();
      useCanvasStore.getState().clear();
      const s = useCanvasStore.getState();
      expect(s.nodes.size).toBe(0);
      expect(s.edges.size).toBe(0);
      expect(s.selection.size).toBe(0);
      expect(s.undoStack.length).toBe(0);
      expect(s.redoStack.length).toBe(0);
    });
  });
});
