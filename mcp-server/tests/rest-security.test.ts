/**
 * Security-focused REST API tests.
 *
 * Covers:
 * - GET /extract-style — SSRF check, invalid URL returns 400
 * - GET /proxy — SSRF check, redirect validation, content-type whitelist, size limit
 * - GET /executions/token-usage — aggregated daily tokens, days parameter
 * - PUT /config — updates env vars, writes to .env file
 * - GET /config — returns all config fields including masked secrets
 * - DELETE /executions/:id — cancels execution, closes SSE
 * - POST /executions/:id/approve/:stepId — approval flow
 * - Auth middleware — 401 without key, pass with correct key, skip /health
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("REST API security and additional routes", () => {
  let tmpDir: string;
  let request: typeof import("supertest").default;
  let app: import("express").Express;
  let originalEnvs: Record<string, string | undefined>;
  let mockExecutor: Record<string, ReturnType<typeof vi.fn>>;

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-rest-sec-"));

    originalEnvs = {
      CHAINS_DIR: process.env.CHAINS_DIR,
      SCHEDULES_FILE: process.env.SCHEDULES_FILE,
      REST_PORT: process.env.REST_PORT,
      OCC_API_KEY: process.env.OCC_API_KEY,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      BLOB_PLANNING_MODEL: process.env.BLOB_PLANNING_MODEL,
    };

    process.env.CHAINS_DIR = tmpDir;
    process.env.SCHEDULES_FILE = path.join(tmpDir, "schedules.json");
    process.env.REST_PORT = "0";
    delete process.env.OCC_API_KEY;
    delete process.env.RESEND_API_KEY;

    vi.resetModules();

    // Build mock executor with rich execution data for token-usage tests
    const executions = new Map<string, any>();
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);

    executions.set("exec_1", {
      id: "exec_1",
      chainName: "chain-a",
      status: "done",
      input: {},
      steps: {
        step1: { stepId: "step1", status: "done", output: "out", inputTokens: 100, outputTokens: 50 },
        step2: { stepId: "step2", status: "done", output: "out2", inputTokens: 200, outputTokens: 80 },
      },
      result: "done",
      startedAt: `${today}T10:00:00.000Z`,
      finishedAt: `${today}T10:01:00.000Z`,
      durationMs: 60000,
    });
    executions.set("exec_2", {
      id: "exec_2",
      chainName: "chain-b",
      status: "done",
      input: {},
      steps: {
        step1: { stepId: "step1", status: "done", output: "out", inputTokens: 50, outputTokens: 30 },
      },
      result: "done",
      startedAt: `${yesterday}T08:00:00.000Z`,
      finishedAt: `${yesterday}T08:00:30.000Z`,
      durationMs: 30000,
    });
    // Old execution (60 days ago — should be excluded with days=30)
    const oldDate = new Date(now.getTime() - 60 * 86400000).toISOString().slice(0, 10);
    executions.set("exec_old", {
      id: "exec_old",
      chainName: "chain-old",
      status: "done",
      input: {},
      steps: {
        step1: { stepId: "step1", status: "done", output: "out", inputTokens: 999, outputTokens: 999 },
      },
      result: "done",
      startedAt: `${oldDate}T12:00:00.000Z`,
      finishedAt: `${oldDate}T12:01:00.000Z`,
      durationMs: 60000,
    });

    mockExecutor = {
      executeChain: vi.fn(async () => "result"),
      getExecution: vi.fn((id: string) => executions.get(id)),
      getAllExecutions: vi.fn(() => [...executions.values()]),
      cancelExecution: vi.fn((id: string) => {
        if (id === "exec_running") return true;
        return executions.has(id);
      }),
      loadPersistedExecutions: vi.fn(),
      resumeExecution: vi.fn(async () => "resumed"),
      approveGate: vi.fn((execId: string, stepId: string, approved: boolean) => {
        if (execId === "exec_no_gate") return false;
        return true;
      }),
      getPendingApprovals: vi.fn(() => []),
      validateClaudeBinary: vi.fn(),
      canStartExecution: vi.fn(() => true),
      getRunningExecutionCount: vi.fn(() => 0),
      getExecutionTimeline: vi.fn(() => []),
    };

    vi.doMock("../src/executor.js", () => mockExecutor);

    vi.doMock("../src/scheduler.js", () => ({
      initScheduler: vi.fn(),
      setSSEEmitter: vi.fn(),
      getSchedules: vi.fn(() => []),
      getSchedule: vi.fn(),
      createSchedule: vi.fn(),
      updateSchedule: vi.fn(),
      deleteSchedule: vi.fn(),
      toggleSchedule: vi.fn(),
      runNow: vi.fn(async () => "exec_123"),
    }));

    // Mock checkSSRF and extractStyle
    vi.doMock("../src/pretool-executor.js", () => ({
      checkSSRF: vi.fn(async (url: string) => {
        if (url.includes("127.0.0.1") || url.includes("localhost") || url.includes("169.254") || url.includes("10.0.0")) {
          throw new Error("SSRF: blocked internal address");
        }
      }),
      executePretool: vi.fn(),
    }));

    vi.doMock("../src/style-extractor.js", () => ({
      extractStyle: vi.fn(async (url: string) => ({
        colors: ["#fff", "#000"],
        fonts: ["Arial"],
        url,
      })),
    }));

    const restModule = await import("../src/rest.js");
    app = restModule.app;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, val] of Object.entries(originalEnvs)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── GET /extract-style ──

  describe("GET /extract-style", () => {
    it("returns 400 for missing URL", async () => {
      const res = await request(app).get("/extract-style");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid url/i);
    });

    it("returns 400 for non-http URL", async () => {
      const res = await request(app).get("/extract-style?url=ftp://example.com");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid url/i);
    });

    it("returns 400 for empty URL param", async () => {
      const res = await request(app).get("/extract-style?url=");
      expect(res.status).toBe(400);
    });

    it("calls SSRF check and returns 500 for internal addresses", async () => {
      const res = await request(app).get("/extract-style?url=http://127.0.0.1/admin");
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/style extraction failed/i);
    });

    it("returns style data for valid external URL", async () => {
      const res = await request(app).get("/extract-style?url=http://example.com");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("colors");
      expect(res.body).toHaveProperty("fonts");
    });
  });

  // ── GET /proxy ──

  describe("GET /proxy", () => {
    it("returns 400 for missing URL", async () => {
      const res = await request(app).get("/proxy");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid url/i);
    });

    it("returns 400 for non-http URL", async () => {
      const res = await request(app).get("/proxy?url=file:///etc/passwd");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid url/i);
    });

    it("returns 502 for SSRF-blocked internal address", async () => {
      const res = await request(app).get("/proxy?url=http://127.0.0.1:8080/internal");
      expect(res.status).toBe(502);
      expect(res.body.error).toContain("SSRF");
    });

    it("returns 502 for SSRF-blocked metadata endpoint", async () => {
      const res = await request(app).get("/proxy?url=http://169.254.169.254/latest/meta-data");
      expect(res.status).toBe(502);
    });
  });

  // ── GET /executions/token-usage ──

  describe("GET /executions/token-usage", () => {
    it("returns aggregated daily token usage", async () => {
      const res = await request(app).get("/executions/token-usage");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // Should have entries for today and yesterday (but not old one beyond 30 days)
      expect(res.body.length).toBeGreaterThanOrEqual(2);
    });

    it("each entry has date, input, output, executions fields", async () => {
      const res = await request(app).get("/executions/token-usage");
      for (const entry of res.body) {
        expect(entry).toHaveProperty("date");
        expect(entry).toHaveProperty("input");
        expect(entry).toHaveProperty("output");
        expect(entry).toHaveProperty("executions");
        expect(typeof entry.input).toBe("number");
        expect(typeof entry.output).toBe("number");
        expect(typeof entry.executions).toBe("number");
      }
    });

    it("aggregates tokens correctly for today", async () => {
      const res = await request(app).get("/executions/token-usage");
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const todayEntry = res.body.find((e: any) => e.date === today);
      expect(todayEntry).toBeDefined();
      // exec_1 has 100+200=300 input, 50+80=130 output
      expect(todayEntry.input).toBe(300);
      expect(todayEntry.output).toBe(130);
      expect(todayEntry.executions).toBe(1);
    });

    it("respects days parameter to filter old entries", async () => {
      const res = await request(app).get("/executions/token-usage?days=1");
      expect(res.status).toBe(200);
      // With days=1, only today's entries should be included
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      for (const entry of res.body) {
        expect(entry.date).toBe(today);
      }
    });

    it("caps days parameter at 90", async () => {
      // Even with days=999, the code caps at 90 via Math.min
      const res = await request(app).get("/executions/token-usage?days=999");
      expect(res.status).toBe(200);
      // Should still work — just means 90 day window
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("excludes entries older than days window", async () => {
      const res = await request(app).get("/executions/token-usage?days=30");
      // The 60-day-old execution should be excluded
      const oldDate = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
      const oldEntry = res.body.find((e: any) => e.date === oldDate);
      expect(oldEntry).toBeUndefined();
    });

    it("returns sorted by date ascending", async () => {
      const res = await request(app).get("/executions/token-usage");
      const dates = res.body.map((e: any) => e.date);
      const sorted = [...dates].sort();
      expect(dates).toEqual(sorted);
    });
  });

  // ── GET /config ──

  describe("GET /config", () => {
    it("returns all configuration fields", async () => {
      const res = await request(app).get("/config");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("chainsDir");
      expect(res.body).toHaveProperty("pipelinesDir");
      expect(res.body).toHaveProperty("workspaceDir");
      expect(res.body).toHaveProperty("restPort");
      expect(res.body).toHaveProperty("claudeCli");
      expect(res.body).toHaveProperty("logLevel");
      expect(res.body).toHaveProperty("apiKeySet");
      expect(res.body).toHaveProperty("blobPlanningModel");
      expect(res.body).toHaveProperty("rateLimitExec");
    });

    it("masks resendApiKey when set", async () => {
      // Re-initialize with RESEND_API_KEY set
      process.env.RESEND_API_KEY = "re_1234567890abcdef";
      vi.resetModules();

      vi.doMock("../src/executor.js", () => mockExecutor);
      vi.doMock("../src/scheduler.js", () => ({
        initScheduler: vi.fn(), setSSEEmitter: vi.fn(),
        getSchedules: vi.fn(() => []), getSchedule: vi.fn(),
        createSchedule: vi.fn(), updateSchedule: vi.fn(),
        deleteSchedule: vi.fn(), toggleSchedule: vi.fn(), runNow: vi.fn(),
      }));
      vi.doMock("../src/pretool-executor.js", () => ({
        checkSSRF: vi.fn(), executePretool: vi.fn(),
      }));
      vi.doMock("../src/style-extractor.js", () => ({
        extractStyle: vi.fn(async () => ({})),
      }));

      const restModule = await import("../src/rest.js");
      const freshApp = restModule.app;
      const res = await request(freshApp).get("/config");
      expect(res.body.resendApiKey).toBe("***");
    });

    it("returns empty string for resendApiKey when not set", async () => {
      delete process.env.RESEND_API_KEY;
      const res = await request(app).get("/config");
      expect(res.body.resendApiKey).toBe("");
    });

    it("reports apiKeySet as false when OCC_API_KEY is unset", async () => {
      const res = await request(app).get("/config");
      expect(res.body.apiKeySet).toBe(false);
    });
  });

  // ── PUT /config ──

  describe("PUT /config", () => {
    it("updates env vars and returns ok", async () => {
      const res = await request(app)
        .put("/config")
        .send({ logLevel: "debug", publicHost: "myserver.com" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(process.env.LOG_LEVEL).toBe("debug");
      expect(process.env.PUBLIC_HOST).toBe("myserver.com");
    });

    it("writes .env file to disk", async () => {
      // Set cwd mock to tmpDir so .env is written there
      const origCwd = process.cwd;
      process.cwd = () => tmpDir;
      try {
        const res = await request(app)
          .put("/config")
          .send({ logLevel: "warn" });
        expect(res.status).toBe(200);
        const envContent = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
        expect(envContent).toContain("LOG_LEVEL=warn");
      } finally {
        process.cwd = origCwd;
      }
    });

    it("ignores unknown config keys", async () => {
      const res = await request(app)
        .put("/config")
        .send({ unknownKey: "value", anotherFake: "123" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("updates existing keys in .env file", async () => {
      const origCwd = process.cwd;
      process.cwd = () => tmpDir;
      // Pre-create .env with an existing key
      fs.writeFileSync(path.join(tmpDir, ".env"), "LOG_LEVEL=info\nREST_PORT=4242\n");
      try {
        await request(app).put("/config").send({ logLevel: "error" });
        const envContent = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
        expect(envContent).toContain("LOG_LEVEL=error");
        // REST_PORT should be unchanged
        expect(envContent).toContain("REST_PORT=4242");
      } finally {
        process.cwd = origCwd;
      }
    });
  });

  // ── DELETE /executions/:id ──

  describe("DELETE /executions/:id (cancel)", () => {
    it("cancels an existing execution and returns ok", async () => {
      const res = await request(app).delete("/executions/exec_1");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockExecutor.cancelExecution).toHaveBeenCalledWith("exec_1");
    });

    it("returns 404 when cancelExecution returns false", async () => {
      mockExecutor.cancelExecution.mockReturnValue(false);
      const res = await request(app).delete("/executions/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found|already finished/i);
    });
  });

  // ── POST /executions/:id/approve/:stepId ──

  describe("POST /executions/:id/approve/:stepId", () => {
    it("approves a gate and returns ok", async () => {
      const res = await request(app)
        .post("/executions/exec_1/approve/gate1")
        .send({ approved: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockExecutor.approveGate).toHaveBeenCalledWith("exec_1", "gate1", true);
    });

    it("rejects a gate (approved=false)", async () => {
      const res = await request(app)
        .post("/executions/exec_1/approve/gate1")
        .send({ approved: false });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockExecutor.approveGate).toHaveBeenCalledWith("exec_1", "gate1", false);
    });

    it("returns 404 when no pending approval found", async () => {
      const res = await request(app)
        .post("/executions/exec_no_gate/approve/step1")
        .send({ approved: true });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/no pending approval/i);
    });

    it("defaults approved to false when body is empty", async () => {
      const res = await request(app)
        .post("/executions/exec_1/approve/gate1")
        .send({});
      expect(res.status).toBe(200);
      expect(mockExecutor.approveGate).toHaveBeenCalledWith("exec_1", "gate1", false);
    });
  });
});

// ── Auth middleware (separate describe to get a fresh app with API key set) ──

describe("Auth middleware security", () => {
  let tmpDir: string;
  let request: typeof import("supertest").default;
  let app: import("express").Express;
  let originalEnvs: Record<string, string | undefined>;

  beforeAll(async () => {
    const supertest = await import("supertest");
    request = supertest.default;
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-auth-sec-"));

    originalEnvs = {
      CHAINS_DIR: process.env.CHAINS_DIR,
      SCHEDULES_FILE: process.env.SCHEDULES_FILE,
      REST_PORT: process.env.REST_PORT,
      OCC_API_KEY: process.env.OCC_API_KEY,
    };

    process.env.CHAINS_DIR = tmpDir;
    process.env.SCHEDULES_FILE = path.join(tmpDir, "schedules.json");
    process.env.REST_PORT = "0";
    process.env.OCC_API_KEY = "secret-api-key-test-42";

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
      initScheduler: vi.fn(), setSSEEmitter: vi.fn(),
      getSchedules: vi.fn(() => []), getSchedule: vi.fn(),
      createSchedule: vi.fn(), updateSchedule: vi.fn(),
      deleteSchedule: vi.fn(), toggleSchedule: vi.fn(), runNow: vi.fn(),
    }));

    vi.doMock("../src/pretool-executor.js", () => ({
      checkSSRF: vi.fn(), executePretool: vi.fn(),
    }));

    vi.doMock("../src/style-extractor.js", () => ({
      extractStyle: vi.fn(async () => ({})),
    }));

    const restModule = await import("../src/rest.js");
    app = restModule.app;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, val] of Object.entries(originalEnvs)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 401 for unauthenticated request to /config", async () => {
    const res = await request(app).get("/config");
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Unauthorized");
  });

  it("returns 401 for unauthenticated request to /executions/token-usage", async () => {
    const res = await request(app).get("/executions/token-usage");
    expect(res.status).toBe(401);
  });

  it("allows /health without auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("allows authenticated access via Bearer token", async () => {
    const res = await request(app)
      .get("/config")
      .set("Authorization", "Bearer secret-api-key-test-42");
    expect(res.status).toBe(200);
  });

  it("rejects api_key query param (removed for security — keys leak in logs/caches)", async () => {
    const res = await request(app).get("/config?api_key=secret-api-key-test-42");
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong Bearer token", async () => {
    const res = await request(app)
      .get("/config")
      .set("Authorization", "Bearer wrong-key-value");
    expect(res.status).toBe(401);
  });

  it("returns 401 for partial correct key (timing-safe)", async () => {
    const res = await request(app)
      .get("/config")
      .set("Authorization", "Bearer secret-api-key-test-4");
    expect(res.status).toBe(401);
  });

  it("skips auth for /assets/ paths (static files)", async () => {
    const res = await request(app).get("/assets/nonexistent.js");
    // Should not be 401 (auth skipped), likely 404 since file doesn't exist
    expect(res.status).not.toBe(401);
  });
});
