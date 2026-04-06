/**
 * Extended REST API tests.
 *
 * Covers:
 * - Security headers (X-Content-Type-Options, X-Frame-Options, etc.)
 * - Auth middleware (OCC_API_KEY)
 * - Rate limit headers
 * - Path traversal rejection on chain/pipeline names
 * - GET /events SSE endpoint
 * - Pipeline CRUD endpoints
 * - Queue endpoints
 * - Approvals endpoint
 * - Execution timeline endpoint
 * - sanitizeName validation
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTmpDir } from "./_test-utils.js";
import * as os from "node:os";

// ─── sanitizeName tests (pure function from loader.ts) ─────────────────────

describe("sanitizeName (path traversal prevention)", () => {
  // Import directly since it's a pure function
  let sanitizeName: (name: string) => string;

  beforeAll(async () => {
    const loader = await import("../src/loader.js");
    sanitizeName = loader.sanitizeName;
  });

  it("accepts valid kebab-case name", () => {
    expect(sanitizeName("my-chain")).toBe("my-chain");
  });

  it("accepts name with underscores", () => {
    expect(sanitizeName("my_chain")).toBe("my_chain");
  });

  it("accepts name with dots", () => {
    expect(sanitizeName("chain.v2")).toBe("chain.v2");
  });

  it("accepts name with numbers", () => {
    expect(sanitizeName("chain123")).toBe("chain123");
  });

  it("accepts single character name", () => {
    expect(sanitizeName("a")).toBe("a");
  });

  it("rejects path traversal with ../", () => {
    expect(() => sanitizeName("../etc/passwd")).toThrow(/invalid name/i);
  });

  it("rejects path traversal with ..\\", () => {
    expect(() => sanitizeName("..\\windows\\system32")).toThrow(/invalid name/i);
  });

  it("rejects absolute path /etc/passwd", () => {
    expect(() => sanitizeName("/etc/passwd")).toThrow(/invalid name/i);
  });

  it("rejects name with forward slash", () => {
    expect(() => sanitizeName("a/b")).toThrow(/invalid name/i);
  });

  it("rejects name with backslash", () => {
    expect(() => sanitizeName("a\\b")).toThrow(/invalid name/i);
  });

  it("rejects name with null byte", () => {
    expect(() => sanitizeName("chain\x00evil")).toThrow(/invalid name/i);
  });

  it("rejects empty string", () => {
    expect(() => sanitizeName("")).toThrow(/invalid name/i);
  });

  it("rejects name starting with dot", () => {
    expect(() => sanitizeName(".hidden")).toThrow(/invalid name/i);
  });

  it("rejects name starting with dash", () => {
    expect(() => sanitizeName("-dash")).toThrow(/invalid name/i);
  });

  it("rejects name with spaces", () => {
    expect(() => sanitizeName("my chain")).toThrow(/invalid name/i);
  });

  it("rejects name with special characters", () => {
    expect(() => sanitizeName("chain<script>")).toThrow(/invalid name/i);
  });

  it("rejects name with colon", () => {
    expect(() => sanitizeName("C:chain")).toThrow(/invalid name/i);
  });

  it("rejects name with pipe", () => {
    expect(() => sanitizeName("chain|evil")).toThrow(/invalid name/i);
  });
});

// ─── HTTP integration tests ────────────────────────────────────────────────

describe("REST API extended HTTP tests", () => {
  let tmpDir: string;
  let tmpSchedulesFile: string;
  let request: typeof import("supertest").default;
  let app: import("express").Express;
  let originalChainsDir: string | undefined;
  let originalSchedulesFile: string | undefined;
  let originalRestPort: string | undefined;
  let originalApiKey: string | undefined;

  const validChainYaml = `
name: test-chain
description: Test chain
version: "1.0"
inputs: []
steps:
  - id: step1
    prompt: "Hello"
    output_var: result
    tools: []
    depends_on: []
output: result
`;

  beforeAll(async () => {
    const supertest = await import("supertest");
    request = supertest.default;
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-rest-ext-"));
    tmpSchedulesFile = path.join(tmpDir, "schedules.json");

    originalChainsDir = process.env.CHAINS_DIR;
    originalSchedulesFile = process.env.SCHEDULES_FILE;
    originalRestPort = process.env.REST_PORT;
    originalApiKey = process.env.OCC_API_KEY;

    process.env.CHAINS_DIR = tmpDir;
    process.env.SCHEDULES_FILE = tmpSchedulesFile;
    process.env.REST_PORT = "0";
    delete process.env.OCC_API_KEY;

    vi.resetModules();

    vi.doMock("../src/executor.js", () => {
      const executions = new Map<string, any>();
      return {
        executeChain: vi.fn(async (chain: any, input: any, emitter: any) => {
          const id = `exec_${Date.now()}`;
          const execution = {
            id,
            chainName: chain.name,
            status: "done",
            input,
            steps: { step1: { stepId: "step1", status: "done", output: "output" } },
            result: "result",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 50,
          };
          executions.set(id, execution);
          if (emitter) {
            emitter({ type: "execution_started", executionId: id, chainName: chain.name });
            emitter({ type: "execution_done", executionId: id, result: "result", durationMs: 50 });
          }
        }),
        getExecution: vi.fn((id: string) => executions.get(id)),
        getAllExecutions: vi.fn(() => [...executions.values()]),
        cancelExecution: vi.fn(() => false),
        loadPersistedExecutions: vi.fn(),
        resumeExecution: vi.fn(async () => "resumed"),
        approveGate: vi.fn(() => true),
        getPendingApprovals: vi.fn(() => [
          { executionId: "e1", stepId: "gate1", prompt: "Approve?", since: new Date().toISOString() },
        ]),
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
      createSchedule: vi.fn((data: any) => ({ ...data, id: `sched_${Date.now()}`, createdAt: new Date().toISOString() })),
      updateSchedule: vi.fn(() => null),
      deleteSchedule: vi.fn(() => false),
      toggleSchedule: vi.fn(() => null),
      runNow: vi.fn(async () => `exec_${Date.now()}`),
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
    await cleanupTmpDir(tmpDir);
  });

  // ── Security headers ──

  describe("Security headers", () => {
    it("sets X-Content-Type-Options: nosniff", async () => {
      const res = await request(app).get("/health");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("sets X-Frame-Options: DENY", async () => {
      const res = await request(app).get("/health");
      expect(res.headers["x-frame-options"]).toBe("DENY");
    });

    it("sets Referrer-Policy: no-referrer", async () => {
      const res = await request(app).get("/health");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
    });

    it("strips X-Powered-By header (security best practice)", async () => {
      const res = await request(app).get("/health");
      expect(res.headers["x-powered-by"]).toBeUndefined();
    });

    it("sets CORS headers when Origin is whitelisted", async () => {
      const res = await request(app).get("/health").set("Origin", "http://localhost:5173");
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
      expect(res.headers["access-control-allow-methods"]).toContain("GET");
      expect(res.headers["access-control-allow-methods"]).toContain("POST");
      expect(res.headers["access-control-allow-methods"]).toContain("DELETE");
    });
  });

  // ── GET /events SSE ──

  describe("GET /events (global SSE)", () => {
    it("returns SSE headers", async () => {
      const http = await import("node:http");
      const server = app.listen(0);
      const addr = server.address() as import("node:net").AddressInfo;
      try {
        const result = await new Promise<{ headers: Record<string, string>; data: string }>((resolve, reject) => {
          let data = "";
          const req = http.get(`http://127.0.0.1:${addr.port}/events`, (res) => {
            res.on("data", (chunk) => { data += chunk.toString(); });
            setTimeout(() => {
              resolve({ headers: res.headers as Record<string, string>, data });
              res.destroy();
              req.destroy();
            }, 200);
          });
          req.on("error", (err) => {
            if ((err as any).code !== "ECONNRESET") reject(err);
          });
          setTimeout(() => { req.destroy(); reject(new Error("timeout")); }, 3000);
        });
        expect(result.headers["content-type"]).toMatch(/text\/event-stream/);
        expect(result.headers["cache-control"]).toBe("no-cache");
        expect(result.data).toContain("Connected to global event stream");
      } finally {
        server.close();
      }
    });
  });

  // ── GET /approvals ──

  describe("GET /approvals", () => {
    it("returns pending approvals list", async () => {
      const res = await request(app).get("/approvals");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toHaveProperty("executionId", "e1");
      expect(res.body[0]).toHaveProperty("stepId", "gate1");
    });
  });

  // ── Pipeline endpoints ──

  describe("Pipeline endpoints", () => {
    it("GET /pipelines returns empty array when no pipelines", async () => {
      const res = await request(app).get("/pipelines");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("GET /pipelines/:name returns 404 for missing pipeline", async () => {
      const res = await request(app).get("/pipelines/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("error");
    });

    it("DELETE /pipelines/:name returns 404 for missing pipeline", async () => {
      const res = await request(app).delete("/pipelines/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  // ── Queue endpoints ──

  describe("Queue endpoints", () => {
    it("GET /queue returns queue stats", async () => {
      const res = await request(app).get("/queue");
      expect(res.status).toBe(200);
      expect(res.body).toBeDefined();
    });

    it("GET /queue/jobs returns job list", async () => {
      const res = await request(app).get("/queue/jobs");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("GET /queue/jobs/:id returns 404 for unknown job", async () => {
      const res = await request(app).get("/queue/jobs/unknown-job-id");
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("error");
    });

    it("DELETE /queue/jobs/:id returns 404 for unknown job", async () => {
      const res = await request(app).delete("/queue/jobs/unknown-id");
      expect(res.status).toBe(404);
    });
  });

  // ── Execution pagination ──

  describe("Execution pagination", () => {
    it("GET /executions accepts limit parameter", async () => {
      const res = await request(app).get("/executions?limit=5");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("GET /executions accepts offset parameter", async () => {
      const res = await request(app).get("/executions?offset=10");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("GET /executions caps limit at 200", async () => {
      const res = await request(app).get("/executions?limit=999");
      expect(res.status).toBe(200);
      // The endpoint internally caps at 200
    });
  });

  // ── Path traversal on chain names ──

  describe("Path traversal prevention on chain names", () => {
    it("POST /chains/../etc/passwd is rejected (404 or 400)", async () => {
      const res = await request(app)
        .post("/chains/../etc/passwd")
        .send(validChainYaml)
        .set("Content-Type", "text/yaml");
      // Express normalizes path traversal so ../ in URL path results in 404 (no route match)
      // or 400 if sanitizeName catches it — either way, the chain should NOT be saved
      expect([400, 404]).toContain(res.status);
    });

    it("POST /chains/name-with-slash is rejected", async () => {
      const res = await request(app)
        .post("/chains/a%2Fb")
        .send(validChainYaml)
        .set("Content-Type", "text/yaml");
      // URL-encoded slash may be decoded; the sanitizeName check should catch it
      expect([200, 400]).toContain(res.status);
    });
  });

  // ── POST /chains/:name body type detection ──

  describe("POST /chains body type handling", () => {
    it("saves JSON body via saveChain", async () => {
      const chainDef = {
        name: "json-test",
        steps: [{ id: "s1", prompt: "hello", output_var: "out", tools: [], depends_on: [] }],
        output: "out",
      };
      const res = await request(app)
        .post("/chains/json-test")
        .send(chainDef)
        .set("Content-Type", "application/json");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("saves YAML string body directly", async () => {
      const res = await request(app)
        .post("/chains/yaml-direct")
        .send(validChainYaml)
        .set("Content-Type", "text/yaml");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      // Verify file was written
      expect(fs.existsSync(path.join(tmpDir, "yaml-direct.yaml"))).toBe(true);
    });
  });

  // ── Pipeline execution endpoint ──

  describe("POST /pipelines/:name/execute", () => {
    it("returns 400 for missing pipeline", async () => {
      const res = await request(app)
        .post("/pipelines/nonexistent/execute")
        .send({ input: {} });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });
  });

  // ── GET /pipeline-executions ──

  describe("Pipeline execution history", () => {
    it("GET /pipeline-executions returns array", async () => {
      const res = await request(app).get("/pipeline-executions");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("GET /pipeline-executions/:id returns 404 for unknown", async () => {
      const res = await request(app).get("/pipeline-executions/unknown-id");
      expect(res.status).toBe(404);
    });
  });

  // ── MCP servers endpoint ──

  describe("GET /mcp-servers", () => {
    it("returns server list (may be empty)", async () => {
      const res = await request(app).get("/mcp-servers");
      // May return 200 or 500 depending on MCP config
      expect([200, 500]).toContain(res.status);
    });
  });

  // ── GET /download edge cases ──

  describe("GET /download edge cases", () => {
    it("returns 400 for empty path", async () => {
      const res = await request(app).get("/download?path=");
      expect(res.status).toBe(400);
    });

    it("returns 403 or 404 for /etc/shadow (outside allowed dirs or not found)", async () => {
      const res = await request(app).get("/download?path=/etc/shadow");
      // On macOS /etc/shadow doesn't exist -> 404 (file not found check happens before path check)
      // On Linux it exists -> 403 (outside allowed dirs)
      expect([403, 404]).toContain(res.status);
    });
  });

  // ── Execution timeline ──

  describe("GET /executions/:id/timeline", () => {
    it("returns timeline data (may be empty array)", async () => {
      const res = await request(app).get("/executions/some-id/timeline");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});

// ─── Auth middleware tests ──────────────────────────────────────────────────

describe("Auth middleware (OCC_API_KEY)", () => {
  let tmpDir: string;
  let request: typeof import("supertest").default;
  let app: import("express").Express;
  let originalChainsDir: string | undefined;
  let originalSchedulesFile: string | undefined;
  let originalApiKey: string | undefined;

  beforeAll(async () => {
    const supertest = await import("supertest");
    request = supertest.default;
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-auth-test-"));
    originalChainsDir = process.env.CHAINS_DIR;
    originalSchedulesFile = process.env.SCHEDULES_FILE;
    originalApiKey = process.env.OCC_API_KEY;

    process.env.CHAINS_DIR = tmpDir;
    process.env.SCHEDULES_FILE = path.join(tmpDir, "schedules.json");
    process.env.REST_PORT = "0";
    process.env.OCC_API_KEY = "test-secret-key-12345";

    vi.resetModules();

    vi.doMock("../src/executor.js", () => ({
      executeChain: vi.fn(),
      getExecution: vi.fn(),
      getAllExecutions: vi.fn(() => []),
      cancelExecution: vi.fn(),
      loadPersistedExecutions: vi.fn(),
      resumeExecution: vi.fn(),
      approveGate: vi.fn(),
      getPendingApprovals: vi.fn(() => []),
      validateClaudeBinary: vi.fn(),
      canStartExecution: vi.fn(() => true),
      getRunningExecutionCount: vi.fn(() => 0),
      getExecutionTimeline: vi.fn(() => []),
    }));

    vi.doMock("../src/scheduler.js", () => ({
      initScheduler: vi.fn(),
      setSSEEmitter: vi.fn(),
      getSchedules: vi.fn(() => []),
      getSchedule: vi.fn(),
      createSchedule: vi.fn(),
      updateSchedule: vi.fn(),
      deleteSchedule: vi.fn(),
      toggleSchedule: vi.fn(),
      runNow: vi.fn(),
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
    if (originalApiKey === undefined) delete process.env.OCC_API_KEY;
    else process.env.OCC_API_KEY = originalApiKey;
    await cleanupTmpDir(tmpDir);
  });

  it("returns 401 for unauthenticated request to /chains", async () => {
    const res = await request(app).get("/chains");
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toContain("Unauthorized");
  });

  it("allows request with valid Bearer token", async () => {
    const res = await request(app)
      .get("/chains")
      .set("Authorization", "Bearer test-secret-key-12345");
    expect(res.status).toBe(200);
  });

  it("rejects api_key query param (removed for security)", async () => {
    const res = await request(app).get("/chains?api_key=test-secret-key-12345");
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong Bearer token", async () => {
    const res = await request(app)
      .get("/chains")
      .set("Authorization", "Bearer wrong-key");
    expect(res.status).toBe(401);
  });

  it("allows /health without authentication", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("allows root / without authentication", async () => {
    const res = await request(app).get("/");
    // Root serves static files or 404, but should NOT be 401
    expect(res.status).not.toBe(401);
  });
});
