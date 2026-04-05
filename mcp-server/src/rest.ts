/**
 * REST + SSE server for the canvas web app.
 * Runs on port 4242 alongside the MCP stdio server.
 */
import * as fs from "node:fs";
import { timingSafeEqual } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import rateLimit from "express-rate-limit";
import { logger } from "./logger.js";
import type { Request, Response } from "express";
import type { ExecutionEvent } from "./types.js";
import {
  listChains,
  loadChainRaw,
  saveChain,
  deleteChain,
  loadChain,
  sanitizeName,
} from "./loader.js";
import { executeChain, getExecution, getAllExecutions, cancelExecution, loadPersistedExecutions, resumeExecution, approveGate, getPendingApprovals, validateClaudeBinary, canStartExecution, getRunningExecutionCount, getExecutionTimeline } from "./executor.js";
import { getChainStats } from "./storage.js";
import { loadMcpServers, discoverTools, getConfiguredServers, getMcpConfig, saveMcpConfig, closeMcpClients } from "./mcp-client.js";
import { closeStorage } from "./storage.js";
import { initQueue, enqueue, getQueueJob, listQueueJobs, listQueueByStatus, cancelQueueJob, getQueueStats, purgeOldJobs, closeQueue } from "./queue.js";
import {
  initScheduler, setSSEEmitter,
  getSchedules, getSchedule,
  createSchedule, updateSchedule, deleteSchedule, toggleSchedule, runNow,
} from "./scheduler.js";
import * as cron from "node-cron";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "text/yaml", limit: "2mb" }));

// SECURITY: Sanitize error messages before sending to clients.
function safeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found|already exists|is required|invalid|missing|blocked/i.test(msg)) return msg;
  return msg
    .replace(/\/[^\s:]+\.(ts|js|mjs):\d+:\d+/g, '[internal]')
    .replace(/at\s+\S+\s+\([^)]+\)/g, '')
    .slice(0, 200);
}

// Serve frontend build — try React SPA first, fallback to legacy canvas
const reactDistDir = process.env.FRONTEND_DIST ?? path.join(process.cwd(), "..", "frontend-react", "dist");
const canvasDistDir = process.env.CANVAS_DIST ?? path.join(process.cwd(), "..", "canvas", "dist");
const frontendDir = fs.existsSync(reactDistDir) ? reactDistDir : canvasDistDir;
if (fs.existsSync(frontendDir)) {
  app.use(express.static(frontendDir));
}

// ─── Rate limiting — protect execution + generation endpoints ────────────────
// Use API key as rate limit key when available, fallback to IP
const rateLimitKeyGenerator = (req: Request): string => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return "key:" + authHeader.slice(7, 15);
  return "ip:" + (req.ip ?? req.socket.remoteAddress ?? "unknown");
};
const executeLimiter = rateLimit({ windowMs: 60_000, max: parseInt(process.env.RATE_LIMIT_EXEC ?? "20"), keyGenerator: rateLimitKeyGenerator, message: { error: "Too many executions — try again in a minute" } });
const generateLimiter = rateLimit({ windowMs: 60_000, max: parseInt(process.env.RATE_LIMIT_GEN ?? "5"), keyGenerator: rateLimitKeyGenerator, message: { error: "Too many generation requests — try again in a minute" } });
const configLimiter = rateLimit({ windowMs: 60_000, max: 30, keyGenerator: rateLimitKeyGenerator, message: { error: "Too many config requests — try again in a minute" } });
app.use("/execute", executeLimiter);
app.use("/pipelines/*/execute", executeLimiter);
app.use("/generate-chain", generateLimiter);
app.use("/config", configLimiter);
app.use("/providers", configLimiter);

// ─── Security headers ────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.removeHeader("X-Powered-By");
  next();
});

// CORS — configurable via CORS_ORIGIN env var
// Default: allow common local dev origins (Python server :8888, Vite :5173/:5174)
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "";
const CORS_ALLOWED = new Set(
  CORS_ORIGIN
    ? [CORS_ORIGIN]
    : ["http://localhost:8888", "http://localhost:5173", "http://localhost:5174"],
);
app.use((req, res, next) => {
  const origin = req.headers.origin ?? "";
  if (CORS_ORIGIN === "*" || CORS_ALLOWED.has(origin)) {
    // Always reflect the specific origin instead of "*" to prevent credential leaks
    res.header("Access-Control-Allow-Origin", origin || "null");
  }
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});
app.options("*", (_req, res) => res.sendStatus(204));

// ─── Authentication — API key bearer token ───────────────────────────────────
// Set OCC_API_KEY env var to enable. REQUIRED in production (NODE_ENV=production).
// Usage: Authorization: Bearer <key>
const API_KEY = process.env.OCC_API_KEY ?? "";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
if (IS_PRODUCTION && !API_KEY) {
  logger.error("occ-auth", "FATAL: OCC_API_KEY is required in production. Set OCC_API_KEY env var.");
  process.exit(1);
}
if (API_KEY) {
  logger.info("occ-auth", "API key authentication ENABLED");
} else {
  logger.warn("occ-auth", "No OCC_API_KEY set — API is unauthenticated (dev mode only).");
}
app.use((req, res, next) => {
  // Skip auth if no key configured (local dev mode only — blocked in production above)
  if (!API_KEY) return next();
  // Skip auth for health check and static files
  if (req.path === "/health" || req.path === "/" || req.path.startsWith("/assets/")) return next();
  // Check Authorization header only (query param auth removed — keys leak in logs/caches)
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  if (token && token.length === API_KEY.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(API_KEY))) return next();
  res.status(401).json({ error: "Unauthorized. Provide Authorization: Bearer <key>" });
});

// ─── SSE subscriber map: executionId → list of response streams ──────────────
const sseClients = new Map<string, Response[]>();

// Global SSE subscribers (for /events endpoint — receives ALL execution events)
const globalSSEClients: Response[] = [];

function emitSSE(executionId: string, event: ExecutionEvent): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;

  // Per-execution subscribers — filter in place, then set or delete atomically
  const clients = sseClients.get(executionId);
  if (clients) {
    const alive = clients.filter((res) => {
      try { res.write(data); return true; } catch { return false; }
    });
    if (alive.length === 0) sseClients.delete(executionId);
    else sseClients.set(executionId, alive);
  }
  // Clean up map entry when execution is complete
  if (event.type === "execution_done" || event.type === "execution_error") {
    sseClients.delete(executionId);
  }

  // Global subscribers — filter and splice atomically (no clear-then-push)
  const filtered = globalSSEClients.filter((res) => {
    try { res.write(data); return true; } catch { return false; }
  });
  globalSSEClients.length = filtered.length;
  for (let i = 0; i < filtered.length; i++) globalSSEClients[i] = filtered[i];
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /events → global SSE stream (all execution events)
app.get("/events", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "system", message: "Connected to global event stream" })}\n\n`);
  globalSSEClients.push(res);
  // Heartbeat every 15s
  const hb = setInterval(() => { try { res.write(": heartbeat\n\n"); } catch { cleanup(); } }, 15000);
  // Idle timeout: close SSE connections after 4 hours of inactivity
  const idleTimeout = setTimeout(() => { cleanup(); try { res.end(); } catch {} }, 4 * 60 * 60 * 1000);
  const cleanup = () => {
    clearInterval(hb);
    clearTimeout(idleTimeout);
    const idx = globalSSEClients.indexOf(res);
    if (idx !== -1) globalSSEClients.splice(idx, 1);
  };
  _req.on("close", cleanup);
  res.on("error", cleanup);
});

// ─── Proxy, YAML-to-JSON, Extract-Style (ported from Python server) ──────────
import { extractStyle } from "./style-extractor.js";
import yaml from "js-yaml";
import { checkSSRF } from "./pretool-executor.js";

// GET /proxy?url=... → CORS proxy with SSRF protection (512KB max)
app.get("/proxy", async (req, res) => {
  const url = req.query.url as string;
  if (!url || !url.match(/^https?:\/\//)) return res.status(400).json({ error: "Invalid URL" });
  try {
    await checkSSRF(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let currentUrl = url;
    let redirectCount = 0;
    const MAX_REDIRECTS = 5;
    let resp: globalThis.Response;
    while (true) {
      resp = await fetch(currentUrl, {
        headers: { "User-Agent": "OCC-Proxy/1.0", Accept: "*/*" },
        signal: ctrl.signal,
        redirect: "manual",
      });
      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        if (++redirectCount > MAX_REDIRECTS) throw new Error("Too many redirects");
        const location = resp.headers.get("location");
        if (!location) throw new Error("Redirect without Location header");
        currentUrl = new URL(location, currentUrl).href;
        await checkSSRF(currentUrl);
        continue;
      }
      break;
    }
    clearTimeout(timer);
    if (!resp.ok) return res.status(502).json({ error: `Upstream ${resp.status}` });
    const ct = resp.headers.get("content-type") ?? "application/octet-stream";
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 512 * 1024) return res.status(413).json({ error: "Response too large (>512KB)" });
    // Whitelist safe content-types to prevent XSS via reflected content
    const SAFE_CT_PREFIXES = ["application/json", "text/plain", "text/csv", "image/", "application/xml", "text/xml"];
    const safeCt = SAFE_CT_PREFIXES.some(p => ct.startsWith(p)) ? ct : "application/octet-stream";
    res.setHeader("Content-Type", safeCt);
    if (!ct.startsWith("application/json") && !ct.startsWith("text/plain")) {
      res.setHeader("Content-Disposition", "attachment");
    }
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(buf);
  } catch (err) {
    res.status(502).json({ error: safeErrorMessage(err) });
  }
});

// GET /yaml-to-json?url=... → fetch YAML from URL, return parsed JSON
app.get("/yaml-to-json", async (req, res) => {
  const url = req.query.url as string;
  if (!url || !url.match(/^https?:\/\//)) return res.status(400).json({ error: "Invalid URL" });
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(url, {
      headers: { Accept: "text/yaml, text/plain, */*" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return res.status(502).json({ error: `Upstream ${resp.status}` });
    const text = await resp.text();
    const parsed = yaml.load(text, { schema: yaml.JSON_SCHEMA });
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: "YAML conversion failed: " + (err as Error).message });
  }
});

// GET /extract-style?url=... → extract CSS design tokens from a website
app.get("/extract-style", async (req, res) => {
  const url = req.query.url as string;
  if (!url || !url.match(/^https?:\/\//)) return res.status(400).json({ error: "Invalid URL" });
  try {
    await checkSSRF(url);
    const result = await extractStyle(url);
    res.json(result);
  } catch (err) {
    logger.warn("extract-style", "Extraction failed", { url, error: (err as Error).message });
    res.status(500).json({ error: "Style extraction failed" });
  }
});

// GET /chains → list
app.get("/chains", (_req, res) => {
  const names = listChains();
  const chains = names.map((name) => {
    try {
      const chain = loadChain(name);
      return {
        name,
        description: chain.description,
        version: chain.version,
        stepCount: chain.steps.length,
        steps: chain.steps.map((s) => ({
          type: s.type ?? "agent",
          id: s.id,
          pre_tools: (s.pre_tools ?? []).map((pt) => typeof pt === "string" ? pt : pt.type),
          tools: s.tools ?? [],
        })),
      };
    } catch (err) {
      return { name, error: (err as Error).message };
    }
  });
  res.json(chains);
});

// GET /chains/:name → raw YAML
app.get("/chains/:name", (req, res) => {
  try {
    const raw = loadChainRaw(req.params.name);
    res.type("text/yaml").send(raw);
  } catch (err) {
    res.status(404).json({ error: safeErrorMessage(err) });
  }
});

// POST /chains/:name → save YAML (body: YAML string, {yaml: string}, or JSON ChainDefinition)
app.post("/chains/:name", (req, res) => {
  try {
    const safeName = sanitizeName(req.params.name);
    const dir = process.env.CHAINS_DIR ?? path.join(process.cwd(), "..", "chains");
    fs.mkdirSync(dir, { recursive: true });

    if (typeof req.body === "string") {
      // Raw YAML string — save directly
      fs.writeFileSync(path.join(dir, `${safeName}.yaml`), req.body as string, "utf-8");
    } else if (req.body && typeof req.body.yaml === "string") {
      // Frontend sends { yaml: "..." } — extract and save the YAML content
      fs.writeFileSync(path.join(dir, `${safeName}.yaml`), req.body.yaml as string, "utf-8");
    } else {
      // JSON ChainDefinition object — convert to YAML via loader
      saveChain(safeName, req.body);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: safeErrorMessage(err) });
  }
});

// DELETE /chains/:name
app.delete("/chains/:name", (req, res) => {
  try {
    deleteChain(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: safeErrorMessage(err) });
  }
});

// POST /execute/:name → start execution (queued if busy), returns executionId immediately
app.post("/execute/:name", async (req: Request, res: Response) => {
  try {
    const chain = loadChain(req.params.name);
    const input = (req.body?.input ?? {}) as Record<string, string>;
    const priority = typeof req.body?.priority === "number" ? req.body.priority : 5;

    // Validate required inputs against chain definition
    for (const inputDef of chain.inputs ?? []) {
      if (!inputDef.optional && (input[inputDef.name] === undefined || input[inputDef.name] === "")) {
        return res.status(400).json({
          error: `Missing required input: "${inputDef.name}"${inputDef.description ? ` (${inputDef.description})` : ""}`,
        });
      }
    }

    if (canStartExecution()) {
      // Fast path: execute immediately
      const executionId = `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;

      const emitter = (event: ExecutionEvent) => {
        if (event.type === "execution_started") {
          (event as any).executionId = executionId;
        }
        emitSSE(executionId, event);
      };

      res.json({ executionId, queued: false });

      setImmediate(() => {
        executeChain(chain, input, emitter).catch(() => {
          // errors are captured in execution record
        });
      });
    } else {
      // Queue path: add to queue, process when a worker is free
      const job = enqueue("chain", req.params.name, input, { priority });
      res.status(202).json({
        jobId: job.id,
        queued: true,
        position: getQueueStats().queued,
        message: `Queued (${getRunningExecutionCount()} running, ${getQueueStats().queued} in queue)`,
      });
    }
  } catch (err) {
    res.status(400).json({ error: safeErrorMessage(err) });
  }
});

