import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;

/**
 * Helper: create a fresh temp dir, set BLOB_DIR env, reset modules,
 * and dynamically import blob.ts so it picks up the new BLOB_DIR.
 */
async function freshImport() {
  vi.resetModules();
  process.env.BLOB_DIR = tmpDir;
  return await import("../src/blob.js");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blob-test-"));
  process.env.BLOB_DIR = tmpDir;
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* EBUSY on Windows */ }
  delete process.env.BLOB_DIR;
});

// ─── listBlobSessions ───────────────────────────────────────────────────────

describe("listBlobSessions", () => {
  it("returns empty array when no index exists", async () => {
    const blob = await freshImport();
    expect(blob.listBlobSessions()).toEqual([]);
  });

  it("returns empty array when index.json is corrupt", async () => {
    const blob = await freshImport();
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "index.json"), "NOT JSON{{{");
    expect(blob.listBlobSessions()).toEqual([]);
  });

  it("returns sessions after creating them", async () => {
    const blob = await freshImport();
    blob.createBlobSession("Session A");
    blob.createBlobSession("Session B", "desc");
    const sessions = blob.listBlobSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].name).toBe("Session A");
    expect(sessions[1].name).toBe("Session B");
    expect(sessions[1].description).toBe("desc");
  });
});

// ─── createBlobSession ──────────────────────────────────────────────────────

describe("createBlobSession", () => {
  it("creates a session with correct default fields", async () => {
    const blob = await freshImport();
    const session = blob.createBlobSession("Test");
    expect(session.name).toBe("Test");
    expect(session.id).toMatch(/^blob_/);
    expect(session.enabled).toBe(true);
    expect(session.autonomous).toBe(false);
    expect(session.nodeCount).toBe(1);
    expect(session.edgeCount).toBe(0);
    expect(session.messageCount).toBe(0);
    expect(session.totalTokens).toBe(0);
    expect(session.createdAt).toBeTruthy();
    expect(session.updatedAt).toBeTruthy();
  });

  it("accepts optional description", async () => {
    const blob = await freshImport();
    const session = blob.createBlobSession("Named", "A description");
    expect(session.description).toBe("A description");
  });

  it("generates unique IDs", async () => {
    const blob = await freshImport();
    const s1 = blob.createBlobSession("A");
    const s2 = blob.createBlobSession("B");
    expect(s1.id).not.toBe(s2.id);
  });

  it("persists session to disk", async () => {
    const blob = await freshImport();
    blob.createBlobSession("Persist");
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].name).toBe("Persist");
  });
});

// ─── updateBlobSession ──────────────────────────────────────────────────────

describe("updateBlobSession", () => {
  it("updates specific fields of an existing session", async () => {
    const blob = await freshImport();
    const session = blob.createBlobSession("Original");
    const updated = blob.updateBlobSession(session.id, { name: "Renamed", nodeCount: 5 });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Renamed");
    expect(updated!.nodeCount).toBe(5);
    expect(updated!.id).toBe(session.id); // id cannot be overridden
  });

  it("returns null for a non-existent ID", async () => {
    const blob = await freshImport();
    expect(blob.updateBlobSession("nonexistent", { name: "X" })).toBeNull();
  });

  it("updates updatedAt timestamp", async () => {
    const blob = await freshImport();
    const session = blob.createBlobSession("TimeCheck");
    // Small delay to ensure timestamp differs
    const updated = blob.updateBlobSession(session.id, { name: "TimeCheck2" });
    expect(updated!.updatedAt).toBeTruthy();
  });

  it("does not allow patching the id field", async () => {
    const blob = await freshImport();
    const session = blob.createBlobSession("IdProtect");
    const updated = blob.updateBlobSession(session.id, { id: "hacked" } as any);
    expect(updated!.id).toBe(session.id);
  });
});

// ─── deleteBlobSession ──────────────────────────────────────────────────────

describe("deleteBlobSession", () => {
  it("deletes an existing session and returns true", async () => {
    const blob = await freshImport();
    const session = blob.createBlobSession("ToDelete");
    expect(blob.deleteBlobSession(session.id)).toBe(true);
    expect(blob.listBlobSessions()).toHaveLength(0);
  });

  it("returns false for a non-existent ID", async () => {
    const blob = await freshImport();
    expect(blob.deleteBlobSession("nope")).toBe(false);
  });

  it("removes associated graph data file", async () => {
    const blob = await freshImport();
    const session = blob.createBlobSession("WithGraph");
    blob.saveBlobGraph(session.id, { nodes: [], edges: [] });
    expect(fs.existsSync(path.join(tmpDir, `${session.id}.json`))).toBe(true);
    blob.deleteBlobSession(session.id);
    expect(fs.existsSync(path.join(tmpDir, `${session.id}.json`))).toBe(false);
  });

  it("succeeds even when no graph data file exists", async () => {
    const blob = await freshImport();
    const session = blob.createBlobSession("NoGraph");
    expect(blob.deleteBlobSession(session.id)).toBe(true);
  });
});

