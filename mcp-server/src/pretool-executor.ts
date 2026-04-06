import * as crypto from "node:crypto";
import * as dns from "node:dns";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import type {
  ChainExecution,
  ChainStep,
  PreTool,
} from "./types.js";
import { resolveVariables } from "./utils.js";

// ─── Shell argument sanitizer — escape metacharacters for safe use in sh -c ─
function sanitizeShellArg(s: string): string {
  // Escape shell metacharacters for safe use in sh -c
  return s.replace(/\0/g, '').replace(/\n/g, ' ').replace(/\r/g, '').replace(/([`$\\!#&|;(){}<>"'])/g, '\\$1');
}

// ─── SQL security — strict read-only validation + parameterized queries ──────
const SQL_BLOCKED_KEYWORDS = /\b(DROP|DELETE|ALTER|TRUNCATE|EXEC|EXECUTE|INSERT|UPDATE|CREATE|GRANT|REVOKE|ATTACH|DETACH|PRAGMA|LOAD_EXTENSION)\b/gi;

function validateReadOnlySQL(sql: string): void {
  // Strip comments and string literals before checking keywords
  const stripped = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const match = stripped.match(SQL_BLOCKED_KEYWORDS);
  if (match) {
    throw new Error(`db_query: blocked SQL keyword "${match[0]}" — only SELECT queries are allowed`);
  }
  // Must start with SELECT or WITH (CTEs)
  const trimmed = stripped.trim().toUpperCase();
  if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("WITH")) {
    throw new Error("db_query: only SELECT/WITH queries are allowed");
  }
}

// ─── SSRF protection — block requests to private/internal networks ──────────
const BLOCKED_CIDRS = [
  '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
  '169.254.0.0/16', '0.0.0.0/8', '100.64.0.0/10', '198.18.0.0/15',
];
const BLOCKED_IPV6 = [
  '::1',             // localhost
  '::ffff:127.0.0.1', // IPv4-mapped localhost
];
const BLOCKED_IPV6_PREFIXES = [
  { prefix: 'fe80:', bits: 10 },  // link-local fe80::/10
  { prefix: 'fc',   bits: 7 },   // ULA fc00::/7 (fc00:: - fdff::)
  { prefix: 'fd',   bits: 7 },   // ULA fc00::/7 (fc00:: - fdff::)
];
function isBlockedIPv6(addr: string): boolean {
  const normalized = addr.toLowerCase();
  if (BLOCKED_IPV6.includes(normalized)) return true;
  for (const { prefix } of BLOCKED_IPV6_PREFIXES) {
    if (normalized.startsWith(prefix)) return true;
  }
  // Also catch IPv4-mapped IPv6 addresses pointing to private ranges (::ffff:10.x.x.x etc.)
  const v4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) {
    for (const cidr of BLOCKED_CIDRS) {
      if (ipInCidr(v4Mapped[1], cidr)) return true;
    }
  }
  return false;
}
function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const mask = ~((1 << (32 - parseInt(bits))) - 1) >>> 0;
  const ipNum = ip.split('.').reduce((n, o) => (n << 8) + parseInt(o), 0) >>> 0;
  const baseNum = base.split('.').reduce((n, o) => (n << 8) + parseInt(o), 0) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}
export async function checkSSRF(urlStr: string): Promise<void> {
  const parsed = new URL(urlStr);
  const hostname = parsed.hostname;
  // Block file:// and other non-http schemes
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`SSRF blocked: scheme ${parsed.protocol} not allowed`);
  }
  // Resolve hostname to IPv4 and check against blocked ranges (5s timeout)
  const DNS_TIMEOUT = 5000;
  const addrs4 = await new Promise<string[]>((resolve) => {
    const timer = setTimeout(() => resolve(net.isIPv4(hostname) ? [hostname] : []), DNS_TIMEOUT);
    dns.resolve4(hostname, (err, addresses) => {
      clearTimeout(timer);
      if (err) {
        if (net.isIPv4(hostname)) resolve([hostname]);
        else resolve([]);
      } else resolve(addresses);
    });
  });
  // Resolve hostname to IPv6 and check against blocked prefixes (5s timeout)
  const addrs6 = await new Promise<string[]>((resolve) => {
    const timer = setTimeout(() => resolve(net.isIPv6(hostname) ? [hostname] : []), DNS_TIMEOUT);
    dns.resolve6(hostname, (err, addresses) => {
      clearTimeout(timer);
      if (err) {
        if (net.isIPv6(hostname)) resolve([hostname]);
        else resolve([]);
      } else resolve(addresses);
    });
  });
  if (addrs4.length === 0 && addrs6.length === 0) {
    throw new Error(`Cannot resolve ${hostname}`);
  }
  for (const addr of addrs4) {
    for (const cidr of BLOCKED_CIDRS) {
      if (ipInCidr(addr, cidr)) {
        throw new Error(`SSRF blocked: ${hostname} resolves to private IP ${addr}`);
      }
    }
  }
  for (const addr of addrs6) {
    if (isBlockedIPv6(addr)) {
      throw new Error(`SSRF blocked: ${hostname} resolves to private IPv6 ${addr}`);
    }
  }
}

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

export function clearPreToolCache(): number {
  const count = preToolCache.size;
  preToolCache.clear();
  return count;
}

export function getPreToolCacheSize(): number {
  return preToolCache.size;
}

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
  const MAX_CACHE_SIZE = 1000;

  if (tool.cache_ttl_minutes && tool.cache_ttl_minutes > 0) {
    // Before cache lookup - evict if over limit
    if (preToolCache.size > MAX_CACHE_SIZE) {
      const now = Date.now();
      // First pass: remove expired
      preToolCache.forEach((entry, key) => {
        if (entry.expiresAt <= now) preToolCache.delete(key);
      });
      // Second pass: if still over limit, remove oldest entries
      if (preToolCache.size > MAX_CACHE_SIZE) {
        const sorted = [...preToolCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
        const toRemove = sorted.slice(0, sorted.length - MAX_CACHE_SIZE + 100);
        for (const [key] of toRemove) preToolCache.delete(key);
      }
    }
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

      // SSRF protection — block requests to private networks
      await checkSSRF(url);

      const headers: Record<string, string> = {};
      if (tool.headers) {
        for (const [k, v] of Object.entries(tool.headers)) {
          headers[k] = resolveVariables(v, vars);
        }
      }

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
        // Cap response size to prevent OOM on large responses (10MB)
        const MAX_FETCH_SIZE = 10 * 1024 * 1024;
        const contentLength = parseInt(resp.headers.get("content-length") ?? "0");
        if (contentLength > MAX_FETCH_SIZE) {
          throw new Error(`http_fetch: response too large (${(contentLength / 1024 / 1024).toFixed(1)}MB > 10MB)`);
        }
        result = await resp.text();
        if (result.length > MAX_FETCH_SIZE) {
          result = result.slice(0, MAX_FETCH_SIZE);
          onLog(`http_fetch: response truncated to 10MB`, "warn");
        }
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
      // Check normalized path first (before realpathSync which throws ENOENT for missing files)
      if (!filePath.startsWith(safeRoot) && !filePath.startsWith(path.resolve(os.tmpdir()))) {
        throw new Error(`read_file: path "${filePath}" outside allowed directory "${safeRoot}"`);
      }
      // Resolve symlinks to prevent traversal via symlink chains
      const realFilePath = fs.realpathSync(filePath);
      const realSafeRoot = fs.realpathSync(safeRoot);
      const realTmpDir = fs.realpathSync(os.tmpdir());
      if (!realFilePath.startsWith(realSafeRoot) && !realFilePath.startsWith(realTmpDir)) {
        throw new Error(`read_file: path "${filePath}" outside allowed directory "${safeRoot}"`);
      }
      const encoding = (tool.encoding ?? "utf-8") as BufferEncoding;
      result = fs.readFileSync(realFilePath, encoding);
      if (result.length > 50000) {
        result = result.slice(0, 50000) + "\n[truncated]";
        onLog(`read_file truncated to 50KB for ${filePath}`, "warn");
      }
      break;
    }

    case "write_file": {
      const filePath = path.resolve(resolveVariables(tool.path ?? "", vars));
      // Path traversal protection — validate BEFORE creating directories (prevent TOCTOU)
      const safeWriteRoot = path.resolve(process.env.WORKSPACE_DIR ?? process.cwd());
      const realSafeWriteRoot = fs.realpathSync(safeWriteRoot);
      const realTmpDir = fs.realpathSync(os.tmpdir());
      // Check the canonical parent path resolves inside allowed roots BEFORE mkdir
      // Use path.resolve to normalize without requiring existence
      const normalizedPath = path.resolve(filePath);
      const normalizedParent = path.dirname(normalizedPath);
      // Walk up to find the first existing ancestor to verify it's within bounds
      let checkDir = normalizedParent;
      while (!fs.existsSync(checkDir) && checkDir !== path.dirname(checkDir)) {
        checkDir = path.dirname(checkDir);
      }
      if (fs.existsSync(checkDir)) {
        const realCheckDir = fs.realpathSync(checkDir);
        if (!realCheckDir.startsWith(realSafeWriteRoot) && !realCheckDir.startsWith(realTmpDir)) {
          throw new Error(`write_file: path "${filePath}" outside allowed directory "${safeWriteRoot}"`);
        }
      }
      // Now safe to create parent directories
      const parentDir = path.dirname(filePath);
      fs.mkdirSync(parentDir, { recursive: true });
      // Final validation after mkdir — resolve symlinks on the actual parent
      const realParentDir = fs.realpathSync(parentDir);
      const realWritePath = path.join(realParentDir, path.basename(filePath));
      if (!realWritePath.startsWith(realSafeWriteRoot) && !realWritePath.startsWith(realTmpDir)) {
        throw new Error(`write_file: resolved path "${realWritePath}" outside allowed directory "${safeWriteRoot}"`);
      }
      const fileContent = resolveVariables(tool.content ?? "", vars);
      const encoding = (tool.encoding ?? "utf-8") as BufferEncoding;
      if (tool.append) {
        fs.appendFileSync(realWritePath, fileContent, encoding);
      } else {
        fs.writeFileSync(realWritePath, fileContent, encoding);
      }
      result = filePath;
      onLog(`write_file${tool.append ? " (append)" : ""} → ${filePath} (${fileContent.length} chars)`, "info");
      break;
    }

    case "bash": {
      const rawCmd = tool.command ?? "";
      // Security: sanitize ALL variable values before shell interpolation
      const sanitizedVars = { ...vars };
      for (const key of Object.keys(sanitizedVars)) {
        sanitizedVars[key] = sanitizeShellArg(sanitizedVars[key]);
      }
      const command = resolveVariables(rawCmd, sanitizedVars);
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
        result = execFileSync("sh", ["-c", command], { timeout: timeoutMs, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      }
      break;
    }

    case "env_var": {
      // SECURITY: Only allow access to explicitly safe environment variables.
      // Blocks access to secrets (API keys, passwords, tokens, credentials).
      const ENV_VAR_BLOCKED_PATTERNS = [
        /KEY/i, /SECRET/i, /TOKEN/i, /PASSWORD/i, /PASSWD/i, /CREDENTIAL/i,
        /AUTH/i, /PRIVATE/i, /^AWS_/i, /^GCP_/i, /^AZURE_/i, /^GITHUB_/i,
        /^NPM_/i, /^DOCKER_/i, /^CI_/i, /^SSH_/i, /^GPG_/i,
        /^DATABASE_URL$/i, /^REDIS_URL$/i, /^MONGO/i,
        /^LD_PRELOAD$/i, /^NODE_OPTIONS$/i, /^PATH$/i,
      ];
      const ENV_VAR_ALLOWLIST = new Set([
        "NODE_ENV", "TZ", "LANG", "LC_ALL", "HOME", "USER", "HOSTNAME",
        "WORKSPACE_DIR", "OCC_CHAIN_DIR", "REST_PORT", "REST_HOST",
        "CORS_ORIGIN", "RATE_LIMIT_EXEC", "RATE_LIMIT_GEN",
      ]);
      const varName = tool.var_name ?? "";
      if (!varName) {
        result = tool.default_value ?? "";
      } else if (ENV_VAR_ALLOWLIST.has(varName)) {
        result = process.env[varName] ?? tool.default_value ?? "";
      } else if (ENV_VAR_BLOCKED_PATTERNS.some(p => p.test(varName))) {
        onLog(`env_var: access to "${varName}" blocked — matches sensitive pattern`, "warn");
        result = tool.default_value ?? "";
      } else {
        // Allow non-sensitive, non-blocked vars (user-defined vars like MY_APP_NAME)
        result = process.env[varName] ?? tool.default_value ?? "";
      }
      break;
    }

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
      // SECURITY: db_query now uses parameterized queries for SQLite (via better-sqlite3)
      // and strict read-only validation for all backends.
      // User input is NEVER interpolated into SQL — it's passed as bound parameters.
      const connStr = resolveVariables(tool.connection ?? "", vars);
      const sqlTemplate = tool.sql ?? "";
      if (!connStr || !sqlTemplate) throw new Error("db_query requires connection and sql");

      // Extract user-input placeholders from SQL template and replace with positional params
      // e.g. "SELECT * FROM users WHERE id = {input.user_id}" → "SELECT * FROM users WHERE id = ?"
      const paramValues: string[] = [];
      const parameterizedSQL = sqlTemplate.replace(/\{([^}]+)\}/g, (_match, varName: string) => {
        const value = vars[varName] ?? "";
        paramValues.push(value);
        return "?";
      });

      // Validate: only read-only queries allowed
      validateReadOnlySQL(parameterizedSQL);

      try {
        if (connStr.endsWith(".db") || connStr.endsWith(".sqlite") || connStr.startsWith("sqlite:")) {
          // Use better-sqlite3 with parameterized queries (already a project dependency)
          const Database = (await import("better-sqlite3")).default;
          const dbPath = connStr.replace("sqlite:", "");
          const db = new Database(dbPath, { readonly: true, timeout: timeoutMs });
          try {
            const stmt = db.prepare(parameterizedSQL);
            const rows = stmt.all(...paramValues);
            result = JSON.stringify(rows);
          } finally {
            db.close();
          }
        } else if (connStr.startsWith("postgres")) {
          // PostgreSQL: use positional $1, $2, ... params via psql is not possible
          // Fallback to CLI but ONLY with validated read-only SQL and escaped params
          const escapedSQL = parameterizedSQL.replace(/\?/g, () => {
            const val = paramValues.shift() ?? "";
            // Escape single quotes for PostgreSQL string literals
            return "'" + val.replace(/'/g, "''") + "'";
          });
          result = execFileSync("psql", [connStr, "-t", "-A", "-c", escapedSQL], { timeout: timeoutMs, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
        } else if (connStr.startsWith("mysql")) {
          const escapedSQL = parameterizedSQL.replace(/\?/g, () => {
            const val = paramValues.shift() ?? "";
            return "'" + val.replace(/'/g, "''").replace(/\\/g, "\\\\") + "'";
          });
          result = execFileSync("mysql", ["--batch", "--raw", "-e", escapedSQL, connStr], { timeout: timeoutMs, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
        } else {
          throw new Error(`db_query: unsupported connection. Use postgres://, mysql://, or path.db/sqlite:`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Never leak SQL details to caller — only generic message
        if (msg.includes("blocked SQL keyword") || msg.includes("only SELECT")) throw e;
        throw new Error(`db_query failed: query execution error`);
      }
      break;
    }

    case "email": {
      const to = resolveVariables(tool.to ?? "", vars);
      const subject = resolveVariables(tool.subject ?? "", vars);
      const emailBody = resolveVariables(tool.content ?? tool.body ?? "", vars);
      const provider = tool.provider ?? "smtp";

      if (!to || !subject) throw new Error("email requires to and subject");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error(`email: invalid recipient address "${to}"`);

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
        result = resp.ok ? `Email sent to ${to} (${resp.status})` : `Email failed: ${resp.status}`;
      } else if (provider === "resend") {
        const apiKey = process.env.RESEND_API_KEY ?? "";
        if (!apiKey) throw new Error("email (resend): RESEND_API_KEY env var required");
        const from = tool.from ?? process.env.RESEND_FROM ?? "onboarding@resend.dev";
        const payload = JSON.stringify({
          from,
          to: [to],
          subject,
          text: emailBody,
        });
        const resp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: payload,
        });
        result = resp.ok ? `Email sent to ${to} via Resend (${resp.status})` : `Email failed: ${resp.status}`;
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
