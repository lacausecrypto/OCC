// ─── Blueprint store — save & reuse canvas node groups ────────────────────────

import { create } from "zustand";
import type { CanvasNode, CanvasEdge } from "../types/canvas";

export interface BlueprintNode {
  /** Relative offset from blueprint origin (top-left of group) */
  dx: number;
  dy: number;
  w: number;
  h: number;
  type: CanvasNode["type"];
  label: string;
  model?: string;
  preTools: CanvasNode["preTools"];
  tools: string[];
  outputVar: string;
  prompt: string;
  /** Original ID used to resolve internal edges */
  _origId: string;
}

export interface BlueprintEdge {
  fromOrigId: string;
  toOrigId: string;
}

export interface Blueprint {
  id: string;
  name: string;
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
  createdAt: number;
  usageCount: number;
}

interface BlueprintState {
  blueprints: Blueprint[];

  saveBlueprint: (
    name: string,
    selectedNodes: CanvasNode[],
    allEdges: CanvasEdge[],
  ) => string;

  pasteBlueprint: (
    blueprintId: string,
    cx: number,
    cy: number,
  ) => { nodes: CanvasNode[]; edges: CanvasEdge[] } | null;

  renameBlueprint: (id: string, name: string) => void;
  deleteBlueprint: (id: string) => void;
  getBlueprint: (id: string) => Blueprint | undefined;
}

const STORAGE_KEY = "occ-blueprints";

function loadFromStorage(): Blueprint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persist(blueprints: Blueprint[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(blueprints));
}

export const useBlueprintStore = create<BlueprintState>((set, get) => ({
  blueprints: loadFromStorage(),

  saveBlueprint: (name, selectedNodes, allEdges) => {
    if (selectedNodes.length === 0) return "";

    // Compute origin (top-left)
    const minX = Math.min(...selectedNodes.map((n) => n.x));
    const minY = Math.min(...selectedNodes.map((n) => n.y));

    const selectedIds = new Set(selectedNodes.map((n) => n.id));

    const bpNodes: BlueprintNode[] = selectedNodes.map((n) => ({
      dx: n.x - minX,
      dy: n.y - minY,
      w: n.w,
      h: n.h,
      type: n.type,
      label: n.label,
      model: n.model,
      preTools: n.preTools,
      tools: n.tools,
      outputVar: n.outputVar,
      prompt: n.prompt,
      _origId: n.id,
    }));

    // Keep only edges that connect two selected nodes
    const bpEdges: BlueprintEdge[] = [];
    for (const [, edge] of allEdges instanceof Map ? allEdges : new Map(Object.entries(allEdges))) {
      const e = edge as CanvasEdge;
      if (selectedIds.has(e.from) && selectedIds.has(e.to)) {
        bpEdges.push({ fromOrigId: e.from, toOrigId: e.to });
      }
    }

    const bp: Blueprint = {
      id: `bp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      nodes: bpNodes,
      edges: bpEdges,
      createdAt: Date.now(),
      usageCount: 0,
    };

    set((s) => {
      const blueprints = [...s.blueprints, bp];
      persist(blueprints);
      return { blueprints };
    });

    return bp.id;
  },

  pasteBlueprint: (blueprintId, cx, cy) => {
    const bp = get().blueprints.find((b) => b.id === blueprintId);
    if (!bp) return null;

    // Compute center of blueprint to center it on cx, cy
    const maxDx = Math.max(...bp.nodes.map((n) => n.dx + n.w), 0);
    const maxDy = Math.max(...bp.nodes.map((n) => n.dy + n.h), 0);
    const offsetX = cx - maxDx / 2;
    const offsetY = cy - maxDy / 2;

    // Map original IDs to new IDs
    const idMap = new Map<string, string>();
    const ts = Date.now();

    const newNodes: CanvasNode[] = bp.nodes.map((n, i) => {
      const newId = `bp${ts}_${i}`;
      idMap.set(n._origId, newId);
      return {
        id: newId,
        x: offsetX + n.dx,
        y: offsetY + n.dy,
        w: n.w,
        h: n.h,
        type: n.type,
        label: n.label,
        model: n.model,
        preTools: structuredClone(n.preTools),
        tools: [...n.tools],
        outputVar: `${newId}_out`,
        stepId: newId,
        prompt: n.prompt,
      };
    });

    let edgeCounter = 0;
    const newEdges: CanvasEdge[] = bp.edges
      .map((e) => {
        const from = idMap.get(e.fromOrigId);
        const to = idMap.get(e.toOrigId);
        if (!from || !to) return null;
        return {
          id: `bpe${ts}_${edgeCounter++}`,
          from,
          to,
        };
      })
      .filter(Boolean) as CanvasEdge[];

    // Increment usage count
    set((s) => {
      const blueprints = s.blueprints.map((b) =>
        b.id === blueprintId ? { ...b, usageCount: b.usageCount + 1 } : b,
      );
      persist(blueprints);
      return { blueprints };
    });

    return { nodes: newNodes, edges: newEdges };
  },

  renameBlueprint: (id, name) => {
    set((s) => {
      const blueprints = s.blueprints.map((b) =>
        b.id === id ? { ...b, name } : b,
      );
      persist(blueprints);
      return { blueprints };
    });
  },

  deleteBlueprint: (id) => {
    set((s) => {
      const blueprints = s.blueprints.filter((b) => b.id !== id);
      persist(blueprints);
      return { blueprints };
    });
  },

  getBlueprint: (id) => get().blueprints.find((b) => b.id === id),
}));