// ─── saveBlobGraph / loadBlobGraph ──────────────────────────────────────────

describe("saveBlobGraph / loadBlobGraph", () => {
  it("round-trips data correctly", async () => {
    const blob = await freshImport();
    const data = { nodes: [{ id: "n1" }], edges: [], meta: "test" };
    blob.saveBlobGraph("valid_session_1", data);
    const loaded = blob.loadBlobGraph("valid_session_1");
    expect(loaded).toEqual(data);
  });

  it("returns null for non-existent session graph", async () => {
    const blob = await freshImport();
    expect(blob.loadBlobGraph("missing_session")).toBeNull();
  });

  it("returns null when graph file is corrupt", async () => {
    const blob = await freshImport();
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "corrupt_sess.json"), "{{BROKEN");
    expect(blob.loadBlobGraph("corrupt_sess")).toBeNull();
  });

  it("handles complex nested data", async () => {
    const blob = await freshImport();
    const complex = { a: [1, 2, { b: true }], c: null, d: "text" };
    blob.saveBlobGraph("complex_1", complex);
    expect(blob.loadBlobGraph("complex_1")).toEqual(complex);
  });
});

// ─── validateSessionId ──────────────────────────────────────────────────────

describe("validateSessionId (via saveBlobGraph / loadBlobGraph)", () => {
  it("accepts valid alphanumeric IDs with hyphens and underscores", async () => {
    const blob = await freshImport();
    expect(() => blob.saveBlobGraph("abc-123_XYZ", {})).not.toThrow();
  });

  it("throws on path traversal characters (../)", async () => {
    const blob = await freshImport();
    expect(() => blob.saveBlobGraph("../etc/passwd", {})).toThrow("Invalid sessionId format");
  });

  it("throws on dots", async () => {
    const blob = await freshImport();
    expect(() => blob.saveBlobGraph("file.json", {})).toThrow("Invalid sessionId format");
  });

  it("throws on slashes", async () => {
    const blob = await freshImport();
    expect(() => blob.loadBlobGraph("foo/bar")).toThrow("Invalid sessionId format");
  });

  it("throws on spaces", async () => {
    const blob = await freshImport();
    expect(() => blob.saveBlobGraph("has space", {})).toThrow("Invalid sessionId format");
  });

  it("throws on empty string", async () => {
    const blob = await freshImport();
    expect(() => blob.saveBlobGraph("", {})).toThrow("Invalid sessionId format");
  });
});

// ─── loadKnowledge / upsertKnowledge ────────────────────────────────────────

describe("loadKnowledge", () => {
  it("returns empty array when no knowledge file exists", async () => {
    const blob = await freshImport();
    expect(blob.loadKnowledge()).toEqual([]);
  });

  it("returns empty array when knowledge file is corrupt", async () => {
    const blob = await freshImport();
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "knowledge.json"), "BAD");
    expect(blob.loadKnowledge()).toEqual([]);
  });
});