// GET /executions/token-usage → aggregated daily token usage (no N+1 queries)
// NOTE: Must be registered BEFORE /executions/:id to avoid Express matching "token-usage" as :id
app.get("/executions/token-usage", (req, res) => {
  const days = Math.min(parseInt(req.query.days as string) || 30, 90);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString();

  const all = getAllExecutions();
  const dayMap = new Map<string, { input: number; output: number; executions: number }>();

  for (const exec of all) {
    if (!exec.startedAt || exec.startedAt < cutoffStr) continue;
    const date = exec.startedAt.slice(0, 10);
    const entry = dayMap.get(date) ?? { input: 0, output: 0, executions: 0 };
    entry.executions++;
    for (const step of Object.values(exec.steps)) {
      entry.input += step.inputTokens ?? 0;
      entry.output += step.outputTokens ?? 0;
    }
    dayMap.set(date, entry);
  }

  const result = [...dayMap.entries()]
    .map(([date, d]) => ({ date, input: d.input, output: d.output, executions: d.executions }))
    .sort((a, b) => a.date.localeCompare(b.date));

  res.json(result);
});

// GET /executions/:id/stream → SSE live stream
app.get("/executions/:id/stream", (req, res) => {
  const { id } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const execution = getExecution(id);

  // Catch-up: replay all step outputs accumulated so far
  if (execution) {
    const send = (e: ExecutionEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    send({ type: "execution_started", executionId: id, chainName: execution.chainName });
    for (const [stepId, step] of Object.entries(execution.steps)) {
      if (step.status === "pending") continue;
      send({ type: "step_started", executionId: id, stepId, label: stepId });
      if (step.output) send({ type: "step_output", executionId: id, stepId, chunk: step.output });
      if (step.status === "done")
        send({ type: "step_done", executionId: id, stepId, durationMs: step.durationMs ?? 0 });
      if (step.status === "error")
        send({ type: "step_error", executionId: id, stepId, error: step.error ?? "" });
    }
    // If already finished, close
    if (execution.status === "done" || execution.status === "error") {
      const event: ExecutionEvent =
        execution.status === "done"
          ? { type: "execution_done", executionId: id, result: execution.result ?? "", durationMs: execution.durationMs ?? 0 }
          : { type: "execution_error", executionId: id, error: execution.error ?? "Unknown error" };
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
      return;
    }
  }

  const clients = sseClients.get(id) ?? [];
  clients.push(res);
  sseClients.set(id, clients);

  // SSE heartbeat: prevent browser/proxy timeouts on idle connections
  const heartbeatTimer = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch {
      clearInterval(heartbeatTimer);
      sseClients.set(id, (sseClients.get(id) ?? []).filter((r) => r !== res));
    }
  }, 30000);

  const cleanupSSE = () => {
    clearInterval(heartbeatTimer);
    sseClients.set(id, (sseClients.get(id) ?? []).filter((r) => r !== res));
  };

  req.on("close", cleanupSSE);
  res.on("error", cleanupSSE); // Handle silent disconnects
});

// GET /executions/:id → status
app.get("/executions/:id", (req, res) => {
  const execution = getExecution(req.params.id);
  if (!execution) return res.status(404).json({ error: "Not found" });
  return res.json(execution);
});

// GET /executions/:id/timeline → time-travel checkpoint history
app.get("/executions/:id/timeline", (req, res) => {
  try {
    const timeline = getExecutionTimeline(req.params.id);
    return res.json(timeline);
  } catch {
    return res.status(404).json({ error: "Not found" });
  }
});

// GET /chains/:name/stats → execution statistics for a chain
app.get("/chains/:name/stats", (req, res) => {
  try {
    const stats = getChainStats(req.params.name);
    return res.json(stats);
  } catch {
    return res.status(500).json({ error: "Stats unavailable" });
  }
});

