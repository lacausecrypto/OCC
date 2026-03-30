import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import type {
  CacheEntry,
  ChainDefinition,
  ChainExecution,
  ChainStep,
  ExecutionEvent,
  PreTool,
  StepResult,
} from "./types.js";
import { buildDependencyGraph } from "./loader.js";
import { evaluateCondition, resolveVariables } from "./utils.js";
import { saveExecution, checkpointStep, loadExecution as loadExecutionFromDb, listExecutions as listExecutionsFromDb, initStorage, getExecutionTimeline, loadChainSnapshot } from "./storage.js";

// ─── In-memory execution store ────────────────────────────────────────────────

const executions = new Map<string, ChainExecution>();

// Map executionId → active ChildProcesses (for cancellation — supports parallel steps)
const activeProcesses = new Map<string, Set<ChildProcess>>();

// ─── Persistence ──────────────────────────────────────────────────────────────

function getExecutionsFile(): string {
  const chainsDir = process.env.CHAINS_DIR ?? "";
  if (chainsDir) {
    return path.join(chainsDir.replace(/[/\\]chains[/\\]?$/, ""), "executions.json");
  }
  return process.env.EXECUTIONS_FILE ?? path.join(os.tmpdir(), "occ-executions.json");
}

function persistExecutions(): void {
  // Write to SQLite (primary)
  try {
    for (const exec of executions.values()) {
      saveExecution(exec);
    }
  } catch { /* SQLite not initialized yet — fallback to JSON */ }

  // JSON fallback for backwards compatibility
  try {
    const file = getExecutionsFile();
    const data = JSON.stringify([...executions.values()].slice(-200), null, 2);
    fs.writeFile(file, data, "utf-8", () => {}); // non-blocking, best-effort
  } catch { /* ignore */ }
}

/** Checkpoint a single execution to SQLite (called after each step). */
function persistStepCheckpoint(executionId: string, step: StepResult): void {
  try {
    checkpointStep(executionId, step);
    const exec = executions.get(executionId);
    if (exec) saveExecution(exec);
  } catch { /* best-effort */ }
}

export function loadPersistedExecutions(): void {
  // Initialize SQLite storage
  try {
    initStorage();
  } catch (err) {
    process.stderr.write(`[occ] WARNING: SQLite init failed, falling back to JSON: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Load from SQLite (primary)
  try {
    const dbExecutions = listExecutionsFromDb(200, 0);
    if (dbExecutions.length > 0) {
      for (const ex of dbExecutions) {
        executions.set(ex.id, ex);
      }
      process.stderr.write(`[occ] Loaded ${executions.size} executions from SQLite\n`);
      return;
    }
  } catch { /* SQLite not available, try JSON */ }

  // Fallback: load from JSON
  try {
    const file = getExecutionsFile();
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, "utf-8");
    let data: ChainExecution[];
    try {
      data = JSON.parse(raw) as ChainExecution[];
    } catch (parseErr) {
      process.stderr.write(`[occ] WARNING: executions.json is corrupted, backing up and starting fresh\n`);
      fs.copyFileSync(file, file + ".backup." + Date.now());
      fs.writeFileSync(file, "[]", "utf-8");
      return;
    }
    for (const ex of data) {
      if (ex.status === "running") {
        ex.status = "error";
        ex.error = "Interrupted — server restarted";
        ex.finishedAt = new Date().toISOString();
      }
    }
    const maxAge = Number(process.env.EXECUTION_MAX_AGE_DAYS) || 7;
    const cutoff = Date.now() - maxAge * 86400000;
    for (const ex of data) {
      if (new Date(ex.startedAt).getTime() >= cutoff) {
        executions.set(ex.id, ex);
      }
    }
    // Migrate JSON → SQLite
    try {
      for (const ex of executions.values()) {
        saveExecution(ex);
        for (const step of Object.values(ex.steps)) {
          checkpointStep(ex.id, step);
        }
      }
      process.stderr.write(`[occ] Migrated ${executions.size} executions from JSON to SQLite\n`);
    } catch { /* migration best-effort */ }
  } catch (err) {
    process.stderr.write(`[occ] WARNING: Failed to load executions: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/** Get execution timeline (time-travel). */
export { getExecutionTimeline };

export function getExecution(id: string): ChainExecution | undefined {
  return executions.get(id);
}

export function getAllExecutions(): ChainExecution[] {
  return [...executions.values()].sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt)
  );
}

/** Trim in-memory executions map to prevent unbounded growth. */
function trimExecutions(): void {
  if (executions.size > 250) {
    const sorted = [...executions.entries()].sort(
      (a, b) => a[1].startedAt.localeCompare(b[1].startedAt)
    );
    const toRemove = sorted.slice(0, sorted.length - 200);
    for (const [key] of toRemove) {
      executions.delete(key);
    }
  }
}

// ─── Step-level caching ──────────────────────────────────────────────────────

function getCacheDir(): string {
  const chainsDir = process.env.CHAINS_DIR ?? "";
  if (chainsDir) {
    return path.resolve(chainsDir, "..", "cache");
  }
  return path.join(os.tmpdir(), "occ-cache");
}

function createCacheKey(stepId: string, resolvedPrompt: string, model?: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(stepId);
  hash.update(resolvedPrompt);
  hash.update(model ?? "");
  return hash.digest("hex");
}

function loadCache(chainName: string, cacheKey: string, ttlMinutes: number): CacheEntry | null {
  try {
    const cacheDir = getCacheDir();
    const cacheFile = path.join(cacheDir, chainName, `${cacheKey}.json`);
    if (!fs.existsSync(cacheFile)) return null;
    const raw = fs.readFileSync(cacheFile, "utf-8");
    const entry = JSON.parse(raw) as CacheEntry;
    const age = (Date.now() - new Date(entry.createdAt).getTime()) / 60000;
    if (age > ttlMinutes) {
      // Expired — remove cache file
      try { fs.unlinkSync(cacheFile); } catch { /* ignore */ }
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

function saveCache(chainName: string, entry: CacheEntry): void {
  try {
    const cacheDir = path.join(getCacheDir(), chainName);
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, `${entry.key}.json`);
    fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2), "utf-8");
  } catch { /* best-effort */ }
}

// ─── Output validation (guardrails) ─────────────────────────────────────────

function validateOutput(
  output: string,
  step: ChainStep,
  onLog: (message: string, level: "info" | "warn" | "error") => void
): string[] {
  const errors: string[] = [];

  // Check guardrails
  if (step.guardrails) {
    for (const guard of step.guardrails) {
      switch (guard.type) {
        case "max_length":
          if (output.length > (guard.value as number)) errors.push(`Output exceeds max length ${guard.value}`);
          break;
        case "min_length":
          if (output.length < (guard.value as number)) errors.push(`Output below min length ${guard.value}`);
          break;
        case "must_contain":
          if (!output.includes(guard.value as string)) errors.push(`Output missing required: "${guard.value}"`);
          break;
        case "must_not_contain":
          if (output.includes(guard.value as string)) errors.push(`Output contains forbidden: "${guard.value}"`);
          break;
        case "regex_match":
          if (!new RegExp(guard.value as string).test(output)) errors.push(`Output doesn't match regex: ${guard.value}`);
          break;
        case "json_valid":
          try { JSON.parse(output); } catch { errors.push("Output is not valid JSON"); }
          break;
      }
    }
  }

  // Check legacy fields
  if (step.output_must_contain) {
    for (const s of step.output_must_contain) {
      if (!output.includes(s)) errors.push(`Missing required string: "${s}"`);
    }
  }
  if (step.output_must_not_contain) {
    for (const s of step.output_must_not_contain) {
      if (output.includes(s)) errors.push(`Contains forbidden string: "${s}"`);
    }
  }
  if (step.output_max_length && output.length > step.output_max_length) {
    errors.push(`Output ${output.length} chars exceeds max ${step.output_max_length}`);
  }
  if (step.output_schema === "json") {
    try { JSON.parse(output); } catch { errors.push("Output is not valid JSON"); }
  }

  return errors;
}

// ─── Execution cancellation ───────────────────────────────────────────────────

export function cancelExecution(id: string): boolean {
  const children = activeProcesses.get(id);
  if (!children || children.size === 0) {
    // Still allow cancelling the execution record even if no active processes
    const execution = executions.get(id);
    if (!execution || execution.status !== "running") return false;
  }

  // Kill all active child processes for this execution (handles parallel steps)
  if (children) {
    for (const child of children) {
      try {
        child.kill("SIGTERM");
        // Force kill after 3s if still alive
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch (e) { process.stderr.write(`[occ] kill SIGKILL failed: ${e}\n`); }
        }, 3000);
      } catch (e) { process.stderr.write(`[occ] kill SIGTERM failed: ${e}\n`); }
    }
  }

  const execution = executions.get(id);
  if (execution && execution.status === "running") {
    execution.status = "error";
    execution.error = "Cancelled by user";
    execution.finishedAt = new Date().toISOString();
    execution.durationMs = Date.now() - new Date(execution.startedAt).getTime();
    for (const step of Object.values(execution.steps)) {
      if (step.status === "pending" || step.status === "running") {
        step.status = "skipped";
      }
    }
    persistExecutions();
  }
  activeProcesses.delete(id);
  return true;
}

// ─── Pre-tool executor ────────────────────────────────────────────────────────

// ─── Pre-tool cache ─────────────────────────────────────────────────────────

const preToolCache = new Map<string, { result: string; expiresAt: number }>();

function getPreToolCacheKey(tool: PreTool, vars: Record<string, string>): string {
  const key = JSON.stringify({ type: tool.type, url: tool.url, query: tool.query, path: tool.path,
    command: tool.command, var_name: tool.var_name, server: tool.server, tool: tool.tool,
    args: tool.args, method: tool.method, headers: tool.headers, body: tool.body });
  return resolveVariables(key, vars); // Resolved key so same inputs = same cache
}

// ─── Single pre-tool executor ───────────────────────────────────────────────