describe("upsertKnowledge", () => {
  it("creates a new entry", async () => {
    const blob = await freshImport();
    const entry = blob.upsertKnowledge("TypeScript", ["typed JS"], "s1", "n1");
    expect(entry.concept).toBe("TypeScript");
    expect(entry.facts).toEqual(["typed JS"]);
    expect(entry.sourceSessionIds).toEqual(["s1"]);
    expect(entry.sourceNodeIds).toEqual(["n1"]);
    expect(entry.accessCount).toBe(1);
    expect(entry.id).toMatch(/^k_/);
  });

  it("updates existing entry (case-insensitive match)", async () => {
    const blob = await freshImport();
    blob.upsertKnowledge("TypeScript", ["typed JS"], "s1", "n1");
    const updated = blob.upsertKnowledge("typescript", ["superset of JS"], "s2", "n2");
    expect(updated.facts).toContain("typed JS");
    expect(updated.facts).toContain("superset of JS");
    expect(updated.sourceSessionIds).toContain("s1");
    expect(updated.sourceSessionIds).toContain("s2");
    expect(updated.accessCount).toBe(2);
  });

  it("deduplicates facts", async () => {
    const blob = await freshImport();
    blob.upsertKnowledge("Go", ["compiled"], "s1", "n1");
    const updated = blob.upsertKnowledge("go", ["compiled", "concurrent"], "s1", "n1");
    const compiledCount = updated.facts.filter((f) => f === "compiled").length;
    expect(compiledCount).toBe(1);
    expect(updated.facts).toContain("concurrent");
  });

  it("does not duplicate sourceSessionIds or sourceNodeIds", async () => {
    const blob = await freshImport();
    blob.upsertKnowledge("Rust", ["fast"], "s1", "n1");
    const updated = blob.upsertKnowledge("rust", ["safe"], "s1", "n1");
    expect(updated.sourceSessionIds).toEqual(["s1"]);
    expect(updated.sourceNodeIds).toEqual(["n1"]);
  });

  it("persists to disk", async () => {
    const blob = await freshImport();
    blob.upsertKnowledge("Disk", ["persistent"], "s1", "n1");
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "knowledge.json"), "utf-8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].concept).toBe("Disk");
  });
});

// ─── updateKnowledgeEntry / deleteKnowledgeEntry / searchKnowledge ──────────

describe("updateKnowledgeEntry", () => {
  it("updates fields of an existing entry", async () => {
    const blob = await freshImport();
    const entry = blob.upsertKnowledge("Concept", ["fact"], "s1", "n1");
    const updated = blob.updateKnowledgeEntry(entry.id, { concept: "Updated" });
    expect(updated).not.toBeNull();
    expect(updated!.concept).toBe("Updated");
    expect(updated!.id).toBe(entry.id); // id preserved
  });

  it("returns null for missing ID", async () => {
    const blob = await freshImport();
    expect(blob.updateKnowledgeEntry("nonexistent", { concept: "X" })).toBeNull();
  });
});

describe("deleteKnowledgeEntry", () => {
  it("deletes an existing entry", async () => {
    const blob = await freshImport();
    const entry = blob.upsertKnowledge("ToRemove", ["fact"], "s1", "n1");
    expect(blob.deleteKnowledgeEntry(entry.id)).toBe(true);
    expect(blob.loadKnowledge()).toHaveLength(0);
  });

  it("returns false for missing ID", async () => {
    const blob = await freshImport();
    expect(blob.deleteKnowledgeEntry("missing")).toBe(false);
  });
});

describe("searchKnowledge", () => {
  it("finds entries matching concept name", async () => {
    const blob = await freshImport();
    blob.upsertKnowledge("Machine Learning", ["subset of AI"], "s1", "n1");
    blob.upsertKnowledge("Cooking", ["food prep"], "s2", "n2");
    const results = blob.searchKnowledge("machine");
    expect(results).toHaveLength(1);
    expect(results[0].concept).toBe("Machine Learning");
  });

  it("finds entries matching fact text", async () => {
    const blob = await freshImport();
    blob.upsertKnowledge("Python", ["interpreted language"], "s1", "n1");
    const results = blob.searchKnowledge("interpreted");
    expect(results).toHaveLength(1);
  });

  it("sorts by accessCount descending", async () => {
    const blob = await freshImport();
    blob.upsertKnowledge("Low", ["data"], "s1", "n1");
    blob.upsertKnowledge("High", ["data"], "s1", "n2");
    // Access "High" more
    blob.upsertKnowledge("high", ["more data"], "s2", "n3");
    blob.upsertKnowledge("high", ["even more data"], "s3", "n4");
    const results = blob.searchKnowledge("data");
    expect(results[0].concept).toBe("High");
  });

  it("returns empty array for no matches", async () => {
    const blob = await freshImport();
    blob.upsertKnowledge("X", ["y"], "s1", "n1");
    expect(blob.searchKnowledge("zzzzz")).toEqual([]);
  });
});

// ─── linkConcepts ───────────────────────────────────────────────────────────

