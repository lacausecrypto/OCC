/**
 * Advanced pre-tool implementations.
 * Separated from executor.ts to keep file sizes manageable.
 *
 * Tier 1: state_load/save, vector_query/index, json_parse, diff_inject, notify
 * Tier 2: semantic_cache, screenshot, sandbox_exec, cost_gate, ast_parse
 * Tier 3: embed_compare, graph_query, parallel_fetch, template_render, approval_request
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";

// ─── State Store (state_load / state_save) ──────────────────────────────────

let stateDb: Database.Database | null = null;

function getStateDb(): Database.Database {
  if (stateDb?.open) return stateDb;
  const dbPath = process.env.OCC_STATE_DB ?? path.join(os.tmpdir(), "occ-state.db");
  stateDb = new Database(dbPath);
  stateDb.pragma("journal_mode = WAL");
  stateDb.exec(`
    CREATE TABLE IF NOT EXISTS kv_state (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (scope, key)
    );
  `);
  return stateDb;
}

export function stateLoad(key: string, scope: string, defaultValue: string): string {
  const db = getStateDb();
  const row = db.prepare(`SELECT value FROM kv_state WHERE scope = ? AND key = ?`).get(scope, key) as any;
  return row?.value ?? defaultValue;
}

export function stateSave(key: string, value: string, scope: string): void {
  const db = getStateDb();
  db.prepare(`INSERT INTO kv_state (scope, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(scope, key, value);
}

// ─── Vector Store (vector_query / vector_index) — SQLite FTS5 ───────────────

let vectorDb: Database.Database | null = null;

function getVectorDb(): Database.Database {
  if (vectorDb?.open) return vectorDb;
  const dbPath = process.env.OCC_VECTOR_DB ?? path.join(os.tmpdir(), "occ-vectors.db");
  vectorDb = new Database(dbPath);
  vectorDb.pragma("journal_mode = WAL");
  vectorDb.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vectors USING fts5(
      collection, chunk, source_id, tokenize='porter unicode61'
    );
    CREATE TABLE IF NOT EXISTS vector_meta (
      id TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      source_text TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return vectorDb;
}

export function vectorIndex(collection: string, text: string, chunkSize: number): string {
  const db = getVectorDb();
  const sourceId = crypto.randomBytes(8).toString("hex");
  // Chunk text
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  const stmt = db.prepare(`INSERT INTO vectors (collection, chunk, source_id) VALUES (?, ?, ?)`);
  for (const chunk of chunks) {
    stmt.run(collection, chunk, sourceId);
  }
  db.prepare(`INSERT INTO vector_meta (id, collection, source_text) VALUES (?, ?, ?)`).run(
    sourceId, collection, text.slice(0, 500)
  );
  return `Indexed ${chunks.length} chunks into "${collection}" (id: ${sourceId})`;
}

export function vectorQuery(collection: string, query: string, topK: number): string {
  const db = getVectorDb();
  const rows = db.prepare(`
    SELECT chunk, rank FROM vectors WHERE collection = ? AND vectors MATCH ? ORDER BY rank LIMIT ?
  `).all(collection, query, topK) as any[];
  if (rows.length === 0) return "(no results)";
  return rows.map((r, i) => `[${i + 1}] ${r.chunk.slice(0, 500)}`).join("\n\n");
}

// ─── JSON Parse (json_parse) ────────────────────────────────────────────────

export function jsonParse(input: string, jsonPath: string): string {
  // Try to extract JSON from the input (handles markdown-wrapped JSON)
  let json: any;
  try {
    json = JSON.parse(input);
  } catch {
    // Try to find JSON in markdown code blocks
    const match = input.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      json = JSON.parse(match[1].trim());
    } else {
      throw new Error("json_parse: input is not valid JSON");
    }
  }

  // Navigate path: "data.items[0].name"
  const parts = jsonPath.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current = json;
  for (const part of parts) {
    if (current === null || current === undefined) return "";
    current = current[part];
  }

  return typeof current === "string" ? current : JSON.stringify(current, null, 2);
}

// ─── Diff Inject (diff_inject) ──────────────────────────────────────────────

export function diffInject(repoPath: string, base: string, head: string, maxTokens: number): string {
  const stat = execSync(`git -C "${repoPath}" diff --stat ${base}...${head}`, { encoding: "utf-8", timeout: 15000 });
  const diff = execSync(`git -C "${repoPath}" diff ${base}...${head}`, { encoding: "utf-8", timeout: 15000 });

  const lines: string[] = [];
  lines.push("## Changed Files");
  lines.push(stat.trim());
  lines.push("");

  // Parse diff into per-file sections
  const fileDiffs = diff.split(/^diff --git/m).filter(Boolean);
  let totalChars = stat.length;

  for (const fileDiff of fileDiffs) {
    const nameMatch = fileDiff.match(/a\/(.+?) b\//);
    const fileName = nameMatch?.[1] ?? "unknown";

    // Count additions/deletions
    const additions = (fileDiff.match(/^\+[^+]/gm) ?? []).length;
    const deletions = (fileDiff.match(/^-[^-]/gm) ?? []).length;

    const section = `### ${fileName} (+${additions}/-${deletions})\n\`\`\`diff\n${fileDiff.slice(0, 2000)}\n\`\`\``;

    if (totalChars + section.length > maxTokens * 4) { // ~4 chars per token
      lines.push(`\n... (${fileDiffs.length - lines.length} more files truncated)`);
      break;
    }

    lines.push(section);
    totalChars += section.length;
  }

  return lines.join("\n");
}

// ─── Notify (notify) ────────────────────────────────────────────────────────

export async function notify(channel: string, webhookUrl: string, message: string): Promise<string> {
  let body: string;
  let headers: Record<string, string> = { "Content-Type": "application/json" };

  switch (channel) {
    case "slack":
      body = JSON.stringify({ text: message });
      break;
    case "discord":
      body = JSON.stringify({ content: message });
      break;
    case "telegram": {
      // webhookUrl should be: https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>
      body = JSON.stringify({ text: message });
      break;
    }
    default:
      // Generic webhook
      body = JSON.stringify({ message, timestamp: new Date().toISOString() });
  }

  const resp = await fetch(webhookUrl, { method: "POST", headers, body });
  return resp.ok ? `Notified (${channel}: ${resp.status})` : `Notification failed: ${resp.status}`;
}

// ─── Semantic Cache (SQLite FTS5 similarity) ────────────────────────────────

let semanticCacheDb: Database.Database | null = null;

function getSemanticCacheDb(): Database.Database {
  if (semanticCacheDb?.open) return semanticCacheDb;
  const dbPath = process.env.OCC_SEMANTIC_CACHE_DB ?? path.join(os.tmpdir(), "occ-semantic-cache.db");
  semanticCacheDb = new Database(dbPath);
  semanticCacheDb.pragma("journal_mode = WAL");
  semanticCacheDb.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS sem_cache USING fts5(query, result, tokenize='porter unicode61');
    CREATE TABLE IF NOT EXISTS sem_cache_meta (
      rowid INTEGER PRIMARY KEY,
      query_hash TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return semanticCacheDb;
}

export function semanticCacheLookup(query: string, ttlMinutes: number, threshold: number): string | null {
  const db = getSemanticCacheDb();
  // FTS5 match with rank — find similar cached queries
  try {
    const rows = db.prepare(`
      SELECT result, rank FROM sem_cache WHERE sem_cache MATCH ? ORDER BY rank LIMIT 1
    `).all(query) as any[];
    if (rows.length > 0) {
      return rows[0].result;
    }
  } catch { /* FTS query syntax error — no match */ }
  return null;
}

