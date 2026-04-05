// ─── BLOB store — organic conversational graph state ─────────────────────────

import { create } from "zustand";
import type {
  BlobSession, BlobNode, BlobEdge, BlobMessage,
  BlobCamera, BlobPlan, KnowledgeEntry,
} from "../types/blob";

const STORAGE_KEY = "occ-blob-sessions";
const KNOWLEDGE_KEY = "occ-blob-knowledge";

// ─── Helpers ────────────────────────────────────────────────────────────────

function uid(): string { return `b${Date.now()}_${Math.random().toString(36).slice(2, 6)}`; }
function now(): string { return new Date().toISOString(); }

function loadSessions(): BlobSession[] {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(data)) return [];
    return data.filter((s: unknown) => s && typeof s === "object" && "id" in (s as Record<string, unknown>) && typeof (s as Record<string, unknown>).id === "string");
  } catch { return []; }
}
function saveSessions(sessions: BlobSession[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}
function loadKnowledge(): KnowledgeEntry[] {
  try {
    const data = JSON.parse(localStorage.getItem(KNOWLEDGE_KEY) ?? "[]");
    if (!Array.isArray(data)) return [];
    return data.filter((k: unknown) => k && typeof k === "object" && "concept" in (k as Record<string, unknown>));
  } catch { return []; }
}
function saveKnowledge(entries: KnowledgeEntry[]) {
  localStorage.setItem(KNOWLEDGE_KEY, JSON.stringify(entries));
}

// ─── Organic layout algorithm ───────────────────────────────────────────────

function computeOrganicPosition(depth: number, angle: number, jitter = 0.1): { x: number; y: number } {
  const baseRadius = 180;
  const r = baseRadius * depth + (Math.random() - 0.5) * baseRadius * jitter;
  return {
    x: Math.cos(angle) * r,
    y: Math.sin(angle) * r,
  };
}

function nextBranchAngle(existingNodes: BlobNode[], depth: number): number {
  // Find existing angles at this depth and pick the most open gap
  const anglesAtDepth = existingNodes
    .filter((n) => Math.abs(n.depth - depth) < 0.5)
    .map((n) => n.angle)
    .sort((a, b) => a - b);

  if (anglesAtDepth.length === 0) return Math.random() * Math.PI * 2;

  // Find largest gap
  let maxGap = 0;
  let bestAngle = 0;
  for (let i = 0; i < anglesAtDepth.length; i++) {
    const next = anglesAtDepth[(i + 1) % anglesAtDepth.length];
    const gap = ((next ?? anglesAtDepth[0] + Math.PI * 2) - anglesAtDepth[i] + Math.PI * 2) % (Math.PI * 2);
    if (gap > maxGap) {
      maxGap = gap;
      bestAngle = anglesAtDepth[i] + gap / 2;
    }
  }
  return bestAngle + (Math.random() - 0.5) * 0.3; // slight randomness
}

// ─── Store ──────────────────────────────────────────────────────────────────

interface BlobState {
  // Session management
  sessions: BlobSession[];
  activeSessionId: string | null;

  // Graph state (for active session)
  nodes: Map<string, BlobNode>;
  edges: Map<string, BlobEdge>;
  camera: BlobCamera;

  // Chat state
  chatInput: string;
  chatStreaming: boolean;

  // Knowledge graph
  knowledge: KnowledgeEntry[];

  // Animation
  animationTick: number;

  // ─── Session CRUD ─────────────────────────────────────────────
  createSession: (name: string, description?: string) => string;
  deleteSession: (id: string) => void;
  renameSession: (id: string, name: string) => void;
  toggleSession: (id: string) => void;
  setAutonomous: (id: string, autonomous: boolean, intervalMs?: number) => void;
  setSessionPrompts: (id: string, chatPrompt?: string, plannerPrompt?: string) => void;
  setActiveSession: (id: string | null) => void;

  // ─── Graph operations ─────────────────────────────────────────
  addNode: (node: BlobNode) => void;
  updateNode: (id: string, patch: Partial<BlobNode>) => void;
  addEdge: (edge: BlobEdge) => void;
  removeNode: (id: string) => void;

  // ─── Chat ─────────────────────────────────────────────────────
  setChatInput: (input: string) => void;
  addMessage: (message: BlobMessage) => void;
  setChatStreaming: (streaming: boolean) => void;

  // ─── Plan execution ───────────────────────────────────────────
  executePlan: (plan: BlobPlan) => void;

  // ─── Growth animation ─────────────────────────────────────────
  tickAnimation: () => void;

  // ─── Knowledge graph ──────────────────────────────────────────
  updateKnowledge: (concept: string, facts: string[], sourceSessionId: string, sourceNodeId: string) => void;
  findRelatedKnowledge: (query: string) => KnowledgeEntry[];

  // ─── Camera ───────────────────────────────────────────────────
  setCamera: (camera: Partial<BlobCamera>) => void;

  // ─── Persistence ──────────────────────────────────────────────
  saveActiveSession: () => void;
  loadSession: (id: string) => void;
  syncFromBackend: () => Promise<void>;
}

// Debounced save — coalesces rapid mutations (addNode/addEdge/updateNode) into one save
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    useBlobStore.getState().saveActiveSession();
  }, 2000);
}