async function executeSinglePreTool(
  tool: PreTool,
  vars: Record<string, string>,
  onLog: (message: string, level: "info" | "warn" | "error") => void,
  execution?: ChainExecution,
  executionId?: string,
  step?: ChainStep,
): Promise<string> {
  // Check cache
  if (tool.cache_ttl_minutes && tool.cache_ttl_minutes > 0) {
    const cacheKey = getPreToolCacheKey(tool, vars);
    const cached = preToolCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      onLog(`pre-tool ${tool.type} → {${tool.inject_as}} (cache hit)`, "info");
      return cached.result;
    }
  }

  const timeoutMs = tool.timeout_ms ?? 30000;
  let result = "";

  switch (tool.type) {
    case "current_datetime": {
      const tz = tool.timezone ?? "UTC";
      const fmt = tool.format ?? "iso";
      if (fmt === "unix") {
        result = String(Math.floor(Date.now() / 1000));
      } else if (fmt === "locale") {
        result = new Date().toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "medium" });
      } else {
        result = new Date().toISOString();
      }
      break;
    }

    case "http_fetch": {
      const url = resolveVariables(tool.url ?? "", vars);
      const method = tool.method ?? "GET";

      // Resolve headers
      const headers: Record<string, string> = {};
      if (tool.headers) {
        for (const [k, v] of Object.entries(tool.headers)) {
          headers[k] = resolveVariables(v, vars);
        }
      }

      // Resolve body
      let body: string | undefined;
      if (tool.body && method !== "GET" && method !== "DELETE") {
        body = resolveVariables(tool.body, vars);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(url, {
          method,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          body,
          signal: controller.signal,
        });
        result = await resp.text();
      } finally {
        clearTimeout(timer);
      }

      // JSON path extraction
      if (tool.json_path && result) {
        try {
          const json = JSON.parse(result);
          const extracted = extractJsonPath(json, tool.json_path);
          result = typeof extracted === "string" ? extracted : JSON.stringify(extracted);
        } catch {
          onLog(`http_fetch json_path extraction failed for "${tool.json_path}"`, "warn");
        }
      }

      if (result.length > 50000) {
        result = result.slice(0, 50000) + "\n[truncated]";
        onLog(`http_fetch truncated to 50KB for ${url}`, "warn");
      }
      break;
    }

    case "web_search": {
      const query = resolveVariables(tool.query ?? "", vars);
      const searchPrompt = `Search the web for: ${query}\n\nProvide a comprehensive summary of the most relevant and recent results. Include key facts, numbers, dates, and sources.`;
      const { stdout } = await runClaude(searchPrompt, { id: "_search", output_var: "_", tools: ["WebSearch"], model: "claude-haiku-4-5", prompt: "" } as ChainStep, () => {});
      result = stdout;
      break;
    }

    case "read_file": {
      const filePath = path.resolve(resolveVariables(tool.path ?? "", vars));
      // Path traversal protection: restrict to WORKSPACE_DIR or cwd
      const safeRoot = path.resolve(process.env.WORKSPACE_DIR ?? process.cwd());
      if (!filePath.startsWith(safeRoot) && !filePath.startsWith(os.tmpdir())) {
        throw new Error(`read_file: path "${filePath}" outside allowed directory "${safeRoot}"`);
      }
      const encoding = (tool.encoding ?? "utf-8") as BufferEncoding;
      result = fs.readFileSync(filePath, encoding);
      if (result.length > 50000) {
        result = result.slice(0, 50000) + "\n[truncated]";
        onLog(`read_file truncated to 50KB for ${filePath}`, "warn");
      }
      break;
    }

    case "write_file": {
      const filePath = path.resolve(resolveVariables(tool.path ?? "", vars));
      // Path traversal protection
      const safeWriteRoot = path.resolve(process.env.WORKSPACE_DIR ?? process.cwd());
      if (!filePath.startsWith(safeWriteRoot) && !filePath.startsWith(os.tmpdir())) {
        throw new Error(`write_file: path "${filePath}" outside allowed directory "${safeWriteRoot}"`);
      }
      const fileContent = resolveVariables(tool.content ?? "", vars);
      const encoding = (tool.encoding ?? "utf-8") as BufferEncoding;
      const dir = path.dirname(filePath);
      if (dir) fs.mkdirSync(dir, { recursive: true });
      if (tool.append) {
        fs.appendFileSync(filePath, fileContent, encoding);
      } else {
        fs.writeFileSync(filePath, fileContent, encoding);
      }
      result = filePath;
      onLog(`write_file${tool.append ? " (append)" : ""} → ${filePath} (${fileContent.length} chars)`, "info");
      break;
    }

    case "bash": {
      const command = resolveVariables(tool.command ?? "", vars);
      if (tool.stderr) {
        // Capture both stdout + stderr
        try {
          const proc = require("node:child_process").spawnSync("sh", ["-c", command], {
            timeout: timeoutMs, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024,
          });
          result = (proc.stdout || "") + (proc.stderr ? "\n[stderr]\n" + proc.stderr : "");
        } catch (e) {
          result = String(e);
        }
      } else {
        result = execSync(command, { timeout: timeoutMs, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      }
      break;
    }

    case "env_var":
      result = process.env[tool.var_name ?? ""] ?? tool.default_value ?? "";
      break;

    case "mcp_call": {
      const { mcpCall } = await import("./mcp-client.js");
      const resolvedArgs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(tool.args ?? {})) {
        resolvedArgs[k] = typeof v === "string" ? resolveVariables(v, vars) : v;
      }
      result = await mcpCall(tool.server ?? "", tool.tool ?? "", resolvedArgs);
      break;
    }

    // ── TIER 1: Game changers ───────────────────────────────────
    case "state_load": {
      const { stateLoad } = await import("./pretool-extras.js");
      const stKey = resolveVariables(tool.key ?? "", vars);
      const stScope = tool.scope ?? execution?.chainName ?? "global";
      result = stateLoad(stKey, stScope, tool.default ?? "");
      break;
    }
    case "state_save": {
      const { stateSave } = await import("./pretool-extras.js");
      const stKey = resolveVariables(tool.key ?? "", vars);
      const stValue = resolveVariables(tool.value ?? "", vars);
      const stScope = tool.scope ?? execution?.chainName ?? "global";
      stateSave(stKey, stValue, stScope);
      result = `Saved "${stKey}" (${stValue.length} chars)`;
      break;
    }
    case "vector_query": {
      const { vectorQuery: vq } = await import("./pretool-extras.js");
      const vqQuery = resolveVariables(tool.query ?? "", vars);
      result = vq(tool.collection ?? "default", vqQuery, tool.top_k ?? 5);
      break;
    }
    case "vector_index": {
      const { vectorIndex: vi } = await import("./pretool-extras.js");
      const viSource = resolveVariables(tool.source ?? "", vars);
      result = vi(tool.collection ?? "default", viSource, tool.chunk_size ?? 512);
      break;
    }
    case "json_parse": {
      const { jsonParse } = await import("./pretool-extras.js");
      const jpInput = resolveVariables(tool.input ?? "", vars);
      const jpPath = tool.json_path ?? "$";
      result = jsonParse(jpInput, jpPath);
      break;
    }
    case "diff_inject": {
      const { diffInject } = await import("./pretool-extras.js");
      const diRepo = resolveVariables(tool.repo ?? "", vars);
      result = diffInject(diRepo, tool.base ?? "main", tool.head ?? "HEAD", tool.max_tokens ?? 4000);
      break;
    }
    case "notify": {
      const { notify: ntf } = await import("./pretool-extras.js");
      const nUrl = resolveVariables(tool.webhook_url ?? "", vars);
      const nMsg = resolveVariables(tool.message ?? "", vars);
      result = await ntf(tool.channel ?? "webhook", nUrl, nMsg);
      break;
    }

    // ── TIER 2: Strong differentiation ──────────────────────────
    case "semantic_cache": {
      const { semanticCacheLookup, semanticCacheStore } = await import("./pretool-extras.js");
      const scQuery = resolveVariables(tool.query ?? "", vars);
      const ttl = tool.cache_ttl_minutes ?? 60;
      const cached = semanticCacheLookup(scQuery, ttl, tool.similarity_threshold ?? 0.85);
      if (cached) {
        result = cached;
        onLog(`semantic_cache HIT for "${scQuery.slice(0, 50)}..."`, "info");
      } else {
        // Execute the underlying web_search and cache the result
        const searchPrompt = `Search the web for: ${scQuery}\n\nProvide a comprehensive summary.`;
        const { stdout } = await runClaude(searchPrompt, { id: "_search", output_var: "_", tools: ["WebSearch"], model: "claude-haiku-4-5", prompt: "" } as ChainStep, () => {});
        result = stdout;
        semanticCacheStore(scQuery, result, ttl);
        onLog(`semantic_cache MISS — stored for ${ttl}min`, "info");
      }
      break;
    }
    case "screenshot": {
      const { takeScreenshot } = await import("./pretool-extras.js");
      const ssUrl = resolveVariables(tool.url ?? "", vars);
      const vp = tool.viewport ?? { width: 1440, height: 900 };
      result = await takeScreenshot(ssUrl, vp, tool.wait_ms ?? 3000);
      break;
    }
    case "sandbox_exec": {
      const { sandboxExec } = await import("./pretool-extras.js");
      const seCmd = resolveVariables(tool.command ?? "", vars);
      const seMount = tool.mount ? resolveVariables(tool.mount, vars) : undefined;
      result = sandboxExec(tool.image ?? "node:20-slim", seCmd, seMount, timeoutMs);
      break;
    }
    case "cost_gate": {
      const { costGate } = await import("./pretool-extras.js");
      const steps = execution ? execution.steps : {};
      result = costGate(tool.budget_usd ?? 1.0, steps, tool.action ?? "warn");
      break;
    }
    case "ast_parse": {
      const { astParse } = await import("./pretool-extras.js");
      const apPath = resolveVariables(tool.path ?? "", vars);
      result = astParse(apPath, tool.extract ?? ["functions", "classes", "exports"]);
      break;
    }

    // ── TIER 3: Forward-looking ─────────────────────────────────
    case "embed_compare": {
      const { embedCompare } = await import("./pretool-extras.js");
      const ecA = resolveVariables(tool.text_a ?? "", vars);
      const ecB = resolveVariables(tool.text_b ?? "", vars);
      result = embedCompare(ecA, ecB);
      break;
    }
    case "graph_query": {
      if (tool.triples && tool.triples.length > 0) {
        const { graphWrite } = await import("./pretool-extras.js");
        // Resolve variables in triple values
        const resolvedTriples = tool.triples.map(t => ({
          subject: resolveVariables(t.subject, vars),
          predicate: resolveVariables(t.predicate, vars),
          object: resolveVariables(t.object, vars),
        }));
        result = graphWrite(resolvedTriples);
      } else {
        const { graphRead } = await import("./pretool-extras.js");
        const gqSubject = tool.graph_query_subject ? resolveVariables(tool.graph_query_subject, vars) : undefined;
        const gqPred = tool.graph_query_predicate ? resolveVariables(tool.graph_query_predicate, vars) : undefined;
        result = graphRead(gqSubject, gqPred);
      }
      break;
    }
    case "parallel_fetch": {
      const { parallelFetch } = await import("./pretool-extras.js");
      const pfUrls = (tool.urls ?? []).map(u => resolveVariables(u, vars));
      result = await parallelFetch(pfUrls, tool.rate_limit_ms ?? 100, timeoutMs);
      break;
    }
    case "template_render": {
      const { templateRender } = await import("./pretool-extras.js");
      const trTemplate = resolveVariables(tool.template ?? "", vars);
      const trData: Record<string, unknown> = {};
      // Merge vars + explicit data
      for (const [k, v] of Object.entries(vars)) trData[k] = v;
      if (tool.data) for (const [k, v] of Object.entries(tool.data)) trData[k] = v;
      result = templateRender(trTemplate, trData);
      break;
    }
    case "approval_request": {
      const { createApprovalRequest } = await import("./pretool-extras.js");
      const arTitle = resolveVariables(tool.title ?? "Approval Required", vars);
      const arDesc = resolveVariables(tool.description ?? "", vars);
      result = createApprovalRequest(
        executionId ?? "unknown",
        step?.id ?? "unknown",
        arTitle,
        arDesc,
        tool.expires_hours ?? 24,
      );
      break;
    }

    case "db_query": {
      // Database query — uses execFileSync to prevent shell injection
      const connStr = resolveVariables(tool.connection ?? "", vars);
      const sqlQuery = resolveVariables(tool.sql ?? "", vars);

      if (!connStr || !sqlQuery) throw new Error("db_query requires connection and sql");

      try {
        if (connStr.startsWith("postgres")) {
          result = execFileSync("psql", [connStr, "-t", "-A", "-c", sqlQuery], { timeout: timeoutMs, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
        } else if (connStr.startsWith("mysql")) {
          result = execFileSync("mysql", ["--batch", "--raw", "-e", sqlQuery, connStr], { timeout: timeoutMs, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
        } else if (connStr.endsWith(".db") || connStr.endsWith(".sqlite") || connStr.startsWith("sqlite:")) {
          const dbPath = connStr.replace("sqlite:", "");
          result = execFileSync("sqlite3", [dbPath, sqlQuery], { timeout: timeoutMs, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
        } else {
          throw new Error(`db_query: unsupported connection. Use postgres://, mysql://, or path.db`);
        }
      } catch (e) {
        throw new Error(`db_query failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    }

    case "email": {
      const to = resolveVariables(tool.to ?? "", vars);
      const subject = resolveVariables(tool.subject ?? "", vars);
      const emailBody = resolveVariables(tool.content ?? tool.body ?? "", vars);
      const provider = tool.provider ?? "smtp";

      if (!to || !subject) throw new Error("email requires to and subject");

      if (provider === "sendgrid") {
        const apiKey = process.env.SENDGRID_API_KEY ?? "";
        if (!apiKey) throw new Error("email (sendgrid): SENDGRID_API_KEY env var required");
        const from = tool.from ?? process.env.SENDGRID_FROM ?? "noreply@example.com";
        const payload = JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: from },
          subject,
          content: [{ type: "text/plain", value: emailBody }],
        });
        const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: payload,
        });
        result = resp.ok ? `Email sent to ${to} (${resp.status})` : `Email failed: ${resp.status} ${await resp.text()}`;
      } else {
        // SMTP via sendmail — use execFileSync to prevent injection
        try {
          const args = ["-s", subject, to];
          if (tool.smtp_host) args.push(`--smtp-server=${tool.smtp_host}`);
          execFileSync("mail", args, { input: emailBody, timeout: timeoutMs, encoding: "utf-8" });
          result = `Email sent to ${to}`;
        } catch (e) {
          throw new Error(`email (smtp) failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      break;
    }

    case "pdf_generate": {
      const htmlContent = resolveVariables(tool.html ?? tool.content ?? "", vars);
      const outputPath = resolveVariables(tool.output_path ?? tool.path ?? path.join(os.tmpdir(), "occ-output.pdf"), vars);

      if (!htmlContent) throw new Error("pdf_generate requires html content");

      const htmlTmpPath = outputPath.replace(/\.pdf$/, ".html");
      const dir = path.dirname(outputPath);
      if (dir) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(htmlTmpPath, htmlContent, "utf-8");

      try {
        // Use execFileSync to prevent shell injection
        execFileSync("wkhtmltopdf", ["--quiet", htmlTmpPath, outputPath], { timeout: timeoutMs });
        result = outputPath;
        onLog(`pdf_generate → ${outputPath}`, "info");
      } catch {
        try {
          execFileSync("google-chrome", ["--headless", "--disable-gpu", `--print-to-pdf=${outputPath}`, htmlTmpPath], { timeout: timeoutMs });
          result = outputPath;
        } catch {
          throw new Error("pdf_generate requires wkhtmltopdf or Chrome. Install: apt install wkhtmltopdf");
        }
      } finally {
        try { fs.unlinkSync(htmlTmpPath); } catch { /* cleanup */ }
      }
      break;
    }

    case "ocr": {
      const imagePath = resolveVariables(tool.image_path ?? tool.path ?? "", vars);
      const lang = tool.language ?? "eng";

      if (!imagePath) throw new Error("ocr requires image_path");
      if (!fs.existsSync(imagePath)) throw new Error(`ocr: file not found: ${imagePath}`);

      // Use execFileSync to prevent shell injection
      try {
        result = execFileSync("tesseract", [imagePath, "stdout", "-l", lang], {
          timeout: timeoutMs, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024,
        });
      } catch {
        throw new Error("ocr requires Tesseract. Install: apt install tesseract-ocr");
      }
      break;
    }
  }

  // Store in cache
  if (tool.cache_ttl_minutes && tool.cache_ttl_minutes > 0) {
    const cacheKey = getPreToolCacheKey(tool, vars);
    preToolCache.set(cacheKey, { result, expiresAt: Date.now() + tool.cache_ttl_minutes * 60000 });
  }

  return result;
}

/** Simple JSON path extractor: "data.items[0].name" → traverse object. */
function extractJsonPath(obj: any, path: string): any {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

// ─── Pre-tool orchestrator (chaining + parallel) ────────────────────────────

async function executePreTools(
  preTools: PreTool[],
  vars: Record<string, string>,
  onLog: (message: string, level: "info" | "warn" | "error") => void,
  execution?: ChainExecution,
  executionId?: string,
  step?: ChainStep,
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};

  // Merge vars so pre-tool B can use output of pre-tool A (chaining)
  const liveVars = { ...vars };

  // Split into sequential and parallel groups
  let i = 0;
  while (i < preTools.length) {
    // Collect consecutive parallel pre-tools
    const parallelBatch: PreTool[] = [];
    while (i < preTools.length && preTools[i].parallel) {
      parallelBatch.push(preTools[i]);
      i++;
    }

    if (parallelBatch.length > 0) {
      // Execute parallel batch
      const parallelResults = await Promise.all(
        parallelBatch.map((tool) => executePreToolWithRetry(tool, liveVars, onLog, execution, executionId, step))
      );
      for (let j = 0; j < parallelBatch.length; j++) {
        results[parallelBatch[j].inject_as] = parallelResults[j];
        liveVars[parallelBatch[j].inject_as] = parallelResults[j]; // Chain: available to next
      }
    }

    // Execute next sequential pre-tool (if any)
    if (i < preTools.length && !preTools[i].parallel) {
      const tool = preTools[i];
      const result = await executePreToolWithRetry(tool, liveVars, onLog, execution, executionId, step);
      results[tool.inject_as] = result;
      liveVars[tool.inject_as] = result; // Chain: available to next pre-tool
      i++;
    }
  }

  return results;
}

/** Execute a single pre-tool with retry logic and error handling. */
async function executePreToolWithRetry(
  tool: PreTool,
  vars: Record<string, string>,
  onLog: (message: string, level: "info" | "warn" | "error") => void,
  execution?: ChainExecution,
  executionId?: string,
  step?: ChainStep,
): Promise<string> {
  const maxAttempts = (tool.retry ?? 0) + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await executeSinglePreTool(tool, vars, onLog, execution, executionId, step);
      onLog(`pre-tool ${tool.type} → {${tool.inject_as}} (${result.length} chars${attempt > 1 ? `, attempt ${attempt}` : ""})`, "info");
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (attempt < maxAttempts) {
        onLog(`pre-tool ${tool.type} failed (attempt ${attempt}/${maxAttempts}): ${message}`, "warn");
        await new Promise((r) => setTimeout(r, 1000 * attempt)); // backoff
        continue;
      }

      // All retries exhausted
      const errorMode = tool.on_error ?? "inject";
      if (errorMode === "fail") {
        throw new Error(`Pre-tool ${tool.type} (${tool.inject_as}) failed after ${maxAttempts} attempt(s): ${message}`);
      } else if (errorMode === "skip") {
        onLog(`pre-tool ${tool.type} failed (skipped): ${message}`, "warn");
        return "";
      } else {
        onLog(`pre-tool ${tool.type} failed: ${message}`, "error");
        return `[PRE-TOOL ERROR: ${message}]`;
      }
    }
  }

  return ""; // unreachable
}

// ─── claude -p invocation ─────────────────────────────────────────────────────

interface ClaudeResult {
  stdout: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 30 * 60 * 1000; // 30 min default
const MAX_OUTPUT = 5_000_000; // 5MB max output size to prevent unbounded memory growth
const MAX_CONCURRENT_EXECUTIONS = Number(process.env.MAX_CONCURRENT_EXECUTIONS) || 5;

// ─── Claude binary validation (once at startup, not per step) ────────────────

let claudeBinValidated = false;
let claudeBinPath = "";

export function validateClaudeBinary(): void {
  const claudeBin = process.env.CLAUDE_CLI ?? process.env.CLAUDE_BIN ?? "claude";
  const whichCmd = process.platform === "win32" ? "where" : "which";
  try {
    execSync(`${whichCmd} "${claudeBin}"`, { encoding: "utf-8", timeout: 5000 });
    claudeBinPath = claudeBin;
    claudeBinValidated = true;
    process.stderr.write(`[occ] Claude binary verified: ${claudeBin}\n`);
  } catch {
    process.stderr.write(`[occ] WARNING: Claude binary "${claudeBin}" not found in PATH. Set CLAUDE_CLI env var.\n`);
    claudeBinPath = claudeBin; // still set so error is clear if used
  }
}

// ─── Concurrent execution tracking ──────────────────────────────────────────

let runningExecutionCount = 0;

export function getRunningExecutionCount(): number {
  return runningExecutionCount;
}

export function canStartExecution(): boolean {
  return runningExecutionCount < MAX_CONCURRENT_EXECUTIONS;
}

function runClaude(
  prompt: string,
  step: ChainStep,
  onChunk: (chunk: string) => void,
  executionId?: string,
  timeoutMs?: number
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let settled = false;

    const args: string[] = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
    ];

    if (step.model) {
      args.push("--model", step.model);
    }

    if (step.tools && step.tools.length > 0) {
      args.push("--allowedTools", ...step.tools);
    }

    // Always use stdin when tools are present (prompt after --allowedTools args is ambiguous)
    const USE_STDIN = prompt.length > 65536 || (step.tools && step.tools.length > 0);
    if (!USE_STDIN) args.push(prompt);

    const claudeBin = claudeBinPath || process.env.CLAUDE_BIN || "claude";
    if (!claudeBinValidated) {
      // Fallback: validate once if startup check was skipped
      const whichCmd = process.platform === "win32" ? "where" : "which";
      try {
        execSync(`${whichCmd} "${claudeBin}"`, { encoding: "utf-8", timeout: 5000 });
        claudeBinValidated = true;
        claudeBinPath = claudeBin;
      } catch {
        reject(new Error(`Claude binary "${claudeBin}" not found in PATH. Set CLAUDE_CLI env var to the full path.`));
        return;
      }
    }
    const cwd = step.cwd ?? process.env.WORKSPACE_DIR ?? process.cwd();

    const child = spawn(claudeBin, args, {
      cwd,
      env: {
        ...process.env,
        TERM: "dumb",
        NO_COLOR: "1",
      },
      stdio: [USE_STDIN ? "pipe" : "ignore", "pipe", "pipe"],
    });

    // Timeout: kill process if it runs too long
    const effectiveTimeout = timeoutMs ?? CLAUDE_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill("SIGTERM"); } catch (e) { process.stderr.write(`[occ] timeout kill SIGTERM failed: ${e}\n`); }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) { process.stderr.write(`[occ] timeout kill SIGKILL failed: ${e}\n`); } }, 3000);
        if (executionId) { activeProcesses.get(executionId)?.delete(child); }
        reject(new Error(`claude timed out after ${effectiveTimeout / 1000}s for step "${step.id}"`));
      }
    }, effectiveTimeout);

    // Heartbeat: detect silently dead processes (check every 30s)
    const heartbeat = setInterval(() => {
      if (settled) { clearInterval(heartbeat); return; }
      try {
        // kill(0) checks if process exists without actually killing it
        process.kill(child.pid!, 0);
      } catch {
        // Process is dead but 'close' event never fired
        clearInterval(heartbeat);
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          if (executionId) { activeProcesses.get(executionId)?.delete(child); }
          const durationMs = Date.now() - startTime;
          if (fullText.trim()) {
            resolve({ stdout: fullText.trim(), durationMs, inputTokens, outputTokens });
          } else {
            reject(new Error(`claude process died silently (pid ${child.pid}) for step "${step.id}" after ${(durationMs / 1000).toFixed(0)}s`));
          }
        }
      }
    }, 30000);

    // Register for cancellation (supports multiple parallel processes per execution)
    if (executionId) {
      if (!activeProcesses.has(executionId)) activeProcesses.set(executionId, new Set());
      activeProcesses.get(executionId)!.add(child);
    }

    if (USE_STDIN) {
      child.stdin!.write(prompt, "utf-8");
      child.stdin!.end();
    }

    let lineBuffer = "";
    let fullText = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stderr = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf-8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            const text: string = event.delta.text ?? "";
            if (text) {
              if (fullText.length < MAX_OUTPUT) { fullText += text; }
              onChunk(text);
            }
          } else if (event.type === "assistant" && event.message?.content) {
            // Tool-using steps emit "assistant" events with text blocks
            const content = event.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text" && block.text) {
                  const text = block.text as string;
                  if (fullText.length < MAX_OUTPUT) { fullText += text; }
                  onChunk(text);
                }
              }
            }
            if (event.message?.usage) {
              inputTokens = event.message.usage.input_tokens;
              outputTokens = (event.message.usage.output_tokens ?? 0) + (outputTokens ?? 0);
            }
          } else if (event.type === "result") {
            if (event.usage) {
              inputTokens = event.usage.input_tokens;
              outputTokens = event.usage.output_tokens;
            }
            // Use result as authoritative final text
            if (event.result) {
              const resultText = event.result as string;
              if (resultText.length > fullText.length) {
                const diff = resultText.slice(fullText.length);
                if (diff) onChunk(diff);
                fullText = resultText;
              }
            }
          } else if (event.type === "message_delta" && event.usage?.output_tokens) {
            outputTokens = event.usage.output_tokens;
          } else if (event.type === "message" && event.message?.content) {
            const content = event.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text" && block.text) {
                  const text = block.text as string;
                  if (fullText.length < MAX_OUTPUT) { fullText += text; }
                  onChunk(text);
                }
              }
            }
            if (event.message?.usage) {
              inputTokens = event.message.usage.input_tokens;
              outputTokens = event.message.usage.output_tokens;
            }
          }
        } catch {
          // Non-JSON line — treat as raw text (fallback for old CLI versions)
          if (line.trim() && fullText.length < MAX_OUTPUT) {
            fullText += line + "\n";
            onChunk(line + "\n");
          }
        }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (settled) return;
      settled = true;
      if (executionId) { activeProcesses.get(executionId)?.delete(child); }
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (settled) return;
      settled = true;
      if (executionId) { activeProcesses.get(executionId)?.delete(child); }

      // Handle remaining buffer
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer);
          if (event.type === "result") {
            if (event.usage) {
              inputTokens = event.usage.input_tokens;
              outputTokens = event.usage.output_tokens;
            }
            if (event.result) {
              const resultText = event.result as string;
              if (resultText.length > fullText.length) {
                fullText = resultText;
              }
            }
          }
        } catch { /* ignore */ }
      }

      const durationMs = Date.now() - startTime;
      if (code === 0 || (code !== null && fullText)) {
        resolve({ stdout: fullText.trim(), durationMs, inputTokens, outputTokens });
      } else {
        reject(
          new Error(
            `claude exited with code ${code}${stderr ? `\nstderr: ${stderr.slice(0, 500)}` : ""}`
          )
        );
      }
    });
  });
}