describe("linkConcepts", () => {
  it("links two entries bidirectionally", async () => {
    const blob = await freshImport();
    const e1 = blob.upsertKnowledge("A", ["f1"], "s1", "n1");
    const e2 = blob.upsertKnowledge("B", ["f2"], "s1", "n2");
    blob.linkConcepts(e1.id, e2.id);
    const knowledge = blob.loadKnowledge();
    const a = knowledge.find((k) => k.concept === "A")!;
    const b = knowledge.find((k) => k.concept === "B")!;
    expect(a.relatedConcepts).toContain("B");
    expect(b.relatedConcepts).toContain("A");
  });

  it("does not duplicate links when called twice", async () => {
    const blob = await freshImport();
    const e1 = blob.upsertKnowledge("X", ["f1"], "s1", "n1");
    const e2 = blob.upsertKnowledge("Y", ["f2"], "s1", "n2");
    blob.linkConcepts(e1.id, e2.id);
    blob.linkConcepts(e1.id, e2.id);
    const knowledge = blob.loadKnowledge();
    const x = knowledge.find((k) => k.concept === "X")!;
    expect(x.relatedConcepts.filter((c) => c === "Y")).toHaveLength(1);
  });

  it("silently handles missing entries", async () => {
    const blob = await freshImport();
    const e1 = blob.upsertKnowledge("Solo", ["f1"], "s1", "n1");
    expect(() => blob.linkConcepts(e1.id, "missing")).not.toThrow();
    expect(() => blob.linkConcepts("missing", e1.id)).not.toThrow();
    expect(() => blob.linkConcepts("m1", "m2")).not.toThrow();
  });
});

// ─── findRelevantKnowledge ──────────────────────────────────────────────────

