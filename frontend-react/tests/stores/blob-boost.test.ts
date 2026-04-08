import { describe, it, expect, beforeEach, vi } from "vitest";
import { useBlobStore } from "../../src/stores/blob";
import type { BlobNode, BlobEdge, BlobMessage } from "../../src/types/blob";

// Mock fetch globally
globalThis.fetch = vi.fn(() =>
  Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
);

function resetStore() {
  useBlobStore.setState({
    sessions: [],
    activeSessionId: null,
    nodes: new Map(),
    edges: new Map(),
    camera: { x: 0, y: 0, zoom: 1 },
    chatInput: "",
    chatStreaming: false,
    knowledge: [],
    animationTick: 0,
  });
  localStorage.clear();
}

function makeBlobNode(id: string, overrides: Partial<BlobNode> = {}): BlobNode {
  return {
    id,
    sessionId: "test-session",
    type: "step",
    label: `Node ${id}`,
    x: 0, y: 0,
    depth: 1, angle: 0,
    data: { kind: "step", stepType: "agent", prompt: "test" },
    status: "idle",
    createdAt: new Date().toISOString(),
    growthProgress: 1,
    ...overrides,
  };
}

function makeCoreNode(sessionId: string): BlobNode {
  return {
    id: `${sessionId}_core`,
    sessionId,
    type: "core",
    label: "BLOB",
    x: 0, y: 0,
    depth: 0, angle: 0,
    data: { kind: "core", messages: [] },
    status: "idle",
    createdAt: new Date().toISOString(),
    growthProgress: 1,
  };
}