export function semanticCacheStore(query: string, result: string, ttlMinutes: number): void {
  const db = getSemanticCacheDb();
  db.prepare(`INSERT INTO sem_cache (query, result) VALUES (?, ?)`).run(query, result);
}

// ─── Screenshot (via Playwright) ────────────────────────────────────────────

export async function takeScreenshot(url: string, viewport: { width: number; height: number }, waitMs: number): Promise<string> {
  const outputPath = path.join(os.tmpdir(), `occ-screenshot-${Date.now()}.png`);

  // Try Playwright first, fall back to Chrome headless
  try {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport });
    await page.goto(url, { waitUntil: "networkidle" });
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    await page.screenshot({ path: outputPath, fullPage: false });
    await browser.close();
    return outputPath;
  } catch {
    // Fallback: Chrome headless CLI
    try {
      execSync(`google-chrome --headless --disable-gpu --screenshot="${outputPath}" --window-size=${viewport.width},${viewport.height} "${url}"`, { timeout: 30000 });
      return outputPath;
    } catch {
      throw new Error("screenshot requires Playwright or Chrome. Install: npx playwright install chromium");
    }
  }
}

// ─── Sandbox Exec (Docker) ──────────────────────────────────────────────────

export function sandboxExec(image: string, command: string, mount: string | undefined, timeoutMs: number): string {
  const mountArg = mount ? `-v "${mount}"` : "";
  const cmd = `docker run --rm --network=none ${mountArg} "${image}" sh -c "${command.replace(/"/g, '\\"')}"`;
  return execSync(cmd, { timeout: timeoutMs, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
}

// ─── Cost Gate ──────────────────────────────────────────────────────────────

// Token costs per million tokens
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.25, output: 1.25 },
};