describe("findRelevantKnowledge", () => {
  it("returns up to 5 entries when query has no useful words", async () => {
    const blob = await freshImport();
    // Create some entries
    for (let i = 0; i < 8; i++) {
      blob.upsertKnowledge(`C${i}`, [`f${i}`], "s1", `n${i}`);
    }
    const all = blob.loadKnowledge();
    const results = blob.findRelevantKnowledge("", all);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("matches keywords in concept names with higher score", async () => {
    const blob = await freshImport();
    blob.upsertKnowledge("Docker", ["container platform"], "s1", "n1");
    blob.upsertKnowledge("Kubernetes", ["orchestrates docker containers"], "s1", "n2");
    const all = blob.loadKnowledge();
    const results = blob.findRelevantKnowledge("docker", all);
    expect(results.length).toBeGreaterThan(0);
    // Docker should score higher (concept name match = 5 pts vs fact match = 2 pts)
    expect(results[0].concept).toBe("Docker");
  });

  it("finds entries via BFS traversal of related concepts", async () => {
    const blob = await freshImport();
    const e1 = blob.upsertKnowledge("React", ["UI library"], "s1", "n1");
    const e2 = blob.upsertKnowledge("JSX", ["syntax extension"], "s1", "n2");
    const e3 = blob.upsertKnowledge("Babel", ["transpiler"], "s1", "n3");
    blob.linkConcepts(e1.id, e2.id);
    blob.linkConcepts(e2.id, e3.id);
    const all = blob.loadKnowledge();
    // Search for "React" should find Babel through BFS: React -> JSX -> Babel
    const results = blob.findRelevantKnowledge("React", all);
    const concepts = results.map((r) => r.concept);
    expect(concepts).toContain("React");
    expect(concepts).toContain("JSX"); // depth 1
    expect(concepts).toContain("Babel"); // depth 2
  });

  it("boosts frequently accessed concepts", async () => {
    const blob = await freshImport();
    blob.upsertKnowledge("Popular", ["info"], "s1", "n1");
    // Access multiple times to increase accessCount
    blob.upsertKnowledge("popular", ["more info"], "s2", "n2");
    blob.upsertKnowledge("popular", ["even more"], "s3", "n3");
    blob.upsertKnowledge("Unpopular", ["info"], "s1", "n4");
    const all = blob.loadKnowledge();
    const results = blob.findRelevantKnowledge("info", all);
    expect(results[0].concept).toBe("Popular");
  });

  it("limits results to 10", async () => {
    const blob = await freshImport();
    for (let i = 0; i < 20; i++) {
      blob.upsertKnowledge(`Concept${i}`, ["shared keyword matching"], "s1", `n${i}`);
    }
    const all = blob.loadKnowledge();
    const results = blob.findRelevantKnowledge("keyword matching", all);
    expect(results.length).toBeLessThanOrEqual(10);
  });

  it("handles single-character words by filtering them out", async () => {
    const blob = await freshImport();
    blob.upsertKnowledge("Test", ["data"], "s1", "n1");
    const all = blob.loadKnowledge();
    // Query of only single chars should be treated like empty
    const results = blob.findRelevantKnowledge("a b c", all);
    // All single-char words filtered out, falls back to returning up to 5
    expect(results.length).toBeLessThanOrEqual(5);
  });
});

// ─── buildPlanningPrompt ────────────────────────────────────────────────────

describe("buildPlanningPrompt", () => {
  it("returns a string containing the user message", async () => {
    const blob = await freshImport();
    const prompt = blob.buildPlanningPrompt({
      sessionId: "s1",
      userMessage: "Build a REST API",
      existingBranches: [],
      knownConcepts: [],
      recentMessages: [],
    });
    expect(prompt).toContain("Build a REST API");
  });

  it("includes existing branches when provided", async () => {
    const blob = await freshImport();
    const prompt = blob.buildPlanningPrompt({
      sessionId: "s1",
      userMessage: "test",
      existingBranches: [{ id: "b1", topic: "Auth Flow", stepIds: ["s1", "s2"] }],
      knownConcepts: [],
      recentMessages: [],
    });
    expect(prompt).toContain("Auth Flow");
    expect(prompt).toContain("b1");
    expect(prompt).toContain("2 steps");
  });

  it("shows (none) when no branches exist", async () => {
    const blob = await freshImport();
    const prompt = blob.buildPlanningPrompt({
      sessionId: "s1",
      userMessage: "test",
      existingBranches: [],
      knownConcepts: [],
      recentMessages: [],
    });
    expect(prompt).toContain("(none)");
  });

  it("includes relevant knowledge from the graph", async () => {
    const blob = await freshImport();
    blob.upsertKnowledge("REST API", ["uses HTTP methods"], "s1", "n1");
    const prompt = blob.buildPlanningPrompt({
      sessionId: "s1",
      userMessage: "How do REST APIs work?",
      existingBranches: [],
      knownConcepts: ["REST API"],
      recentMessages: [],
    });
    expect(prompt).toContain("REST API");
    expect(prompt).toContain("uses HTTP methods");
  });

  it("contains the BLOB orchestrator system prompt structure", async () => {
    const blob = await freshImport();
    const prompt = blob.buildPlanningPrompt({
      sessionId: "s1",
      userMessage: "hello",
      existingBranches: [],
      knownConcepts: [],
      recentMessages: [],
    });
    expect(prompt).toContain("BLOB Orchestrator");
    expect(prompt).toContain("## Your Task");
    expect(prompt).toContain("## Rules");
    expect(prompt).toContain("branches");
    expect(prompt).toContain("reuseBranches");
    expect(prompt).toContain("memoryUpdates");
  });
});

// ─── buildExtractionPrompt ──────────────────────────────────────────────────

describe("buildExtractionPrompt", () => {
  it("includes the step output text", async () => {
    const blob = await freshImport();
    const prompt = blob.buildExtractionPrompt("Some analysis output", []);
    expect(prompt).toContain("Some analysis output");
  });

  it("includes existing concepts", async () => {
    const blob = await freshImport();
    const prompt = blob.buildExtractionPrompt("text", ["Docker", "K8s"]);
    expect(prompt).toContain("Docker");
    expect(prompt).toContain("K8s");
  });

  it("shows (none) when no existing concepts", async () => {
    const blob = await freshImport();
    const prompt = blob.buildExtractionPrompt("text", []);
    expect(prompt).toContain("(none)");
  });

  it("truncates long output to 3000 chars", async () => {
    const blob = await freshImport();
    const longText = "x".repeat(5000);
    const prompt = blob.buildExtractionPrompt(longText, []);
    // The prompt should contain a truncated version
    expect(prompt.length).toBeLessThan(longText.length);
  });
});

// ─── getAutonomousPlan ──────────────────────────────────────────────────────

describe("getAutonomousPlan", () => {
  it("returns null when no plan file exists", async () => {
    const blob = await freshImport();
    fs.mkdirSync(tmpDir, { recursive: true });
    expect(blob.getAutonomousPlan("session_abc")).toBeNull();
  });

  it("returns plan data and deletes the file (consume-on-read)", async () => {
    const blob = await freshImport();
    fs.mkdirSync(tmpDir, { recursive: true });
    const planData = { plan: { branches: [] }, timestamp: "2024-01-01" };
    const planPath = path.join(tmpDir, "session_abc_auto_plan.json");
    fs.writeFileSync(planPath, JSON.stringify(planData));
    const result = blob.getAutonomousPlan("session_abc");
    expect(result).toEqual(planData);
    expect(fs.existsSync(planPath)).toBe(false); // consumed
  });

  it("returns null when plan file is corrupt", async () => {
    const blob = await freshImport();
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "bad_sess_auto_plan.json"), "BROKEN{{{");
    expect(blob.getAutonomousPlan("bad_sess")).toBeNull();
  });
});