// ─── Condition evaluator ──────────────────────────────────────────────────────

// evaluateCondition and resolveVariables imported from ./utils.ts

// ─── Retry with exponential backoff + model fallback ─────────────────────────

async function runStepWithRetry(
  step: ChainStep,
  resolvedPrompt: string,
  onChunk: (chunk: string) => void,
  executionId: string,
  onLog: (message: string, level: "info" | "warn" | "error") => void
): Promise<ClaudeResult> {
  const maxAttempts = step.retry?.max ?? 1;
  const delayMs = step.retry?.delay_ms ?? 2000;
  const backoff = step.retry?.backoff ?? 2;
  const models = step.fallback_models ?? (step.model ? [step.model] : []);

  let lastError: Error | null = null;

  for (const model of models.length > 0 ? models : [undefined]) {
    const stepWithModel = model ? { ...step, model } : step;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1 || (model && model !== (step.model ?? models[0]))) {
          onLog(`Attempt ${attempt}${model ? ` with ${model}` : ''}`, "warn");
        }
        return await runClaude(resolvedPrompt, stepWithModel, onChunk, executionId, step.timeout_ms);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        onLog(`Attempt ${attempt}${model ? ` (${model})` : ''} failed: ${lastError.message}`, "error");

        if (attempt < maxAttempts) {
          const waitMs = delayMs * Math.pow(backoff, attempt - 1) * (0.5 + Math.random() * 0.5);
          onLog(`Retrying in ${Math.round(waitMs)}ms...`, "info");
          await new Promise(r => setTimeout(r, waitMs));
        }
      }
    }
  }

  throw lastError ?? new Error("All retry attempts exhausted");
}