export function costGate(budgetUsd: number, executionSteps: Record<string, { inputTokens?: number; outputTokens?: number }>, action: string): string {
  let totalCost = 0;
  const defaultCosts = MODEL_COSTS["claude-sonnet-4-6"];

  for (const step of Object.values(executionSteps)) {
    const input = step.inputTokens ?? 0;
    const output = step.outputTokens ?? 0;
    totalCost += (input * defaultCosts.input + output * defaultCosts.output) / 1_000_000;
  }

  const remaining = budgetUsd - totalCost;
  const status = remaining > 0 ? "within_budget" : "over_budget";

  return JSON.stringify({
    status,
    spent_usd: Number(totalCost.toFixed(4)),
    budget_usd: budgetUsd,
    remaining_usd: Number(remaining.toFixed(4)),
    action: remaining <= 0 ? action : "continue",
  });
}

// ─── AST Parse (regex-based, no tree-sitter dependency) ─────────────────────

export function astParse(filePath: string, extracts: string[]): string {
  const content = fs.readFileSync(filePath, "utf-8");
  const ext = path.extname(filePath).toLowerCase();
  const results: string[] = [];

  const isTS = [".ts", ".tsx", ".js", ".jsx"].includes(ext);
  const isPy = ext === ".py";
  const isGo = ext === ".go";

  if (extracts.includes("functions")) {
    let fns: string[] = [];
    if (isTS) {
      fns = [...content.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)/g)].map(m => m[0]);
      fns.push(...[...content.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*\w+)?\s*=>/g)].map(m => m[0]));
    } else if (isPy) {
      fns = [...content.matchAll(/def\s+(\w+)\s*\([^)]*\)/g)].map(m => m[0]);
    } else if (isGo) {
      fns = [...content.matchAll(/func\s+(?:\([^)]*\)\s+)?(\w+)\s*\([^)]*\)/g)].map(m => m[0]);
    }
    if (fns.length > 0) results.push(`## Functions (${fns.length})\n${fns.join("\n")}`);
  }

  if (extracts.includes("classes")) {
    let cls: string[] = [];
    if (isTS) cls = [...content.matchAll(/(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?/g)].map(m => m[0]);
    if (isPy) cls = [...content.matchAll(/class\s+(\w+)(?:\([^)]*\))?:/g)].map(m => m[0]);
    if (cls.length > 0) results.push(`## Classes (${cls.length})\n${cls.join("\n")}`);
  }

  if (extracts.includes("imports")) {
    let imps: string[] = [];
    if (isTS) imps = [...content.matchAll(/import\s+.*?from\s+["'][^"']+["']/g)].map(m => m[0]);
    if (isPy) imps = [...content.matchAll(/(?:from\s+\S+\s+)?import\s+.+/g)].map(m => m[0]);
    if (isGo) imps = [...content.matchAll(/import\s+(?:\([\s\S]*?\)|\S+)/g)].map(m => m[0]);
    if (imps.length > 0) results.push(`## Imports (${imps.length})\n${imps.join("\n")}`);
  }

  if (extracts.includes("exports")) {
    let exps: string[] = [];
    if (isTS) exps = [...content.matchAll(/export\s+(?:default\s+)?(?:function|class|const|let|type|interface|enum)\s+(\w+)/g)].map(m => m[0]);
    if (exps.length > 0) results.push(`## Exports (${exps.length})\n${exps.join("\n")}`);
  }

  if (extracts.includes("types")) {
    let types: string[] = [];
    if (isTS) {
      types = [...content.matchAll(/(?:export\s+)?(?:type|interface)\s+(\w+)/g)].map(m => m[0]);
    }
    if (types.length > 0) results.push(`## Types (${types.length})\n${types.join("\n")}`);
  }

  return results.length > 0 ? results.join("\n\n") : "(no matching code structures found)";
}

// ─── Embed Compare (keyword-based similarity) ───────────────────────────────