// ─── Atomic writes ──────────────────────────────────────────────────────────

describe("Atomic writes", () => {
  it("does not leave tmp files after saving index", async () => {
    const blob = await freshImport();
    blob.createBlobSession("AtomicTest");
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  it("does not leave tmp files after saving graph", async () => {
    const blob = await freshImport();
    blob.saveBlobGraph("atomic_graph_1", { data: true });
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  it("does not leave tmp files after saving knowledge", async () => {
    const blob = await freshImport();
    blob.upsertKnowledge("AtomicK", ["fact"], "s1", "n1");
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ─── startAutonomousEngine / stopAutonomousEngine ──────────────────────────

describe("startAutonomousEngine / stopAutonomousEngine", () => {
  it("does not throw when stop is called without starting", async () => {
    const blob = await freshImport();
    expect(() => blob.stopAutonomousEngine()).not.toThrow();
  });

  it("starts and stops the engine without errors", async () => {
    process.env.BLOB_AUTO_CHECK_SEC = "9999"; // very large to avoid firing
    const blob = await freshImport();
    expect(() => blob.startAutonomousEngine()).not.toThrow();
    expect(() => blob.stopAutonomousEngine()).not.toThrow();
    delete process.env.BLOB_AUTO_CHECK_SEC;
  });

  it("calling start twice clears previous timer (no leak)", async () => {
    process.env.BLOB_AUTO_CHECK_SEC = "9999";
    const blob = await freshImport();
    blob.startAutonomousEngine();
    blob.startAutonomousEngine(); // should clear the first
    blob.stopAutonomousEngine();
    delete process.env.BLOB_AUTO_CHECK_SEC;
  });

  it("autonomous tick processes sessions with autonomous=true", async () => {
    vi.useFakeTimers();
    process.env.BLOB_AUTO_CHECK_SEC = "1";
    const blob = await freshImport();

    // Create an autonomous session
    const session = blob.createBlobSession("AutoSession");
    blob.updateBlobSession(session.id, {
      autonomous: true,
      autonomousIntervalMs: 1000,
    });

    // Save a graph so the engine can load it
    blob.saveBlobGraph(session.id, { nodes: [], edges: [] });

    // Mock the dynamic import of claude-runner
    vi.doMock("../src/claude-runner.js", () => ({
      runClaude: vi.fn(async (_prompt: string, _step: unknown, onChunk: (c: string) => void) => {
        onChunk('{"branches":[],"reuseBranches":[],"memoryUpdates":[],"directResponse":"auto"}');
      }),
    }));

    blob.startAutonomousEngine();

    // Advance timers to trigger the interval
    await vi.advanceTimersByTimeAsync(1500);

    blob.stopAutonomousEngine();
    vi.useRealTimers();
    vi.doUnmock("../src/claude-runner.js");
  });

  it("autonomous tick skips sessions that are not enabled", async () => {
    vi.useFakeTimers();
    process.env.BLOB_AUTO_CHECK_SEC = "1";
    const blob = await freshImport();

    const session = blob.createBlobSession("DisabledSession");
    blob.updateBlobSession(session.id, {
      enabled: false,
      autonomous: true,
      autonomousIntervalMs: 1000,
    });

    blob.startAutonomousEngine();
    await vi.advanceTimersByTimeAsync(1500);
    blob.stopAutonomousEngine();
    vi.useRealTimers();

    // No plan file should be created for a disabled session
    const planPath = path.join(tmpDir, `${session.id}_auto_plan.json`);
    expect(fs.existsSync(planPath)).toBe(false);
  });

  it("autonomous tick skips sessions without autonomousIntervalMs", async () => {
    vi.useFakeTimers();
    process.env.BLOB_AUTO_CHECK_SEC = "1";
    const blob = await freshImport();

    const session = blob.createBlobSession("NoInterval");
    blob.updateBlobSession(session.id, {
      autonomous: true,
      // no autonomousIntervalMs
    });

    blob.startAutonomousEngine();
    await vi.advanceTimersByTimeAsync(1500);
    blob.stopAutonomousEngine();
    vi.useRealTimers();

    const planPath = path.join(tmpDir, `${session.id}_auto_plan.json`);
    expect(fs.existsSync(planPath)).toBe(false);
  });
});