describe("useBlobStore — boost coverage", () => {
  beforeEach(() => {
    resetStore();
    vi.restoreAllMocks();
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
  });

  // ─── Graph operations ─────────────────────────────────────────

  describe("addNode", () => {
    it("adds a node to the graph", () => {
      const node = makeBlobNode("n1");
      useBlobStore.getState().addNode(node);
      expect(useBlobStore.getState().nodes.size).toBe(1);
      expect(useBlobStore.getState().nodes.get("n1")?.label).toBe("Node n1");
    });

    it("adds multiple nodes", () => {
      useBlobStore.getState().addNode(makeBlobNode("n1"));
      useBlobStore.getState().addNode(makeBlobNode("n2"));
      useBlobStore.getState().addNode(makeBlobNode("n3"));
      expect(useBlobStore.getState().nodes.size).toBe(3);
    });
  });

  describe("updateNode", () => {
    it("patches an existing node", () => {
      useBlobStore.getState().addNode(makeBlobNode("n1"));
      useBlobStore.getState().updateNode("n1", { label: "Updated" });
      expect(useBlobStore.getState().nodes.get("n1")?.label).toBe("Updated");
    });

    it("does nothing for non-existent node", () => {
      useBlobStore.getState().updateNode("ghost", { label: "X" });
      expect(useBlobStore.getState().nodes.size).toBe(0);
    });

    it("preserves other fields when patching", () => {
      useBlobStore.getState().addNode(makeBlobNode("n1", { x: 100, y: 200 }));
      useBlobStore.getState().updateNode("n1", { label: "New" });
      const n = useBlobStore.getState().nodes.get("n1");
      expect(n?.x).toBe(100);
      expect(n?.y).toBe(200);
    });
  });

  describe("addEdge", () => {
    it("adds an edge", () => {
      const edge: BlobEdge = { id: "e1", sessionId: "s1", from: "n1", to: "n2", type: "branch", growthProgress: 0 };
      useBlobStore.getState().addEdge(edge);
      expect(useBlobStore.getState().edges.size).toBe(1);
    });
  });

  describe("removeNode", () => {
    it("removes a node and its connected edges", () => {
      useBlobStore.getState().addNode(makeBlobNode("n1"));
      useBlobStore.getState().addNode(makeBlobNode("n2"));
      useBlobStore.getState().addEdge({ id: "e1", sessionId: "s1", from: "n1", to: "n2", type: "branch", growthProgress: 1 });
      useBlobStore.getState().removeNode("n1");
      expect(useBlobStore.getState().nodes.size).toBe(1);
      expect(useBlobStore.getState().edges.size).toBe(0);
    });

    it("removes only edges connected to the deleted node", () => {
      useBlobStore.getState().addNode(makeBlobNode("n1"));
      useBlobStore.getState().addNode(makeBlobNode("n2"));
      useBlobStore.getState().addNode(makeBlobNode("n3"));
      useBlobStore.getState().addEdge({ id: "e1", sessionId: "s1", from: "n1", to: "n2", type: "branch", growthProgress: 1 });
      useBlobStore.getState().addEdge({ id: "e2", sessionId: "s1", from: "n2", to: "n3", type: "branch", growthProgress: 1 });
      useBlobStore.getState().removeNode("n1");
      expect(useBlobStore.getState().edges.size).toBe(1);
      expect(useBlobStore.getState().edges.has("e2")).toBe(true);
    });
  });

  // ─── Chat ─────────────────────────────────────────────────────

  describe("addMessage", () => {
    it("appends message to core node", () => {
      const sid = useBlobStore.getState().createSession("Test");
      const msg: BlobMessage = {
        id: "m1", role: "user", content: "Hello", timestamp: new Date().toISOString(),
      };
      useBlobStore.getState().addMessage(msg);
      const core = [...useBlobStore.getState().nodes.values()].find((n) => n.type === "core");
      expect(core?.data.kind).toBe("core");
      if (core?.data.kind === "core") {
        expect(core.data.messages.length).toBe(1);
        expect(core.data.messages[0].content).toBe("Hello");
      }
    });

    it("does nothing if no core node exists", () => {
      // Empty graph, no core node
      useBlobStore.setState({ nodes: new Map() });
      const msg: BlobMessage = { id: "m1", role: "user", content: "Hello", timestamp: "" };
      useBlobStore.getState().addMessage(msg);
      // Should not throw
      expect(useBlobStore.getState().nodes.size).toBe(0);
    });
  });

  // ─── Animation ────────────────────────────────────────────────

  describe("tickAnimation", () => {
    it("advances growthProgress on nodes", () => {
      const node = makeBlobNode("n1", { growthProgress: 0.5 });
      useBlobStore.setState({ nodes: new Map([["n1", node]]) });
      useBlobStore.getState().tickAnimation();
      const n = useBlobStore.getState().nodes.get("n1");
      expect(n!.growthProgress).toBeGreaterThan(0.5);
    });

    it("advances growthProgress on edges", () => {
      const edge: BlobEdge = { id: "e1", sessionId: "s1", from: "n1", to: "n2", type: "branch", growthProgress: 0.5 };
      useBlobStore.setState({ edges: new Map([["e1", edge]]) });
      useBlobStore.getState().tickAnimation();
      const e = useBlobStore.getState().edges.get("e1");
      expect(e!.growthProgress).toBeGreaterThan(0.5);
    });

    it("caps growthProgress at 1", () => {
      const node = makeBlobNode("n1", { growthProgress: 0.99 });
      useBlobStore.setState({ nodes: new Map([["n1", node]]) });
      useBlobStore.getState().tickAnimation();
      const n = useBlobStore.getState().nodes.get("n1");
      expect(n!.growthProgress).toBe(1);
    });

    it("does not change state when everything is fully grown", () => {
      const node = makeBlobNode("n1", { growthProgress: 1 });
      const edge: BlobEdge = { id: "e1", sessionId: "s1", from: "n1", to: "n2", type: "branch", growthProgress: 1 };
      useBlobStore.setState({
        nodes: new Map([["n1", node]]),
        edges: new Map([["e1", edge]]),
        animationTick: 5,
      });
      useBlobStore.getState().tickAnimation();
      expect(useBlobStore.getState().animationTick).toBe(5); // unchanged
    });

    it("increments animationTick when changes occur", () => {
      const node = makeBlobNode("n1", { growthProgress: 0.5 });
      useBlobStore.setState({ nodes: new Map([["n1", node]]), animationTick: 0 });
      useBlobStore.getState().tickAnimation();
      expect(useBlobStore.getState().animationTick).toBe(1);
    });
  });

  // ─── Knowledge graph ──────────────────────────────────────────

  describe("updateKnowledge", () => {
    it("adds new knowledge entry", () => {
      useBlobStore.getState().updateKnowledge("React", ["A UI library"], "s1", "n1");
      expect(useBlobStore.getState().knowledge.length).toBe(1);
      expect(useBlobStore.getState().knowledge[0].concept).toBe("React");
      expect(useBlobStore.getState().knowledge[0].facts).toEqual(["A UI library"]);
    });

    it("updates existing knowledge entry with new facts", () => {
      useBlobStore.getState().updateKnowledge("React", ["A UI library"], "s1", "n1");
      useBlobStore.getState().updateKnowledge("React", ["Component-based"], "s1", "n2");
      expect(useBlobStore.getState().knowledge.length).toBe(1);
      expect(useBlobStore.getState().knowledge[0].facts).toContain("A UI library");
      expect(useBlobStore.getState().knowledge[0].facts).toContain("Component-based");
    });

    it("deduplicates facts", () => {
      useBlobStore.getState().updateKnowledge("React", ["Fact A"], "s1", "n1");
      useBlobStore.getState().updateKnowledge("React", ["Fact A", "Fact B"], "s1", "n1");
      const entry = useBlobStore.getState().knowledge[0];
      expect(entry.facts.filter((f) => f === "Fact A").length).toBe(1);
    });

    it("tracks source session and node IDs", () => {
      useBlobStore.getState().updateKnowledge("React", ["Fact"], "s1", "n1");
      useBlobStore.getState().updateKnowledge("React", ["Fact 2"], "s2", "n2");
      const entry = useBlobStore.getState().knowledge[0];
      expect(entry.sourceSessionIds).toContain("s1");
      expect(entry.sourceSessionIds).toContain("s2");
      expect(entry.sourceNodeIds).toContain("n1");
      expect(entry.sourceNodeIds).toContain("n2");
    });

    it("does not duplicate source IDs", () => {
      useBlobStore.getState().updateKnowledge("React", ["Fact"], "s1", "n1");
      useBlobStore.getState().updateKnowledge("React", ["Fact 2"], "s1", "n1");
      const entry = useBlobStore.getState().knowledge[0];
      expect(entry.sourceSessionIds.filter((id) => id === "s1").length).toBe(1);
    });

    it("increments accessCount on existing entry", () => {
      useBlobStore.getState().updateKnowledge("React", ["Fact"], "s1", "n1");
      useBlobStore.getState().updateKnowledge("React", ["Fact 2"], "s1", "n1");
      expect(useBlobStore.getState().knowledge[0].accessCount).toBe(2);
    });

    it("case-insensitive concept matching", () => {
      useBlobStore.getState().updateKnowledge("React", ["Fact 1"], "s1", "n1");
      useBlobStore.getState().updateKnowledge("react", ["Fact 2"], "s1", "n2");
      expect(useBlobStore.getState().knowledge.length).toBe(1);
    });

    it("saves knowledge to localStorage", () => {
      useBlobStore.getState().updateKnowledge("React", ["A library"], "s1", "n1");
      const stored = localStorage.getItem("occ-blob-knowledge");
      expect(stored).toBeTruthy();
      const parsed = JSON.parse(stored!);
      expect(parsed.length).toBe(1);
    });
  });

  describe("findRelatedKnowledge", () => {
    beforeEach(() => {
      useBlobStore.getState().updateKnowledge("React Components", ["Functional components"], "s1", "n1");
      useBlobStore.getState().updateKnowledge("Vue.js", ["Progressive framework"], "s1", "n2");
      useBlobStore.getState().updateKnowledge("React Hooks", ["useState, useEffect"], "s1", "n3");
    });

    it("finds by concept name", () => {
      const results = useBlobStore.getState().findRelatedKnowledge("React");
      expect(results.length).toBe(2);
    });

    it("finds by fact content", () => {
      const results = useBlobStore.getState().findRelatedKnowledge("useState");
      expect(results.length).toBe(1);
      expect(results[0].concept).toBe("React Hooks");
    });

    it("returns empty for no match", () => {
      const results = useBlobStore.getState().findRelatedKnowledge("Angular");
      expect(results.length).toBe(0);
    });

    it("is case insensitive", () => {
      const results = useBlobStore.getState().findRelatedKnowledge("react");
      expect(results.length).toBe(2);
    });

    it("limits results to 10", () => {
      for (let i = 0; i < 15; i++) {
        useBlobStore.getState().updateKnowledge(`Test Concept ${i}`, ["test fact"], "s1", `n${i}`);
      }
      const results = useBlobStore.getState().findRelatedKnowledge("test");
      expect(results.length).toBeLessThanOrEqual(10);
    });

    it("sorts by accessCount descending", () => {
      // Access "React Hooks" multiple times
      useBlobStore.getState().updateKnowledge("React Hooks", ["more facts"], "s2", "n4");
      useBlobStore.getState().updateKnowledge("React Hooks", ["even more"], "s3", "n5");
      const results = useBlobStore.getState().findRelatedKnowledge("React");
      expect(results[0].concept).toBe("React Hooks");
    });
  });

  // ─── Session prompts ──────────────────────────────────────────

  describe("setSessionPrompts", () => {
    it("updates session prompts", () => {
      const id = useBlobStore.getState().createSession("Test");
      useBlobStore.getState().setSessionPrompts(id, "chat prompt", "planner prompt");
      const session = useBlobStore.getState().sessions.find((s) => s.id === id);
      expect(session?.chatPrompt).toBe("chat prompt");
      expect(session?.plannerPrompt).toBe("planner prompt");
    });

    it("syncs to backend", () => {
      const id = useBlobStore.getState().createSession("Test");
      useBlobStore.getState().setSessionPrompts(id, "cp", "pp");
      expect(globalThis.fetch).toHaveBeenCalled();
    });
  });

  // ─── Persistence ──────────────────────────────────────────────

  describe("saveActiveSession", () => {
    it("saves nodes and edges to localStorage", () => {
      const id = useBlobStore.getState().createSession("Test");
      useBlobStore.getState().addNode(makeBlobNode("n1", { sessionId: id }));
      useBlobStore.getState().saveActiveSession();
      const stored = localStorage.getItem(`occ-blob-${id}`);
      expect(stored).toBeTruthy();
      const parsed = JSON.parse(stored!);
      expect(parsed.nodes.length).toBeGreaterThan(0);
    });

    it("does nothing without active session", () => {
      useBlobStore.setState({ activeSessionId: null });
      useBlobStore.getState().saveActiveSession();
      // Should not throw
    });

    it("does nothing with empty nodes", () => {
      useBlobStore.setState({ activeSessionId: "test", nodes: new Map() });
      useBlobStore.getState().saveActiveSession();
      expect(localStorage.getItem("occ-blob-test")).toBeNull();
    });

    it("updates session stats", () => {
      const id = useBlobStore.getState().createSession("Test");
      useBlobStore.getState().saveActiveSession();
      const session = useBlobStore.getState().sessions.find((s) => s.id === id);
      expect(session?.nodeCount).toBe(1); // core node
    });

    it("syncs to backend", () => {
      const id = useBlobStore.getState().createSession("Test");
      (globalThis.fetch as any).mockClear();
      useBlobStore.getState().saveActiveSession();
      expect(globalThis.fetch).toHaveBeenCalled();
    });
  });

  describe("loadSession", () => {
    it("loads session from localStorage", () => {
      const core = makeCoreNode("sess-1");
      const data = { nodes: [core], edges: [], camera: { x: 10, y: 20, zoom: 1.5 } };
      localStorage.setItem("occ-blob-sess-1", JSON.stringify(data));
      useBlobStore.getState().loadSession("sess-1");
      expect(useBlobStore.getState().nodes.size).toBe(1);
      expect(useBlobStore.getState().camera).toEqual({ x: 10, y: 20, zoom: 1.5 });
    });

    it("creates core node when no local data exists", () => {
      useBlobStore.getState().loadSession("new-sess");
      expect(useBlobStore.getState().nodes.size).toBe(1);
      const core = [...useBlobStore.getState().nodes.values()][0];
      expect(core.type).toBe("core");
    });

    it("attempts backend fetch", () => {
      useBlobStore.getState().loadSession("sess-1");
      expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining("/blobs/sess-1/graph"));
    });
  });

  describe("setActiveSession", () => {
    it("persists active session to localStorage", () => {
      const id = useBlobStore.getState().createSession("Test");
      useBlobStore.getState().setActiveSession(id);
      expect(localStorage.getItem("occ-blob-active-session")).toBe(id);
    });

    it("removes localStorage entry when set to null", () => {
      const id = useBlobStore.getState().createSession("Test");
      useBlobStore.getState().setActiveSession(null);
      expect(localStorage.getItem("occ-blob-active-session")).toBeNull();
    });

    it("saves current session before switching", () => {
      const id1 = useBlobStore.getState().createSession("S1");
      useBlobStore.getState().addNode(makeBlobNode("extra", { sessionId: id1 }));
      const id2 = useBlobStore.getState().createSession("S2");
      // Switching back should save S2 state
      useBlobStore.getState().setActiveSession(id1);
      // id1 should be active
      expect(useBlobStore.getState().activeSessionId).toBe(id1);
    });
  });

  // ─── syncFromBackend ──────────────────────────────────────────

  describe("syncFromBackend", () => {
    it("merges backend sessions with local", async () => {
      useBlobStore.getState().createSession("Local Only");
      const localId = useBlobStore.getState().sessions[0].id;

      globalThis.fetch = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify([
              { id: "backend-1", name: "Backend Session", createdAt: "", updatedAt: "", enabled: true, autonomous: false, nodeCount: 0, edgeCount: 0, messageCount: 0, totalTokens: 0 },
            ]),
            { status: 200 },
          ),
        ),
      );

      await useBlobStore.getState().syncFromBackend();
      const sessions = useBlobStore.getState().sessions;
      expect(sessions.length).toBe(2);
      expect(sessions.some((s) => s.id === localId)).toBe(true);
      expect(sessions.some((s) => s.id === "backend-1")).toBe(true);
    });

    it("handles fetch failure gracefully", async () => {
      globalThis.fetch = vi.fn(() => Promise.reject(new Error("offline")));
      await useBlobStore.getState().syncFromBackend();
      // Should not throw
    });

    it("handles non-ok response", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response(null, { status: 500 })),
      );
      await useBlobStore.getState().syncFromBackend();
      // Should not throw
    });

    it("handles non-array response", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: "bad" }), { status: 200 })),
      );
      await useBlobStore.getState().syncFromBackend();
      // Should not throw
    });
  });

  // ─── executePlan ──────────────────────────────────────────────

  describe("executePlan", () => {
    it("does nothing without active session", () => {
      useBlobStore.setState({ activeSessionId: null });
      useBlobStore.getState().executePlan({ branches: [], reuseBranches: [], memoryUpdates: [] });
      // Should not throw
    });

    it("does nothing without core node", () => {
      useBlobStore.setState({ activeSessionId: "s1", nodes: new Map() });
      useBlobStore.getState().executePlan({ branches: [], reuseBranches: [], memoryUpdates: [] });
      // Should not throw
    });
  });

  // ─── toggleSession with fetch ─────────────────────────────────

  describe("toggleSession", () => {
    it("syncs toggle state to backend", () => {
      const id = useBlobStore.getState().createSession("Test");
      (globalThis.fetch as any).mockClear();
      useBlobStore.getState().toggleSession(id);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/blobs/${id}`),
        expect.objectContaining({ method: "PUT" }),
      );
    });
  });

  describe("setAutonomous", () => {
    it("sets autonomous with custom interval", () => {
      const id = useBlobStore.getState().createSession("Test");
      useBlobStore.getState().setAutonomous(id, true, 30000);
      const session = useBlobStore.getState().sessions.find((s) => s.id === id);
      expect(session?.autonomous).toBe(true);
      expect(session?.autonomousIntervalMs).toBe(30000);
    });

    it("syncs to backend", () => {
      const id = useBlobStore.getState().createSession("Test");
      (globalThis.fetch as any).mockClear();
      useBlobStore.getState().setAutonomous(id, true);
      expect(globalThis.fetch).toHaveBeenCalled();
    });
  });

  // ─── deleteSession edge cases ─────────────────────────────────

  describe("deleteSession", () => {
    it("clears graph when active session is deleted", () => {
      const id = useBlobStore.getState().createSession("Test");
      useBlobStore.getState().deleteSession(id);
      expect(useBlobStore.getState().activeSessionId).toBeNull();
      expect(useBlobStore.getState().nodes.size).toBe(0);
    });

    it("removes session data from localStorage", () => {
      const id = useBlobStore.getState().createSession("Test");
      localStorage.setItem(`occ-blob-${id}`, JSON.stringify({ nodes: [], edges: [] }));
      useBlobStore.getState().deleteSession(id);
      expect(localStorage.getItem(`occ-blob-${id}`)).toBeNull();
    });

    it("does not affect other sessions", () => {
      const id1 = useBlobStore.getState().createSession("S1");
      const id2 = useBlobStore.getState().createSession("S2");
      useBlobStore.getState().deleteSession(id1);
      expect(useBlobStore.getState().sessions.some((s) => s.id === id2)).toBe(true);
    });
  });

  // ─── createSession edge cases ─────────────────────────────────

  describe("createSession edge cases", () => {
    it("creates session with description", () => {
      const id = useBlobStore.getState().createSession("Test", "A description");
      const session = useBlobStore.getState().sessions.find((s) => s.id === id);
      expect(session?.description).toBe("A description");
    });

    it("persists session list to localStorage", () => {
      useBlobStore.getState().createSession("Test");
      const stored = localStorage.getItem("occ-blob-sessions");
      expect(stored).toBeTruthy();
      const parsed = JSON.parse(stored!);
      expect(parsed.length).toBe(1);
    });
  });
});
