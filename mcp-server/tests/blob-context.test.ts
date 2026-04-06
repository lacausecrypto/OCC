/**
 * Tests for BLOB Context Enrichment.
 *
 * Covers:
 * - POST /blobs/:id/execute-step — backward compatibility and context enrichment
 * - POST /blobs/:id/chat — knowledge injection in system prompt
 * - POST /blobs/:id/execute-branch — sequential context accumulation
 *
 * Strategy: use supertest against the Express app with mocked heavy dependencies
 * (claude-runner, executor, scheduler, mcp-client, blob knowledge functions).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { cleanupTmpDir } from "./_test-utils.js";

describe("BLOB Context Enrichment", () => {
  let tmpDir: string;
  let tmpBlobDir: string;
  let request: typeof import("supertest").default;
  let app: import("express").Express;

  let originalChainsDir: string | undefined;
  let originalSchedulesFile: string | undefined;
  let originalRestPort: string | undefined;
  let originalApiKey: string | undefined;
  let originalBlobDir: string | undefined;

  // Track the prompts that runClaude receives
  let capturedPrompts: string[] = [];
  // Configurable runClaude mock behavior
  let runClaudeMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const supertest = await import("supertest");
    request = supertest.default;
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-blob-ctx-"));
    tmpBlobDir = path.join(tmpDir, "blobs");
    fs.mkdirSync(tmpBlobDir, { recursive: true });

    originalChainsDir = process.env.CHAINS_DIR;
    originalSchedulesFile = process.env.SCHEDULES_FILE;
    originalRestPort = process.env.REST_PORT;
    originalApiKey = process.env.OCC_API_KEY;
    originalBlobDir = process.env.BLOB_DIR;

    process.env.CHAINS_DIR = tmpDir;
    process.env.SCHEDULES_FILE = path.join(tmpDir, "schedules.json");
    process.env.REST_PORT = "0";
    process.env.BLOB_DIR = tmpBlobDir;
    delete process.env.OCC_API_KEY;

    capturedPrompts = [];

    vi.resetModules();

    // Default runClaude mock: returns captured prompt as output
    runClaudeMock = vi.fn(async (prompt: string, _step: unknown, onChunk: (c: string) => void) => {
      capturedPrompts.push(prompt);
      const output = `output for: ${prompt.slice(0, 50)}`;
      onChunk(output);
      return { stdout: output, durationMs: 100, inputTokens: 10, outputTokens: 20 };
    });

    vi.doMock("../src/claude-runner.js", () => ({
      runClaude: runClaudeMock,
      runStepWithRetry: vi.fn(async () => ({ stdout: "mock", durationMs: 1 })),
    }));

    vi.doMock("../src/executor.js", () => {
      return {
        executeChain: vi.fn(),
        getExecution: vi.fn(),
        getAllExecutions: vi.fn(() => []),
        cancelExecution: vi.fn(() => false),
        loadPersistedExecutions: vi.fn(),
        resumeExecution: vi.fn(async () => "resumed"),
        approveGate: vi.fn(() => true),
        getPendingApprovals: vi.fn(() => []),
        validateClaudeBinary: vi.fn(),
        canStartExecution: vi.fn(() => true),
        getRunningExecutionCount: vi.fn(() => 0),
        getExecutionTimeline: vi.fn(() => []),
      };
    });

    vi.doMock("../src/scheduler.js", () => ({
      initScheduler: vi.fn(),
      setSSEEmitter: vi.fn(),
      getSchedules: vi.fn(() => []),
      getSchedule: vi.fn(() => undefined),
      createSchedule: vi.fn(),
      updateSchedule: vi.fn(() => null),
      deleteSchedule: vi.fn(() => false),
      toggleSchedule: vi.fn(() => null),
      runNow: vi.fn(),
    }));

    vi.doMock("../src/mcp-client.js", () => ({
      loadMcpServers: vi.fn(async () => []),
      discoverTools: vi.fn(async () => []),
      getConfiguredServers: vi.fn(() => []),
      getMcpConfig: vi.fn(() => ({})),
      saveMcpConfig: vi.fn(),
      closeMcpClients: vi.fn(),
    }));

    const restModule = await import("../src/rest.js");
    app = restModule.app;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalChainsDir === undefined) delete process.env.CHAINS_DIR;
    else process.env.CHAINS_DIR = originalChainsDir;
    if (originalSchedulesFile === undefined) delete process.env.SCHEDULES_FILE;
    else process.env.SCHEDULES_FILE = originalSchedulesFile;
    if (originalRestPort === undefined) delete process.env.REST_PORT;
    else process.env.REST_PORT = originalRestPort;
    if (originalApiKey === undefined) delete process.env.OCC_API_KEY;
    else process.env.OCC_API_KEY = originalApiKey;
    if (originalBlobDir === undefined) delete process.env.BLOB_DIR;
    else process.env.BLOB_DIR = originalBlobDir;
    await cleanupTmpDir(tmpDir);
  });

  // ─── Helper: parse SSE response text into events ─────────────────────────
  function parseSSEEvents(text: string): Array<Record<string, unknown>> {
    const events: Array<Record<string, unknown>> = [];
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          events.push(JSON.parse(line.slice(6)));
        } catch { /* skip non-JSON lines */ }
      }
    }
    return events;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. execute-step backward compatible
  // ═══════════════════════════════════════════════════════════════════════════

  describe("POST /blobs/:id/execute-step — backward compatible", () => {
    it("works with only stepType and prompt (no context fields)", async () => {
      const res = await request(app)
        .post("/blobs/test-session/execute-step")
        .send({ stepType: "agent", prompt: "Write a haiku" })
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          res.on("end", () => cb(null, data));
        });

      expect(res.status).toBe(200);

      // runClaude should receive the original prompt unchanged
      expect(capturedPrompts).toHaveLength(1);
      expect(capturedPrompts[0]).toBe("Write a haiku");

      // Should contain SSE done event
      const events = parseSSEEvents(res.body as string);
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
      expect(doneEvent!.output).toBeTruthy();
    });

    it("returns 400 when prompt is missing", async () => {
      const res = await request(app)
        .post("/blobs/test-session/execute-step")
        .send({ stepType: "agent" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/prompt required/i);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. execute-step with context
  // ═══════════════════════════════════════════════════════════════════════════

  describe("POST /blobs/:id/execute-step — with context enrichment", () => {
    it("builds enriched prompt with previousOutputs", async () => {
      const previousOutputs = [
        { stepId: "s1", label: "Research", output: "Found 3 relevant papers" },
        { stepId: "s2", label: "Analysis", output: "Key findings: A, B, C" },
      ];

      const res = await request(app)
        .post("/blobs/test-session/execute-step")
        .send({
          stepType: "agent",
          prompt: "Write the summary",
          branchNodeId: "b1",
          previousOutputs,
        })
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          res.on("end", () => cb(null, data));
        });

      expect(res.status).toBe(200);
      expect(capturedPrompts).toHaveLength(1);

      const enriched = capturedPrompts[0];
      // Should contain previous steps section
      expect(enriched).toContain("## Previous Steps in This Branch");
      expect(enriched).toContain("### Research");
      expect(enriched).toContain("Found 3 relevant papers");
      expect(enriched).toContain("### Analysis");
      expect(enriched).toContain("Key findings: A, B, C");
      // Should contain current task section
      expect(enriched).toContain("## Current Task");
      expect(enriched).toContain("Write the summary");
    });

    it("truncates long previousOutputs to 2000 chars", async () => {
      const longOutput = "x".repeat(3000);
      const previousOutputs = [
        { stepId: "s1", label: "Long Step", output: longOutput },
      ];

      await request(app)
        .post("/blobs/test-session/execute-step")
        .send({
          stepType: "agent",
          prompt: "Summarize",
          branchNodeId: "b1",
          previousOutputs,
        })
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          res.on("end", () => cb(null, data));
        });

      const enriched = capturedPrompts[0];
      expect(enriched).toContain("[truncated]");
      // Should not contain the full 3000-char output
      expect(enriched).not.toContain(longOutput);
    });

    it("limits previousOutputs to last 5", async () => {
      const previousOutputs = Array.from({ length: 8 }, (_, i) => ({
        stepId: `s${i}`,
        label: `Step ${i}`,
        output: `Output ${i}`,
      }));

      await request(app)
        .post("/blobs/test-session/execute-step")
        .send({
          stepType: "agent",
          prompt: "Final step",
          branchNodeId: "b1",
          previousOutputs,
        })
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          res.on("end", () => cb(null, data));
        });

      const enriched = capturedPrompts[0];
      // Steps 0-2 should be excluded (only last 5 kept: 3-7)
      expect(enriched).not.toContain("Step 0");
      expect(enriched).not.toContain("Step 1");
      expect(enriched).not.toContain("Step 2");
      expect(enriched).toContain("Step 3");
      expect(enriched).toContain("Step 7");
    });

    it("handles empty previousOutputs array (no enrichment)", async () => {
      await request(app)
        .post("/blobs/test-session/execute-step")
        .send({
          stepType: "agent",
          prompt: "Solo step",
          previousOutputs: [],
        })
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          res.on("end", () => cb(null, data));
        });

      // No branchNodeId and empty previousOutputs = no enrichment
      expect(capturedPrompts[0]).toBe("Solo step");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. chat with knowledge
  // ═══════════════════════════════════════════════════════════════════════════

  describe("POST /blobs/:id/chat — knowledge injection", () => {
    it("includes knowledge in system prompt when entries exist", async () => {
      // Write knowledge to the temp blob dir
      const knowledge = [
        {
          id: "k_1",
          concept: "TypeScript",
          facts: ["typed JavaScript", "compiles to JS", "supports generics"],
          relatedConcepts: [],
          sourceSessionIds: ["s1"],
          sourceNodeIds: ["n1"],
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
          accessCount: 5,
        },
      ];
      fs.writeFileSync(path.join(tmpBlobDir, "knowledge.json"), JSON.stringify(knowledge));

      const res = await request(app)
        .post("/blobs/test-session/chat")
        .send({ message: "Tell me about TypeScript" });

      expect(res.status).toBe(200);
      expect(res.body.text).toBeTruthy();

      // The prompt sent to runClaude should contain knowledge
      expect(capturedPrompts).toHaveLength(1);
      const fullPrompt = capturedPrompts[0];
      expect(fullPrompt).toContain("Relevant knowledge from previous exploration");
      expect(fullPrompt).toContain("TypeScript");
      expect(fullPrompt).toContain("typed JavaScript");
    });

    it("does not include knowledge section when no entries exist", async () => {
      // No knowledge file = loadKnowledge returns []
      const res = await request(app)
        .post("/blobs/test-session/chat")
        .send({ message: "Hello" });

      expect(res.status).toBe(200);
      expect(capturedPrompts).toHaveLength(1);
      const fullPrompt = capturedPrompts[0];
      expect(fullPrompt).not.toContain("Relevant knowledge");
    });

    it("does not include knowledge section when knowledge file is empty array", async () => {
      fs.writeFileSync(path.join(tmpBlobDir, "knowledge.json"), "[]");

      const res = await request(app)
        .post("/blobs/test-session/chat")
        .send({ message: "Hello" });

      expect(res.status).toBe(200);
      expect(capturedPrompts[0]).not.toContain("Relevant knowledge");
    });

    it("returns 400 when message is missing", async () => {
      const res = await request(app)
        .post("/blobs/test-session/chat")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/message required/i);
    });

    it("returns JSON response with text, tokens, and duration", async () => {
      const res = await request(app)
        .post("/blobs/test-session/chat")
        .send({ message: "Hi" });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("text");
      expect(res.body).toHaveProperty("inputTokens");
      expect(res.body).toHaveProperty("outputTokens");
      expect(res.body).toHaveProperty("durationMs");
    });

    it("includes conversation context in the prompt", async () => {
      const res = await request(app)
        .post("/blobs/test-session/chat")
        .send({
          message: "What next?",
          context: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi! How can I help?" },
          ],
        });

      expect(res.status).toBe(200);
      const fullPrompt = capturedPrompts[0];
      expect(fullPrompt).toContain("user: Hello");
      expect(fullPrompt).toContain("assistant: Hi! How can I help?");
      expect(fullPrompt).toContain("user: What next?");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. execute-branch sequential context
  // ═══════════════════════════════════════════════════════════════════════════

  describe("POST /blobs/:id/execute-branch — sequential context", () => {
    it("passes step 1 output as context to step 2", async () => {
      // Create a blob graph with a branch and 2 steps in sequence
      const graph = {
        nodes: [
          { id: "branch1", type: "branch", data: { kind: "branch" } },
          { id: "step1", type: "step", data: { kind: "step", stepType: "agent", prompt: "Research the topic" } },
          { id: "step2", type: "step", data: { kind: "step", stepType: "agent", prompt: "Summarize findings" } },
        ],
        edges: [
          { from: "branch1", to: "step1" },
          { from: "step1", to: "step2" },
        ],
      };
      fs.writeFileSync(path.join(tmpBlobDir, "sess1.json"), JSON.stringify(graph));

      // Configure runClaude to return predictable outputs per step
      let callCount = 0;
      runClaudeMock.mockImplementation(async (prompt: string, _step: unknown, onChunk: (c: string) => void) => {
        capturedPrompts.push(prompt);
        callCount++;
        const output = `Step ${callCount} result`;
        onChunk(output);
        return { stdout: output, durationMs: 50, inputTokens: 5, outputTokens: 10 };
      });

      const res = await request(app)
        .post("/blobs/sess1/execute-branch")
        .send({ branchNodeId: "branch1" })
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          res.on("end", () => cb(null, data));
        });

      expect(res.status).toBe(200);

      // Should have called runClaude twice (once per step)
      expect(capturedPrompts).toHaveLength(2);

      // Step 1 prompt should be the raw prompt (no previous steps)
      expect(capturedPrompts[0]).toBe("Research the topic");

      // Step 2 prompt should contain step 1's output as context
      expect(capturedPrompts[1]).toContain("## Previous Steps");
      expect(capturedPrompts[1]).toContain("Step 1 result");
      expect(capturedPrompts[1]).toContain("## Current Task");
      expect(capturedPrompts[1]).toContain("Summarize findings");

      // Verify SSE events include branch_done
      const events = parseSSEEvents(res.body as string);
      const branchDone = events.find((e) => e.type === "branch_done");
      expect(branchDone).toBeDefined();
      expect(branchDone!.stepsExecuted).toBe(2);
    });

    it("limits context to last 3 previous outputs", async () => {
      // Create a branch with 5 steps
      const graph = {
        nodes: [
          { id: "b1", type: "branch", data: { kind: "branch" } },
          ...Array.from({ length: 5 }, (_, i) => ({
            id: `s${i}`,
            type: "step",
            data: { kind: "step", stepType: "agent", prompt: `Step ${i} task` },
          })),
        ],
        edges: [
          { from: "b1", to: "s0" },
          ...Array.from({ length: 4 }, (_, i) => ({
            from: `s${i}`,
            to: `s${i + 1}`,
          })),
        ],
      };
      fs.writeFileSync(path.join(tmpBlobDir, "sess2.json"), JSON.stringify(graph));

      let callCount = 0;
      runClaudeMock.mockImplementation(async (prompt: string, _step: unknown, onChunk: (c: string) => void) => {
        capturedPrompts.push(prompt);
        callCount++;
        const output = `Result ${callCount}`;
        onChunk(output);
        return { stdout: output, durationMs: 50, inputTokens: 5, outputTokens: 10 };
      });

      await request(app)
        .post("/blobs/sess2/execute-branch")
        .send({ branchNodeId: "b1" })
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          res.on("end", () => cb(null, data));
        });

      // Step 5 (index 4) should see previous outputs (default limit 5 via BLOB_MAX_PREV_OUTPUTS)
      // capturedPrompts[4] is for step s4
      const lastPrompt = capturedPrompts[4];
      expect(lastPrompt).toContain("## Previous Steps");
      // Should contain recent step outputs
      expect(lastPrompt).toContain("Result 2");
      expect(lastPrompt).toContain("Result 3");
      expect(lastPrompt).toContain("Result 4");
    });

    it("returns 400 when branchNodeId is missing", async () => {
      const res = await request(app)
        .post("/blobs/test-session/execute-branch")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/branchNodeId required/i);
    });

    it("returns 404 when session graph does not exist", async () => {
      const res = await request(app)
        .post("/blobs/nonexistent/execute-branch")
        .send({ branchNodeId: "b1" });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/no graph data/i);
    });

    it("returns 400 when branch has no steps", async () => {
      const graph = {
        nodes: [
          { id: "b1", type: "branch", data: { kind: "branch" } },
        ],
        edges: [],
      };
      fs.writeFileSync(path.join(tmpBlobDir, "sess3.json"), JSON.stringify(graph));

      const res = await request(app)
        .post("/blobs/sess3/execute-branch")
        .send({ branchNodeId: "b1" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no steps found/i);
    });

    it("injects knowledge into branch step prompts", async () => {
      // Set up knowledge
      const knowledge = [
        {
          id: "k_1",
          concept: "Machine Learning",
          facts: ["subset of AI", "uses training data"],
          relatedConcepts: [],
          sourceSessionIds: ["s1"],
          sourceNodeIds: ["n1"],
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
          accessCount: 3,
        },
      ];
      fs.writeFileSync(path.join(tmpBlobDir, "knowledge.json"), JSON.stringify(knowledge));

      const graph = {
        nodes: [
          { id: "b1", type: "branch", data: { kind: "branch" } },
          { id: "s1", type: "step", data: { kind: "step", stepType: "agent", prompt: "Explain machine learning" } },
        ],
        edges: [
          { from: "b1", to: "s1" },
        ],
      };
      fs.writeFileSync(path.join(tmpBlobDir, "sess4.json"), JSON.stringify(graph));

      await request(app)
        .post("/blobs/sess4/execute-branch")
        .send({ branchNodeId: "b1" })
        .buffer(true)
        .parse((res, cb) => {
          let data = "";
          res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          res.on("end", () => cb(null, data));
        });

      // The prompt should contain knowledge
      expect(capturedPrompts).toHaveLength(1);
      const enriched = capturedPrompts[0];
      expect(enriched).toContain("## Relevant Knowledge");
      expect(enriched).toContain("Machine Learning");
      expect(enriched).toContain("subset of AI");
    });
  });
});