// ─── Gate approval mechanism ─────────────────────────────────────────────────

const pendingApprovals = new Map<string, { resolve: (value: string) => void }>();

// Gate results for suspend/resume pattern (non-blocking gates)
const gateResults = new Map<string, string>(); // executionId:stepId → "approved"|"rejected"|"skipped"
const gateTimers = new Map<string, ReturnType<typeof setTimeout>>(); // executionId:stepId → timeout handle

/** Error thrown to suspend execution at a gate step (frees the worker). */
export class GateSuspendError extends Error {
  constructor(public readonly stepId: string, public readonly executionId: string) {
    super(`Execution suspended at gate "${stepId}"`);
    this.name = "GateSuspendError";
  }
}

export function getPendingApprovals(): Array<{ executionId: string; stepId: string; chainName: string; prompt: string; startedAt: string }> {
  const results: Array<{ executionId: string; stepId: string; chainName: string; prompt: string; startedAt: string }> = [];
  for (const key of pendingApprovals.keys()) {
    const [executionId, stepId] = key.split(":");
    const execution = executions.get(executionId);
    if (execution) {
      const step = execution.steps[stepId];
      results.push({
        executionId,
        stepId,
        chainName: execution.chainName,
        prompt: step?.output ?? "",
        startedAt: step?.startedAt ?? execution.startedAt,
      });
    }
  }
  return results;
}

export function approveGate(executionId: string, stepId: string, approved: boolean): boolean {
  const key = `${executionId}:${stepId}`;

  // Clear the timeout timer for this gate
  const timer = gateTimers.get(key);
  if (timer) { clearTimeout(timer); gateTimers.delete(key); }

  // New suspend/resume pattern: store result for when execution resumes
  gateResults.set(key, approved ? "approved" : "rejected");

  // Legacy Promise-based pattern (backwards compat)
  const pending = pendingApprovals.get(key);
  if (pending) {
    pending.resolve(approved ? "approved" : "rejected");
    pendingApprovals.delete(key);
  }

  return true;
}

function waitForApproval(
  executionId: string,
  stepId: string,
  timeoutHours: number,
  onTimeout: "skip" | "error" | "approve"
): Promise<string> {
  return new Promise((resolve) => {
    const key = `${executionId}:${stepId}`;
    pendingApprovals.set(key, { resolve });

    // Timeout
    setTimeout(() => {
      if (pendingApprovals.has(key)) {
        pendingApprovals.delete(key);
        if (onTimeout === "approve") resolve("approved");
        else if (onTimeout === "skip") resolve("skipped");
        else resolve("rejected");
      }
    }, timeoutHours * 60 * 60 * 1000);
  });
}

// ─── Context compression ─────────────────────────────────────────────────────

async function applyContextStrategy(
  vars: Record<string, string>,
  strategy: Record<string, string>,
  onLog: (message: string, level: "info" | "warn" | "error") => void
): Promise<Record<string, string>> {
  const result = { ...vars };

  for (const [varName, action] of Object.entries(strategy)) {
    const value = vars[varName];
    if (!value) continue;

    if (action === "full") {
      // No change
      continue;
    }

    if (action === "summarize") {
      // Use Haiku to summarize
      try {
        const summaryPrompt = `Summarize the following content concisely, preserving all key technical details, decisions, and important information:\n\n${value}`;
        const { stdout } = await runClaude(
          summaryPrompt,
          { id: "_summarize", output_var: "_", tools: [], model: "claude-haiku-4-5", prompt: "" } as ChainStep,
          () => {}
        );
        result[varName] = stdout;
        onLog(`Context compressed ${varName}: ${value.length} → ${stdout.length} chars (summarize)`, "info");
      } catch (err) {
        onLog(`Failed to summarize ${varName}: ${err instanceof Error ? err.message : String(err)}`, "warn");
        // Keep original on failure
      }
      continue;
    }

    // truncate:N
    const truncateMatch = action.match(/^truncate:(\d+)$/);
    if (truncateMatch) {
      const limit = parseInt(truncateMatch[1], 10);
      if (value.length > limit) {
        result[varName] = value.slice(0, limit) + "\n[truncated from " + value.length + " chars]";
        onLog(`Context compressed ${varName}: ${value.length} → ${limit} chars (truncate)`, "info");
      }
      continue;
    }
  }

  return result;
}

// ─── Chain executor ───────────────────────────────────────────────────────────

type EventEmitter = (event: ExecutionEvent) => void;

// ─── Shared step dispatch (used by both executeChain and resumeExecution) ────

