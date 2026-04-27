import { describe, it, expect, beforeEach } from "vitest";
import {
  useWorkflowChatStore,
  getSessionsForContext,
} from "../../src/stores/workflowChat";

// Multi-session machinery tests for the workflow chat store. These cover:
//   setContextKey  → auto-creates a session per context, persists active id
//   createSession  → adds entry to index, becomes active, dedicated message slot
//   switchSession  → no-op on same id, otherwise loads messages from slot
//   renameSession  → idempotent, ignores blank names
//   deleteSession  → removes entry + messages, falls back to remaining/new session
//   clearMessages  → wipes both store + per-session storage
//   getSessionsForContext → filters the global index
//
// All persistence goes through localStorage; tests reset it in beforeEach.

const IDX_KEY = "occ-wfc-index";
const ACTIVE_KEY = "occ-wfc-active";

function resetStore() {
  useWorkflowChatStore.setState({
    contextKey: "_default",
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

beforeEach(() => {
  localStorage.clear();
  resetStore();
});

// ─── setContextKey ─────────────────────────────────────────────────────

describe("setContextKey", () => {
  it("is a no-op when the key is already active", () => {
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().setContextKey("chain:foo");
    expect(useWorkflowChatStore.getState().contextKey).toBe("chain:foo");
    expect(useWorkflowChatStore.getState().activeSessionId).toBeNull();
  });

  it("auto-creates the first session for an empty context", () => {
    useWorkflowChatStore.getState().setContextKey("chain:deep-research");
    const s = useWorkflowChatStore.getState();
    expect(s.contextKey).toBe("chain:deep-research");
    expect(s.activeSessionId).toBeTruthy();
    const idx = JSON.parse(localStorage.getItem(IDX_KEY) ?? "[]");
    expect(idx).toHaveLength(1);
    expect(idx[0].name).toMatch(/deep-research #1/);
  });

  it("derives the auto-session name from chain:/pipeline:/_new prefix", () => {
    useWorkflowChatStore.getState().setContextKey("pipeline:foo");
    let idx = JSON.parse(localStorage.getItem(IDX_KEY) ?? "[]");
    expect(idx[0].name).toMatch(/^foo #1/);

    useWorkflowChatStore.getState().setContextKey("_new");
    idx = JSON.parse(localStorage.getItem(IDX_KEY) ?? "[]");
    expect(idx[1].name).toMatch(/^Chat #1/);
  });

  it("reuses the last active session when re-entering a context", () => {
    useWorkflowChatStore.getState().setContextKey("chain:foo");
    const firstId = useWorkflowChatStore.getState().activeSessionId;
    useWorkflowChatStore.setState({ messages: [
      { id: "m1", role: "user", content: "hi", timestamp: "t" },
    ]});
    // Switch away and back — same session must load.
    useWorkflowChatStore.getState().setContextKey("chain:bar");
    useWorkflowChatStore.getState().setContextKey("chain:foo");
    expect(useWorkflowChatStore.getState().activeSessionId).toBe(firstId);
    expect(useWorkflowChatStore.getState().messages.map((m) => m.content)).toEqual(["hi"]);
  });

  it("falls back to the first session if the last-active id is stale", () => {
    // Simulate a pre-recorded active map pointing at a session that no
    // longer exists in the index.
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ "chain:foo": "stale-id" }));
    localStorage.setItem(IDX_KEY, JSON.stringify([
      { id: "real", contextKey: "chain:foo", name: "foo #1", createdAt: "t" },
    ]));
    useWorkflowChatStore.getState().setContextKey("chain:foo");
    expect(useWorkflowChatStore.getState().activeSessionId).toBe("real");
  });

  it("persists messages of the previous session before switching", () => {
    useWorkflowChatStore.getState().setContextKey("chain:foo");
    const fooId = useWorkflowChatStore.getState().activeSessionId!;
    useWorkflowChatStore.setState({ messages: [
      { id: "m", role: "user", content: "saved", timestamp: "t" },
    ]});
    useWorkflowChatStore.getState().setContextKey("chain:bar");
    const persisted = JSON.parse(localStorage.getItem(`occ-wfc-msg-${fooId}`) ?? "[]");
    expect(persisted).toHaveLength(1);
    expect(persisted[0].content).toBe("saved");
  });
});

// ─── createSession ─────────────────────────────────────────────────────

describe("createSession", () => {
  it("adds an entry to the index and makes it active", () => {
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().createSession("Custom");
    const id = useWorkflowChatStore.getState().activeSessionId;
    expect(id).toBeTruthy();
    const idx = JSON.parse(localStorage.getItem(IDX_KEY) ?? "[]");
    expect(idx.find((s: { id: string; name: string }) => s.id === id)?.name).toBe("Custom");
  });

  it("auto-numbers the session label when no name is given", () => {
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().createSession();
    useWorkflowChatStore.getState().createSession();
    const idx = JSON.parse(localStorage.getItem(IDX_KEY) ?? "[]");
    expect(idx[0].name).toMatch(/foo #1/);
    expect(idx[1].name).toMatch(/foo #2/);
  });

  it("persists pre-existing orphan messages into the new session slot", () => {
    // Simulate a fresh chat with messages but no active session id.
    useWorkflowChatStore.setState({
      contextKey: "_new",
      activeSessionId: null,
      messages: [{ id: "m", role: "user", content: "drafted", timestamp: "t" }],
    });
    useWorkflowChatStore.getState().createSession();
    const id = useWorkflowChatStore.getState().activeSessionId!;
    const stored = JSON.parse(localStorage.getItem(`occ-wfc-msg-${id}`) ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe("drafted");
  });

  it("starts with an empty message list when there was already an active session", () => {
    // Two consecutive createSession calls — the second arrives with the
    // first session active, so it should NOT carry over its messages.
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().createSession();
    useWorkflowChatStore.setState({ messages: [
      { id: "m", role: "user", content: "first session message", timestamp: "t" },
    ]});
    useWorkflowChatStore.getState().createSession();
    expect(useWorkflowChatStore.getState().messages).toEqual([]);
  });
});

// ─── switchSession ─────────────────────────────────────────────────────

describe("switchSession", () => {
  it("is a no-op when the target id equals the active id", () => {
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().createSession();
    const id = useWorkflowChatStore.getState().activeSessionId!;
    useWorkflowChatStore.setState({ messages: [
      { id: "m", role: "user", content: "stay", timestamp: "t" },
    ]});
    useWorkflowChatStore.getState().switchSession(id);
    expect(useWorkflowChatStore.getState().messages.map((m) => m.content)).toEqual(["stay"]);
  });

  it("persists current messages and loads the target session's messages", () => {
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().createSession("A");
    const idA = useWorkflowChatStore.getState().activeSessionId!;
    useWorkflowChatStore.setState({ messages: [
      { id: "m1", role: "user", content: "session A message", timestamp: "t" },
    ]});
    useWorkflowChatStore.getState().createSession("B");
    const idB = useWorkflowChatStore.getState().activeSessionId!;

    // Pre-populate B's slot then switch back to A.
    useWorkflowChatStore.setState({ messages: [
      { id: "m2", role: "user", content: "session B message", timestamp: "t" },
    ]});
    useWorkflowChatStore.getState().switchSession(idA);
    expect(useWorkflowChatStore.getState().activeSessionId).toBe(idA);
    expect(useWorkflowChatStore.getState().messages.map((m) => m.content)).toEqual(
      ["session A message"],
    );

    // Switch forward to B, B's saved messages must come back.
    useWorkflowChatStore.getState().switchSession(idB);
    expect(useWorkflowChatStore.getState().messages.map((m) => m.content)).toEqual(
      ["session B message"],
    );
  });

  it("persists the new active id per context", () => {
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().createSession("A");
    useWorkflowChatStore.getState().createSession("B");
    const idB = useWorkflowChatStore.getState().activeSessionId!;
    const active = JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? "{}");
    expect(active["chain:foo"]).toBe(idB);
  });
});

// ─── renameSession ─────────────────────────────────────────────────────

describe("renameSession", () => {
  it("updates the session name in the index", () => {
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().createSession();
    const id = useWorkflowChatStore.getState().activeSessionId!;
    useWorkflowChatStore.getState().renameSession(id, "Renamed");
    const idx = JSON.parse(localStorage.getItem(IDX_KEY) ?? "[]");
    expect(idx.find((s: { id: string }) => s.id === id).name).toBe("Renamed");
  });

  it("trims whitespace from the new name", () => {
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().createSession();
    const id = useWorkflowChatStore.getState().activeSessionId!;
    useWorkflowChatStore.getState().renameSession(id, "  spaced  ");
    const idx = JSON.parse(localStorage.getItem(IDX_KEY) ?? "[]");
    expect(idx.find((s: { id: string }) => s.id === id).name).toBe("spaced");
  });

  it("ignores blank/whitespace-only renames (keeps the previous name)", () => {
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().createSession("Original");
    const id = useWorkflowChatStore.getState().activeSessionId!;
    useWorkflowChatStore.getState().renameSession(id, "   ");
    const idx = JSON.parse(localStorage.getItem(IDX_KEY) ?? "[]");
    expect(idx.find((s: { id: string }) => s.id === id).name).toBe("Original");
  });

  it("is a silent no-op for unknown ids", () => {
    expect(() => useWorkflowChatStore.getState().renameSession("ghost", "x")).not.toThrow();
  });
});

// ─── deleteSession ─────────────────────────────────────────────────────

describe("deleteSession", () => {
  it("removes the session entry from the index", () => {
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().createSession("A");
    useWorkflowChatStore.getState().createSession("B");
    const idB = useWorkflowChatStore.getState().activeSessionId!;
    // Delete a non-active session — index shrinks, active stays.
    const idx0 = JSON.parse(localStorage.getItem(IDX_KEY) ?? "[]");
    const idA = idx0.find((s: { name: string }) => s.name === "A").id;
    useWorkflowChatStore.getState().deleteSession(idA);
    const idx1 = JSON.parse(localStorage.getItem(IDX_KEY) ?? "[]");
    expect(idx1).toHaveLength(1);
    expect(useWorkflowChatStore.getState().activeSessionId).toBe(idB);
  });

  it("clears the session's persisted messages when deleting a NON-active session", () => {
    // Using a non-active target avoids the createSession-fallback that
    // would re-save an empty array into the just-cleared slot when the
    // last active session is deleted (covered separately below).
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().createSession("A");
    const idA = useWorkflowChatStore.getState().activeSessionId!;
    useWorkflowChatStore.getState().createSession("B");
    localStorage.setItem(`occ-wfc-msg-${idA}`, JSON.stringify([{ id: "m", role: "user", content: "x", timestamp: "t" }]));
    useWorkflowChatStore.getState().deleteSession(idA);
    expect(localStorage.getItem(`occ-wfc-msg-${idA}`)).toBeNull();
  });

  it("switches to another remaining session when deleting the active one", () => {
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().createSession("A");
    const idA = useWorkflowChatStore.getState().activeSessionId!;
    useWorkflowChatStore.getState().createSession("B");
    const idB = useWorkflowChatStore.getState().activeSessionId!;
    useWorkflowChatStore.getState().deleteSession(idB);
    expect(useWorkflowChatStore.getState().activeSessionId).toBe(idA);
  });

  it("creates a fresh session when the last one is deleted", () => {
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().createSession();
    const id = useWorkflowChatStore.getState().activeSessionId!;
    useWorkflowChatStore.getState().deleteSession(id);
    // A new session was auto-created — different id, still active.
    expect(useWorkflowChatStore.getState().activeSessionId).toBeTruthy();
    expect(useWorkflowChatStore.getState().activeSessionId).not.toBe(id);
  });
});

// ─── clearMessages ─────────────────────────────────────────────────────

describe("clearMessages", () => {
  it("empties the in-memory message list", () => {
    useWorkflowChatStore.setState({ messages: [
      { id: "m", role: "user", content: "x", timestamp: "t" },
    ]});
    useWorkflowChatStore.getState().clearMessages();
    expect(useWorkflowChatStore.getState().messages).toEqual([]);
  });

  it("also wipes the persisted messages slot when a session is active", () => {
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().createSession();
    const id = useWorkflowChatStore.getState().activeSessionId!;
    localStorage.setItem(`occ-wfc-msg-${id}`, JSON.stringify([{ id: "m", role: "user", content: "leftover", timestamp: "t" }]));
    useWorkflowChatStore.getState().clearMessages();
    const persisted = JSON.parse(localStorage.getItem(`occ-wfc-msg-${id}`) ?? "[]");
    expect(persisted).toEqual([]);
  });

  it("is a safe no-op on the persistence layer when no session is active", () => {
    useWorkflowChatStore.setState({ activeSessionId: null, messages: [
      { id: "m", role: "user", content: "x", timestamp: "t" },
    ]});
    expect(() => useWorkflowChatStore.getState().clearMessages()).not.toThrow();
    expect(useWorkflowChatStore.getState().messages).toEqual([]);
  });
});

// ─── getSessionsForContext ─────────────────────────────────────────────

describe("getSessionsForContext", () => {
  it("filters the global index by contextKey", () => {
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().createSession("F1");
    useWorkflowChatStore.getState().createSession("F2");
    useWorkflowChatStore.setState({ contextKey: "chain:bar" });
    useWorkflowChatStore.getState().createSession("B1");

    const fooSessions = getSessionsForContext("chain:foo");
    const barSessions = getSessionsForContext("chain:bar");
    expect(fooSessions.map((s) => s.name).sort()).toEqual(["F1", "F2"]);
    expect(barSessions.map((s) => s.name)).toEqual(["B1"]);
  });

  it("returns an empty array for unknown contexts", () => {
    expect(getSessionsForContext("chain:never")).toEqual([]);
  });

  it("the store-bound getSessionsForContext follows the active context", () => {
    useWorkflowChatStore.setState({ contextKey: "chain:foo" });
    useWorkflowChatStore.getState().createSession("A");
    useWorkflowChatStore.getState().createSession("B");
    expect(useWorkflowChatStore.getState().getSessionsForContext().map((s) => s.name).sort())
      .toEqual(["A", "B"]);
  });
});

// ─── Plain setters (already partly covered, round out the rest) ────────

describe("plain setters", () => {
  it.each([
    ["setChatSystemPrompt", "chatSystemPrompt", "custom chat prompt"],
    ["setPlannerSystemPrompt", "plannerSystemPrompt", "custom planner prompt"],
  ] as const)("%s mutates the matching slice", (setter, slice, value) => {
    (useWorkflowChatStore.getState() as Record<string, unknown> & {
      [K in typeof setter]: (v: string) => void;
    })[setter](value);
    expect((useWorkflowChatStore.getState() as Record<string, unknown>)[slice]).toBe(value);
  });
});
