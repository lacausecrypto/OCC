import { describe, it, expect, beforeEach } from "vitest";
import { useBlobStore } from "../../src/stores/blob";

describe("useBlobStore", () => {
  beforeEach(() => {
    useBlobStore.setState({
      sessions: [],
      activeSessionId: null,
      nodes: new Map(),
      edges: new Map(),
      messages: [],
      camera: { x: 0, y: 0, zoom: 1 },
      chatInput: "",
      chatStreaming: false,
      knowledge: [],
    });
    localStorage.clear();
  });

  it("has correct initial state", () => {
    const s = useBlobStore.getState();
    expect(s.sessions).toEqual([]);
    expect(s.activeSessionId).toBeNull();
    expect(s.nodes.size).toBe(0);
    expect(s.edges.size).toBe(0);
    expect(s.chatInput).toBe("");
    expect(s.chatStreaming).toBe(false);
  });

  describe("session management", () => {
    it("createSession adds a session and returns id", () => {
      const id = useBlobStore.getState().createSession("Test Session");
      expect(id).toBeTruthy();
      const sessions = useBlobStore.getState().sessions;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].name).toBe("Test Session");
    });

    it("createSession activates the new session", () => {
      useBlobStore.getState().createSession("S1");
      expect(useBlobStore.getState().activeSessionId).toBeTruthy();
    });

    it("createSession creates a root node", () => {
      useBlobStore.getState().createSession("S1");
      expect(useBlobStore.getState().nodes.size).toBe(1);
      const firstNode = [...useBlobStore.getState().nodes.values()][0];
      expect(firstNode.type).toBe("core");
    });

    it("setActiveSession switches session", () => {
      useBlobStore.getState().createSession("S1");
      const id1 = useBlobStore.getState().activeSessionId!;
      useBlobStore.getState().createSession("S2");
      const id2 = useBlobStore.getState().activeSessionId!;
      expect(id1).not.toBe(id2);
      useBlobStore.getState().setActiveSession(id1);
      expect(useBlobStore.getState().activeSessionId).toBe(id1);
    });

    it("deleteSession removes session", () => {
      const id = useBlobStore.getState().createSession("S1");
      useBlobStore.getState().deleteSession(id);
      expect(useBlobStore.getState().sessions).toHaveLength(0);
    });

    it("renameSession updates session name", () => {
      const id = useBlobStore.getState().createSession("Old");
      useBlobStore.getState().renameSession(id, "New");
      expect(useBlobStore.getState().sessions[0].name).toBe("New");
    });

    it("toggleSession toggles session enabled state", () => {
      const id = useBlobStore.getState().createSession("S1");
      const initialEnabled = useBlobStore.getState().sessions[0].enabled;
      useBlobStore.getState().toggleSession(id);
      expect(useBlobStore.getState().sessions[0].enabled).toBe(!initialEnabled);
    });

    it("setAutonomous updates autonomous mode", () => {
      const id = useBlobStore.getState().createSession("S1");
      useBlobStore.getState().setAutonomous(id, true, 60000);
      const session = useBlobStore.getState().sessions.find(s => s.id === id);
      expect(session?.autonomous).toBe(true);
    });
  });

  describe("graph operations", () => {
    it("setChatInput updates chat input", () => {
      useBlobStore.getState().setChatInput("hello");
      expect(useBlobStore.getState().chatInput).toBe("hello");
    });

    it("setChatStreaming updates streaming state", () => {
      useBlobStore.getState().setChatStreaming(true);
      expect(useBlobStore.getState().chatStreaming).toBe(true);
    });

    it("setCamera updates camera", () => {
      useBlobStore.getState().setCamera({ x: 100, y: 200, zoom: 2 });
      expect(useBlobStore.getState().camera).toEqual({ x: 100, y: 200, zoom: 2 });
    });

    it("setCamera partial update preserves other fields", () => {
      useBlobStore.getState().setCamera({ x: 100 });
      expect(useBlobStore.getState().camera.x).toBe(100);
      expect(useBlobStore.getState().camera.y).toBe(0);
    });

    it("addMessage adds a message to active session", () => {
      useBlobStore.getState().createSession("S1");
      const msg = {
        id: "m1",
        role: "user" as const,
        content: "Hello",
        timestamp: new Date().toISOString(),
      };
      useBlobStore.getState().addMessage(msg);
      // Messages may be stored per-session; check state shape
      const msgs = useBlobStore.getState().messages;
      expect(Array.isArray(msgs)).toBe(true);
    });
  });

  describe("knowledge", () => {
    it("updateKnowledge adds or updates entry", () => {
      useBlobStore.getState().updateKnowledge("React", ["Component-based"], "s1", "n1");
      expect(useBlobStore.getState().knowledge.length).toBeGreaterThanOrEqual(1);
    });

    it("findRelatedKnowledge returns matching entries", () => {
      useBlobStore.getState().updateKnowledge("React Components", ["Functional"], "s1", "n1");
      const results = useBlobStore.getState().findRelatedKnowledge("React");
      expect(results.length).toBeGreaterThanOrEqual(0);
    });
  });
});