async function executeStep(
  step: ChainStep,
  chain: ChainDefinition,
  vars: Record<string, string>,
  execution: ChainExecution,
  executionId: string,
  emit: EventEmitter
): Promise<void> {
  const stepId = step.id;
  const stepResult = execution.steps[stepId];

  const onLog = (message: string, level: "info" | "warn" | "error") => {
    emit({ type: "step_log", executionId, stepId, message, level });
  };

  // Early exit check
  if (step.early_exit_if) {
    const resolved = resolveVariables(step.early_exit_if, vars);
    if (evaluateCondition(resolved)) {
      onLog("Early exit triggered", "info");
      stepResult.status = "skipped";
      stepResult.finishedAt = new Date().toISOString();
      vars[step.output_var] = "";
      emit({ type: "step_done", executionId, stepId, durationMs: 0 });

      // Signal early exit by setting a special var
      vars["__early_exit"] = "true";
      persistExecutions();
      return;
    }
  }

  // Check condition
  if (step.condition) {
    const resolved = resolveVariables(step.condition, vars);
    if (!evaluateCondition(resolved)) {
      stepResult.status = "skipped";
      stepResult.finishedAt = new Date().toISOString();
      vars[step.output_var] = "";
      emit({ type: "step_log", executionId, stepId, message: `Condition not met: ${step.condition}`, level: "info" });
      emit({ type: "step_done", executionId, stepId, durationMs: 0 });
      persistExecutions();
      return;
    }
  }

  // Check step-level cache before any execution
  if (step.cache?.enabled) {
    const resolvedForCache = resolveVariables(step.prompt, vars);
    const cacheKey = createCacheKey(step.id, resolvedForCache, step.model);
    const cached = loadCache(chain.name, cacheKey, step.cache.ttl_minutes ?? 60);
    if (cached) {
      stepResult.status = "done";
      stepResult.output = cached.result;
      stepResult.finishedAt = new Date().toISOString();
      stepResult.durationMs = 0;
      stepResult.inputTokens = cached.inputTokens;
      stepResult.outputTokens = cached.outputTokens;
      vars[step.output_var] = cached.result;
      emit({ type: "step_cache_hit", executionId, stepId: step.id });
      emit({ type: "step_done", executionId, stepId: step.id, durationMs: 0 });
      persistExecutions();
      return;
    }
  }

  // Dispatch by step type
  const stepType = step.type ?? "agent";

  if (stepType === "router") {
    // Router: use Claude to classify, then mark non-selected branches as skipped
    const resolvedPrompt = resolveVariables(step.prompt, vars);
    const { stdout, durationMs, inputTokens, outputTokens } = await runStepWithRetry(
      { ...step, model: step.model ?? "claude-haiku-4-5" }, // cheap model for routing
      resolvedPrompt,
      (chunk) => { emit({ type: "step_output", executionId, stepId, chunk }); },
      executionId,
      (message, level) => { emit({ type: "step_log", executionId, stepId, message, level }); }
    );

    // Find matching route
    // Try exact match first, then check if output contains any route key
    let routeKey = stdout.trim().toLowerCase();
    const routes = step.routes ?? {};
    const routeKeys = Object.keys(routes);

    // Handle empty LLM output
    if (!routeKey) {
      emit({ type: "step_log", executionId, stepId, message: "Router returned empty output", level: "warn" });
      if (step.default_route && routes[step.default_route]) {
        routeKey = step.default_route;
        emit({ type: "step_log", executionId, stepId, message: `Using default route: ${routeKey}`, level: "info" });
      }
    }

    // If no exact match, search for a route key within the output
    if (!routes[routeKey]) {
      const found = routeKeys.find(k => routeKey.includes(k.toLowerCase()));
      if (found) {
        emit({ type: "step_log", executionId, stepId, message: `Router: no exact match for "${routeKey}", found key "${found}" in output`, level: "info" });
        routeKey = found;
      } else if (step.default_route && routes[step.default_route]) {
        emit({ type: "step_log", executionId, stepId, message: `Router: no match for "${routeKey}", falling back to default route "${step.default_route}"`, level: "warn" });
        routeKey = step.default_route;
      } else {
        emit({ type: "step_log", executionId, stepId, message: `Router: no match for "${routeKey}" and no default route`, level: "warn" });
      }
    }
    const selectedSteps = routes[routeKey] ?? [];

    // Mark all steps NOT in the selected route as skipped
    const allRouteSteps = new Set(Object.values(routes).flat());
    for (const routeStepId of allRouteSteps) {
      if (!selectedSteps.includes(routeStepId)) {
        const rs = execution.steps[routeStepId];
        if (rs && rs.status === "pending") {
          rs.status = "skipped";
          emit({ type: "step_log", executionId, stepId: routeStepId, message: `Skipped by router (route: ${routeKey})`, level: "info" });
        }
      }
    }

    stepResult.status = "done";
    stepResult.output = routeKey;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = durationMs;
    stepResult.inputTokens = inputTokens;
    stepResult.outputTokens = outputTokens;
    vars[step.output_var] = routeKey;

    // Save router result to cache if enabled
    if (step.cache?.enabled) {
      const cacheKey = createCacheKey(step.id, resolvedPrompt, step.model);
      saveCache(chain.name, {
        key: cacheKey,
        stepId: step.id,
        chainName: chain.name,
        result: routeKey,
        createdAt: new Date().toISOString(),
        ttlMinutes: step.cache.ttl_minutes ?? 60,
        inputTokens,
        outputTokens,
      });
    }

    emit({ type: "step_done", executionId, stepId, durationMs, inputTokens, outputTokens });
    emit({ type: "step_log", executionId, stepId, message: `Routed to: ${routeKey} → [${selectedSteps.join(", ")}]`, level: "info" });
    persistExecutions();
    return;
  }

  if (stepType === "transform") {
    // Transform: no LLM call, pure data transformation
    const transformInputVar = step.input_var ?? "";
    if (transformInputVar && !(transformInputVar in vars)) {
      emit({ type: "step_log", executionId, stepId, message: `Warning: input_var "${transformInputVar}" not found in variables`, level: "warn" });
    }
    const inputVal = vars[transformInputVar] ?? resolveVariables(step.prompt, vars);
    let result = "";

    switch (step.operation) {
      case "json_extract": {
        try {
          const parsed = JSON.parse(inputVal);
          // Simple dot-path extraction (e.g., "results.0.name")
          const path = step.json_path ?? "";
          const parts = path.replace(/^\$\.?/, "").split(".");
          let current: unknown = parsed;
          for (const part of parts) {
            if (current == null) break;
            if (part === "*" && Array.isArray(current)) {
              // Apply remaining path parts to each array element
              const remainingParts = parts.slice(parts.indexOf(part) + 1);
              if (remainingParts.length === 0) break;
              current = current.map(item => {
                let val: unknown = item;
                for (const rp of remainingParts) {
                  if (val == null) break;
                  val = (val as Record<string, unknown>)[rp];
                }
                return val;
              });
              break; // remaining parts already applied
            }
            current = (current as Record<string, unknown>)[part];
          }
          result = typeof current === "string" ? current : JSON.stringify(current, null, 2);
        } catch (e) {
          result = `[JSON parse error: ${e instanceof Error ? e.message : 'invalid JSON'}]`;
          emit({ type: "step_log", executionId, stepId, message: `json_extract failed: input is not valid JSON`, level: "warn" });
        }
        break;
      }
      case "regex_match": {
        const regex = new RegExp(step.regex ?? "", "g");
        const matches = inputVal.match(regex);
        result = matches ? matches.join("\n") : "";
        break;
      }
      case "template": {
        result = resolveVariables(step.template_str ?? "", vars);
        break;
      }
      case "split": {
        // Split into JSON array (by newlines)
        result = JSON.stringify(inputVal.split("\n").filter(Boolean));
        break;
      }
      case "merge": {
        // Merge multiple variables
        const mergeInputs = step.inputs ?? [];
        const parts = mergeInputs.map(v => vars[v] ?? "").filter(Boolean);
        result = parts.join("\n\n---\n\n");
        break;
      }
      case "truncate": {
        const limit = step.truncate_limit ?? 5000;
        result = inputVal.length > limit ? inputVal.slice(0, limit) + `\n[truncated from ${inputVal.length} chars]` : inputVal;
        break;
      }
      case "replace": {
        // Replace using regex or string
        const pattern = step.regex ?? "";
        const replacement = step.template_str ?? "";
        if (pattern) {
          result = inputVal.replace(new RegExp(pattern, "g"), replacement);
        } else {
          result = inputVal;
        }
        break;
      }
      case "filter": {
        // Filter lines matching regex
        const regex = new RegExp(step.regex ?? ".*");
        result = inputVal.split("\n").filter(line => regex.test(line)).join("\n");
        break;
      }
      case "map": {
        // Apply template to each line
        const template = step.template_str ?? "{item}";
        result = inputVal.split("\n").filter(Boolean).map((line, i) => {
          return template.replace(/\{item\}/g, line).replace(/\{index\}/g, String(i));
        }).join("\n");
        break;
      }
      case "join": {
        // Join array items with separator
        const separator = step.template_str ?? "\n";
        try {
          const arr = JSON.parse(inputVal);
          result = Array.isArray(arr) ? arr.join(separator) : inputVal;
        } catch {
          result = inputVal;
        }
        break;
      }
      case "to_json": {
        // Parse lines into JSON array
        result = JSON.stringify(inputVal.split("\n").filter(Boolean));
        break;
      }
      case "from_json": {
        // Convert JSON to readable text
        try {
          const parsed = JSON.parse(inputVal);
          if (Array.isArray(parsed)) {
            result = parsed.map(String).join("\n");
          } else if (typeof parsed === "object") {
            result = Object.entries(parsed).map(([k, v]) => `${k}: ${v}`).join("\n");
          } else {
            result = String(parsed);
          }
        } catch {
          result = inputVal;
        }
        break;
      }
      default:
        result = inputVal;
    }

    stepResult.status = "done";
    stepResult.output = result;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = 0;
    vars[step.output_var] = result;

    emit({ type: "step_output", executionId, stepId, chunk: result });
    emit({ type: "step_done", executionId, stepId, durationMs: 0 });
    emit({ type: "step_log", executionId, stepId, message: `Transform ${step.operation}: ${result.length} chars`, level: "info" });
    persistExecutions();
    return;
  }

  if (stepType === "evaluator") {
    // Evaluator: check input against criteria, optionally retry target step
    let passed = false;
    let evalOutput = "";
    let evalDuration = 0;
    let evalInputTokens = 0;
    let evalOutputTokens = 0;
    const maxRetries = step.max_retries ?? 2;
    const retryKey = `__retry_count_${step.retry_target ?? step.id}`;

    for (let evalAttempt = 0; evalAttempt <= maxRetries; evalAttempt++) {
      // Run evaluation
      const inputVal = vars[step.input_var ?? ""] ?? "";
      const criteriaPrompt = step.eval_scoring
        ? `Rate this output 1-10 based on the criteria. Reply with ONLY a number (1-10) on the first line, then a brief explanation.\n\nCriteria:\n${step.criteria ?? ""}\n\nOutput:\n${inputVal}`
        : `Evaluate this output against the following criteria. Reply ONLY with "PASS" or "FAIL" followed by a brief explanation.\n\nCriteria:\n${step.criteria ?? ""}\n\nOutput to evaluate:\n${inputVal}`;

      const evalResult = await runStepWithRetry(
        { ...step, model: step.model ?? "claude-haiku-4-5", tools: [] },
        criteriaPrompt,
        (chunk) => { emit({ type: "step_output", executionId, stepId, chunk }); },
        executionId,
        (message, level) => { emit({ type: "step_log", executionId, stepId, message, level }); }
      );

      evalOutput = evalResult.stdout;
      evalDuration += evalResult.durationMs;
      evalInputTokens += evalResult.inputTokens ?? 0;
      evalOutputTokens += evalResult.outputTokens ?? 0;

      if (step.eval_scoring) {
        const scoreMatch = evalOutput.match(/^(\d+)/);
        const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
        passed = score >= (step.eval_threshold ?? 7);
        onLog(`Evaluation score: ${score}/10 (threshold: ${step.eval_threshold ?? 7})`, passed ? "info" : "warn");
      } else {
        passed = evalOutput.trim().toUpperCase().startsWith("PASS");
      }

      if (passed || step.on_fail !== "retry" || !step.retry_target || evalAttempt >= maxRetries) {
        break;
      }

      // Re-run target step with feedback
      const targetStep = chain.steps.find(s => s.id === step.retry_target);
      if (!targetStep) break;

      const retryCount = parseInt(vars[retryKey] ?? "0", 10);
      vars[retryKey] = String(retryCount + 1);
      emit({ type: "step_log", executionId, stepId, message: `Evaluation FAILED (attempt ${evalAttempt + 1}/${maxRetries}). Re-running ${step.retry_target}...`, level: "warn" });

      // Re-run the target step
      const targetResult = execution.steps[step.retry_target!];
      targetResult.status = "running";
      targetResult.startedAt = new Date().toISOString();
      emit({ type: "step_started", executionId, stepId: step.retry_target!, label: targetStep.label ?? targetStep.id });

      const retryPrompt = resolveVariables(targetStep.prompt + `\n\n[Previous attempt failed evaluation: ${evalOutput}]\nPlease fix the issues and try again.`, vars);
      const retryResult = await runStepWithRetry(
        targetStep, retryPrompt,
        (chunk) => { emit({ type: "step_output", executionId, stepId: step.retry_target!, chunk }); },
        executionId,
        (message, level) => { emit({ type: "step_log", executionId, stepId: step.retry_target!, message, level }); }
      );

      targetResult.status = "done";
      targetResult.output = retryResult.stdout;
      targetResult.finishedAt = new Date().toISOString();
      targetResult.durationMs = retryResult.durationMs;
      vars[targetStep.output_var] = retryResult.stdout;
      emit({ type: "step_done", executionId, stepId: step.retry_target!, durationMs: retryResult.durationMs });

      emit({ type: "step_log", executionId, stepId, message: `Re-evaluating after retry ${evalAttempt + 1}...`, level: "info" });
    }

    stepResult.status = "done";
    stepResult.output = evalOutput;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = evalDuration;
    stepResult.inputTokens = evalInputTokens;
    stepResult.outputTokens = evalOutputTokens;
    vars[step.output_var] = passed ? "PASS" : "FAIL";

    // Output validation (guardrails) for evaluator
    const evalValidationErrors = validateOutput(evalOutput, step, (message, level) => {
      emit({ type: "step_log", executionId, stepId, message, level });
    });
    if (evalValidationErrors.length > 0) {
      for (const err of evalValidationErrors) {
        emit({ type: "step_log", executionId, stepId, message: `Guardrail warning: ${err}`, level: "warn" });
      }
    }

    // Save evaluator result to cache if enabled
    if (step.cache?.enabled) {
      const evalCacheKey = createCacheKey(step.id, vars[step.input_var ?? ""] ?? "", step.model);
      saveCache(chain.name, {
        key: evalCacheKey,
        stepId: step.id,
        chainName: chain.name,
        result: passed ? "PASS" : "FAIL",
        createdAt: new Date().toISOString(),
        ttlMinutes: step.cache.ttl_minutes ?? 60,
        inputTokens: evalInputTokens,
        outputTokens: evalOutputTokens,
      });
    }

    emit({ type: "step_done", executionId, stepId, durationMs: evalDuration, inputTokens: evalInputTokens, outputTokens: evalOutputTokens });
    persistExecutions();
    return;
  }

  if (stepType === "gate") {
    // Check auto-approve condition
    if (step.gate_auto_approve_if) {
      const resolvedCondition = resolveVariables(step.gate_auto_approve_if, vars);
      if (evaluateCondition(resolvedCondition)) {
        onLog("Auto-approved: condition met", "info");
        stepResult.status = "done";
        stepResult.output = "auto-approved";
        stepResult.finishedAt = new Date().toISOString();
        stepResult.durationMs = 0;
        vars[step.output_var] = "approved";
        emit({ type: "step_done", executionId, stepId, durationMs: 0 });
        persistExecutions();
        return;
      }
    }

    // Gate: suspend execution and free the worker (non-blocking)
    const resolvedPrompt = resolveVariables(step.prompt, vars);
    emit({ type: "step_waiting_approval", executionId, stepId, prompt: resolvedPrompt });
    emit({ type: "step_log", executionId, stepId, message: "Waiting for human approval — worker released", level: "info" });

    // Check if already approved (from a previous suspended run being resumed)
    const existingApproval = gateResults.get(`${executionId}:${stepId}`);
    if (existingApproval) {
      gateResults.delete(`${executionId}:${stepId}`);
      if (existingApproval === "approved") {
        stepResult.status = "done";
        stepResult.output = "approved";
        stepResult.finishedAt = new Date().toISOString();
        vars[step.output_var] = "approved";
        emit({ type: "step_done", executionId, stepId, durationMs: 0 });
      } else if (existingApproval === "skipped") {
        stepResult.status = "skipped";
        stepResult.finishedAt = new Date().toISOString();
        vars[step.output_var] = "";
        emit({ type: "step_done", executionId, stepId, durationMs: 0 });
      } else {
        throw new Error("Gate rejected by user");
      }
      persistExecutions();
      return;
    }

    // Suspend: save state, mark as pending, free the worker
    stepResult.status = "running";
    stepResult.startedAt = new Date().toISOString();
    const execution = executions.get(executionId);
    if (execution) {
      execution.status = "pending";
      execution.error = `Suspended at gate "${stepId}" — waiting for approval`;
    }
    persistStepCheckpoint(executionId, stepResult);
    persistExecutions();

    // Register for timeout (track timer so it can be cancelled on gate resolution)
    const timeoutMs = (step.timeout_hours ?? 24) * 60 * 60 * 1000;
    const onTimeout = step.on_timeout ?? "error";
    const gateKey = `${executionId}:${stepId}`;
    const gateTimer = setTimeout(() => {
      gateTimers.delete(gateKey);
      if (!gateResults.has(gateKey)) {
        // Auto-resolve on timeout
        if (onTimeout === "approve") {
          gateResults.set(gateKey, "approved");
        } else if (onTimeout === "skip") {
          gateResults.set(gateKey, "skipped");
        } else {
          gateResults.set(gateKey, "rejected");
        }
      }
    }, timeoutMs);
    gateTimers.set(gateKey, gateTimer);

    // Throw to unwind the execution — worker is freed
    throw new GateSuspendError(stepId, executionId);
  }

  if (stepType === "merge") {
    // Merge: combine multiple inputs
    const mergeStartTime = Date.now();
    const mergeInputs = step.inputs ?? [];
    const strategy = step.strategy ?? "concatenate";
    let result = "";

    if (strategy === "concatenate") {
      result = mergeInputs.map(v => vars[v] ?? "").filter(Boolean).join("\n\n---\n\n");
    } else if (strategy === "json_array") {
      result = JSON.stringify(mergeInputs.map(v => vars[v] ?? ""));
    } else if (strategy === "llm_summarize") {
      const content = mergeInputs.map(v => `## ${v}\n${vars[v] ?? ""}`).join("\n\n");
      const summaryPrompt = `Synthesize and summarize the following sections into a coherent document:\n\n${content}`;
      const { stdout, durationMs: d, inputTokens: it, outputTokens: ot } = await runStepWithRetry(
        { ...step, model: step.model ?? "claude-haiku-4-5" },
        summaryPrompt,
        (chunk) => { emit({ type: "step_output", executionId, stepId, chunk }); },
        executionId,
        (message, level) => { emit({ type: "step_log", executionId, stepId, message, level }); }
      );
      result = stdout;
      stepResult.durationMs = d;
      stepResult.inputTokens = it;
      stepResult.outputTokens = ot;
    } else if (strategy === "pick_best") {
      const content = mergeInputs.map(v => `## Option: ${v}\n${vars[v] ?? ""}`).join("\n\n");
      const pickPrompt = `You are given multiple outputs. Pick the BEST one based on quality, completeness, and accuracy. Return ONLY the content of the best option, with no additional commentary.\n\n${content}`;
      const { stdout, durationMs: d, inputTokens: it, outputTokens: ot } = await runStepWithRetry(
        { ...step, model: step.model ?? "claude-haiku-4-5" },
        pickPrompt,
        (chunk) => { emit({ type: "step_output", executionId, stepId, chunk }); },
        executionId,
        (message, level) => { emit({ type: "step_log", executionId, stepId, message, level }); }
      );
      result = stdout;
      stepResult.durationMs = d;
      stepResult.inputTokens = it;
      stepResult.outputTokens = ot;
    }

    const mergeDuration = Date.now() - mergeStartTime;

    stepResult.status = "done";
    stepResult.output = result;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = stepResult.durationMs ?? mergeDuration; // keep LLM duration if set
    vars[step.output_var] = result;

    // Output validation (guardrails) for merge (especially llm_summarize)
    if (strategy === "llm_summarize") {
      const mergeValidationErrors = validateOutput(result, step, (message, level) => {
        emit({ type: "step_log", executionId, stepId, message, level });
      });
      if (mergeValidationErrors.length > 0) {
        for (const err of mergeValidationErrors) {
          emit({ type: "step_log", executionId, stepId, message: `Guardrail warning: ${err}`, level: "warn" });
        }
      }
    }

    emit({ type: "step_output", executionId, stepId, chunk: result });
    emit({ type: "step_done", executionId, stepId, durationMs: stepResult.durationMs, inputTokens: stepResult.inputTokens, outputTokens: stepResult.outputTokens });
    persistExecutions();
    return;
  }

  if (stepType === "browser") {
    // Browser v2: Playwright-powered, fully parameterizable
    const browserUrl = step.browser_url ? resolveVariables(step.browser_url, vars) : "";
    const browserTask = step.browser_task ? resolveVariables(step.browser_task, vars) : resolveVariables(step.prompt, vars);
    const maxSteps = step.browser_max_steps ?? 20;
    const browserToolsPath = process.env.BROWSER_TOOLS_PATH ?? new URL("../browser-tools.cjs", import.meta.url).pathname;

    // Build CLI options from step config
    const pageName = step.browser_page_name ?? step.id;
    const cliOpts: string[] = [`--page=${pageName}`];
    if (step.browser_port) cliOpts.push(`--port=${step.browser_port}`);
    if (step.browser_headless) cliOpts.push("--headless");
    if (step.browser_wait_ms) cliOpts.push(`--timeout=${step.browser_wait_ms}`);

    const bt = `node "${browserToolsPath}" ${cliOpts.join(" ")}`;

    // Build output format instruction
    const outputInstructions: string[] = [];
    const fmt = step.browser_output_format ?? "text";
    if (fmt === "json") outputInstructions.push("Return your findings as a JSON object with structured data.");
    else if (fmt === "markdown") outputInstructions.push("Return your findings formatted as clean Markdown.");
    else if (fmt === "screenshot") outputInstructions.push("Take a final screenshot and return only the file path.");

    // Build scroll instruction
    const scrollInstructions: string[] = [];
    const scroll = step.browser_scroll_strategy ?? "auto";
    if (scroll === "full") scrollInstructions.push("Before doing anything, scroll through the entire page to load all content: `scroll bottom` then `scroll top`.");
    else if (scroll === "none") scrollInstructions.push("Do NOT scroll the page.");

    // Build cookies instruction
    const cookieInstructions: string[] = [];
    if (step.browser_cookies_domain) {
      cookieInstructions.push(`If you need authentication cookies, run: \`${bt} cookies ${step.browser_cookies_domain}\``);
    }

    const browserPrompt = [
      `You have a Playwright-powered browser. Use these commands via Bash:`,
      "",
      "## Navigation & Reading",
      `  ${bt} goto <url>         — Navigate to URL`,
      `  ${bt} snapshot           — ⭐ AI-optimized page snapshot (accessibility tree — PREFER THIS)`,
      `  ${bt} screenshot [path]  — Take PNG screenshot`,
      `  ${bt} read               — Extract all page text`,
      `  ${bt} title              — Get page title + URL`,
      `  ${bt} cookies [domain]   — Get cookies`,
      "",
      "## Interaction",
      `  ${bt} click <selector>   — Click element (CSS selector)`,
      `  ${bt} click <x>,<y>      — Click coordinates`,
      `  ${bt} fill <selector> <text>  — Fill input field`,
      `  ${bt} type <text>        — Type on keyboard`,
      `  ${bt} press <key>        — Press key (Enter, Tab, Escape...)`,
      `  ${bt} hover <selector>   — Hover element`,
      `  ${bt} select <sel> <val> — Select dropdown`,
      `  ${bt} check <selector>   — Toggle checkbox`,
      `  ${bt} scroll <dir> [px]  — Scroll (up/down/top/bottom)`,
      "",
      "## Advanced",
      `  ${bt} eval <js>          — Execute JavaScript in page`,
      `  ${bt} script <file.js>   — Run a Playwright script file`,
      `  ${bt} tabs               — List open tabs`,
      `  ${bt} pdf [path]         — Save page as PDF`,
      `  ${bt} read-html [sel]    — Get HTML of element`,
      "",
      "## Workflow",
      "1. Use `snapshot` first to understand the page (returns CSS selectors)",
      "2. Act using selectors from the snapshot (click, fill, select...)",
      "3. Use `snapshot` again to verify the result",
      "4. Only use `screenshot` + Read when you need visual layout",
      "",
      `Page "${pageName}" is PERSISTENT — keeps state between commands.`,
      `Maximum ${maxSteps} actions. Be efficient.`,
      ...scrollInstructions,
      ...cookieInstructions,
      ...outputInstructions,
      "",
      browserUrl ? `First, navigate to: ${browserUrl}` : "",
      "",
      `Task: ${browserTask}`,
    ].filter(Boolean).join("\n");

    const browserStep: ChainStep = {
      ...step,
      tools: [`Bash(node "${browserToolsPath}"*)`, "Read"],
      prompt: browserPrompt,
    };

    const { stdout, durationMs, inputTokens, outputTokens } = await runStepWithRetry(
      browserStep,
      browserPrompt,
      (chunk) => { emit({ type: "step_output", executionId, stepId, chunk }); },
      executionId,
      (message, level) => { emit({ type: "step_log", executionId, stepId, message, level }); }
    );

    stepResult.status = "done";
    stepResult.output = stdout;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = durationMs;
    stepResult.inputTokens = inputTokens;
    stepResult.outputTokens = outputTokens;
    vars[step.output_var] = stdout;

    // Output validation (guardrails) for browser
    const browserValidationErrors = validateOutput(stdout, step, (message, level) => {
      emit({ type: "step_log", executionId, stepId, message, level });
    });
    if (browserValidationErrors.length > 0) {
      for (const err of browserValidationErrors) {
        emit({ type: "step_log", executionId, stepId, message: `Guardrail warning: ${err}`, level: "warn" });
      }
    }

    // Save browser result to cache if enabled
    if (step.cache?.enabled) {
      const browserCacheKey = createCacheKey(step.id, browserPrompt, step.model);
      saveCache(chain.name, {
        key: browserCacheKey,
        stepId: step.id,
        chainName: chain.name,
        result: stdout,
        createdAt: new Date().toISOString(),
        ttlMinutes: step.cache.ttl_minutes ?? 60,
        inputTokens,
        outputTokens,
      });
    }

    emit({ type: "step_done", executionId, stepId, durationMs, inputTokens, outputTokens });
    persistExecutions();
    return;
  }

  if (stepType === "loop") {
    // Loop: iterate over items, run step_template for each
    const itemsRaw = vars[step.items_var ?? ""] ?? "[]";
    let items: string[];
    try {
      const parsed = JSON.parse(itemsRaw);
      if (Array.isArray(parsed)) {
        items = parsed.map(String);
      } else if (typeof parsed === 'object' && parsed !== null) {
        items = Object.values(parsed).map(String);
      } else {
        items = [String(parsed)];
      }
    } catch {
      items = itemsRaw.split("\n").filter(Boolean);
    }

    if (items.length === 0) {
      emit({ type: "step_log", executionId, stepId, message: "Loop: no items to iterate", level: "warn" });
      stepResult.status = "done";
      stepResult.output = "[]";
      stepResult.finishedAt = new Date().toISOString();
      stepResult.durationMs = 0;
      vars[step.output_var] = "[]";
      emit({ type: "step_done", executionId, stepId, durationMs: 0 });
      persistExecutions();
      return;
    }

    const maxParallel = step.max_parallel ?? items.length;
    const template = step.step_template;
    const results: string[] = [];
    let totalDuration = 0;
    let totalInput = 0;
    let totalOutput = 0;

    emit({ type: "step_log", executionId, stepId, message: `Loop: ${items.length} items, max parallel ${maxParallel}`, level: "info" });

    // Process in batches of maxParallel
    for (let i = 0; i < items.length; i += maxParallel) {
      const batch = items.slice(i, i + maxParallel);
      const batchResults = await Promise.all(
        batch.map(async (item, batchIdx) => {
          const itemIdx = i + batchIdx;
          try {
            const iterVars = { ...vars, item, item_index: String(itemIdx), loop_total: String(items.length) };
            const iterPrompt = resolveVariables(template?.prompt ?? step.prompt, iterVars);

            emit({ type: "step_log", executionId, stepId, message: `Loop item ${itemIdx + 1}/${items.length}: ${item.slice(0, 50)}...`, level: "info" });

            const iterStep: ChainStep = {
              id: `${step.id}_iter_${itemIdx}`,
              output_var: `${step.output_var}_iter_${itemIdx}`,
              model: template?.model ?? step.model,
              prompt: iterPrompt,
              tools: template?.tools ?? step.tools ?? [],
              pre_tools: template?.pre_tools,
              retry: template?.retry ?? step.retry,
            };

            // Execute pre-tools for this iteration
            if (iterStep.pre_tools && iterStep.pre_tools.length > 0) {
              const preResults = await executePreTools(iterStep.pre_tools, iterVars, (message, level) => {
                emit({ type: "step_log", executionId, stepId, message: `[iter ${itemIdx}] ${message}`, level });
              }, execution, executionId, step);
              Object.assign(iterVars, preResults);
            }

            const finalPrompt = resolveVariables(iterStep.prompt, iterVars);
            const { stdout, durationMs: d, inputTokens: it, outputTokens: ot } = await runStepWithRetry(
              iterStep, finalPrompt,
              (chunk) => { emit({ type: "step_output", executionId, stepId, chunk: `[${itemIdx + 1}] ${chunk}` }); },
              executionId,
              (message, level) => { emit({ type: "step_log", executionId, stepId, message: `[iter ${itemIdx}] ${message}`, level }); }
            );

            totalDuration += d;
            totalInput += it ?? 0;
            totalOutput += ot ?? 0;
            return stdout;
          } catch (err) {
            if (step.loop_on_error === "continue") {
              const errMsg = err instanceof Error ? err.message : String(err);
              onLog(`Loop item ${itemIdx} failed (continuing): ${errMsg}`, "warn");
              return `[ERROR: ${errMsg}]`;
            }
            throw err; // default: abort
          }
        })
      );
      results.push(...batchResults);

      // Check loop break condition
      if (step.loop_until) {
        const resolvedUntil = resolveVariables(step.loop_until, { ...vars, loop_result: JSON.stringify(results) });
        if (evaluateCondition(resolvedUntil)) {
          onLog(`Loop break condition met after ${results.length} items`, "info");
          break;
        }
      }
    }

    const loopResult = JSON.stringify(results);
    stepResult.status = "done";
    stepResult.output = loopResult;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = totalDuration;
    stepResult.inputTokens = totalInput;
    stepResult.outputTokens = totalOutput;
    vars[step.output_var] = loopResult;

    emit({ type: "step_log", executionId, stepId, message: `Loop complete: ${results.length} results`, level: "info" });
    emit({ type: "step_done", executionId, stepId, durationMs: totalDuration, inputTokens: totalInput, outputTokens: totalOutput });
    persistExecutions();
    return;
  }

  // ── Subchain: execute another chain as a node ────────────────────────────
  if (stepType === "subchain") {
    const subchainName = step.subchain;
    if (!subchainName) throw new Error(`Step "${step.id}" missing "subchain" field`);

    const { loadChain } = await import("./loader.js");
    const subchain = loadChain(subchainName);

    // Map vars to subchain inputs
    const subInput: Record<string, string> = {};
    if (step.subchain_input_map) {
      for (const [subKey, varExpr] of Object.entries(step.subchain_input_map)) {
        subInput[subKey] = resolveVariables(varExpr, vars);
      }
    } else {
      // Pass all current vars by default
      Object.assign(subInput, vars);
    }

    onLog(`Subchain "${subchainName}" starting with ${Object.keys(subInput).length} inputs`, "info");
    const subStart = Date.now();

    const subResult = await executeChain(subchain, subInput, (ev) => {
      if (ev.type === "step_output") {
        emit({ type: "step_output", executionId, stepId, chunk: (ev as { chunk: string }).chunk });
      } else if (ev.type === "step_started") {
        onLog(`[sub:${subchainName}] Started: ${(ev as { label?: string; stepId: string }).label ?? (ev as { stepId: string }).stepId}`, "info");
      } else if (ev.type === "step_done") {
        onLog(`[sub:${subchainName}] Done: ${(ev as { stepId: string }).stepId} (${((ev as { durationMs: number }).durationMs / 1000).toFixed(1)}s)`, "info");
      } else if (ev.type === "step_error") {
        onLog(`[sub:${subchainName}] Error: ${(ev as { error: string }).error}`, "error");
      }
    });

    const subDuration = Date.now() - subStart;
    stepResult.status = "done";
    stepResult.output = subResult;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = subDuration;
    vars[step.output_var] = subResult;

    emit({ type: "step_done", executionId, stepId, durationMs: subDuration });
    onLog(`Subchain "${subchainName}" complete (${(subDuration / 1000).toFixed(1)}s, ${subResult.length} chars)`, "info");
    persistExecutions();
    return;
  }

  // ── Debate: multi-agent deliberation ───────────────────────────────────
  if (stepType === "debate") {
    const agents = step.debate_agents ?? [];
    if (agents.length === 0) throw new Error(`Debate step "${step.id}" has no agents defined`);

    const rounds = step.debate_rounds ?? 1;
    const decision = step.debate_decision ?? "voting";
    let totDur = 0, totIn = 0, totOut = 0;
    let agentOutputs: string[] = [];

    onLog(`Debate: ${agents.length} agents, ${rounds} round(s), decision: ${decision}`, "info");

    for (let rd = 0; rd < rounds; rd++) {
      onLog(`── Round ${rd + 1}/${rounds} ──`, "info");

      const roundResults = await Promise.all(
        agents.map(async (ag, idx) => {
          let agentPrompt = resolveVariables(ag.prompt, vars);

          // Inject other agents' perspectives after round 1
          if (rd > 0 && agentOutputs.length > 0) {
            const others = agentOutputs
              .filter((_, j) => j !== idx)
              .map((o, j) => `### Agent ${j + 1}\n${o}`)
              .join("\n\n");
            agentPrompt += `\n\n---\nOther agents' perspectives from the previous round:\n${others}\n\nConsidering these perspectives, refine your analysis:`;
          }

          const agentStep: ChainStep = {
            id: `${step.id}_agent${idx}_r${rd}`,
            output_var: `_debate_${idx}`,
            model: ag.model ?? step.model ?? "claude-sonnet-4-6",
            prompt: agentPrompt,
            tools: [],
            retry: step.retry,
          };

          const r = await runStepWithRetry(
            agentStep, agentPrompt,
            (chunk) => { emit({ type: "step_output", executionId, stepId, chunk: `[Agent${idx + 1}] ${chunk}` }); },
            executionId,
            (msg, lvl) => { onLog(`[Agent${idx + 1}] ${msg}`, lvl); }
          );

          totDur += r.durationMs;
          totIn += r.inputTokens ?? 0;
          totOut += r.outputTokens ?? 0;
          return r.stdout;
        })
      );
      agentOutputs = roundResults;
    }

    // Decision phase
    let finalResult: string;
    if (decision === "last_round") {
      finalResult = agentOutputs.map((o, i) => `## Agent ${i + 1}\n${o}`).join("\n\n");
    } else {
      const label = decision === "voting" ? "majority position" : "consensus";
      const synthPrompt = `Multiple experts have analyzed this topic${rounds > 1 ? ` over ${rounds} rounds of debate` : ""}. Synthesize their final positions into a single coherent answer reflecting the ${label}.\n\n${agentOutputs.map((o, i) => `## Expert ${i + 1}\n${o}`).join("\n\n")}\n\nFinal synthesized answer:`;

      const synthStep: ChainStep = {
        id: `${step.id}_synthesis`,
        output_var: "_synthesis",
        model: step.model ?? "claude-sonnet-4-6",
        prompt: synthPrompt,
        tools: [],
      };

      const sr = await runStepWithRetry(
        synthStep, synthPrompt,
        (chunk) => { emit({ type: "step_output", executionId, stepId, chunk }); },
        executionId,
        (msg, lvl) => { onLog(`[Synthesis] ${msg}`, lvl); }
      );

      totDur += sr.durationMs;
      totIn += sr.inputTokens ?? 0;
      totOut += sr.outputTokens ?? 0;
      finalResult = sr.stdout;
    }

    stepResult.status = "done";
    stepResult.output = finalResult;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = totDur;
    stepResult.inputTokens = totIn;
    stepResult.outputTokens = totOut;
    vars[step.output_var] = finalResult;

    // Validate output
    const debateValidationErrors = validateOutput(finalResult, step, onLog);
    if (debateValidationErrors.length > 0) {
      for (const err of debateValidationErrors) {
        onLog(`Guardrail warning: ${err}`, "warn");
      }
    }

    // Cache if enabled
    if (step.cache?.enabled) {
      const cacheKey = createCacheKey(step.id, agents.map(a => a.prompt).join("|"), step.model);
      saveCache(chain.name, {
        key: cacheKey, stepId: step.id, chainName: chain.name,
        result: finalResult, createdAt: new Date().toISOString(),
        ttlMinutes: step.cache.ttl_minutes ?? 60,
        inputTokens: totIn, outputTokens: totOut,
      });
    }

    emit({ type: "step_done", executionId, stepId, durationMs: totDur, inputTokens: totIn, outputTokens: totOut });
    onLog(`Debate complete: ${agents.length} agents, ${rounds} rounds, ${finalResult.length} chars`, "info");
    persistExecutions();
    return;
  }

  // Webhook: HTTP callback with payload, headers, retry
  if (stepType === "webhook") {
    const webhookStart = Date.now();

    if (!step.webhook_url) {
      throw new Error(`Webhook step "${step.id}" missing webhook_url`);
    }

    const url = resolveVariables(step.webhook_url, vars);
    const method = step.webhook_method ?? "POST";
    const timeoutMs = step.webhook_timeout_ms ?? 30000;
    const maxRetries = step.webhook_retry ?? 0;
    const successStatuses = step.webhook_success_status ?? [];

    // Resolve headers
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (step.webhook_headers) {
      for (const [k, v] of Object.entries(step.webhook_headers)) {
        headers[k] = resolveVariables(v, vars);
      }
    }

    // Build body
    let body: string | undefined;
    if (method !== "GET" && method !== "DELETE") {
      if (step.webhook_body) {
        body = resolveVariables(step.webhook_body, vars);
      } else {
        // Default: send execution context as JSON
        body = JSON.stringify({
          executionId,
          stepId: step.id,
          chainName: execution.chainName,
          vars: Object.fromEntries(
            Object.entries(vars).filter(([k]) => !k.startsWith("__"))
          ),
        });
      }
    }

    let lastError = "";
    let responseBody = "";
    let responseStatus = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        onLog(`Webhook retry ${attempt}/${maxRetries}`, "warn");
        await new Promise((r) => setTimeout(r, 1000 * attempt)); // backoff
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(url, {
          method,
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timer);
        responseStatus = response.status;
        responseBody = await response.text();

        // Check success
        const isSuccess = successStatuses.length > 0
          ? successStatuses.includes(responseStatus)
          : responseStatus >= 200 && responseStatus < 300;

        if (isSuccess) {
          break; // Success — stop retrying
        }

        lastError = `HTTP ${responseStatus}: ${responseBody.slice(0, 200)}`;
        onLog(`Webhook returned ${responseStatus}`, "warn");
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        onLog(`Webhook failed: ${lastError}`, "error");
      }
    }

    const webhookDuration = Date.now() - webhookStart;

    // If all retries exhausted and still failing, throw
    const finalSuccess = successStatuses.length > 0
      ? successStatuses.includes(responseStatus)
      : responseStatus >= 200 && responseStatus < 300;

    if (!finalSuccess && lastError) {
      throw new Error(`Webhook failed after ${maxRetries + 1} attempt(s): ${lastError}`);
    }

    // Store result
    stepResult.status = "done";
    stepResult.output = responseBody;
    stepResult.finishedAt = new Date().toISOString();
    stepResult.durationMs = webhookDuration;
    vars[step.output_var] = responseBody;

    emit({ type: "step_done", executionId, stepId, durationMs: webhookDuration });
    onLog(`Webhook ${method} ${url} → ${responseStatus} (${responseBody.length} chars, ${webhookDuration}ms)`, "info");
    persistStepCheckpoint(executionId, stepResult);
    persistExecutions();
    return;
  }

  // Default: "agent" type

  // Execute pre-tools
  if (step.pre_tools && step.pre_tools.length > 0) {
    const preResults = await executePreTools(
      step.pre_tools,
      vars,
      (message, level) => {
        emit({ type: "step_log", executionId, stepId, message, level });
      },
      execution,
      executionId,
      step,
    );
    Object.assign(vars, preResults);
  }

  // Apply context compression if specified
  let resolveVars = vars;
  if (step.context_strategy) {
    resolveVars = await applyContextStrategy(
      vars,
      step.context_strategy as Record<string, string>,
      (message, level) => { emit({ type: "step_log", executionId, stepId, message, level }); }
    );
  }

  const resolvedPrompt = resolveVariables(step.prompt, resolveVars);
  const { stdout, durationMs, inputTokens, outputTokens } = await runStepWithRetry(
    step,
    resolvedPrompt,
    (chunk) => {
      emit({ type: "step_output", executionId, stepId, chunk });
    },
    executionId,
    (message, level) => {
      emit({ type: "step_log", executionId, stepId, message, level });
    }
  );

  stepResult.status = "done";
  stepResult.output = stdout;
  stepResult.finishedAt = new Date().toISOString();
  stepResult.durationMs = durationMs;
  stepResult.inputTokens = inputTokens;
  stepResult.outputTokens = outputTokens;

  vars[step.output_var] = stdout;

  // Output validation (guardrails)
  const validationErrors = validateOutput(stdout, step, (message, level) => {
    emit({ type: "step_log", executionId, stepId, message, level });
  });
  if (validationErrors.length > 0) {
    for (const err of validationErrors) {
      emit({ type: "step_log", executionId, stepId, message: `Guardrail warning: ${err}`, level: "warn" });
    }
  }

  // Save to cache if enabled
  if (step.cache?.enabled) {
    const cacheKey = createCacheKey(step.id, resolvedPrompt, step.model);
    saveCache(chain.name, {
      key: cacheKey,
      stepId: step.id,
      chainName: chain.name,
      result: stdout,
      createdAt: new Date().toISOString(),
      ttlMinutes: step.cache.ttl_minutes ?? 60,
      inputTokens,
      outputTokens,
    });
  }

  emit({ type: "step_done", executionId, stepId, durationMs, inputTokens, outputTokens });
  persistStepCheckpoint(executionId, stepResult);
  persistExecutions();
}