export function embedCompare(textA: string, textB: string): string {
  // Simple keyword-based similarity (no external model needed)
  const wordsA = new Set(textA.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const wordsB = new Set(textB.toLowerCase().split(/\W+/).filter(w => w.length > 3));

  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  const similarity = union.size > 0 ? intersection.size / union.size : 0;

  // Find words only in B (new content)
  const newWords = [...wordsB].filter(w => !wordsA.has(w)).slice(0, 20);
  // Find words only in A (removed content)
  const removedWords = [...wordsA].filter(w => !wordsB.has(w)).slice(0, 20);

  return JSON.stringify({
    similarity: Number(similarity.toFixed(3)),
    new_keywords: newWords,
    removed_keywords: removedWords,
    verdict: similarity > 0.8 ? "mostly_same" : similarity > 0.5 ? "partially_changed" : "significantly_changed",
  });
}

// ─── Graph Query (SQLite triples) ───────────────────────────────────────────

let graphDb: Database.Database | null = null;

function getGraphDb(): Database.Database {
  if (graphDb?.open) return graphDb;
  const dbPath = process.env.OCC_GRAPH_DB ?? path.join(os.tmpdir(), "occ-graph.db");
  graphDb = new Database(dbPath);
  graphDb.pragma("journal_mode = WAL");
  graphDb.exec(`
    CREATE TABLE IF NOT EXISTS triples (
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(subject, predicate, object)
    );
    CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject);
    CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate);
  `);
  return graphDb;
}

export function graphWrite(triples: Array<{ subject: string; predicate: string; object: string }>): string {
  const db = getGraphDb();
  const stmt = db.prepare(`INSERT OR IGNORE INTO triples (subject, predicate, object) VALUES (?, ?, ?)`);
  let inserted = 0;
  for (const t of triples) {
    const r = stmt.run(t.subject, t.predicate, t.object);
    inserted += r.changes;
  }
  return `Inserted ${inserted} triples`;
}

export function graphRead(subject?: string, predicate?: string): string {
  const db = getGraphDb();
  let query = "SELECT subject, predicate, object FROM triples WHERE 1=1";
  const params: string[] = [];
  if (subject) { query += " AND subject = ?"; params.push(subject); }
  if (predicate) { query += " AND predicate = ?"; params.push(predicate); }
  query += " LIMIT 50";

  const rows = db.prepare(query).all(...params) as any[];
  if (rows.length === 0) return "(no triples found)";
  return rows.map(r => `${r.subject} —[${r.predicate}]→ ${r.object}`).join("\n");
}

// ─── Parallel Fetch ─────────────────────────────────────────────────────────

export async function parallelFetch(urls: string[], rateLimitMs: number, timeoutMs: number): Promise<string> {
  const results: string[] = [];

  // Execute with rate limiting
  for (let i = 0; i < urls.length; i++) {
    if (i > 0 && rateLimitMs > 0) {
      await new Promise(r => setTimeout(r, rateLimitMs));
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(urls[i], { signal: controller.signal });
      clearTimeout(timer);
      const text = await resp.text();
      results.push(`[${urls[i]}] (${resp.status})\n${text.slice(0, 5000)}`);
    } catch (err) {
      results.push(`[${urls[i]}] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return results.join("\n\n---\n\n");
}

// ─── Template Render (Handlebars-like) ──────────────────────────────────────

export function templateRender(template: string, data: Record<string, unknown>): string {
  let result = template;

  // {{#each items}}...{{/each}}
  result = result.replace(/\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_, key, body) => {
    const arr = data[key];
    if (!Array.isArray(arr)) return "";
    return arr.map((item, idx) => {
      let rendered = body;
      if (typeof item === "object" && item !== null) {
        for (const [k, v] of Object.entries(item)) {
          rendered = rendered.replaceAll(`{{${k}}}`, String(v));
        }
      }
      rendered = rendered.replaceAll("{{this}}", String(item));
      rendered = rendered.replaceAll("{{@index}}", String(idx));
      return rendered;
    }).join("");
  });

  // {{#if key}}...{{else}}...{{/if}}
  result = result.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g, (_, key, ifBody, elseBody) => {
    return data[key] ? ifBody : (elseBody ?? "");
  });

  // {{key}} simple replacement
  result = result.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key) => {
    const parts = key.split(".");
    let val: any = data;
    for (const p of parts) {
      if (val === null || val === undefined) return "";
      val = val[p];
    }
    return val !== undefined ? String(val) : "";
  });

  return result;
}

// ─── Approval Request ───────────────────────────────────────────────────────

export function createApprovalRequest(executionId: string, stepId: string, title: string, description: string, expiresHours: number): string {
  // Generate a unique approval URL that can be shared
  const token = crypto.randomBytes(16).toString("hex");
  const port = process.env.REST_PORT ?? "4242";
  const host = process.env.REST_HOST ?? "localhost";

  // The approval is handled by the existing POST /executions/:id/approve/:stepId endpoint
  const approveUrl = `http://${host}:${port}/executions/${executionId}/approve/${stepId}`;

  return JSON.stringify({
    title,
    description,
    approve_url: approveUrl,
    approve_command: `curl -X POST ${approveUrl} -H "Content-Type: application/json" -d '{"approved": true}'`,
    reject_command: `curl -X POST ${approveUrl} -H "Content-Type: application/json" -d '{"approved": false}'`,
    expires_at: new Date(Date.now() + expiresHours * 3600000).toISOString(),
    token,
  });
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

export function closeExtraDbs(): void {
  if (stateDb?.open) stateDb.close();
  if (vectorDb?.open) vectorDb.close();
  if (semanticCacheDb?.open) semanticCacheDb.close();
  if (graphDb?.open) graphDb.close();
  stateDb = null;
  vectorDb = null;
  semanticCacheDb = null;
  graphDb = null;
}
