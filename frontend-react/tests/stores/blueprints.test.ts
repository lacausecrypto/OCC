import { describe, it, expect, beforeEach } from "vitest";
import { useBlueprintStore } from "../../src/stores/blueprints";
import type { CanvasNode, CanvasEdge } from "../../src/types/canvas";

function makeNode(id: string, x = 0, y = 0): CanvasNode {
  return {
    id, x, y, w: 200, h: 100,
    type: "agent", label: id,
    preTools: [], tools: ["Read"],
    outputVar: `${id}_out`, stepId: id,
    prompt: "test",
  };
}

describe("useBlueprintStore", () => {
  beforeEach(() => {
    useBlueprintStore.setState({ blueprints: [] });
    localStorage.clear();
  });

  describe("saveBlueprint", () => {
    it("saves a blueprint from selected nodes", () => {
      const nodes = [makeNode("n1", 100, 100), makeNode("n2", 300, 100)];
      const edges = new Map<string, CanvasEdge>([
        ["e1", { id: "e1", from: "n1", to: "n2" }],
      ]);
      const id = useBlueprintStore.getState().saveBlueprint("Test BP", nodes, edges);
      expect(id).toBeTruthy();
      expect(useBlueprintStore.getState().blueprints).toHaveLength(1);
      expect(useBlueprintStore.getState().blueprints[0].name).toBe("Test BP");
    });

    it("saves relative positions", () => {
      const nodes = [makeNode("n1", 100, 200), makeNode("n2", 300, 400)];
      useBlueprintStore.getState().saveBlueprint("BP", nodes, new Map());
      const bp = useBlueprintStore.getState().blueprints[0];
      expect(bp.nodes[0].dx).toBe(0);
      expect(bp.nodes[0].dy).toBe(0);
      expect(bp.nodes[1].dx).toBe(200);
      expect(bp.nodes[1].dy).toBe(200);
    });

    it("returns empty string for no nodes", () => {
      const id = useBlueprintStore.getState().saveBlueprint("Empty", [], new Map());
      expect(id).toBe("");
      expect(useBlueprintStore.getState().blueprints).toHaveLength(0);
    });

    it("only keeps internal edges", () => {
      const nodes = [makeNode("n1"), makeNode("n2")];
      const edges = new Map<string, CanvasEdge>([
        ["e1", { id: "e1", from: "n1", to: "n2" }],
        ["e2", { id: "e2", from: "n2", to: "n3" }], // n3 not selected
      ]);
      useBlueprintStore.getState().saveBlueprint("BP", nodes, edges);
      expect(useBlueprintStore.getState().blueprints[0].edges).toHaveLength(1);
    });
  });

  describe("pasteBlueprint", () => {
    it("creates new nodes with new IDs at target position", () => {
      const nodes = [makeNode("n1", 0, 0)];
      const id = useBlueprintStore.getState().saveBlueprint("BP", nodes, new Map());
      const result = useBlueprintStore.getState().pasteBlueprint(id, 500, 500);
      expect(result).not.toBeNull();
      expect(result!.nodes).toHaveLength(1);
      expect(result!.nodes[0].id).not.toBe("n1"); // New ID
    });

    it("increments usage count", () => {
      const nodes = [makeNode("n1")];
      const id = useBlueprintStore.getState().saveBlueprint("BP", nodes, new Map());
      useBlueprintStore.getState().pasteBlueprint(id, 0, 0);
      expect(useBlueprintStore.getState().blueprints[0].usageCount).toBe(1);
      useBlueprintStore.getState().pasteBlueprint(id, 0, 0);
      expect(useBlueprintStore.getState().blueprints[0].usageCount).toBe(2);
    });

    it("returns null for non-existent blueprint", () => {
      const result = useBlueprintStore.getState().pasteBlueprint("nope", 0, 0);
      expect(result).toBeNull();
    });

    it("recreates internal edges with new IDs", () => {
      const nodes = [makeNode("n1"), makeNode("n2")];
      const edges = new Map<string, CanvasEdge>([
        ["e1", { id: "e1", from: "n1", to: "n2" }],
      ]);
      const id = useBlueprintStore.getState().saveBlueprint("BP", nodes, edges);
      const result = useBlueprintStore.getState().pasteBlueprint(id, 0, 0);
      expect(result!.edges).toHaveLength(1);
      expect(result!.edges[0].from).toBe(result!.nodes[0].id);
      expect(result!.edges[0].to).toBe(result!.nodes[1].id);
    });
  });

  describe("renameBlueprint", () => {
    it("renames a blueprint", () => {
      const nodes = [makeNode("n1")];
      const id = useBlueprintStore.getState().saveBlueprint("Old", nodes, new Map());
      useBlueprintStore.getState().renameBlueprint(id, "New Name");
      expect(useBlueprintStore.getState().blueprints[0].name).toBe("New Name");
    });
  });

  describe("deleteBlueprint", () => {
    it("removes a blueprint", () => {
      const nodes = [makeNode("n1")];
      const id = useBlueprintStore.getState().saveBlueprint("BP", nodes, new Map());
      useBlueprintStore.getState().deleteBlueprint(id);
      expect(useBlueprintStore.getState().blueprints).toHaveLength(0);
    });
  });

  describe("getBlueprint", () => {
    it("finds blueprint by id", () => {
      const nodes = [makeNode("n1")];
      const id = useBlueprintStore.getState().saveBlueprint("BP", nodes, new Map());
      const bp = useBlueprintStore.getState().getBlueprint(id);
      expect(bp?.name).toBe("BP");
    });

    it("returns undefined for missing id", () => {
      expect(useBlueprintStore.getState().getBlueprint("nope")).toBeUndefined();
    });
  });
});