export async function executeChain(
  chain: ChainDefinition,
  input: Record<string, string>,
  emit: EventEmitter
): Promise<string> {
  const executionId = crypto.randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();

  // Validate required inputs
  for (const inputDef of chain.inputs ?? []) {
    if (!inputDef.optional && input[inputDef.name] === undefined) {
      throw new Error(`Missing required input: "${inputDef.name}"`);
    }
  }

  const execution: ChainExecution = {
    id: executionId,
    chainName: chain.name,
    status: "running",
    input,
    steps: {},
    startedAt,
  };
  executions.set(executionId, execution);
  trimExecutions();

  // Save chain snapshot for safe resume (chain YAML can change after this point)
  try {
    const yaml = await import("js-yaml");
    const snapshot = yaml.dump(chain);
    saveExecution(execution, snapshot);
  } catch {
    persistExecutions();
  }

  for (const step of chain.steps) {
    execution.steps[step.id] = {
      stepId: step.id,
      status: "pending",
    };
  }

  emit({ type: "execution_started", executionId, chainName: chain.name });

  runningExecutionCount++;

  const graph = buildDependencyGraph(chain);

  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    vars[`input.${k}`] = v;
    vars[k] = v;
  }

  try {
    for (const wave of graph.waves) {
      await Promise.all(
        wave.map(async (stepId) => {
          const step = chain.steps.find((s) => s.id === stepId)!;
          const stepResult = execution.steps[stepId];
          stepResult.status = "running";
          stepResult.startedAt = new Date().toISOString();

          emit({
            type: "step_started",
            executionId,
            stepId,
            label: step.label ?? step.id,
          });

          try {
            await executeStep(step, chain, vars, execution, executionId, emit);
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            stepResult.status = "error";
            stepResult.error = error;
            stepResult.finishedAt = new Date().toISOString();

            emit({ type: "step_error", executionId, stepId, error });
            persistStepCheckpoint(executionId, stepResult);
            persistExecutions();
            throw err;
          }
        })
      );

      if (vars["__early_exit"] === "true") {
        emit({ type: "step_log", executionId, stepId: "chain", message: "Early exit — skipping remaining waves", level: "info" });
        break;
      }
    }

    const result = vars[chain.output] ?? "";
    execution.status = "done";
    execution.result = result;
    execution.finishedAt = new Date().toISOString();
    execution.durationMs = Date.now() - new Date(startedAt).getTime();

    emit({
      type: "execution_done",
      executionId,
      result,
      durationMs: execution.durationMs,
    });
    persistExecutions();

    return result;
  } catch (err) {
    // Gate suspension — not a real error, execution is paused
    if (err instanceof GateSuspendError) {
      execution.status = "pending";
      execution.error = `Suspended at gate "${err.stepId}" — POST /executions/${executionId}/approve/${err.stepId} to continue`;
      emit({ type: "step_log", executionId, stepId: err.stepId, message: "Execution suspended — worker released", level: "info" });
      persistExecutions();
      return `suspended:${err.stepId}`;
    }

    const error = err instanceof Error ? err.message : String(err);
    execution.status = "error";
    execution.error = error;
    execution.finishedAt = new Date().toISOString();
    execution.durationMs = Date.now() - new Date(startedAt).getTime();

    for (const stepResult of Object.values(execution.steps)) {
      if (stepResult.status === "pending") {
        stepResult.status = "skipped";
      }
    }

    emit({ type: "execution_error", executionId, error });
    persistExecutions();
    throw err;
  } finally {
    runningExecutionCount--;
  }
}

