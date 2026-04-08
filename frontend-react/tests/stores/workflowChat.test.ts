import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkflowChatStore } from "../../src/stores/workflowChat";
import type { WFMessage } from "../../src/stores/workflowChat";

// Mock fetch globally
globalThis.fetch = vi.fn(() =>
  Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
);

function resetStore() {
  useWorkflowChatStore.setState({
    contextKey: "_test",
    activeSessionId: null,
    messages: [],
    input: "",
    streaming: false,
    thinkingStartedAt: null,
    chatModel: "claude-haiku-4-5",
    plannerModel: "claude-sonnet-4-6",
    configOpen: false,
  });
}

describe("useWorkflowChatStore", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
    vi.restoreAllMocks();
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
  });

  describe("initial state", () => {
    it("has correct defaults", () => {
      const s = useWorkflowChatStore.getState();
      expect(s.messages).toEqual([]);
      expect(s.input).toBe("");
      expect(s.streaming).toBe(false);
      expect(s.thinkingStartedAt).toBeNull();
      expect(s.chatModel).toBe("claude-haiku-4-5");
      expect(s.plannerModel).toBe("claude-sonnet-4-6");
      expect(s.configOpen).toBe(false);
    });
  });

  describe("setInput", () => {
    it("updates input", () => {
      useWorkflowChatStore.getState().setInput("hello world");
      expect(useWorkflowChatStore.getState().input).toBe("hello world");
    });

    it("can set empty input", () => {
      useWorkflowChatStore.getState().setInput("something");
      useWorkflowChatStore.getState().setInput("");
      expect(useWorkflowChatStore.getState().input).toBe("");
    });
  });

  describe("setConfigOpen", () => {
    it("toggles config panel", () => {
      useWorkflowChatStore.getState().setConfigOpen(true);
      expect(useWorkflowChatStore.getState().configOpen).toBe(true);
      useWorkflowChatStore.getState().setConfigOpen(false);
      expect(useWorkflowChatStore.getState().configOpen).toBe(false);
    });
  });

  describe("setChatModel", () => {
    it("changes chat model", () => {
      useWorkflowChatStore.getState().setChatModel("claude-opus-4-6");
      expect(useWorkflowChatStore.getState().chatModel).toBe("claude-opus-4-6");
    });
  });

  describe("setPlannerModel", () => {
    it("changes planner model", () => {
      useWorkflowChatStore.getState().setPlannerModel("claude-haiku-4-5");
      expect(useWorkflowChatStore.getState().plannerModel).toBe("claude-haiku-4-5");
    });
  });

  describe("setChatSystemPrompt", () => {
    it("changes chat system prompt", () => {
      useWorkflowChatStore.getState().setChatSystemPrompt("Custom prompt");
      expect(useWorkflowChatStore.getState().chatSystemPrompt).toBe("Custom prompt");
    });
  });

  describe("setPlannerSystemPrompt", () => {
    it("changes planner system prompt", () => {
      useWorkflowChatStore.getState().setPlannerSystemPrompt("Custom planner");
      expect(useWorkflowChatStore.getState().plannerSystemPrompt).toBe("Custom planner");
    });
  });

  describe("clearMessages", () => {
    it("empties messages", () => {
      useWorkflowChatStore.setState({
        messages: [
          { id: "m1", role: "user", content: "test", timestamp: new Date().toISOString() },
        ],
      });
      useWorkflowChatStore.getState().clearMessages();
      expect(useWorkflowChatStore.getState().messages).toEqual([]);
    });

    it("saves empty array when session is active", () => {
      useWorkflowChatStore.setState({
        activeSessionId: "sess-1",
        messages: [
          { id: "m1", role: "user", content: "test", timestamp: new Date().toISOString() },
        ],
      });
      useWorkflowChatStore.getState().clearMessages();
      expect(useWorkflowChatStore.getState().messages).toEqual([]);
    });
  });

  describe("setContextKey", () => {
    it("switches context and creates session if none exists", () => {
      useWorkflowChatStore.getState().setContextKey("chain:my-chain");
      const s = useWorkflowChatStore.getState();
      expect(s.contextKey).toBe("chain:my-chain");
      expect(s.activeSessionId).toBeTruthy();
    });

    it("does nothing if same context", () => {
      useWorkflowChatStore.setState({ contextKey: "chain:same" });
      const sessionBefore = useWorkflowChatStore.getState().activeSessionId;
      useWorkflowChatStore.getState().setContextKey("chain:same");
      expect(useWorkflowChatStore.getState().activeSessionId).toBe(sessionBefore);
    });

    it("clears input when switching context", () => {
      useWorkflowChatStore.setState({ input: "some text" });
      useWorkflowChatStore.getState().setContextKey("chain:other");
      expect(useWorkflowChatStore.getState().input).toBe("");
    });
  });

  describe("createSession", () => {
    it("creates a session with auto-generated name", () => {
      useWorkflowChatStore.setState({ contextKey: "chain:test" });
      useWorkflowChatStore.getState().createSession();
      const s = useWorkflowChatStore.getState();
      expect(s.activeSessionId).toBeTruthy();
    });

    it("creates a session with custom name", () => {
      useWorkflowChatStore.setState({ contextKey: "chain:test" });
      useWorkflowChatStore.getState().createSession("My Session");
      expect(useWorkflowChatStore.getState().activeSessionId).toBeTruthy();
    });

    it("clears messages for new session when previous session existed", () => {
      // First session with messages
      useWorkflowChatStore.setState({
        contextKey: "chain:test",
        activeSessionId: "old-session",
        messages: [{ id: "m1", role: "user", content: "old", timestamp: "" }],
      });
      useWorkflowChatStore.getState().createSession("New");
      expect(useWorkflowChatStore.getState().messages).toEqual([]);
    });
  });

  describe("switchSession", () => {
    it("switches to a different session", () => {
      useWorkflowChatStore.setState({
        contextKey: "chain:test",
        activeSessionId: "sess-1",
        messages: [],
      });
      // Save some messages for sess-2 in localStorage
      localStorage.setItem("occ-wfc-msg-sess-2", JSON.stringify([
        { id: "m2", role: "user", content: "from sess 2", timestamp: "" },
      ]));
      useWorkflowChatStore.getState().switchSession("sess-2");
      expect(useWorkflowChatStore.getState().activeSessionId).toBe("sess-2");
      expect(useWorkflowChatStore.getState().messages.length).toBe(1);
    });

    it("does nothing if switching to same session", () => {
      useWorkflowChatStore.setState({
        activeSessionId: "sess-1",
        messages: [{ id: "m1", role: "user", content: "test", timestamp: "" }],
      });
      useWorkflowChatStore.getState().switchSession("sess-1");
      // Messages should remain unchanged
      expect(useWorkflowChatStore.getState().messages.length).toBe(1);
    });
  });

  describe("renameSession", () => {
    it("renames a session in the index", () => {
      // Set up index
      const session = { id: "sess-1", contextKey: "chain:test", name: "Old Name", createdAt: "" };
      localStorage.setItem("occ-wfc-index", JSON.stringify([session]));
      useWorkflowChatStore.getState().renameSession("sess-1", "New Name");
      const index = JSON.parse(localStorage.getItem("occ-wfc-index")!);
      expect(index[0].name).toBe("New Name");
    });

    it("does not rename with empty string", () => {
      const session = { id: "sess-1", contextKey: "chain:test", name: "Keep This", createdAt: "" };
      localStorage.setItem("occ-wfc-index", JSON.stringify([session]));
      useWorkflowChatStore.getState().renameSession("sess-1", "");
      const index = JSON.parse(localStorage.getItem("occ-wfc-index")!);
      expect(index[0].name).toBe("Keep This");
    });
  });

  describe("deleteSession", () => {
    it("removes session from index", () => {
      const sessions = [
        { id: "sess-1", contextKey: "chain:test", name: "S1", createdAt: "" },
        { id: "sess-2", contextKey: "chain:test", name: "S2", createdAt: "" },
      ];
      localStorage.setItem("occ-wfc-index", JSON.stringify(sessions));
      useWorkflowChatStore.setState({ activeSessionId: "sess-1", contextKey: "chain:test" });
      useWorkflowChatStore.getState().deleteSession("sess-2");
      const index = JSON.parse(localStorage.getItem("occ-wfc-index")!);
      expect(index.length).toBe(1);
      expect(index[0].id).toBe("sess-1");
    });

    it("switches to another session when active is deleted", () => {
      const sessions = [
        { id: "sess-1", contextKey: "chain:test", name: "S1", createdAt: "" },
        { id: "sess-2", contextKey: "chain:test", name: "S2", createdAt: "" },
      ];
      localStorage.setItem("occ-wfc-index", JSON.stringify(sessions));
      useWorkflowChatStore.setState({ activeSessionId: "sess-1", contextKey: "chain:test", messages: [] });
      useWorkflowChatStore.getState().deleteSession("sess-1");
      // Should have switched to sess-2 or created a new one
      expect(useWorkflowChatStore.getState().activeSessionId).toBeTruthy();
      expect(useWorkflowChatStore.getState().activeSessionId).not.toBe("sess-1");
    });
  });

  describe("getSessionsForContext", () => {
    it("returns sessions filtered by current context", () => {
      const sessions = [
        { id: "s1", contextKey: "chain:a", name: "A1", createdAt: "" },
        { id: "s2", contextKey: "chain:b", name: "B1", createdAt: "" },
        { id: "s3", contextKey: "chain:a", name: "A2", createdAt: "" },
      ];
      localStorage.setItem("occ-wfc-index", JSON.stringify(sessions));
      useWorkflowChatStore.setState({ contextKey: "chain:a" });
      const result = useWorkflowChatStore.getState().getSessionsForContext();
      expect(result.length).toBe(2);
      expect(result.every((s) => s.contextKey === "chain:a")).toBe(true);
    });

    it("returns empty array for unknown context", () => {
      localStorage.setItem("occ-wfc-index", JSON.stringify([]));
      useWorkflowChatStore.setState({ contextKey: "chain:nonexistent" });
      const result = useWorkflowChatStore.getState().getSessionsForContext();
      expect(result).toEqual([]);
    });
  });

  describe("sendMessage", () => {
    it("does nothing if input is empty", async () => {
      useWorkflowChatStore.setState({ input: "  " });
      await useWorkflowChatStore.getState().sendMessage();
      expect(useWorkflowChatStore.getState().messages.length).toBe(0);
    });

    it("does nothing if already streaming", async () => {
      useWorkflowChatStore.setState({ input: "test", streaming: true });
      const msgsBefore = useWorkflowChatStore.getState().messages.length;
      await useWorkflowChatStore.getState().sendMessage();
      expect(useWorkflowChatStore.getState().messages.length).toBe(msgsBefore);
    });

    it("adds user message and sets streaming state", async () => {
      // Mock a streaming response
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"done","text":"Response","inputTokens":10,"outputTokens":20}\n\n'));
          controller.close();
        },
      });

      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response(stream, { status: 200 })),
      );

      useWorkflowChatStore.setState({ input: "Hello", activeSessionId: "s1" });
      await useWorkflowChatStore.getState().sendMessage();

      const s = useWorkflowChatStore.getState();
      expect(s.streaming).toBe(false);
      // Should have user message + assistant message at minimum
      expect(s.messages.length).toBeGreaterThanOrEqual(2);
      expect(s.messages[0].role).toBe("user");
      expect(s.messages[0].content).toBe("Hello");
      expect(s.input).toBe("");
    });

    it("creates session if none exists", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"done","text":"ok"}\n\n'));
          controller.close();
        },
      });
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response(stream, { status: 200 })),
      );

      useWorkflowChatStore.setState({ input: "test", activeSessionId: null, contextKey: "chain:test" });
      await useWorkflowChatStore.getState().sendMessage();
      expect(useWorkflowChatStore.getState().activeSessionId).toBeTruthy();
    });

    it("handles fetch error gracefully", async () => {
      globalThis.fetch = vi.fn(() => Promise.reject(new Error("Network down")));

      useWorkflowChatStore.setState({ input: "test", activeSessionId: "s1" });
      await useWorkflowChatStore.getState().sendMessage();

      const s = useWorkflowChatStore.getState();
      expect(s.streaming).toBe(false);
      // Should have error message
      const errorMsg = s.messages.find((m) => m.role === "system" && m.content.includes("Error"));
      expect(errorMsg).toBeDefined();
    });

    it("handles non-ok response", async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response(null, { status: 500 })),
      );

      useWorkflowChatStore.setState({ input: "test", activeSessionId: "s1" });
      await useWorkflowChatStore.getState().sendMessage();

      const s = useWorkflowChatStore.getState();
      expect(s.streaming).toBe(false);
      const errorMsg = s.messages.find((m) => m.role === "system" && m.content.includes("Error"));
      expect(errorMsg).toBeDefined();
    });
  });
});