export const useBlobStore = create<BlobState>((set, get) => ({
  sessions: loadSessions(),
  activeSessionId: null,
  nodes: new Map(),
  edges: new Map(),
  camera: { x: 0, y: 0, zoom: 1 },
  chatInput: "",
  chatStreaming: false,
  knowledge: loadKnowledge(),
  animationTick: 0,

  // ─── Session CRUD ─────────────────────────────────────────────

  createSession: (name, description) => {
    const id = uid();
    const session: BlobSession = {
      id, name, description,
      createdAt: now(), updatedAt: now(),
      enabled: true, autonomous: false,
      nodeCount: 1, edgeCount: 0, messageCount: 0, totalTokens: 0,
    };

    // Create core node
    const coreNode: BlobNode = {
      id: `${id}_core`,
      sessionId: id,
      type: "core",
      label: "BLOB",
      x: 0, y: 0,
      depth: 0, angle: 0,
      data: { kind: "core", messages: [] },
      status: "idle",
      createdAt: now(),
      growthProgress: 1,
    };

    set((s) => {
      const sessions = [...s.sessions, session];
      saveSessions(sessions);
      const nodes = new Map<string, BlobNode>();
      nodes.set(coreNode.id, coreNode);
      return {
        sessions,
        activeSessionId: id,
        nodes,
        edges: new Map(),
        camera: { x: 0, y: 0, zoom: 1 },
      };
    });

    return id;
  },

  deleteSession: (id) => {
    set((s) => {
      const sessions = s.sessions.filter((ss) => ss.id !== id);
      saveSessions(sessions);
      localStorage.removeItem(`occ-blob-${id}`);
      return {
        sessions,
        ...(s.activeSessionId === id ? { activeSessionId: null, nodes: new Map(), edges: new Map() } : {}),
      };
    });
  },

  renameSession: (id, name) => {
    set((s) => {
      const sessions = s.sessions.map((ss) => ss.id === id ? { ...ss, name, updatedAt: now() } : ss);
      saveSessions(sessions);
      return { sessions };
    });
  },

  toggleSession: (id) => {
    const session = get().sessions.find((s) => s.id === id);
    const newEnabled = session ? !session.enabled : true;
    set((s) => {
      const sessions = s.sessions.map((ss) => ss.id === id ? { ...ss, enabled: newEnabled, updatedAt: now() } : ss);
      saveSessions(sessions);
      return { sessions };
    });
    fetch(`/blobs/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: newEnabled }),
    }).catch(() => {});
  },

  setAutonomous: (id, autonomous, intervalMs) => {
    set((s) => {
      const sessions = s.sessions.map((ss) =>
        ss.id === id ? { ...ss, autonomous, autonomousIntervalMs: intervalMs ?? ss.autonomousIntervalMs, updatedAt: now() } : ss,
      );
      saveSessions(sessions);
      return { sessions };
    });
    // Sync to backend
    fetch(`/blobs/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autonomous, autonomousIntervalMs: intervalMs }),
    }).catch(() => {});
  },

  setSessionPrompts: (id, chatPrompt, plannerPrompt) => {
    set((s) => {
      const sessions = s.sessions.map((ss) =>
        ss.id === id ? { ...ss, chatPrompt, plannerPrompt, updatedAt: now() } : ss,
      );
      saveSessions(sessions);
      return { sessions };
    });
    fetch(`/blobs/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatPrompt, plannerPrompt }),
    }).catch(() => {});
  },

  setActiveSession: (id) => {
    const current = get().activeSessionId;
    if (current && current !== id) {
      get().saveActiveSession();
    }
    if (id && id !== current) {
      // Only load if switching to a different session
      // (don't reload if we just created it — nodes are already set)
      const hasNodes = get().nodes.size > 0 && [...get().nodes.values()][0]?.sessionId === id;
      if (!hasNodes) {
        get().loadSession(id);
      }
    }
    set({ activeSessionId: id });
    // Persist active session so we can restore on page reload
    if (id) {
      localStorage.setItem("occ-blob-active-session", id);
    } else {
      localStorage.removeItem("occ-blob-active-session");
    }
  },

  // ─── Graph operations ─────────────────────────────────────────

  addNode: (node) => {
    set((s) => {
      const nodes = new Map(s.nodes);
      nodes.set(node.id, node);
      return { nodes };
    });
    debouncedSave();
  },

  updateNode: (id, patch) => {
    set((s) => {
      const existing = s.nodes.get(id);
      if (!existing) return s;
      const nodes = new Map(s.nodes);
      nodes.set(id, { ...existing, ...patch });
      return { nodes };
    });
  },

  addEdge: (edge) => {
    set((s) => {
      const edges = new Map(s.edges);
      edges.set(edge.id, edge);
      return { edges };
    });
    debouncedSave();
  },

  removeNode: (id) => set((s) => {
    const nodes = new Map(s.nodes);
    nodes.delete(id);
    const edges = new Map(s.edges);
    for (const [eid, e] of edges) {
      if (e.from === id || e.to === id) edges.delete(eid);
    }
    return { nodes, edges };
  }),

  // ─── Chat ─────────────────────────────────────────────────────

  setChatInput: (chatInput) => set({ chatInput }),

  addMessage: (message) => {
    set((s) => {
      const nodes = new Map(s.nodes);
      const coreNode = [...nodes.values()].find((n) => n.type === "core");
      if (coreNode && coreNode.data.kind === "core") {
        nodes.set(coreNode.id, {
          ...coreNode,
          data: { ...coreNode.data, messages: [...coreNode.data.messages, message] },
        });
      }
      return { nodes };
    });
    debouncedSave();
  },

  setChatStreaming: (chatStreaming) => set({ chatStreaming }),

  // ─── Plan execution — grows the graph organically ─────────────

  executePlan: (plan) => {
    const state = get();
    const sessionId = state.activeSessionId;
    if (!sessionId) return;

    const allNodes = [...state.nodes.values()];
    const coreId = allNodes.find((n) => n.type === "core")?.id;
    if (!coreId) return;

    // Queue of nodes to spawn with staggered delays for realtime growth
    let delay = 0;
    const BRANCH_DELAY = 600;  // ms between each branch
    const STEP_DELAY = 400;    // ms between each step within a branch
    const EDGE_DELAY = 200;    // ms for edge after node

    for (const branch of plan.branches) {
      const branchDepth = 1;
      const branchAngle = nextBranchAngle(allNodes, branchDepth);
      const branchPos = computeOrganicPosition(branchDepth, branchAngle);
      const branchId = uid();

      // Spawn branch node after delay
      setTimeout(() => {
        get().addNode({
          id: branchId, sessionId,
          type: "branch",
          label: branch.topic,
          x: branchPos.x, y: branchPos.y,
          depth: branchDepth, angle: branchAngle,
          data: { kind: "branch", topic: branch.topic, summary: "", chainSteps: [] },
          status: "running",
          createdAt: now(),
          growthProgress: 0,
        });
      }, delay);

      // Spawn edge slightly after
      setTimeout(() => {
        get().addEdge({
          id: uid(), sessionId,
          from: coreId, to: branchId,
          type: "root", growthProgress: 0,
        });
      }, delay + EDGE_DELAY);

      delay += BRANCH_DELAY;

      // Spawn steps one by one
      let prevStepId = branchId;
      for (let i = 0; i < branch.steps.length; i++) {
        const step = branch.steps[i];
        const stepDepth = branchDepth + 0.5 + i * 0.4;
        const stepAngle = branchAngle + (Math.random() - 0.5) * 0.4;
        const stepPos = computeOrganicPosition(stepDepth, stepAngle);
        const stepId = uid();
        const fromId = prevStepId;

        setTimeout(() => {
          get().addNode({
            id: stepId, sessionId,
            type: "step",
            label: step.label,
            x: stepPos.x, y: stepPos.y,
            depth: stepDepth, angle: stepAngle,
            data: { kind: "step", stepType: step.type, prompt: step.prompt, model: step.model },
            status: "idle",
            createdAt: now(),
            growthProgress: 0,
          });
        }, delay);

        setTimeout(() => {
          get().addEdge({
            id: uid(), sessionId,
            from: fromId, to: stepId,
            type: "branch", growthProgress: 0,
          });
        }, delay + EDGE_DELAY);

        delay += STEP_DELAY;
        prevStepId = stepId;
      }
    }

    // Handle reuse/fork of existing branches (also staggered)
    for (const reuse of plan.reuseBranches) {
      const existingBranch = state.nodes.get(reuse.branchNodeId);
      if (!existingBranch) continue;
      if (!reuse.newSteps?.length) continue;

      // Find the fork point: explicit stepId, or last step of branch, or branch itself
      let forkFromId = reuse.forkAtStepId;
      if (!forkFromId || !state.nodes.has(forkFromId)) {
        // Find last step connected to this branch
        const branchEdges = [...state.edges.values()].filter((e) => e.from === reuse.branchNodeId);
        if (branchEdges.length > 0) {
          // Walk to the last step in the chain
          let lastId = branchEdges[0].to;
          const walked = new Set<string>();
          while (true) {
            walked.add(lastId);
            const next = [...state.edges.values()].find((e) => e.from === lastId && !walked.has(e.to));
            if (!next) break;
            lastId = next.to;
          }
          forkFromId = lastId;
        } else {
          forkFromId = reuse.branchNodeId;
        }
      }

      {
        const forkId = uid();
        const forkAngle = existingBranch.angle + (Math.random() - 0.5) * 0.8;
        const forkDepth = existingBranch.depth + 0.5;
        const forkPos = computeOrganicPosition(forkDepth, forkAngle);
        const sid = sessionId!;

        setTimeout(() => {
          get().addNode({
            id: forkId, sessionId: sid,
            type: "fork", label: "Fork",
            x: forkPos.x, y: forkPos.y,
            depth: forkDepth, angle: forkAngle,
            data: { kind: "fork", parentBranchId: reuse.branchNodeId, reason: "topic divergence" },
            status: "idle", createdAt: now(), growthProgress: 0,
          });
          get().addEdge({
            id: uid(), sessionId: sid,
            from: forkFromId, to: forkId,
            type: "fork", growthProgress: 0,
          });
        }, delay);
        delay += BRANCH_DELAY;

        let prevId = forkId;
        for (const step of reuse.newSteps) {
          const stepId = uid();
          const stepDepth2 = forkDepth + 0.4;
          const stepAngle2 = forkAngle + (Math.random() - 0.5) * 0.3;
          const stepPos2 = computeOrganicPosition(stepDepth2, stepAngle2);
          const fromId = prevId;

          setTimeout(() => {
            get().addNode({
              id: stepId, sessionId: sid,
              type: "step", label: step.label,
              x: stepPos2.x, y: stepPos2.y,
              depth: stepDepth2, angle: stepAngle2,
              data: { kind: "step", stepType: step.type, prompt: step.prompt },
              status: "idle", createdAt: now(), growthProgress: 0,
            });
            get().addEdge({
              id: uid(), sessionId: sid,
              from: fromId, to: stepId,
            type: "branch", growthProgress: 0,
          });
          }, delay);
          delay += STEP_DELAY;
          prevId = stepId;
        }
      }
    }

    // Memory updates
    for (const mem of plan.memoryUpdates) {
      state.updateKnowledge(mem.concept, mem.facts, sessionId, coreId);
    }

    // Update session stats + auto-save after all nodes have been spawned
    setTimeout(() => {
      set((s) => {
        const sessions = s.sessions.map((ss) =>
          ss.id === sessionId ? { ...ss, nodeCount: s.nodes.size, edgeCount: s.edges.size, updatedAt: now() } : ss,
        );
        saveSessions(sessions);
        return { sessions };
      });
      // Save the full graph state (nodes + edges + camera)
      get().saveActiveSession();
    }, delay + 500);
  },

  // ─── Growth animation ─────────────────────────────────────────

  tickAnimation: () => set((s) => {
    let changed = false;
    const nodes = new Map(s.nodes);
    const edges = new Map(s.edges);

    for (const [id, node] of nodes) {
      if (node.growthProgress < 1) {
        nodes.set(id, { ...node, growthProgress: Math.min(1, node.growthProgress + 0.02) });
        changed = true;
      }
    }
    for (const [id, edge] of edges) {
      if (edge.growthProgress < 1) {
        edges.set(id, { ...edge, growthProgress: Math.min(1, edge.growthProgress + 0.015) });
        changed = true;
      }
    }

    if (!changed) return s;
    return { nodes, edges, animationTick: s.animationTick + 1 };
  }),

  // ─── Knowledge graph ──────────────────────────────────────────

  updateKnowledge: (concept, facts, sourceSessionId, sourceNodeId) => {
    set((s) => {
      const knowledge = [...s.knowledge];
      const existing = knowledge.find((k) => k.concept.toLowerCase() === concept.toLowerCase());
      if (existing) {
        existing.facts = [...new Set([...existing.facts, ...facts])];
        if (!existing.sourceSessionIds.includes(sourceSessionId)) existing.sourceSessionIds.push(sourceSessionId);
        if (!existing.sourceNodeIds.includes(sourceNodeId)) existing.sourceNodeIds.push(sourceNodeId);
        existing.updatedAt = now();
        existing.accessCount++;
      } else {
        knowledge.push({
          id: uid(), concept, facts,
          relatedConcepts: [],
          sourceSessionIds: [sourceSessionId],
          sourceNodeIds: [sourceNodeId],
          createdAt: now(), updatedAt: now(),
          accessCount: 1,
        });
      }
      saveKnowledge(knowledge);
      return { knowledge };
    });
  },

  findRelatedKnowledge: (query) => {
    const q = query.toLowerCase();
    return get().knowledge
      .filter((k) => k.concept.toLowerCase().includes(q) || k.facts.some((f) => f.toLowerCase().includes(q)))
      .sort((a, b) => b.accessCount - a.accessCount)
      .slice(0, 10);
  },

  // ─── Camera ───────────────────────────────────────────────────

  setCamera: (partial) => set((s) => ({ camera: { ...s.camera, ...partial } })),

  // ─── Persistence ──────────────────────────────────────────────

  saveActiveSession: () => {
    const { activeSessionId, nodes, edges, camera } = get();
    if (!activeSessionId) return;
    if (nodes.size === 0) return; // Don't save empty state
    const data = {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      camera,
    };
    const json = JSON.stringify(data);
    // Save locally — this is the primary persistence
    try {
      localStorage.setItem(`occ-blob-${activeSessionId}`, json);
    } catch (e) {
      console.error("BLOB localStorage save failed:", e);
    }
    // Also sync to backend (secondary, for cross-device)
    fetch(`/blobs/${activeSessionId}/graph`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: json,
    }).catch(() => { /* backend offline — localStorage is primary */ });
    // Update session stats
    const core = [...nodes.values()].find((n) => n.type === "core");
    const messageCount = core?.data.kind === "core" ? core.data.messages.length : 0;
    let totalTokens = 0;
    for (const n of nodes.values()) {
      if (n.data.kind === "step") {
        totalTokens += (n.data.inputTokens ?? 0) + (n.data.outputTokens ?? 0);
      }
    }
    if (core?.data.kind === "core") {
      for (const m of core.data.messages) {
        totalTokens += (m.inputTokens ?? 0) + (m.outputTokens ?? 0);
      }
    }
    const sessions = get().sessions.map((s) =>
      s.id === activeSessionId ? {
        ...s,
        nodeCount: nodes.size,
        edgeCount: edges.size,
        messageCount,
        totalTokens,
        updatedAt: new Date().toISOString(),
      } : s,
    );
    set({ sessions });
    localStorage.setItem("occ-blob-sessions", JSON.stringify(sessions));
  },

  loadSession: (id) => {
    const makeCoreNode = (): BlobNode => ({
      id: `${id}_core`, sessionId: id,
      type: "core", label: "BLOB",
      x: 0, y: 0, depth: 0, angle: 0,
      data: { kind: "core", messages: [] },
      status: "idle", createdAt: now(), growthProgress: 1,
    });

    const restoreFromData = (data: { nodes: BlobNode[]; edges: BlobEdge[]; camera?: BlobCamera }) => {
      set({
        nodes: new Map(data.nodes.map((n) => [n.id, n])),
        edges: new Map(data.edges.map((e) => [e.id, e])),
        camera: data.camera ?? { x: 0, y: 0, zoom: 1 },
      });
    };

    // Try localStorage first (has camera state)
    const localRaw = localStorage.getItem(`occ-blob-${id}`);
    let localData: { nodes: BlobNode[]; edges: BlobEdge[]; camera?: BlobCamera } | null = null;
    try {
      if (localRaw) localData = JSON.parse(localRaw);
    } catch { /* ignore */ }

    // If we have local data, restore immediately (sync)
    if (localData?.nodes?.length) {
      restoreFromData(localData);
    } else {
      // No local data — create core node immediately so the blob is visible
      const core = makeCoreNode();
      set({
        nodes: new Map([[core.id, core]]),
        edges: new Map(),
        camera: { x: 0, y: 0, zoom: 1 },
      });
    }

    // Then try backend async — only use if it has MORE data than local
    fetch(`/blobs/${id}/graph`).then((r) => r.ok ? r.json() : null).then((backendData) => {
      if (backendData?.nodes?.length > 0) {
        const localNodeCount = localData?.nodes?.length ?? 0;
        const backendNodeCount = backendData.nodes.length;
        // Only overwrite if backend has strictly more nodes (richer state)
        if (backendNodeCount > localNodeCount) {
          restoreFromData({
            nodes: backendData.nodes,
            edges: backendData.edges ?? [],
            camera: localData?.camera ?? get().camera,
          });
        }
      }
    }).catch(() => { /* backend offline — already showing local/core */ });
  },

  syncFromBackend: async () => {
    try {
      const res = await fetch("/blobs", { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const backendSessions = await res.json() as BlobSession[];
      if (!Array.isArray(backendSessions)) return;

      set((s) => {
        const backendIds = new Set(backendSessions.map((bs) => bs.id));
        const localOnly = s.sessions.filter((ls) => !backendIds.has(ls.id));
        const merged = [...backendSessions, ...localOnly];

        // Recalculate stats from localStorage graph data (more accurate than backend)
        for (const session of merged) {
          try {
            const raw = localStorage.getItem(`occ-blob-${session.id}`);
            if (!raw) continue;
            const data = JSON.parse(raw) as { nodes?: BlobNode[]; edges?: BlobEdge[] };
            if (!data.nodes?.length) continue;
            session.nodeCount = data.nodes.length;
            session.edgeCount = data.edges?.length ?? 0;
            const core = data.nodes.find((n) => n.type === "core");
            session.messageCount = core?.data.kind === "core" ? core.data.messages.length : 0;
            let tokens = 0;
            for (const n of data.nodes) {
              if (n.data.kind === "step") tokens += (n.data.inputTokens ?? 0) + (n.data.outputTokens ?? 0);
            }
            if (core?.data.kind === "core") {
              for (const m of core.data.messages) tokens += (m.inputTokens ?? 0) + (m.outputTokens ?? 0);
            }
            session.totalTokens = tokens;
          } catch { /* skip */ }
        }

        saveSessions(merged);
        return { sessions: merged };
      });
    } catch { /* backend offline — keep local sessions */ }
  },
}));

// Auto-save on unload — flush any pending debounced save
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    useBlobStore.getState().saveActiveSession();
  });
}