// ─── Checkpoint resume ───────────────────────────────────────────────────────

export async function resumeExecution(
  executionId: string,
  chain: ChainDefinition,
  emit: EventEmitter
): Promise<string> {
  const existing = executions.get(executionId);
  if (!existing) throw new Error(`Execution ${executionId} not found`);
  if (existing.status !== "error" && existing.status !== "pending") throw new Error(`Execution ${executionId} is not in error/pending state (current: ${existing.status})`);

  // Use chain snapshot from launch if available (protects against YAML changes during execution)
  try {
    const snapshot = loadChainSnapshot(executionId);
    if (snapshot) {
      const yaml = await import("js-yaml");
      const parsed = yaml.load(snapshot) as ChainDefinition;
      if (parsed && parsed.steps) {
        chain = parsed;
        emit({ type: "step_log", executionId, stepId: "chain", message: "Resuming from chain snapshot (safe against YAML changes)", level: "info" });
      }
    }
  } catch { /* fallback to provided chain */ }

  // Restore vars from completed steps
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(existing.input)) {
    vars[`input.${k}`] = v;
    vars[k] = v;
  }
  for (const step of chain.steps) {
    const stepResult = existing.steps[step.id];
    if (stepResult?.status === "done" && stepResult.output) {
      vars[step.output_var] = stepResult.output;
    }
  }

  // Reset error/pending steps
  existing.status = "running";
  existing.error = undefined;
  existing.finishedAt = undefined;
  for (const stepResult of Object.values(existing.steps)) {
    if (stepResult.status === "error" || stepResult.status === "skipped") {
      stepResult.status = "pending";
      stepResult.error = undefined;
      stepResult.output = undefined;
    }
  }
  persistExecutions();

  emit({ type: "execution_started", executionId, chainName: chain.name });

  const graph = buildDependencyGraph(chain);

  try {
    for (const wave of graph.waves) {
      await Promise.all(
        wave.map(async (stepId) => {
          const step = chain.steps.find((s) => s.id === stepId)!;
          const stepResult = existing.steps[stepId];

          // Skip already completed steps
          if (stepResult.status === "done") {
            emit({ type: "step_log", executionId, stepId, message: "Restored from checkpoint", level: "info" });
            return;
          }

          stepResult.status = "running";
          stepResult.startedAt = new Date().toISOString();
          emit({ type: "step_started", executionId, stepId, label: step.label ?? step.id });

          try {
            await executeStep(step, chain, vars, existing, executionId, emit);
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            stepResult.status = "error";
            stepResult.error = error;
            stepResult.finishedAt = new Date().toISOString();
            emit({ type: "step_error", executionId, stepId, error });
            persistExecutions();
            throw err;
          }
        })
      );

      if (vars["__early_exit"] === "true") {
        emit({ type: "step_log", executionId, stepId: "chain", message: "Early exit — skipping remaining waves", level: "info" });
        break;
      }
    }

    const result = vars[chain.output] ?? "";
    existing.status = "done";
    existing.result = result;
    existing.finishedAt = new Date().toISOString();
    existing.durationMs = Date.now() - new Date(existing.startedAt).getTime();
    emit({ type: "execution_done", executionId, result, durationMs: existing.durationMs });
    persistExecutions();
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    existing.status = "error";
    existing.error = error;
    existing.finishedAt = new Date().toISOString();
    existing.durationMs = Date.now() - new Date(existing.startedAt).getTime();
    for (const stepResult of Object.values(existing.steps)) {
      if (stepResult.status === "pending") stepResult.status = "skipped";
    }
    emit({ type: "execution_error", executionId, error });
    persistExecutions();
    throw err;
  }
}
