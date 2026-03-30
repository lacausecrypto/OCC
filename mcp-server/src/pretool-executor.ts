import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import type {
  ChainExecution,
  ChainStep,
  PreTool,
} from "./types.js";
import { resolveVariables } from "./utils.js";

// ─── ClaudeResult type (matches executor.ts) ────────────────────────────────

export interface ClaudeResult {
  stdout: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Signature for the Claude runner function passed in by the caller. */
export type ClaudeRunner = (
  prompt: string,
  step: ChainStep,
  onChunk: (chunk: string) => void,
  executionId?: string,
) => Promise<ClaudeResult>;

// ─── Pre-tool cache ─────────────────────────────────────────────────────────

const preToolCache = new Map<string, { result: string; expiresAt: number }>();

function getPreToolCacheKey(tool: PreTool, vars: Record<string, string>): string {
  const key = JSON.stringify({ type: tool.type, url: tool.url, query: tool.query, path: tool.path,
    command: tool.command, var_name: tool.var_name, server: tool.server, tool: tool.tool,
    args: tool.args, method: tool.method, headers: tool.headers, body: tool.body });
  return resolveVariables(key, vars); // Resolved key so same inputs = same cache
}

// ─── Single pre-tool executor ───────────────────────────────────────────────

export async function executeSinglePreTool(
  tool: PreTool,
  vars: Record<string, string>,
  onLog: (message: string, level: "info" | "warn" | "error") => void,
  execution?: ChainExecution,
  executionId?: string,
  step?: ChainStep,
  claudeRunner?: ClaudeRunner,
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
      if (!claudeRunner) throw new Error("web_search requires a claudeRunner");
      const query = resolveVariables(tool.query ?? "", vars);
      const searchPrompt = `Search the web for: ${query}\n\nProvide a comprehensive summary of the most relevant and recent results. Include key facts, numbers, dates, and sources.`;
      const { stdout } = await claudeRunner(searchPrompt, { id: "_search", output_var: "_", tools: ["WebSearch"], model: "claude-haiku-4-5", prompt: "" } as ChainStep, () => {});
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
      result = await vq(tool.collection ?? "default", vqQuery, tool.top_k ?? 5);
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
      const cached = await semanticCacheLookup(scQuery, ttl, tool.similarity_threshold ?? 0.85);
      if (cached) {
        result = cached;
        onLog(`semantic_cache HIT for "${scQuery.slice(0, 50)}..."`, "info");
      } else {
        if (!claudeRunner) throw new Error("semantic_cache requires a claudeRunner");
        // Execute the underlying web_search and cache the result
        const searchPrompt = `Search the web for: ${scQuery}\n\nProvide a comprehensive summary.`;
        const { stdout } = await claudeRunner(searchPrompt, { id: "_search", output_var: "_", tools: ["WebSearch"], model: "claude-haiku-4-5", prompt: "" } as ChainStep, () => {});
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
      result = await embedCompare(ecA, ecB);
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

export async function executePreTools(
  preTools: PreTool[],
  vars: Record<string, string>,
  onLog: (message: string, level: "info" | "warn" | "error") => void,
  execution?: ChainExecution,
  executionId?: string,
  step?: ChainStep,
  claudeRunner?: ClaudeRunner,
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
        parallelBatch.map((tool) => executePreToolWithRetry(tool, liveVars, onLog, execution, executionId, step, claudeRunner))
      );
      for (let j = 0; j < parallelBatch.length; j++) {
        results[parallelBatch[j].inject_as] = parallelResults[j];
        liveVars[parallelBatch[j].inject_as] = parallelResults[j]; // Chain: available to next
      }
    }

    // Execute next sequential pre-tool (if any)
    if (i < preTools.length && !preTools[i].parallel) {
      const tool = preTools[i];
      const result = await executePreToolWithRetry(tool, liveVars, onLog, execution, executionId, step, claudeRunner);
      results[tool.inject_as] = result;
      liveVars[tool.inject_as] = result; // Chain: available to next pre-tool
      i++;
    }
  }

  return results;
}

/** Execute a single pre-tool with retry logic and error handling. */
export async function executePreToolWithRetry(
  tool: PreTool,
  vars: Record<string, string>,
  onLog: (message: string, level: "info" | "warn" | "error") => void,
  execution?: ChainExecution,
  executionId?: string,
  step?: ChainStep,
  claudeRunner?: ClaudeRunner,
): Promise<string> {
  const maxAttempts = (tool.retry ?? 0) + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await executeSinglePreTool(tool, vars, onLog, execution, executionId, step, claudeRunner);
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
