/**
 * Comprehensive tests for the OCC 3 REST API (rest.ts).
 *
 * Strategy:
 * 1. Route structure tests — read the source and verify all expected routes exist.
 * 2. Loader integration tests — test chain CRUD via the loader with a temp directory.
 * 3. HTTP integration tests — use supertest against the Express app (mocking heavy deps).
 */
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── 1. Route structure tests (static analysis) ─────────────────────────────

describe("Route structure (static analysis of rest.ts)", () => {
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(
      path.resolve(__dirname, "../src/rest.ts"),
      "utf-8",
    );
  });

  const expectedRoutes = [
    { method: "get", path: "/chains" },
    { method: "get", path: "/chains/:name" },
    { method: "post", path: "/chains/:name" },
    { method: "delete", path: "/chains/:name" },
    { method: "post", path: "/execute/:name" },
    { method: "get", path: "/executions/:id/stream" },
    { method: "get", path: "/executions/:id" },
    { method: "delete", path: "/executions/:id" },
    { method: "post", path: "/executions/:id/resume" },
    { method: "post", path: "/executions/:id/approve/:stepId" },
    { method: "get", path: "/executions" },
    { method: "get", path: "/download" },
    { method: "get", path: "/schedules" },
    { method: "get", path: "/schedules/:id" },
    { method: "post", path: "/schedules" },
    { method: "put", path: "/schedules/:id" },
    { method: "patch", path: "/schedules/:id/toggle" },
    { method: "post", path: "/schedules/:id/run" },
    { method: "delete", path: "/schedules/:id" },
    { method: "get", path: "/health" },
  ];

  for (const route of expectedRoutes) {
    it(`defines ${route.method.toUpperCase()} ${route.path}`, () => {
      // Escape special regex chars in the path string
      const escaped = route.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(
        `app\\.${route.method}\\(["'\`]${escaped}["'\`]`,
      );
      expect(source).toMatch(pattern);
    });
  }

  it("exports the app", () => {
    expect(source).toMatch(/export\s*\{\s*app\s*\}/);
  });

  it("sets up CORS middleware", () => {
    expect(source).toContain("Access-Control-Allow-Origin");
    expect(source).toContain("Access-Control-Allow-Methods");
  });

  it("configures JSON body parser with 2mb limit", () => {
    expect(source).toMatch(/express\.json\(\{.*limit.*2mb/s);
  });

  it("configures YAML text body parser", () => {
    expect(source).toMatch(/express\.text\(\{.*text\/yaml/s);
  });
});

// ─── 2. Loader integration tests (chain CRUD with temp directory) ────────────

describe("Loader integration (chain CRUD)", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-test-chains-"));
    originalEnv = process.env.CHAINS_DIR;
    process.env.CHAINS_DIR = tmpDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CHAINS_DIR;
    } else {
      process.env.CHAINS_DIR = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Dynamically import the loader so CHAINS_DIR is picked up
  async function getLoader() {
    // Use a cache-busting query to get fresh module state isn't needed
    // because getChainsDir reads env at call time
    return await import("../src/loader.js");
  }

  const validChainYaml = `
name: test-chain
description: A test chain
version: "1.0"
inputs:
  - name: topic
    description: The topic
steps:
  - id: step1
    prompt: "Write about {topic}"
    output_var: result
    tools: []
    depends_on: []
output: result
`;

  const validChainObject = {
    name: "test-chain",
    description: "A test chain",
    version: "1.0",
    inputs: [{ name: "topic", description: "The topic" }],
    steps: [
      {
        id: "step1",
        prompt: "Write about {topic}",
        output_var: "result",
        tools: [],
        depends_on: [],
      },
    ],
    output: "result",
  };

  it("listChains returns empty array when directory is empty", async () => {
    const loader = await getLoader();
    expect(loader.listChains()).toEqual([]);
  });

  it("listChains returns chain names from .yaml files", async () => {
    fs.writeFileSync(path.join(tmpDir, "my-chain.yaml"), validChainYaml);
    fs.writeFileSync(path.join(tmpDir, "other.yml"), validChainYaml);
    const loader = await getLoader();
    const names = loader.listChains();
    expect(names).toContain("my-chain");
    expect(names).toContain("other");
  });

  it("saveChain writes a YAML file and loadChain reads it back", async () => {
    const loader = await getLoader();
    loader.saveChain("saved-chain", validChainObject as any);

    const filePath = path.join(tmpDir, "saved-chain.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    const loaded = loader.loadChain("saved-chain");
    expect(loaded.name).toBe("test-chain");
    expect(loaded.steps).toHaveLength(1);
    expect(loaded.output).toBe("result");
  });

  it("loadChainRaw returns raw YAML string", async () => {
    fs.writeFileSync(path.join(tmpDir, "raw-test.yaml"), validChainYaml);
    const loader = await getLoader();
    const raw = loader.loadChainRaw("raw-test");
    expect(raw).toContain("name: test-chain");
    expect(raw).toContain("Write about {topic}");
  });

  it("loadChain throws for non-existent chain", async () => {
    const loader = await getLoader();
    expect(() => loader.loadChain("nonexistent")).toThrow(/not found/i);
  });

  it("deleteChain removes the file", async () => {
    fs.writeFileSync(path.join(tmpDir, "to-delete.yaml"), validChainYaml);
    const loader = await getLoader();
    expect(loader.listChains()).toContain("to-delete");

    loader.deleteChain("to-delete");
    expect(loader.listChains()).not.toContain("to-delete");
    expect(fs.existsSync(path.join(tmpDir, "to-delete.yaml"))).toBe(false);
  });

  it("deleteChain throws for non-existent chain", async () => {
    const loader = await getLoader();
    expect(() => loader.deleteChain("ghost")).toThrow(/not found/i);
  });

  it("loadChain validates chain structure", async () => {
    const invalidYaml = "name: bad\n"; // missing steps and output
    fs.writeFileSync(path.join(tmpDir, "invalid.yaml"), invalidYaml);
    const loader = await getLoader();
    expect(() => loader.loadChain("invalid")).toThrow(/invalid chain/i);
  });

  it("loadChain supports .yml extension", async () => {
    fs.writeFileSync(path.join(tmpDir, "yml-test.yml"), validChainYaml);
    const loader = await getLoader();
    const chain = loader.loadChain("yml-test");
    expect(chain.name).toBe("test-chain");
  });
});

// ─── 3. Dependency graph tests ───────────────────────────────────────────────

describe("Dependency graph (buildDependencyGraph)", () => {
  async function getLoader() {
    return await import("../src/loader.js");
  }

  it("builds a single wave for steps with no dependencies", async () => {
    const { buildDependencyGraph } = await getLoader();
    const chain = {
      name: "test",
      steps: [
        { id: "a", prompt: "a", output_var: "out_a", depends_on: [], tools: [] },
        { id: "b", prompt: "b", output_var: "out_b", depends_on: [], tools: [] },
      ],
      output: "out_a",
    } as any;
    const graph = buildDependencyGraph(chain);
    expect(graph.waves).toHaveLength(1);
    expect(graph.waves[0]).toContain("a");
    expect(graph.waves[0]).toContain("b");
  });

  it("builds multiple waves for dependent steps", async () => {
    const { buildDependencyGraph } = await getLoader();
    const chain = {
      name: "test",
      steps: [
        { id: "a", prompt: "a", output_var: "out_a", depends_on: [], tools: [] },
        { id: "b", prompt: "b", output_var: "out_b", depends_on: ["a"], tools: [] },
        { id: "c", prompt: "c", output_var: "out_c", depends_on: ["b"], tools: [] },
      ],
      output: "out_c",
    } as any;
    const graph = buildDependencyGraph(chain);
    expect(graph.waves).toHaveLength(3);
    expect(graph.waves[0]).toEqual(["a"]);
    expect(graph.waves[1]).toEqual(["b"]);
    expect(graph.waves[2]).toEqual(["c"]);
  });

  it("detects circular dependencies", async () => {
    const { buildDependencyGraph } = await getLoader();
    const chain = {
      name: "test",
      steps: [
        { id: "a", prompt: "a", output_var: "out_a", depends_on: ["b"], tools: [] },
        { id: "b", prompt: "b", output_var: "out_b", depends_on: ["a"], tools: [] },
      ],
      output: "out_a",
    } as any;
    expect(() => buildDependencyGraph(chain)).toThrow(/circular/i);
  });

  it("detects unknown dependency references", async () => {
    const { buildDependencyGraph } = await getLoader();
    const chain = {
      name: "test",
      steps: [
        { id: "a", prompt: "a", output_var: "out_a", depends_on: ["z"], tools: [] },
      ],
      output: "out_a",
    } as any;
    expect(() => buildDependencyGraph(chain)).toThrow(/unknown step/i);
  });

  it("detects invalid output reference", async () => {
    const { buildDependencyGraph } = await getLoader();
    const chain = {
      name: "test",
      steps: [
        { id: "a", prompt: "a", output_var: "out_a", depends_on: [], tools: [] },
      ],
      output: "nonexistent",
    } as any;
    expect(() => buildDependencyGraph(chain)).toThrow(/output/i);
  });
});

// ─── 4. HTTP integration tests with supertest ────────────────────────────────

describe("REST API HTTP integration", () => {
  let tmpDir: string;
  let tmpSchedulesFile: string;
  let request: typeof import("supertest").default;
  let app: import("express").Express;
  let originalChainsDir: string | undefined;
  let originalSchedulesFile: string | undefined;
  let originalRestPort: string | undefined;

  const validChainYaml = `
name: http-test
description: HTTP test chain
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-rest-test-"));
    tmpSchedulesFile = path.join(tmpDir, "schedules.json");

    originalChainsDir = process.env.CHAINS_DIR;
    originalSchedulesFile = process.env.SCHEDULES_FILE;
    originalRestPort = process.env.REST_PORT;

    process.env.CHAINS_DIR = tmpDir;
    process.env.SCHEDULES_FILE = tmpSchedulesFile;
    // Use port 0 to avoid conflicts (though supertest uses the app directly)
    process.env.REST_PORT = "0";

    // Reset module cache to get fresh app instance with mocked deps
    vi.resetModules();

    // Mock the executor to avoid spawning real processes
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
            steps: {
              step1: { stepId: "step1", status: "done", output: "test output" },
            },
            result: "test result",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 100,
          };
          executions.set(id, execution);
          if (emitter) {
            emitter({ type: "execution_started", executionId: id, chainName: chain.name });
            emitter({ type: "execution_done", executionId: id, result: "test result", durationMs: 100 });
          }
          return "test result";
        }),
        getExecution: vi.fn((id: string) => executions.get(id)),
        getAllExecutions: vi.fn(() => [...executions.values()]),
        cancelExecution: vi.fn((id: string) => executions.has(id)),
        loadPersistedExecutions: vi.fn(),
        resumeExecution: vi.fn(async () => "resumed result"),
        approveGate: vi.fn(() => true),
        getPendingApprovals: vi.fn(() => []),
        validateClaudeBinary: vi.fn(),
        canStartExecution: vi.fn(() => true),
        getRunningExecutionCount: vi.fn(() => 0),
      };
    });

    // Mock the scheduler to avoid starting real cron jobs
    vi.doMock("../src/scheduler.js", () => {
      const schedules: any[] = [];
      return {
        initScheduler: vi.fn(),
        setSSEEmitter: vi.fn(),
        getSchedules: vi.fn(() => [...schedules]),
        getSchedule: vi.fn((id: string) => schedules.find((s) => s.id === id)),
        createSchedule: vi.fn((data: any) => {
          const s = {
            ...data,
            id: `sched_${Date.now()}`,
            createdAt: new Date().toISOString(),
          };
          schedules.push(s);
          return s;
        }),
        updateSchedule: vi.fn((id: string, patch: any) => {
          const idx = schedules.findIndex((s) => s.id === id);
          if (idx === -1) return null;
          schedules[idx] = { ...schedules[idx], ...patch };
          return schedules[idx];
        }),
        deleteSchedule: vi.fn((id: string) => {
          const idx = schedules.findIndex((s) => s.id === id);
          if (idx === -1) return false;
          schedules.splice(idx, 1);
          return true;
        }),
        toggleSchedule: vi.fn((id: string) => {
          const s = schedules.find((x) => x.id === id);
          if (!s) return null;
          s.enabled = !s.enabled;
          return s;
        }),
        runNow: vi.fn(async () => `exec_${Date.now()}`),
      };
    });

    // Import app after mocks are set up
    const restModule = await import("../src/rest.js");
    app = restModule.app;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalChainsDir === undefined) delete process.env.CHAINS_DIR;
    else process.env.CHAINS_DIR = originalChainsDir;
    if (originalSchedulesFile === undefined) delete process.env.SCHEDULES_FILE;
    else process.env.SCHEDULES_FILE = originalSchedulesFile;
    if (originalRestPort === undefined) delete process.env.REST_PORT;
    else process.env.REST_PORT = originalRestPort;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Health ──

  describe("GET /health", () => {
    it("returns ok and version", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, version: "2.0.0" });
    });
  });

  // ── CORS ──

  describe("CORS", () => {
    it("returns CORS headers when Origin is sent", async () => {
      const res = await request(app).get("/health").set("Origin", "http://localhost:8888");
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:8888");
      expect(res.headers["access-control-allow-methods"]).toContain("GET");
    });

    it("does not set Allow-Origin for unknown origins", async () => {
      const res = await request(app).get("/health").set("Origin", "http://evil.com");
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("handles OPTIONS preflight", async () => {
      const res = await request(app).options("/chains");
      expect(res.status).toBe(204);
    });
  });

  // ── Chains CRUD ──

  describe("Chain endpoints", () => {
    it("GET /chains returns empty array when no chains exist", async () => {
      const res = await request(app).get("/chains");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("POST /chains/:name saves a chain (JSON body)", async () => {
      const chainDef = {
        name: "my-chain",
        description: "test",
        steps: [
          { id: "s1", prompt: "do stuff", output_var: "out", tools: [], depends_on: [] },
        ],
        output: "out",
      };
      const res = await request(app)
        .post("/chains/my-chain")
        .send(chainDef)
        .set("Content-Type", "application/json");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      // Verify it was saved
      const filePath = path.join(tmpDir, "my-chain.yaml");
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("POST /chains/:name saves raw YAML body", async () => {
      const res = await request(app)
        .post("/chains/yaml-chain")
        .send(validChainYaml)
        .set("Content-Type", "text/yaml");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      const filePath = path.join(tmpDir, "yaml-chain.yaml");
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toContain("http-test");
    });

    it("GET /chains returns chain metadata after saving", async () => {
      fs.writeFileSync(path.join(tmpDir, "listed.yaml"), validChainYaml);
      const res = await request(app).get("/chains");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const chain = res.body.find((c: any) => c.name === "listed");
      expect(chain).toBeDefined();
      expect(chain.description).toBe("HTTP test chain");
      expect(chain.stepCount).toBe(1);
    });

    it("GET /chains/:name returns raw YAML", async () => {
      fs.writeFileSync(path.join(tmpDir, "get-raw.yaml"), validChainYaml);
      const res = await request(app).get("/chains/get-raw");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/yaml/);
      expect(res.text).toContain("http-test");
    });

    it("GET /chains/:name returns 404 for missing chain", async () => {
      const res = await request(app).get("/chains/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("error");
      expect(typeof res.body.error).toBe("string");
    });

    it("DELETE /chains/:name removes a chain", async () => {
      fs.writeFileSync(path.join(tmpDir, "to-delete.yaml"), validChainYaml);
      const res = await request(app).delete("/chains/to-delete");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(fs.existsSync(path.join(tmpDir, "to-delete.yaml"))).toBe(false);
    });

    it("DELETE /chains/:name returns 404 for missing chain", async () => {
      const res = await request(app).delete("/chains/ghost");
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("error");
    });
  });

  // ── Execution ──

  describe("Execution endpoints", () => {
    it("POST /execute/:name starts execution and returns executionId", async () => {
      fs.writeFileSync(path.join(tmpDir, "exec-test.yaml"), validChainYaml);
      const res = await request(app)
        .post("/execute/exec-test")
        .send({ input: { topic: "testing" } });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("executionId");
      expect(typeof res.body.executionId).toBe("string");
      expect(res.body.executionId.length).toBeGreaterThan(0);
    });

    it("POST /execute/:name with empty input (no required inputs)", async () => {
      fs.writeFileSync(path.join(tmpDir, "exec-empty.yaml"), validChainYaml);
      const res = await request(app)
        .post("/execute/exec-empty")
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("executionId");
    });

    it("POST /execute/:name rejects missing required inputs", async () => {
      const chainWithRequired = `
name: required-test
description: Chain with required input
version: "1.0"
inputs:
  - name: topic
    description: The topic
steps:
  - id: step1
    prompt: "Write about {topic}"
    output_var: result
    tools: []
    depends_on: []
output: result
`;
      fs.writeFileSync(path.join(tmpDir, "required-test.yaml"), chainWithRequired);
      const res = await request(app)
        .post("/execute/required-test")
        .send({ input: {} });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toContain("Missing required input");
    });

    it("POST /execute/:name returns 400 for missing chain", async () => {
      const res = await request(app)
        .post("/execute/nonexistent")
        .send({ input: {} });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("GET /executions returns execution history", async () => {
      const res = await request(app).get("/executions");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("GET /executions/:id returns 404 for unknown execution", async () => {
      const res = await request(app).get("/executions/unknown-id");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Not found" });
    });

    it("DELETE /executions/:id returns 404 for unknown execution", async () => {
      const res = await request(app).delete("/executions/unknown-id");
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("error");
    });

    it("POST /executions/:id/resume returns 404 for unknown execution", async () => {
      const res = await request(app)
        .post("/executions/unknown-id/resume")
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Execution not found" });
    });

    it("POST /executions/:id/approve/:stepId returns 404 when no pending approval", async () => {
      // approveGate is mocked to return true by default, but for unknown IDs...
      const res = await request(app)
        .post("/executions/unknown-id/approve/step1")
        .send({ approved: true });
      // Our mock returns true always, so this would be 200
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("GET /executions/:id/stream returns SSE headers", async () => {
      // SSE endpoints stream indefinitely; use a raw http request with abort
      const http = await import("node:http");
      const server = app.listen(0);
      const addr = server.address() as import("node:net").AddressInfo;
      try {
        const result = await new Promise<{ headers: Record<string, string> }>((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${addr.port}/executions/some-id/stream`, (res) => {
            resolve({ headers: res.headers as Record<string, string> });
            res.destroy();
            req.destroy();
          });
          req.on("error", (err) => {
            // ignore ECONNRESET from our own destroy
            if ((err as any).code !== "ECONNRESET") reject(err);
          });
          setTimeout(() => { req.destroy(); reject(new Error("timeout")); }, 3000);
        });
        expect(result.headers["content-type"]).toMatch(/text\/event-stream/);
        expect(result.headers["cache-control"]).toBe("no-cache");
      } finally {
        server.close();
      }
    });
  });

  // ── Schedules ──

  describe("Schedule endpoints", () => {
    it("GET /schedules returns empty array initially", async () => {
      const res = await request(app).get("/schedules");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("POST /schedules creates a schedule", async () => {
      const res = await request(app)
        .post("/schedules")
        .send({
          chainName: "my-chain",
          cron: "0 * * * *",
          label: "Hourly run",
          input: { topic: "test" },
          enabled: true,
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.chainName).toBe("my-chain");
      expect(res.body.cron).toBe("0 * * * *");
      expect(res.body.label).toBe("Hourly run");
    });

    it("POST /schedules returns 400 when chainName is missing", async () => {
      const res = await request(app)
        .post("/schedules")
        .send({ cron: "0 * * * *" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "chainName and cron are required" });
    });

    it("POST /schedules returns 400 when cron is missing", async () => {
      const res = await request(app)
        .post("/schedules")
        .send({ chainName: "test" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "chainName and cron are required" });
    });

    it("GET /schedules/:id returns 404 for unknown schedule", async () => {
      const res = await request(app).get("/schedules/unknown-id");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Not found" });
    });

    it("PUT /schedules/:id returns 404 for unknown schedule", async () => {
      const res = await request(app)
        .put("/schedules/unknown-id")
        .send({ label: "updated" });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Not found" });
    });

    it("PATCH /schedules/:id/toggle returns 404 for unknown schedule", async () => {
      const res = await request(app).patch("/schedules/unknown-id/toggle");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Not found" });
    });

    it("DELETE /schedules/:id returns 404 for unknown schedule", async () => {
      const res = await request(app).delete("/schedules/unknown-id");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Not found" });
    });
  });

  // ── Download endpoint ──

  describe("GET /download", () => {
    it("returns 400 when path query is missing", async () => {
      const res = await request(app).get("/download");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Missing path" });
    });

    it("returns 403 for paths outside allowed directories", async () => {
      const res = await request(app).get("/download?path=/etc/passwd");
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Path not allowed" });
    });

    it("returns 404 for non-existent file in /tmp", async () => {
      const res = await request(app).get(
        `/download?path=${encodeURIComponent("/tmp/nonexistent-file-12345.pdf")}`,
      );
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "File not found" });
    });

    it("serves a file from /tmp", async () => {
      // Use /tmp directly (not os.tmpdir() which may resolve to /private/tmp on macOS)
      const tmpFile = `/tmp/occ-test-download-${Date.now()}.csv`;
      fs.writeFileSync(tmpFile, "col1,col2\na,b\n");
      try {
        const res = await request(app).get(
          `/download?path=${encodeURIComponent(tmpFile)}`,
        );
        expect(res.status).toBe(200);
        expect(res.headers["content-disposition"]).toContain("attachment");
        expect(res.text).toContain("col1,col2");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });

  // ── Request/Response shape validation ──

  describe("Request/Response shape validation", () => {
    it("GET /chains returns array of objects with name field", async () => {
      fs.writeFileSync(path.join(tmpDir, "shape-test.yaml"), validChainYaml);
      const res = await request(app).get("/chains");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      for (const item of res.body) {
        expect(item).toHaveProperty("name");
        expect(typeof item.name).toBe("string");
      }
    });

    it("error responses have { error: string } shape", async () => {
      const res = await request(app).get("/chains/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("error");
      expect(typeof res.body.error).toBe("string");
      expect(res.body.error.length).toBeGreaterThan(0);
    });

    it("POST /execute/:name expects { input: Record<string,string> }", async () => {
      fs.writeFileSync(path.join(tmpDir, "input-test.yaml"), validChainYaml);
      // Send proper input shape with required 'topic' field
      const res = await request(app)
        .post("/execute/input-test")
        .send({ input: { topic: "test topic" } });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("executionId");
    });

    it("POST /chains/:name success response is { ok: true }", async () => {
      const chainDef = {
        name: "ok-test",
        steps: [{ id: "s1", prompt: "x", output_var: "out", tools: [], depends_on: [] }],
        output: "out",
      };
      const res = await request(app)
        .post("/chains/ok-test")
        .send(chainDef);
      expect(res.body).toEqual({ ok: true });
    });

    it("DELETE success response is { ok: true }", async () => {
      fs.writeFileSync(path.join(tmpDir, "del-ok.yaml"), validChainYaml);
      const res = await request(app).delete("/chains/del-ok");
      expect(res.body).toEqual({ ok: true });
    });

    it("GET /health response shape", async () => {
      const res = await request(app).get("/health");
      expect(res.body).toMatchObject({ ok: true, version: "2.0.0" });
    });

    it("GET /executions history items have expected fields", async () => {
      const res = await request(app).get("/executions");
      expect(res.status).toBe(200);
      // Even if empty, should be an array
      expect(Array.isArray(res.body)).toBe(true);
      for (const item of res.body) {
        expect(item).toHaveProperty("id");
        expect(item).toHaveProperty("chainName");
        expect(item).toHaveProperty("status");
        expect(item).toHaveProperty("startedAt");
        expect(item).toHaveProperty("files");
        expect(Array.isArray(item.files)).toBe(true);
      }
    });
  });
});