// DELETE /executions → clear all execution history
app.delete("/executions", (_req, res) => {
  try {
    const { db } = require("./storage.js");
    db.exec("DELETE FROM executions");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /executions/:id → cancel a running execution
app.delete("/executions/:id", (req, res) => {
  const id = req.params.id;
  const ok = cancelExecution(id);
  if (!ok) return res.status(404).json({ error: "Execution not found or already finished" });
  // Close SSE streams for this execution
  const clients = sseClients.get(id);
  if (clients) {
    for (const c of clients) { try { c.end(); } catch {} }
    sseClients.delete(id);
  }
  return res.json({ ok: true });
});

// POST /executions/:id/resume → resume a failed execution from checkpoint
app.post("/executions/:id/resume", async (req, res) => {
  try {
    const { id } = req.params;
    const execution = getExecution(id);
    if (!execution) return res.status(404).json({ error: "Execution not found" });

    const chain = loadChain(execution.chainName);
    if (!chain) return res.status(404).json({ error: `Chain "${execution.chainName}" not found` });

    // Use same SSE broadcast pattern as execute
    const result = await resumeExecution(id, chain, (event) => {
      emitSSE(id, event);
    });

    res.json({ executionId: id, result });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  }
});

// POST /executions/:id/approve/:stepId → approve or reject a gate step
app.post("/executions/:id/approve/:stepId", (req, res) => {
  const { id, stepId } = req.params;
  const { approved } = req.body as { approved: boolean };

  const success = approveGate(id, stepId, approved ?? false);
  if (!success) {
    return res.status(404).json({ error: "No pending approval found" });
  }

  res.json({ ok: true });
});

// GET /approvals → list all pending gate approvals
app.get("/approvals", (_req, res) => {
  res.json(getPendingApprovals());
});

// Extract absolute file paths from text
function extractFilePaths(text: string): string[] {
  const matches = text.match(/\/[^\s"'`\])}>]+\.(pdf|png|jpg|csv)/gi) ?? [];
  return [...new Set(matches)];
}

// GET /executions → history (paginated)
app.get("/executions", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;
  const all = getAllExecutions().slice(offset, offset + limit);
  res.json(
    all.map(({ id, chainName, status, startedAt, finishedAt, durationMs, result, steps }) => {
      // Collect file paths from result + all step outputs
      const texts = [result ?? "", ...Object.values(steps).map((s) => s.output ?? "")];
      const files = extractFilePaths(texts.join("\n"));
      return { id, chainName, status, startedAt, finishedAt, durationMs, files };
    })
  );
});

// GET /download?path=... → serve a local file (restricted to /tmp and WORKSPACE_DIR)
app.get("/download", (req, res) => {
  const filePath = decodeURIComponent((req.query.path as string) ?? "");
  if (!filePath) return res.status(400).json({ error: "Missing path" });

  // Security: resolve to absolute path first to prevent path traversal attacks
  const resolved = path.resolve(filePath);
  const allowed = [os.tmpdir(), "/tmp", process.env.WORKSPACE_DIR ?? ""].filter(Boolean);
  // Resolve allowed dirs to real paths (handles macOS /tmp -> /private/tmp)
  const realAllowed = allowed.map(d => { try { return fs.realpathSync(path.resolve(d)); } catch { return path.resolve(d); } });

  if (!fs.existsSync(resolved)) return res.status(404).json({ error: "File not found" });

  // Resolve to real path (follows symlinks) and check against allowed dirs
  const realPath = fs.realpathSync(resolved);
  const safe = realAllowed.some(dir => realPath.startsWith(dir + path.sep) || realPath.startsWith(dir));
  if (!safe) return res.status(403).json({ error: "Path not allowed" });

  const filename = path.basename(realPath);
  const safeFilename = filename.replace(/["\\\n\r]/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  return res.sendFile(realPath);
});

// ─── Schedule routes ──────────────────────────────────────────────────────────

// GET /schedules
app.get("/schedules", (_req, res) => res.json(getSchedules()));

// GET /schedules/:id
app.get("/schedules/:id", (req, res) => {
  const s = getSchedule(req.params.id);
  if (!s) return res.status(404).json({ error: "Not found" });
  return res.json(s);
});

// POST /schedules
app.post("/schedules", (req, res) => {
  try {
    const { label, chainName, input, cron: cronExpr, enabled } = req.body;
    if (!chainName || !cronExpr) return res.status(400).json({ error: "chainName and cron are required" });
    if (!cron.validate(cronExpr)) return res.status(400).json({ error: "Invalid cron expression" });
    const s = createSchedule({ label: label || chainName, chainName, input: input ?? {}, cron: cronExpr, enabled: enabled ?? true });
    return res.status(201).json(s);
  } catch (err) {
    return res.status(400).json({ error: safeErrorMessage(err) });
  }
});

// PUT /schedules/:id
app.put("/schedules/:id", (req, res) => {
  const s = updateSchedule(req.params.id, req.body);
  if (!s) return res.status(404).json({ error: "Not found" });
  return res.json(s);
});

// PATCH /schedules/:id/toggle
app.patch("/schedules/:id/toggle", (req, res) => {
  const s = toggleSchedule(req.params.id);
  if (!s) return res.status(404).json({ error: "Not found" });
  return res.json(s);
});

// POST /schedules/:id/run — trigger immediately
app.post("/schedules/:id/run", async (req, res) => {
  try {
    const executionId = await runNow(req.params.id);
    return res.json({ executionId });
  } catch (err) {
    return res.status(400).json({ error: safeErrorMessage(err) });
  }
});

// DELETE /schedules/:id
app.delete("/schedules/:id", (req, res) => {
  const ok = deleteSchedule(req.params.id);
  if (!ok) return res.status(404).json({ error: "Not found" });
  return res.json({ ok: true });
});

// ─── Pipeline routes ─────────────────────────────────────────────────────────

import {
  listPipelines, loadPipeline, loadPipelineRaw,
  savePipeline, deletePipeline as deletePipelineFile,
} from "./pipeline-loader.js";
import {
  executePipeline, getPipelineExecution, getAllPipelineExecutions,
  loadPersistedPipelineExecutions,
} from "./pipeline-executor.js";

// GET /pipelines
app.get("/pipelines", (_req, res) => {
  const names = listPipelines();
  const pipelines = names.map((name) => {
    try {
      const p = loadPipeline(name);
      return { name, description: p.description, version: p.version, chainCount: p.chains.length };
    } catch (err) {
      return { name, error: (err as Error).message };
    }
  });
  res.json(pipelines);
});

// GET /pipelines/:name
app.get("/pipelines/:name", (req, res) => {
  try {
    const raw = loadPipelineRaw(req.params.name);
    res.type("text/yaml").send(raw);
  } catch (err) {
    res.status(404).json({ error: safeErrorMessage(err) });
  }
});

// GET /pipelines/:name/json
app.get("/pipelines/:name/json", (req, res) => {
  try {
    const p = loadPipeline(req.params.name);
    res.json(p);
  } catch (err) {
    res.status(404).json({ error: safeErrorMessage(err) });
  }
});

// POST /pipelines/:name — save
app.post("/pipelines/:name", (req, res) => {
  try {
    if (typeof req.body === "string") {
      const dir = process.env.PIPELINES_DIR ??
        path.join((process.env.CHAINS_DIR ?? "").replace(/[/\\]chains[/\\]?$/, ""), "pipelines") ??
        path.join(process.cwd(), "..", "pipelines");
      fs.mkdirSync(dir, { recursive: true });
      const pSafeName = sanitizeName(req.params.name);
      fs.writeFileSync(path.join(dir, `${pSafeName}.yaml`), req.body, "utf-8");
    } else {
      savePipeline(sanitizeName(req.params.name), req.body);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: safeErrorMessage(err) });
  }
});

// DELETE /pipelines/:name
app.delete("/pipelines/:name", (req, res) => {
  try {
    deletePipelineFile(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: safeErrorMessage(err) });
  }
});

// POST /pipelines/:name/execute — run pipeline
app.post("/pipelines/:name/execute", async (req: Request, res: Response) => {
  try {
    if (!canStartExecution()) {
      return res.status(429).json({
        error: `Too many concurrent executions (${getRunningExecutionCount()} running). Try again later.`,
      });
    }

    const pipeline = loadPipeline(req.params.name);
    const input = (req.body?.input ?? {}) as Record<string, string>;

    // Validate required pipeline inputs
    for (const inputDef of pipeline.inputs ?? []) {
      if (!inputDef.optional && (input[inputDef.name] === undefined || input[inputDef.name] === "")) {
        return res.status(400).json({
          error: `Missing required input: "${inputDef.name}"${inputDef.description ? ` (${inputDef.description})` : ""}`,
        });
      }
    }

    let executionId = "";
    const emitter = (event: ExecutionEvent) => {
      if (event.type === "execution_started") executionId = event.executionId;
      if (executionId) emitSSE(executionId, event);
    };

    executePipeline(pipeline, input, emitter).catch((err) => {
      const error = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[occ] Pipeline "${pipeline.name}" execution failed: ${error}\n`);
      if (executionId) {
        emitSSE(executionId, { type: "execution_error", executionId, error });
      }
    });
    await new Promise((r) => setTimeout(r, 50));
    res.json({ executionId });
  } catch (err) {
    res.status(400).json({ error: safeErrorMessage(err) });
  }
});

// GET /pipelines/executions
app.get("/pipeline-executions", (_req, res) => {
  res.json(getAllPipelineExecutions().slice(0, 50));
});

// GET /pipeline-executions/:id
app.get("/pipeline-executions/:id", (req, res) => {
  const ex = getPipelineExecution(req.params.id);
  if (!ex) return res.status(404).json({ error: "Not found" });
  return res.json(ex);
});

// ─── Queue routes ────────────────────────────────────────────────────────────

// GET /queue → queue statistics
app.get("/queue", (_req, res) => res.json(getQueueStats()));

// GET /queue/jobs → list all jobs
app.get("/queue/jobs", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;
  const status = req.query.status as string;
  if (status) {
    res.json(listQueueByStatus(status, limit));
  } else {
    res.json(listQueueJobs(limit, offset));
  }
});

// GET /queue/jobs/:id → single job status
app.get("/queue/jobs/:id", (req, res) => {
  const job = getQueueJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json(job);
});

// DELETE /queue → clear all queue entries
app.delete("/queue", (_req, res) => {
  try {
    const { db } = require("./storage.js");
    db.exec("DELETE FROM queue");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /queue/jobs/:id → cancel a queued job
app.delete("/queue/jobs/:id", (req, res) => {
  const ok = cancelQueueJob(req.params.id);
  if (!ok) return res.status(404).json({ error: "Job not found or already running" });
  return res.json({ ok: true });
});

// DELETE /queue/purge → remove old completed/failed jobs
app.delete("/queue/purge", (req, res) => {
  const days = parseInt(req.query.days as string) || 7;
  const purged = purgeOldJobs(days);
  res.json({ purged });
});

// GET /health
app.get("/health", (_req, res) => res.json({
  ok: true,
  version: "2.0.0",
  runningExecutions: getRunningExecutionCount(),
  mcpServers: getConfiguredServers(),
  queue: getQueueStats(),
  chainsDir: process.env.CHAINS_DIR ?? "./chains",
  pipelinesDir: process.env.PIPELINES_DIR ?? "./pipelines",
  workspaceDir: process.env.WORKSPACE_DIR ?? ".",
  restPort: parseInt(process.env.REST_PORT ?? "4242"),
  claudeCli: process.env.CLAUDE_CLI ?? "claude",
  nodeVersion: process.version,
  uptime: Math.floor(process.uptime()),
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT_EXECUTIONS ?? "5"),
  claudeTimeoutMs: parseInt(process.env.CLAUDE_TIMEOUT_MS ?? "1800000"),
}));

// GET /config — current server configuration
app.get("/config", (_req, res) => {
  res.json({
    chainsDir: process.env.CHAINS_DIR ?? "./chains",
    pipelinesDir: process.env.PIPELINES_DIR ?? "./pipelines",
    workspaceDir: process.env.WORKSPACE_DIR ?? ".",
    restPort: process.env.REST_PORT ?? "4242",
    restHost: process.env.REST_HOST ?? "127.0.0.1",
    claudeCli: process.env.CLAUDE_CLI ?? "claude",
    claudeTimeoutMs: process.env.CLAUDE_TIMEOUT_MS ?? "1800000",
    maxConcurrentExecutions: process.env.MAX_CONCURRENT_EXECUTIONS ?? "5",
    corsOrigin: process.env.CORS_ORIGIN ?? "",
    logLevel: process.env.LOG_LEVEL ?? "info",
    apiKeySet: !!process.env.OCC_API_KEY,
    occDb: process.env.OCC_DB ?? "./occ.db",
    occQueueDb: process.env.OCC_QUEUE_DB ?? "./occ-queue.db",
    occStateDb: process.env.OCC_STATE_DB ?? "",
    occVectorDb: process.env.OCC_VECTOR_DB ?? "",
    occSemanticCacheDb: process.env.OCC_SEMANTIC_CACHE_DB ?? "",
    occGraphDb: process.env.OCC_GRAPH_DB ?? "",
    logFormat: process.env.LOG_FORMAT ?? "text",
    blobDir: process.env.BLOB_DIR ?? "./blobs",
    executionMaxAgeDays: process.env.EXECUTION_MAX_AGE_DAYS ?? "7",
    publicHost: process.env.PUBLIC_HOST ?? "localhost",
    rateLimitExec: process.env.RATE_LIMIT_EXEC ?? "20",
    rateLimitGen: process.env.RATE_LIMIT_GEN ?? "5",
    blobPlanningModel: process.env.BLOB_PLANNING_MODEL ?? "claude-sonnet-4-6",
    blobChatModel: process.env.BLOB_CHAT_MODEL ?? "claude-sonnet-4-6",
    blobStepModel: process.env.BLOB_STEP_MODEL ?? "claude-sonnet-4-6",
    blobAutoCheckSec: process.env.BLOB_AUTO_CHECK_SEC ?? "60",
    resendApiKey: process.env.RESEND_API_KEY ? "***" : "",
    resendFrom: process.env.RESEND_FROM ?? "",
  });
});

// PUT /config — update server config (writes to .env file)
// Security: warn if no API key is set (critical endpoint)
app.put("/config", (req, res) => {
  if (!API_KEY) {
    logger.warn("occ-security", "PUT /config called without OCC_API_KEY set — config is writable by anyone");
  }
  try {
    const updates = req.body as Record<string, string>;
    const envPath = path.join(process.cwd(), ".env");
    let envContent = "";
    try { envContent = fs.readFileSync(envPath, "utf-8"); } catch { /* no .env file yet */ }

    // Map config keys to env var names
    const keyMap: Record<string, string> = {
      chainsDir: "CHAINS_DIR",
      pipelinesDir: "PIPELINES_DIR",
      workspaceDir: "WORKSPACE_DIR",
      restPort: "REST_PORT",
      restHost: "REST_HOST",
      claudeCli: "CLAUDE_CLI",
      claudeTimeoutMs: "CLAUDE_TIMEOUT_MS",
      maxConcurrentExecutions: "MAX_CONCURRENT_EXECUTIONS",
      corsOrigin: "CORS_ORIGIN",
      logLevel: "LOG_LEVEL",
      occDb: "OCC_DB",
      occQueueDb: "OCC_QUEUE_DB",
      occStateDb: "OCC_STATE_DB",
      occVectorDb: "OCC_VECTOR_DB",
      occSemanticCacheDb: "OCC_SEMANTIC_CACHE_DB",
      occGraphDb: "OCC_GRAPH_DB",
      logFormat: "LOG_FORMAT",
      blobDir: "BLOB_DIR",
      executionMaxAgeDays: "EXECUTION_MAX_AGE_DAYS",
      publicHost: "PUBLIC_HOST",
      rateLimitExec: "RATE_LIMIT_EXEC",
      rateLimitGen: "RATE_LIMIT_GEN",
      blobPlanningModel: "BLOB_PLANNING_MODEL",
      blobChatModel: "BLOB_CHAT_MODEL",
      blobStepModel: "BLOB_STEP_MODEL",
      blobAutoCheckSec: "BLOB_AUTO_CHECK_SEC",
      resendApiKey: "RESEND_API_KEY",
      resendFrom: "RESEND_FROM",
    };

    for (const [key, value] of Object.entries(updates)) {
      const envKey = keyMap[key];
      if (!envKey) continue;
      // Update process.env immediately
      process.env[envKey] = value;
      // Update .env file
      const regex = new RegExp(`^${envKey}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${envKey}=${value}`);
      } else {
        envContent += `\n${envKey}=${value}`;
      }
    }
    fs.writeFileSync(envPath, envContent.trim() + "\n");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ─── LLM Providers ──────────────────────────────────────────────────────────
import {
  listProviders, getProvider, createProvider, updateProvider, deleteProvider,
  testProvider, getAllModels, resolveProvider,
} from "./providers.js";

// GET /providers → list all configured LLM providers (API keys masked)
app.get("/providers", (_req, res) => res.json(listProviders()));

// GET /providers/models → all models across all enabled providers
app.get("/providers/models", (_req, res) => res.json(getAllModels()));

// GET /providers/:id → single provider detail
app.get("/providers/:id", (req, res) => {
  const p = getProvider(req.params.id);
  if (!p) return res.status(404).json({ error: "Provider not found" });
  res.json({ ...p, apiKey: p.apiKey ? `${p.apiKey.slice(0, 8)}...` : "" });
});

// POST /providers → create new provider
app.post("/providers", (req, res) => {
  const { id, name, type, apiKey, baseUrl, defaultModel, enabled, models } = req.body;
  if (!id || !type) return res.status(400).json({ error: "id and type are required" });
  const p = createProvider({ id, name, type, apiKey: apiKey ?? "", baseUrl: baseUrl ?? "", defaultModel, enabled: enabled ?? true, models });
  res.status(201).json({ ...p, apiKey: p.apiKey ? `${p.apiKey.slice(0, 8)}...` : "" });
});

// PUT /providers/:id → update provider
app.put("/providers/:id", (req, res) => {
  const p = updateProvider(req.params.id, req.body);
  if (!p) return res.status(404).json({ error: "Provider not found" });
  res.json({ ...p, apiKey: p.apiKey ? `${p.apiKey.slice(0, 8)}...` : "" });
});

// DELETE /providers/:id → delete provider (can't delete "claude")
app.delete("/providers/:id", (req, res) => {
  if (!deleteProvider(req.params.id)) return res.status(400).json({ error: "Cannot delete this provider" });
  res.json({ ok: true });
});

// POST /providers/:id/test → test API key / connection
app.post("/providers/:id/test", async (req, res) => {
  const result = await testProvider(req.params.id);
  res.json(result);
});

// GET /mcp-servers → return config (with tools if ?discover=true)
app.get("/mcp-servers", async (req, res) => {
  try {
    if (req.query.discover === "true") {
      const tools = await discoverTools();
      res.json(tools);
    } else {
      // Return the raw config so the frontend can edit it
      res.json(getMcpConfig());
    }
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// PUT /mcp-servers → save config + hot-reload servers
app.put("/mcp-servers", async (req, res) => {
  try {
    const config = req.body as Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
    if (!config || typeof config !== "object") {
      return res.status(400).json({ error: "Expected JSON object of server configs" });
    }
    await saveMcpConfig(config);
    res.json({ ok: true, servers: Object.keys(config).length });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ─── BLOB — Organic conversational graph ────────────────────────────────────
import {
  listBlobSessions, createBlobSession, updateBlobSession, deleteBlobSession,
  saveBlobGraph, loadBlobGraph, buildPlanningPrompt, buildExtractionPrompt,
  loadKnowledge, upsertKnowledge, updateKnowledgeEntry, deleteKnowledgeEntry,
  searchKnowledge, linkConcepts, startAutonomousEngine, getAutonomousPlan,
  findRelevantKnowledge,
  type BlobPlanRequest,
} from "./blob.js";

// GET /blobs — list all BLOB sessions
app.get("/blobs", (_req, res) => res.json(listBlobSessions()));

// GET /blobs/:id — single session detail
app.get("/blobs/:id", (req, res) => {
  const sessions = listBlobSessions();
  const session = sessions.find((s) => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

// POST /blobs — create new BLOB session
app.post("/blobs", (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  res.status(201).json(createBlobSession(name, description));
});

// PUT /blobs/:id — update session
app.put("/blobs/:id", (req, res) => {
  const result = updateBlobSession(req.params.id, req.body);
  if (!result) return res.status(404).json({ error: "Session not found" });
  res.json(result);
});

// PATCH /blobs/:id/autonomous — toggle + configure autonomous mode
app.patch("/blobs/:id/autonomous", (req, res) => {
  const { autonomous, intervalMs } = req.body as { autonomous?: boolean; intervalMs?: number };
  const sessions = listBlobSessions();
  const session = sessions.find((s) => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const patch: Record<string, unknown> = {};
  if (autonomous !== undefined) patch.autonomous = autonomous;
  if (intervalMs !== undefined) patch.autonomousIntervalMs = intervalMs;

  const result = updateBlobSession(req.params.id, patch as Partial<import("./blob.js").BlobSession>);
  if (!result) return res.status(500).json({ error: "Failed to update" });
  res.json(result);
});

// DELETE /blobs/:id — delete session
app.delete("/blobs/:id", (req, res) => {
  if (!deleteBlobSession(req.params.id)) return res.status(404).json({ error: "Session not found" });
  res.json({ ok: true });
});

// PUT /blobs/:id/graph — save graph data
app.put("/blobs/:id/graph", (req, res) => {
  saveBlobGraph(req.params.id, req.body);
  res.json({ ok: true });
});

// GET /blobs/:id/graph — load graph data
app.get("/blobs/:id/graph", (req, res) => {
  const data = loadBlobGraph(req.params.id);
  if (!data) return res.status(404).json({ error: "No graph data" });
  res.json(data);
});

// POST /blobs/:id/message — persist a message to the graph's core node
app.post("/blobs/:id/message", (req, res) => {
  const { role, content } = req.body as { role: string; content: string };
  if (!role || !content) return res.status(400).json({ error: "role and content required" });

  const graphRaw = loadBlobGraph(req.params.id);
  if (!graphRaw) return res.status(404).json({ error: "No graph data" });

  const graph = graphRaw as { nodes: Array<{ id: string; type: string; data: { kind: string; messages?: Array<unknown> } }>; edges: unknown[] };
  const coreNode = graph.nodes?.find((n) => n.type === "core");
  if (!coreNode || coreNode.data.kind !== "core") return res.status(404).json({ error: "No core node" });

  const msg = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
    role,
    content,
    timestamp: new Date().toISOString(),
    spawnedNodeIds: [],
  };
  if (!coreNode.data.messages) coreNode.data.messages = [];
  coreNode.data.messages.push(msg);
  saveBlobGraph(req.params.id, graph);

  // Update session message count
  updateBlobSession(req.params.id, { messageCount: coreNode.data.messages.length });
  res.status(201).json(msg);
});

// GET /blobs/:id/stats — live stats for a session
app.get("/blobs/:id/stats", (req, res) => {
  const sessions = listBlobSessions();
  const session = sessions.find((s) => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const graphRaw = loadBlobGraph(req.params.id);
  const graph = graphRaw as { nodes?: Array<{ type: string; data: { kind: string; messages?: Array<{ inputTokens?: number; outputTokens?: number }>; durationMs?: number; inputTokens?: number; outputTokens?: number } }>; edges?: unknown[] } | null;

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalDurationMs = 0;
  let branchCount = 0;
  let stepCount = 0;
  let doneSteps = 0;
  let errorSteps = 0;

  if (graph?.nodes) {
    for (const node of graph.nodes) {
      if (node.type === "branch") branchCount++;
      if (node.type === "step") {
        stepCount++;
        const d = node.data as { kind: string; durationMs?: number; inputTokens?: number; outputTokens?: number };
        if (d.inputTokens) totalInputTokens += d.inputTokens;
        if (d.outputTokens) totalOutputTokens += d.outputTokens;
        if (d.durationMs) totalDurationMs += d.durationMs;
        const status = (node as { status?: string }).status;
        if (status === "done") doneSteps++;
        if (status === "error") errorSteps++;
      }
    }
  }

  res.json({
    ...session,
    branchCount,
    stepCount,
    doneSteps,
    errorSteps,
    totalInputTokens,
    totalOutputTokens,
    totalDurationMs,
    edgeCount: (graph?.edges as unknown[])?.length ?? 0,
  });
});

// POST /blobs/:id/execute-branch — execute all steps in a branch sequentially
app.post("/blobs/:id/execute-branch", async (req, res) => {
  const { branchNodeId } = req.body as { branchNodeId: string };
  if (!branchNodeId) return res.status(400).json({ error: "branchNodeId required" });

  const graphRaw = loadBlobGraph(req.params.id);
  if (!graphRaw) return res.status(404).json({ error: "No graph data" });

  const graph = graphRaw as {
    nodes?: Array<{ id: string; type: string; data: { kind: string; stepType?: string; prompt?: string; model?: string } }>;
    edges?: Array<{ from: string; to: string }>;
  };
  if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
    return res.status(400).json({ error: "Invalid graph format" });
  }

  // Find all step nodes connected to this branch (walk edges)
  const steps: Array<{ id: string; stepType: string; prompt: string; model?: string }> = [];
  const visited = new Set<string>();
  const queue = [branchNodeId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const node = graph.nodes.find((n) => n.id === current);
    if (node?.type === "step" && node.data.kind === "step") {
      steps.push({ id: node.id, stepType: node.data.stepType ?? "agent", prompt: node.data.prompt ?? "", model: node.data.model });
    }

    // Follow outgoing edges
    for (const edge of graph.edges) {
      if (edge.from === current && !visited.has(edge.to)) queue.push(edge.to);
    }
  }

  if (steps.length === 0) return res.status(400).json({ error: "No steps found in branch" });

  // Execute each step sequentially, streaming results
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");

  const { runClaude } = await import("./claude-runner.js");

  for (const step of steps) {
    res.write(`data: ${JSON.stringify({ type: "step_start", stepId: step.id, label: step.stepType })}\n\n`);

    try {
      let output = "";
      const result = await runClaude(step.prompt, {
        id: step.id,
        type: (step.stepType as "agent") ?? "agent",
        model: step.model ?? process.env.BLOB_STEP_MODEL ?? "claude-sonnet-4-6",
        prompt: "",
        tools: [],
        output_var: `_step_${step.id}`,
        pre_tools: [],
      }, (chunk) => {
        output += chunk;
        res.write(`data: ${JSON.stringify({ type: "chunk", stepId: step.id, text: chunk })}\n\n`);
      });

      res.write(`data: ${JSON.stringify({
        type: "step_done",
        stepId: step.id,
        output,
        durationMs: result.durationMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: "step_error", stepId: step.id, error: (err as Error).message })}\n\n`);
    }
  }

  res.write(`data: ${JSON.stringify({ type: "branch_done", branchNodeId, stepsExecuted: steps.length })}\n\n`);
  res.end();
});

// GET /blobs/:id/knowledge — session-scoped knowledge entries
app.get("/blobs/:id/knowledge", (req, res) => {
  const all = loadKnowledge();
  const sessionScoped = all.filter((k) => k.sourceSessionIds.includes(req.params.id));
  res.json(sessionScoped);
});

// POST /blobs/:id/plan — ask LLM to plan graph growth
app.post("/blobs/:id/plan", async (req, res) => {
  const blobExecId = `blob_${req.params.id}`;
  const startTime = Date.now();

  try {
    const { customPlannerPrompt, ...planFields } = req.body as BlobPlanRequest & { customPlannerPrompt?: string };
    const planReq = planFields as BlobPlanRequest;
    const { getMcpConfig } = await import("./mcp-client.js");
    const mcpServerNames = Object.keys(getMcpConfig());
    let prompt = buildPlanningPrompt(planReq, mcpServerNames);
    if (customPlannerPrompt) prompt += `\n\n## Custom Planning Instructions\n${customPlannerPrompt}`;

    emitSSE(blobExecId, { type: "step_started", executionId: blobExecId, stepId: "plan", label: "Graph Planning", timestamp: new Date().toISOString() });

    const { runClaude } = await import("./claude-runner.js");
    let planText = "";
    await runClaude(prompt, {
      id: "blob-planner",
      type: "agent",
      model: process.env.BLOB_PLANNING_MODEL ?? "claude-sonnet-4-6",
      prompt: "",
      tools: [],
      output_var: "_plan",
      pre_tools: [],
    }, (chunk) => { planText += chunk; });

    const jsonMatch = planText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: "LLM did not return valid JSON", raw: planText });
    }
    const plan = JSON.parse(jsonMatch[0]);

    const branchCount = plan.branches?.length ?? 0;
    emitSSE(blobExecId, { type: "step_done", executionId: blobExecId, stepId: "plan", durationMs: Date.now() - startTime, timestamp: new Date().toISOString() });
    emitSSE(blobExecId, { type: "step_log", executionId: blobExecId, stepId: "plan", message: `Generated ${branchCount} branches`, level: "info", timestamp: new Date().toISOString() });

    // Inject relevant knowledge into each step's prompt
    const allKnowledge = loadKnowledge();
    if (allKnowledge.length > 0 && plan.branches) {
      for (const branch of plan.branches) {
        if (!branch.steps) continue;
        for (const step of branch.steps) {
          const relevant = findRelevantKnowledge(
            (step.prompt ?? "") + " " + (step.label ?? ""),
            allKnowledge,
          );
          if (relevant.length > 0) {
            const knowledgeLines = relevant.map(
              (k) => `- ${k.concept}: ${k.facts.slice(0, 3).join("; ")}`,
            );
            step.prompt = (step.prompt ?? "") + "\n\nRelevant prior knowledge:\n" + knowledgeLines.join("\n");
          }
        }
      }
    }

    res.json(plan);
  } catch (err) {
    emitSSE(blobExecId, { type: "step_error", executionId: blobExecId, stepId: "plan", error: (err as Error).message, timestamp: new Date().toISOString() });
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /blobs/:id/chat — conversational chat (JSON response)
app.post("/blobs/:id/chat", async (req, res) => {
  const { message, context, systemPrompt: customSystemPrompt } = req.body as { message: string; context?: Array<{ role: string; content: string }>; systemPrompt?: string };
  if (!message) return res.status(400).json({ error: "message required" });

  const blobExecId = `blob_${req.params.id}`;
  const startTime = Date.now();

  try {
    const { runClaude } = await import("./claude-runner.js");

    emitSSE(blobExecId, { type: "execution_started", executionId: blobExecId, chainName: `BLOB Chat`, timestamp: new Date().toISOString() });
    emitSSE(blobExecId, { type: "step_started", executionId: blobExecId, stepId: "chat", label: "Chat Response", timestamp: new Date().toISOString() });

    // Build system prompt with available MCP tools
    const { getMcpConfig } = await import("./mcp-client.js");
    const mcpCfg = getMcpConfig();
    const mcpList = Object.keys(mcpCfg);
    const mcpSection = mcpList.length > 0
      ? `\n\nAvailable MCP servers (use mcp_call pre-tool in steps): ${mcpList.join(", ")}. You can instruct steps to use these tools.`
      : "";
    const defaultPrompt = `You are the BLOB — an organic AI assistant that lives on an infinite canvas. You help users by growing branches of workflows, research chains, and knowledge graphs. Be concise and helpful. When the user's request requires real work (research, code, analysis), tell them what you'll build. For simple questions, answer directly.${mcpSection}`;
    const systemPrompt = customSystemPrompt ? `${defaultPrompt}\n\n## Custom Instructions\n${customSystemPrompt}` : defaultPrompt;

    const contextStr = (context ?? []).map((m) => `${m.role}: ${m.content}`).join("\n");
    const fullPrompt = contextStr ? `${systemPrompt}\n\nConversation:\n${contextStr}\nuser: ${message}\nassistant:` : `${systemPrompt}\n\nuser: ${message}\nassistant:`;

    let text = "";
    const result = await runClaude(fullPrompt, {
      id: "blob-chat",
      type: "agent",
      model: process.env.BLOB_CHAT_MODEL ?? "claude-haiku-4-5",
      prompt: "",
      tools: [],
      output_var: "_chat",
      pre_tools: [],
    }, (chunk) => { text += chunk; });

    emitSSE(blobExecId, { type: "step_done", executionId: blobExecId, stepId: "chat", durationMs: result.durationMs ?? 0, inputTokens: result.inputTokens, outputTokens: result.outputTokens, timestamp: new Date().toISOString() });

    res.json({
      text,
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      durationMs: result.durationMs ?? 0,
    });

    emitSSE(blobExecId, { type: "execution_done", executionId: blobExecId, result: "Chat complete", durationMs: Date.now() - startTime, timestamp: new Date().toISOString() });
  } catch (err) {
    emitSSE(blobExecId, { type: "step_error", executionId: blobExecId, stepId: "chat", error: (err as Error).message, timestamp: new Date().toISOString() });
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /blobs/:id/execute-step — execute a single blob step via OCC executor
app.post("/blobs/:id/execute-step", async (req, res) => {
  const { stepType, prompt, model, tools } = req.body as {
    stepType: string; prompt: string; model?: string; tools?: string[];
  };
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  const blobExecId = `blob_${req.params.id}`;
  const stepId = `step_${Date.now()}`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  try {
    const { runClaude } = await import("./claude-runner.js");
    let fullOutput = "";
    let inputTokens = 0;
    let outputTokens = 0;
    const startTime = Date.now();
    let chunkBuffer = "";

    emitSSE(blobExecId, { type: "step_started", executionId: blobExecId, stepId, label: prompt.slice(0, 50), timestamp: new Date().toISOString() });

    const result = await runClaude(prompt, {
      id: `blob-step-${Date.now()}`,
      type: (stepType as "agent") ?? "agent",
      model: model ?? process.env.BLOB_STEP_MODEL ?? "claude-sonnet-4-6",
      prompt: "",
      tools: tools ?? [],
      output_var: "_step_out",
      pre_tools: [],
    }, (chunk) => {
      fullOutput += chunk;
      res.write(`data: ${JSON.stringify({ type: "chunk", text: chunk })}\n\n`);
      if (typeof (res as any).flush === "function") (res as any).flush();
      chunkBuffer += chunk;
      if (chunkBuffer.length > 500) {
        emitSSE(blobExecId, { type: "step_output", executionId: blobExecId, stepId, chunk: chunkBuffer, timestamp: new Date().toISOString() });
        chunkBuffer = "";
      }
    });

    inputTokens = result.inputTokens ?? 0;
    outputTokens = result.outputTokens ?? 0;

    emitSSE(blobExecId, { type: "step_done", executionId: blobExecId, stepId, durationMs: Date.now() - startTime, inputTokens, outputTokens, timestamp: new Date().toISOString() });

    res.write(`data: ${JSON.stringify({
      type: "done",
      output: fullOutput,
      durationMs: Date.now() - startTime,
      inputTokens,
      outputTokens,
    })}\n\n`);
    res.end();
  } catch (err) {
    emitSSE(blobExecId, { type: "step_error", executionId: blobExecId, stepId, error: (err as Error).message, timestamp: new Date().toISOString() });
    res.write(`data: ${JSON.stringify({ type: "error", error: (err as Error).message })}\n\n`);
    res.end();
  }
});

// GET /blobs/:id/auto-plan — get pending autonomous plan (consumed on read)
app.get("/blobs/:id/auto-plan", (req, res) => {
  const plan = getAutonomousPlan(req.params.id);
  if (!plan) return res.status(404).json({ error: "No pending plan" });
  res.json(plan);
});

// POST /blobs/:id/test-plan — inject a synthetic plan for debugging all graph features
app.post("/blobs/:id/test-plan", (req, res) => {
  const mode = (req.body?.mode as string) ?? "full"; // "full" | "fork" | "extend"

  if (mode === "fork") {
    // Requires existing branch/step IDs passed in body
    const { branchNodeId, forkAtStepId } = req.body;
    if (!branchNodeId) return res.status(400).json({ error: "branchNodeId required for fork mode" });
    res.json({
      branches: [],
      reuseBranches: [
        {
          branchNodeId,
          forkAtStepId: forkAtStepId ?? branchNodeId,
          newSteps: [
            { type: "agent", label: "Fork Analysis A", prompt: "Analyze the divergent path from this branch — explore alternative approaches" },
            { type: "transform", label: "Fork Synthesis", prompt: "Synthesize the forked analysis into actionable recommendations" },
            { type: "agent", label: "Fork Deep-Dive", prompt: "Deep-dive into the most promising alternative identified" },
          ],
        },
      ],
      memoryUpdates: [
        { concept: "Fork Testing", facts: ["Fork created from existing branch", "3 new steps added to fork"] },
      ],
    });
    return;
  }

  if (mode === "extend") {
    // Adds new steps to existing branch
    const { branchNodeId } = req.body;
    if (!branchNodeId) return res.status(400).json({ error: "branchNodeId required for extend mode" });
    res.json({
      branches: [],
      reuseBranches: [
        {
          branchNodeId,
          newSteps: [
            { type: "agent", label: "Extended Research", prompt: "Continue researching this topic in more depth" },
            { type: "web_search", label: "Latest Developments", prompt: "Search for the latest 2026 developments in this area" },
          ],
        },
      ],
      memoryUpdates: [],
    });
    return;
  }

  // mode === "full" — comprehensive test plan with multiple branches
  res.json({
    branches: [
      {
        topic: "Microservices Architecture",
        steps: [
          { type: "agent", label: "Service Design", prompt: "Analyze microservice decomposition strategies", tools: ["Read"] },
          { type: "web_search", label: "Service Mesh Research", prompt: "Research Istio vs Linkerd vs Consul Connect 2026", tools: ["WebSearch"] },
          { type: "transform", label: "Pattern Synthesis", prompt: "Synthesize findings into a decision matrix" },
        ],
      },
      {
        topic: "Event-Driven Patterns",
        steps: [
          { type: "agent", label: "Event Sourcing", prompt: "Deep-dive into event sourcing with Kafka", tools: [] },
          { type: "agent", label: "CQRS Integration", prompt: "How CQRS complements event-driven architecture" },
          { type: "transform", label: "Saga Patterns", prompt: "Analyze distributed saga patterns for consistency" },
          { type: "agent", label: "Schema Evolution", prompt: "Event schema versioning and backward compatibility strategies" },
        ],
      },
      {
        topic: "Serverless & FaaS",
        steps: [
          { type: "web_search", label: "Cold Start Analysis", prompt: "Benchmark cold start times across Lambda, Cloud Functions, Azure Functions" },
          { type: "agent", label: "Cost Modeling", prompt: "Build a cost model comparing serverless vs containers for different traffic patterns" },
        ],
      },
      {
        topic: "Hexagonal Architecture",
        steps: [
          { type: "agent", label: "Ports & Adapters", prompt: "Define port interfaces and adapter patterns for a payment system" },
          { type: "transform", label: "Testing Strategy", prompt: "How hexagonal architecture enables superior testability" },
          { type: "agent", label: "DDD Integration", prompt: "Combining hexagonal architecture with Domain-Driven Design bounded contexts" },
        ],
      },
      {
        topic: "Hybrid Approaches",
        steps: [
          { type: "agent", label: "Pattern Composition", prompt: "How to combine microservices + event-driven + CQRS effectively" },
          { type: "transform", label: "Decision Framework", prompt: "Build a decision tree: when to use which pattern based on team size, scale, latency" },
        ],
      },
    ],
    reuseBranches: [],
    memoryUpdates: [
      { concept: "Cloud-Native Architecture", facts: ["5 major patterns analyzed", "Hybrid approaches are most common in production", "No single pattern fits all use cases"] },
      { concept: "Microservices", facts: ["Require service mesh for observability at scale", "Team size > 5 devs is a good threshold"] },
      { concept: "Event Sourcing", facts: ["Kafka is the dominant event store", "Schema evolution is the biggest operational challenge"] },
    ],
  });
});

// ─── Knowledge Graph ────────────────────────────────────────────────────────

// GET /knowledge — list all knowledge entries
app.get("/knowledge", (req, res) => {
  const query = req.query.q as string | undefined;
  res.json(query ? searchKnowledge(query) : loadKnowledge());
});

// POST /knowledge — upsert a knowledge entry
app.post("/knowledge", (req, res) => {
  const { concept, facts, sessionId, nodeId } = req.body;
  if (!concept) return res.status(400).json({ error: "concept required" });
  const entry = upsertKnowledge(concept, facts ?? [], sessionId ?? "", nodeId ?? "");
  res.status(201).json(entry);
});

// PUT /knowledge/:id — update entry
app.put("/knowledge/:id", (req, res) => {
  const result = updateKnowledgeEntry(req.params.id, req.body);
  if (!result) return res.status(404).json({ error: "Not found" });
  res.json(result);
});

// DELETE /knowledge — clear all knowledge entries
app.delete("/knowledge", (_req, res) => {
  const fs = require("node:fs");
  const path = require("node:path");
  const kPath = path.join(process.env.BLOB_DIR ?? path.join(process.cwd(), "blobs"), "knowledge.json");
  try { fs.writeFileSync(kPath, "[]"); } catch { /* ignore */ }
  res.json({ ok: true });
});

// DELETE /knowledge/:id — delete entry
app.delete("/knowledge/:id", (req, res) => {
  if (!deleteKnowledgeEntry(req.params.id)) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

// POST /knowledge/link — link two concepts
app.post("/knowledge/link", (req, res) => {
  const { id1, id2 } = req.body;
  if (!id1 || !id2) return res.status(400).json({ error: "id1 and id2 required" });
  linkConcepts(id1, id2);
  res.json({ ok: true });
});

// POST /knowledge/extract — extract concepts from text via LLM
app.post("/knowledge/extract", async (req, res) => {
  const { text, sessionId, nodeId } = req.body;
  if (!text) return res.status(400).json({ error: "text required" });

  try {
    const existing = loadKnowledge().map((k) => k.concept);
    const prompt = buildExtractionPrompt(text, existing);

    const { runClaude } = await import("./claude-runner.js");
    let output = "";
    await runClaude(prompt, {
      id: "knowledge-extractor",
      type: "agent",
      model: process.env.BLOB_PLANNING_MODEL ?? "claude-sonnet-4-6",
      prompt: "",
      tools: [],
      output_var: "_extract",
      pre_tools: [],
    }, (chunk) => { output += chunk; });

    // Parse extracted concepts
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.json({ extracted: [] });

    const concepts = JSON.parse(jsonMatch[0]) as Array<{ concept: string; facts: string[]; relatedTo?: string[] }>;

    // Upsert each concept
    const results = concepts.map((c) => {
      const entry = upsertKnowledge(c.concept, c.facts, sessionId ?? "", nodeId ?? "");
      // Link related concepts
      if (c.relatedTo) {
        const allKnowledge = loadKnowledge();
        for (const rel of c.relatedTo) {
          const related = allKnowledge.find((k) => k.concept.toLowerCase() === rel.toLowerCase());
          if (related) linkConcepts(entry.id, related.id);
        }
      }
      return entry;
    });

    res.json({ extracted: results });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ─── Workflow Chat — two-stage conversational chain builder ────────────────
import { runStepWithRetry } from "./claude-runner.js";

app.post("/workflow-chat", async (req: Request, res: Response) => {
  const { stage, message, context, systemPrompt, model } = req.body as {
    stage: "chat" | "plan";
    message: string;
    context?: Array<{ role: string; content: string }>;
    systemPrompt?: string;
    model?: string;
  };

  if (!stage || !message) {
    return res.status(400).json({ error: "stage and message required" });
  }

  try {
    // Build full prompt from context
    const contextStr = (context ?? [])
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n\n");
    const fullPrompt = contextStr
      ? `${contextStr}\n\n[user]: ${message}`
      : message;

    const step = {
      id: `_wf_${stage}`,
      prompt: "",
      output_var: "_wf_out",
      model: model ?? (stage === "chat" ? "claude-haiku-4-5" : "claude-sonnet-4-6"),
      tools: [] as string[],
    };

    const sysPrompt = systemPrompt
      ? `${systemPrompt}\n\nRespond based on the conversation above.`
      : (stage === "chat"
        ? "You are a helpful workflow architect AI. Help the user design their chain."
        : "You are a chain planner. Output ONLY valid JSON."
      );

    const result = await runStepWithRetry(
      step,
      `${sysPrompt}\n\n---\n\n${fullPrompt}`,
      () => {}, // no streaming needed
      `wf-${stage}-${Date.now()}`,
      (msg: string, level: "info" | "warn" | "error") => logger[level]("workflow-chat", msg),
    );

    if (stage === "plan") {
      // Parse JSON from response
      const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const plan = JSON.parse(jsonMatch[0]);
          return res.json(plan);
        } catch {
          return res.json({ directResponse: "Could not parse plan JSON", raw: result.stdout });
        }
      }
      return res.json({ directResponse: result.stdout });
    }

    // Chat stage — return text response
    res.json({
      text: result.stdout,
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
    });
  } catch (err) {
    logger.error("workflow-chat", `${stage} failed`, { error: safeErrorMessage(err) });
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ──��� Generate Chain via Claude Code CLI + MCP (conversational + SSE stream) ──
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

// Session store for multi-turn conversations
const sessions = new Map<string, { conversationId: string; description: string; history: string[] }>();

const SYSTEM_PROMPT = `Tu es un architecte de workflows OCC (Claude Chain Orchestrator), expert en création de chains d'agents IA.
Tu travailles pour un développeur francophone. Réponds TOUJOURS en français.

═══ TON RÔLE ═══
Tu crées des chains de haute qualité en utilisant les outils MCP du chain-orchestrator.
Tu dois être RIGOUREUX, PRÉCIS et COMPLET.

═══ PHASE 1 : ANALYSE & QUESTIONS ═══
Avant de créer quoi que ce soit, tu DOIS d'abord :
1. Analyser la demande de l'utilisateur
2. Identifier les ambiguïtés et les paramètres manquants
3. Poser des questions PRÉCISES pour clarifier :

Questions à considérer (pose UNIQUEMENT celles qui sont pertinentes) :
- Objectif exact : quel résultat final attendu ?
- Périmètre : sur quel projet/codebase/dossier travailler ?
- Langue/framework : Python, TypeScript, React, etc. ?
- Profondeur : analyse rapide ou audit exhaustif ?
- Output : rapport, code, fichier, PR, etc. ?
- Qualité : mode brouillon ou production ?
- Dépendances : faut-il utiliser des APIs externes, un browser, des fichiers ?
- Parallélisme : quelles parties peuvent tourner simultanément ?
- Validation : faut-il un gate humain avant certaines étapes ?
- Chains existantes : veut-il réutiliser/combiner des chains déjà créées ?

FORMAT DE RÉPONSE QUAND TU POSES DES QUESTIONS :
Commence ta réponse par "QUESTIONS:" suivi d'un JSON array :
QUESTIONS:["Question 1 ?", "Question 2 ?", "Question 3 ?"]

Ne pose que 2 à 5 questions maximum. Sois concis.
Si la demande est déjà claire et complète, passe directement à la création (Phase 2).

═══ PHASE 2 : CRÉATION ═══
Quand tu as assez d'infos (soit après les réponses, soit si la demande est claire) :

1. Utilise list_chains pour voir les chains existantes
2. Étudie 2-3 chains similaires avec get_chain
3. Conçois l'architecture optimale :
   - Identifie les steps parallélisables (pas de depends_on entre eux)
   - Utilise le bon type pour chaque step :
     * agent : step principal (LLM fait le travail)
     * router : aiguillage conditionnel (ex: si erreur → route A, sinon → route B)
     * transform : manipulation de données (json_extract, template, regex, truncate)
     * evaluator : scoring + décision (seuil de qualité, retry si score bas)
     * gate : pause pour validation humaine ou condition temporelle
     * merge : combine les outputs de steps parallèles (concat, smart_summary, pick_best)
     * browser : automatisation web (goto, click, screenshot, extract)
     * loop : répétition avec condition de sortie
     * subchain : réutilise une chain existante comme step
     * debate : multi-agents qui débattent (brainstorm, Devil's advocate)
   - Écris des agent_prompt DÉTAILLÉS (10+ lignes, avec contexte, contraintes, format attendu)
   - Configure les tools pertinents pour chaque step (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch)
   - Ajoute des pre_tools si un step a besoin de données injectées (lire un fichier, une variable d'env)
   - Configure les retry, cache, timeout quand pertinent

4. Crée la chain via create_chain puis add_step pour chaque étape
5. Vérifie avec get_chain que tout est correct

FORMAT DE RÉPONSE FINALE :
Commence par "CREATED:" suivi du nom de la chain :
CREATED:nom-de-la-chain

═══ PRINCIPES ═══
- Chaque agent_prompt doit être autonome : contient TOUT le contexte nécessaire
- Utilise {variable} pour référencer les outputs des steps précédents
- Les inputs de la chain sont accessibles via {input_name}
- Privilégie la qualité : mieux vaut 7 steps bien faits que 3 bâclés
- Les steps sans depends_on commun s'exécutent EN PARALLÈLE automatiquement
- Nomme les steps en kebab-case descriptif (analyze-code, generate-tests, write-report)`;

// POST /generate-chain — Start or continue a conversation
app.post("/generate-chain", async (req: Request, res: Response) => {
  const { description, sessionId, answers } = req.body;

  if (!description && !answers) {
    return res.status(400).json({ error: "description or answers required" });
  }

  try {
    const claudePath = process.env.CLAUDE_CLI ?? "claude";
    const chainsDir = process.env.CHAINS_DIR ?? path.join(process.cwd(), "..", "chains");
    const mcpConfig = path.join(chainsDir, "..", ".mcp.json");
    const allowedTools = [
      "mcp__chain-orchestrator__list_chains",
      "mcp__chain-orchestrator__get_chain",
      "mcp__chain-orchestrator__create_chain",
      "mcp__chain-orchestrator__add_step",
      "mcp__chain-orchestrator__update_step",
      "mcp__chain-orchestrator__add_pre_tool",
    ].join(",");

    let userMessage: string;
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (answers && session) {
      // ── Continue conversation with answers ──────────────────
      // Reset session expiry on access
      if ((session as any)._timeout) { clearTimeout((session as any)._timeout); }
      const sid = session.conversationId;
      (session as any)._timeout = setTimeout(() => sessions.delete(sid), 600_000);

      userMessage = `Voici mes réponses à tes questions :\n\n${answers}\n\nMaintenant crée la chain avec les outils MCP.`;
      session.history.push(userMessage);
    } else {
      // ── New conversation ────────────────────────────────────
      const sid = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      session = { conversationId: sid, description: description!, history: [] };
      sessions.set(sid, session);
      userMessage = `Demande de l'utilisateur : "${description}"`;
      session.history.push(userMessage);

      // Auto-cleanup old sessions after 10 min (reset on each access)
      const sessionTimeout = setTimeout(() => sessions.delete(sid), 600_000);
      (session as any)._timeout = sessionTimeout;
    }

    const fullPrompt = session.history.length > 1
      ? `${SYSTEM_PROMPT}\n\n═══ HISTORIQUE ═══\n${session.history.join("\n\n---\n\n")}`
      : `${SYSTEM_PROMPT}\n\n${userMessage}`;

    process.stderr.write(`[generate-chain] Session ${session.conversationId}: ${userMessage.slice(0, 100)}...\n`);

    const { stdout } = await execFileAsync(claudePath, [
      "--print",
      "--mcp-config", mcpConfig,
      "--allowedTools", allowedTools,
      fullPrompt,
    ], {
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
      cwd: chainsDir,
    });

    const output = stdout.trim();
    process.stderr.write(`[generate-chain] Output: ${output.slice(0, 300)}...\n`);

    // ── Parse response ───────────────────────────────────────
    // Check if Claude is asking questions
    const questionsMatch = output.match(/QUESTIONS:\s*\[([^\]]+)\]/);
    if (questionsMatch) {
      try {
        const questions = JSON.parse(`[${questionsMatch[1]}]`) as string[];
        session.history.push(output);
        return res.json({
          status: "questions",
          sessionId: session.conversationId,
          questions,
          message: output.replace(/QUESTIONS:\s*\[.*\]/, "").trim(),
        });
      } catch { /* parse failed, treat as creation */ }
    }

    // Check if Claude created a chain
    const createdMatch = output.match(/CREATED:\s*([a-z0-9-]+)/i);
    const chainName = createdMatch?.[1]
      ?? output.match(/(?:chain[:\s]+["']?|créée?\s*:\s*["']?|name:\s*)([a-z0-9][a-z0-9-]*)/i)?.[1]
      ?? `voice-chain-${Date.now()}`;

    // Load the YAML from disk (created via MCP)
    let yaml = "";
    try {
      yaml = loadChainRaw(chainName);
    } catch {
      // Fallback: extract from output
      yaml = output;
      if (yaml.includes("```")) {
        const parts = yaml.split("```");
        if (parts.length >= 2) {
          yaml = parts[1].replace(/^ya?ml\n/, "");
        }
      }
    }

    // Cleanup session
    if (sessionId) sessions.delete(sessionId);

    process.stderr.write(`[generate-chain] Created chain: ${chainName}\n`);
    res.json({
      status: "created",
      chainName,
      yaml: yaml.trim(),
      summary: output.replace(/CREATED:.*/, "").trim().slice(0, 500),
    });
  } catch (err: any) {
    process.stderr.write(`[generate-chain] Error: ${err.message}\n`);
    res.status(500).json({ error: err.message ?? "Generation failed" });
  }
});

// ─── SSE Streaming endpoint for live Claude CLI output ───────────────────────
app.get("/generate-chain/stream/:sessionId", (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": CORS_ORIGIN,
  });
  res.write(`data: ${JSON.stringify({ type: "connected", sessionId })}\n\n`);

  if (!session) {
    res.write(`data: ${JSON.stringify({ type: "error", message: "Session not found" })}\n\n`);
    res.end();
    return;
  }

  // Store SSE response for this session so the generate-chain POST can stream to it
  (session as any)._sseRes = res;

  req.on("close", () => {
    (session as any)._sseRes = undefined;
  });
});

// Streaming version of generate-chain: spawns Claude CLI and streams output via SSE
app.post("/generate-chain/stream", async (req: Request, res: Response) => {
  const { description, sessionId: existingSessionId, answers } = req.body;

  if (!description && !answers) {
    return res.status(400).json({ error: "description or answers required" });
  }

  const claudePath = process.env.CLAUDE_CLI ?? "claude";
  const chainsDir = process.env.CHAINS_DIR ?? path.join(process.cwd(), "..", "chains");
  const mcpConfig = path.join(chainsDir, "..", ".mcp.json");
  const allowedTools = [
    "mcp__chain-orchestrator__list_chains",
    "mcp__chain-orchestrator__get_chain",
    "mcp__chain-orchestrator__create_chain",
    "mcp__chain-orchestrator__add_step",
    "mcp__chain-orchestrator__update_step",
    "mcp__chain-orchestrator__add_pre_tool",
  ].join(",");

  // Create or resume session
  let session = existingSessionId ? sessions.get(existingSessionId) : undefined;
  const sid = session?.conversationId ?? `gen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  if (!session) {
    session = { conversationId: sid, description: description ?? "", history: [] };
    sessions.set(sid, session);
    setTimeout(() => sessions.delete(sid), 600_000);
  }

  // Build prompt
  let userMessage: string;
  if (answers && existingSessionId) {
    userMessage = `Voici mes réponses :\n\n${answers}\n\nMaintenant crée la chain.`;
  } else {
    userMessage = `Demande : "${description}"`;
  }
  session.history.push(userMessage);

  const fullPrompt = session.history.length > 1
    ? `${SYSTEM_PROMPT}\n\n═══ HISTORIQUE ═══\n${session.history.join("\n\n---\n\n")}`
    : `${SYSTEM_PROMPT}\n\n${userMessage}`;

  // ── Set up SSE response ────────────────────────────────────
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": CORS_ORIGIN,
  });

  const sendEvent = (data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent({ type: "start", sessionId: sid });

  // ── Spawn Claude CLI and stream output ─────────────────────
  const child: ChildProcess = spawn(claudePath, [
    "--print",
    "--mcp-config", mcpConfig,
    "--allowedTools", allowedTools,
    fullPrompt,
  ], {
    env: { ...process.env, NO_COLOR: "1" },
    cwd: chainsDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let fullOutput = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    fullOutput += text;
    sendEvent({ type: "text", content: text });
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    // Claude CLI outputs tool use info on stderr
    if (text.includes("mcp__")) {
      const toolMatch = text.match(/mcp__chain-orchestrator__(\w+)/);
      if (toolMatch) {
        sendEvent({ type: "tool", tool: toolMatch[1], raw: text.trim().slice(0, 200) });
      }
    }
    sendEvent({ type: "progress", content: text.trim().slice(0, 200) });
  });

  child.on("close", (code) => {
    const output = fullOutput.trim();

    // Parse result
    const questionsMatch = output.match(/QUESTIONS:\s*\[([^\]]+)\]/);
    if (questionsMatch) {
      try {
        const questions = JSON.parse(`[${questionsMatch[1]}]`) as string[];
        session!.history.push(output);
        sendEvent({
          type: "questions",
          sessionId: sid,
          questions,
          message: output.replace(/QUESTIONS:\s*\[.*\]/, "").trim(),
        });
        sendEvent({ type: "done" });
        res.end();
        return;
      } catch { /* parse failed */ }
    }

    // Extract chain name
    const createdMatch = output.match(/CREATED:\s*([a-z0-9-]+)/i);
    const chainName = createdMatch?.[1]
      ?? output.match(/(?:chain[:\s]+["']?|name:\s*)([a-z0-9][a-z0-9-]*)/i)?.[1]
      ?? `voice-chain-${Date.now()}`;

    let yaml = "";
    try { yaml = loadChainRaw(chainName); }
    catch {
      yaml = output;
      if (yaml.includes("```")) {
        const parts = yaml.split("```");
        if (parts.length >= 2) yaml = parts[1].replace(/^ya?ml\n/, "");
      }
    }

    if (existingSessionId) sessions.delete(existingSessionId);

    sendEvent({
      type: "created",
      chainName,
      yaml: yaml.trim(),
      summary: output.replace(/CREATED:.*/, "").trim().slice(0, 500),
    });
    sendEvent({ type: "done" });
    res.end();
  });

  child.on("error", (err) => {
    sendEvent({ type: "error", message: err.message });
    sendEvent({ type: "done" });
    res.end();
  });

  // Timeout
  const timeout = setTimeout(() => {
    child.kill();
    sendEvent({ type: "error", message: "Timeout (3 min)" });
    sendEvent({ type: "done" });
    res.end();
  }, 180_000);

  child.on("close", () => clearTimeout(timeout));

  req.on("close", () => { child.kill(); clearTimeout(timeout); });
});

// ─── SPA fallback — serve index.html for client-side routes ──────────────────
if (fs.existsSync(frontendDir)) {
  const indexHtml = path.join(frontendDir, "index.html");
  if (fs.existsSync(indexHtml)) {
    app.get("*", (_req, res, next) => {
      // Don't intercept API routes or file requests with extensions
      if (_req.path.startsWith("/api") || _req.path.includes(".")) return next();
      res.sendFile(indexHtml);
    });
  }
}

// ─── Global error handler — prevent stack trace leaks ──────────────────────
app.use((err: Error, _req: Request, res: Response, _next: Function) => {
  logger.error("occ-rest", "Unhandled route error", { error: err.message, path: _req.path });
  if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.REST_PORT ?? "4242", 10);
const HOST = process.env.REST_HOST ?? "127.0.0.1";  // Bind to localhost only by default (set REST_HOST=0.0.0.0 for network access)

// SECURITY: Warn loudly when API is network-accessible without authentication
if (HOST === "0.0.0.0" && !API_KEY) {
  const banner = [
    "",
    "╔══════════════════════════════════════════════════════════════════╗",
    "║  ⚠  WARNING: API is bound to 0.0.0.0 WITHOUT authentication   ║",
    "║  Anyone on your network can execute chains and access config.   ║",
    "║  Set OCC_API_KEY in your .env or environment to secure the API. ║",
    "╚═════════════════════════════════════════════════════════════════��╝",
    "",
  ].join("\n");
  process.stderr.write(banner);
  logger.warn("occ-auth", "API bound to 0.0.0.0 without authentication — set OCC_API_KEY");
}

const server = app.listen(PORT, HOST, () => {
  logger.info("occ-rest", `Listening on http://${HOST}:${PORT}`, { host: HOST, port: PORT, auth: !!API_KEY, cors: CORS_ORIGIN });
  validateClaudeBinary();
  loadMcpServers();
  loadPersistedExecutions();
  startAutonomousEngine();
  // Initialize queue with a runner that executes chains
  initQueue(async (job) => {
    const chain = loadChain(job.name);
    let executionId = "";
    const emitter = (event: ExecutionEvent) => {
      if (event.type === "execution_started") {
        executionId = event.executionId; // Capture ACTUAL executionId from executor
      }
      if (executionId) emitSSE(executionId, event);
    };
    await executeChain(chain, job.input, emitter);
    return executionId;
  });
  loadPersistedPipelineExecutions();
  setSSEEmitter(emitSSE);
  initScheduler();
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!process.env.VITEST) {
    process.stderr.write(`[occ-rest] Graceful shutdown initiated...\n`);
  }
  // 1. Stop accepting new connections
  try { server.close(); } catch {}
  // 2. Kill all active Claude CLI child processes
  try {
    const { getAllActiveProcesses } = await import("./executor.js");
    for (const [, children] of getAllActiveProcesses()) {
      for (const child of children) {
        try { child.kill("SIGTERM"); } catch {}
      }
    }
  } catch {}
  // 3. Close all SSE connections
  for (const [, clients] of sseClients) {
    for (const c of clients) { try { c.end(); } catch {} }
  }
  sseClients.clear();
  for (const c of globalSSEClients) { try { c.end(); } catch {} }
  globalSSEClients.length = 0;
  // 4. Close databases and services
  try { closeQueue(); } catch {}
  try { await closeMcpClients(); } catch {}
  try { closeStorage(); } catch {}
  try { const { closeExtraDbs } = await import("./pretool-extras.js"); closeExtraDbs(); } catch {}
  // 5. Allow 3s for in-flight requests to finish, then exit
  if (!process.env.VITEST) {
    setTimeout(() => process.exit(0), 3000);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (reason) => {
  logger.error("occ", "Unhandled promise rejection", { reason: String(reason) });
});
process.on("uncaughtException", (err) => {
  logger.error("occ", "Uncaught exception — shutting down", { error: err.message, stack: err.stack });
  shutdown();
});

export { app };
