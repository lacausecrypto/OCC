import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { z } from "zod";
import type { ChainDefinition } from "./types.js";

// ─── Validation schema ────────────────────────────────────────────────────────

const PreToolSchema = z.object({
  type: z.enum([
    "current_datetime", "http_fetch", "web_search", "read_file", "write_file",
    "bash", "env_var", "mcp_call", "db_query", "email", "pdf_generate", "ocr",
    "state_load", "state_save", "vector_query", "vector_index", "json_parse",
    "diff_inject", "notify", "semantic_cache", "screenshot", "sandbox_exec",
    "cost_gate", "ast_parse", "embed_compare", "graph_query", "parallel_fetch",
    "template_render", "approval_request", "image_generate",
  ]),
  inject_as: z.string().min(1),
  label: z.string().optional(),
  url: z.string().optional(),
  query: z.string().optional(),
  path: z.string().optional(),
  content: z.string().optional(),
  command: z.string().optional(),
  var_name: z.string().optional(),
  // mcp_call
  server: z.string().optional(),
  tool: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  // http_fetch advanced
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  json_path: z.string().optional(),
  // current_datetime
  timezone: z.string().optional(),
  format: z.enum(["iso", "locale", "unix"]).optional(),
  // read_file / write_file
  encoding: z.string().optional(),
  append: z.boolean().optional(),
  // bash
  stderr: z.boolean().optional(),
  // env_var
  default_value: z.string().optional(),
  // db_query
  connection: z.string().optional(),
  sql: z.string().optional(),
  // email
  to: z.string().optional(),
  subject: z.string().optional(),
  from: z.string().optional(),
  provider: z.enum(["smtp", "sendgrid"]).optional(),
  smtp_host: z.string().optional(),
  smtp_port: z.number().optional(),
  // pdf_generate
  html: z.string().optional(),
  output_path: z.string().optional(),
  // ocr
  image_path: z.string().optional(),
  language: z.string().optional(),
  // state_load / state_save
  key: z.string().optional(),
  value: z.string().optional(),
  scope: z.string().optional(),
  default: z.string().optional(),
  // vector_query / vector_index
  collection: z.string().optional(),
  top_k: z.number().optional(),
  source: z.string().optional(),
  chunk_size: z.number().optional(),
  // json_parse
  input: z.string().optional(),
  // diff_inject
  repo: z.string().optional(),
  base: z.string().optional(),
  head: z.string().optional(),
  max_tokens: z.number().optional(),
  // notify
  channel: z.string().optional(),
  webhook_url: z.string().optional(),
  message: z.string().optional(),
  // semantic_cache
  similarity_threshold: z.number().optional(),
  // screenshot
  viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  wait_ms: z.number().optional(),
  // sandbox_exec
  image: z.string().optional(),
  mount: z.string().optional(),
  // cost_gate
  budget_usd: z.number().optional(),
  action: z.string().optional(),
  // ast_parse
  extract: z.array(z.string()).optional(),
  // embed_compare
  text_a: z.string().optional(),
  text_b: z.string().optional(),
  // graph_query
  triples: z.array(z.object({ subject: z.string(), predicate: z.string(), object: z.string() })).optional(),
  graph_query_subject: z.string().optional(),
  graph_query_predicate: z.string().optional(),
  // parallel_fetch
  urls: z.array(z.string()).optional(),
  rate_limit_ms: z.number().optional(),
  // template_render
  template: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  // approval_request
  title: z.string().optional(),
  description: z.string().optional(),
  expires_hours: z.number().optional(),
  // image_generate
  image_provider: z.enum(["openai", "huggingface", "stability"]).optional(),
  image_model: z.string().optional(),
  image_size: z.string().optional(),
  image_quality: z.string().optional(),
  image_style: z.string().optional(),
  negative_prompt: z.string().optional(),
  image_format: z.enum(["png", "jpeg", "webp"]).optional(),
  // Error handling
  on_error: z.enum(["inject", "skip", "fail"]).optional(),
  // Timeout & retry
  timeout_ms: z.number().optional(),
  retry: z.number().optional(),
  // Caching
  cache_ttl_minutes: z.number().optional(),
  // Execution mode
  parallel: z.boolean().optional(),
});

const StepSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["agent", "router", "gate", "evaluator", "transform", "loop", "merge", "browser", "subchain", "debate", "webhook", "image_gen"]).optional(),
  label: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string().min(1),
  tools: z.array(z.string()).optional().default([]),
  depends_on: z.array(z.string()).optional().default([]),
  output_var: z.string().min(1),
  cwd: z.string().optional(),
  pre_tools: z.array(PreToolSchema).optional(),
  condition: z.string().optional(),
  retry: z.object({
    max: z.number(),
    delay_ms: z.number().optional(),
    backoff: z.number().optional(),
  }).optional(),
  fallback_models: z.array(z.string()).optional(),
  routes: z.record(z.string(), z.array(z.string())).optional(),
  default_route: z.string().optional(),
  timeout_hours: z.number().optional(),
  on_timeout: z.enum(["skip", "error", "approve"]).optional(),
  input_var: z.string().optional(),
  criteria: z.string().optional(),
  on_fail: z.enum(["retry", "skip", "error", "continue"]).optional(),
  max_retries: z.number().optional(),
  retry_target: z.string().optional(),
  operation: z.enum(["json_extract", "regex_match", "template", "split", "merge", "truncate", "replace", "filter", "map", "join", "to_json", "from_json"]).optional(),
  json_path: z.string().optional(),
  regex: z.string().optional(),
  template_str: z.string().optional(),
  items_var: z.string().optional(),
  max_parallel: z.number().optional(),
  inputs: z.union([z.array(z.string()), z.record(z.string())]).optional(),
  strategy: z.enum(["concatenate", "json_array", "llm_summarize", "pick_best", "consensus", "vote"]).optional(),
  browser_url: z.string().optional(),
  browser_task: z.string().optional(),
  browser_max_steps: z.number().optional(),
  browser_headless: z.boolean().optional(),
  browser_port: z.number().optional(),
  browser_viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  browser_wait_ms: z.number().optional(),
  browser_output_format: z.enum(["text", "markdown", "json", "screenshot"]).optional(),
  browser_page_name: z.string().optional(),
  browser_scroll_strategy: z.enum(["auto", "full", "none"]).optional(),
  browser_cookies_domain: z.string().optional(),
  context_strategy: z.record(z.string(), z.string()).optional(),
  // Caching
  cache: z.object({
    enabled: z.boolean(),
    ttl_minutes: z.number().optional(),
  }).optional(),
  // Output validation
  output_schema: z.enum(["json", "markdown", "text"]).optional(),
  output_must_contain: z.array(z.string()).optional(),
  output_must_not_contain: z.array(z.string()).optional(),
  output_max_length: z.number().optional(),
  // Per-step timeout
  timeout_ms: z.number().optional(),
  // Subchain
  subchain: z.string().optional(),
  chain: z.string().optional(),      // alias for subchain
  url: z.string().optional(),        // alias for webhook_url
  subchain_input_map: z.record(z.string(), z.string()).optional(),
  // Debate
  debate_agents: z.array(z.object({ prompt: z.string(), model: z.string().optional() })).optional(),
  debate_rounds: z.number().optional(),
  debate_decision: z.enum(["voting", "consensus", "last_round"]).optional(),
  // Webhook
  webhook_url: z.string().optional(),
  webhook_method: z.enum(["POST", "PUT", "PATCH", "GET", "DELETE"]).optional(),
  webhook_headers: z.record(z.string(), z.string()).optional(),
  webhook_body: z.string().optional(),
  webhook_timeout_ms: z.number().optional(),
  webhook_retry: z.number().optional(),
  webhook_success_status: z.array(z.number()).optional(),
  // Early exit
  early_exit_if: z.string().optional(),
  // Transform extras
  truncate_limit: z.number().optional(),
  // Loop improvements
  loop_until: z.string().optional(),
  loop_on_error: z.enum(["continue", "abort"]).optional(),
  // Gate improvements
  gate_actions: z.array(z.string()).optional(),
  gate_rejection_reason: z.boolean().optional(),
  gate_auto_approve_if: z.string().optional(),
  // Evaluator improvements
  eval_scoring: z.boolean().optional(),
  eval_threshold: z.number().optional(),
  guardrails: z.array(z.object({
    type: z.enum(["max_length", "min_length", "must_contain", "must_not_contain", "regex_match", "json_valid"]),
    value: z.union([z.string(), z.number()]).optional(),
  })).optional(),
});

const ChainSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  inputs: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        optional: z.boolean().optional().default(false),
      })
    )
    .optional()
    .default([]),
  steps: z.array(StepSchema).min(1),
  output: z.string().min(1),
  max_context_chars: z.number().optional(),
});

// ─── Loader ───────────────────────────────────────────────────────────────────

export function getChainsDir(): string {
  if (process.env.CHAINS_DIR) return process.env.CHAINS_DIR;
  // Resolve relative to this file's location (mcp-server/src/ or mcp-server/dist/)
  // mcp-server/dist/loader.js → ../../chains  (project root)
  // Use fileURLToPath to correctly decode %20 → spaces in paths
  const fileDir = path.dirname(fileURLToPath(import.meta.url));
  // Try: go up to mcp-server/, then up to project root, then /chains
  const fromFile = path.resolve(fileDir, "..", "..", "chains");
  if (fs.existsSync(fromFile)) return fromFile;
  // Fallback: relative to cwd
  const fromCwd = path.join(process.cwd(), "chains");
  if (fs.existsSync(fromCwd)) return fromCwd;
  return fromCwd;
}

/** Sanitize a chain/pipeline name to prevent path traversal */
export function sanitizeName(name: string): string {
  // Strip directory separators, null bytes, and path traversal patterns
  const clean = name.replace(/[\/\\:*?"<>|\x00]/g, '').replace(/\.\./g, '');
  if (!clean || clean !== name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(clean)) {
    throw new Error(`Invalid name: "${name}" — only alphanumeric, dash, underscore, dot allowed`);
  }
  return clean;
}

export function listChains(): string[] {
  const dir = getChainsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => path.basename(f, path.extname(f)));
}

export function loadChain(name: string): ChainDefinition {
  const safeName = sanitizeName(name);
  const dir = getChainsDir();
  const candidates = [
    path.join(dir, `${safeName}.yaml`),
    path.join(dir, `${safeName}.yml`),
  ];
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    throw new Error(`Chain "${name}" not found in ${dir}`);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = yaml.load(raw);
  const result = ChainSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid chain "${name}":\n${issues}`);
  }
  return result.data as ChainDefinition;
}

export function saveChain(name: string, chain: ChainDefinition): void {
  const safeName = sanitizeName(name);
  const dir = getChainsDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${safeName}.yaml`);
  const content = yaml.dump(chain, { lineWidth: 120, quotingType: '"' });
  fs.writeFileSync(filePath, content, "utf-8");
}

export function deleteChain(name: string): void {
  const safeName = sanitizeName(name);
  const dir = getChainsDir();
  const candidates = [
    path.join(dir, `${safeName}.yaml`),
    path.join(dir, `${safeName}.yml`),
  ];
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) throw new Error(`Chain "${name}" not found`);
  fs.unlinkSync(filePath);
}

export function loadChainRaw(name: string): string {
  const safeName = sanitizeName(name);
  const dir = getChainsDir();
  const candidates = [
    path.join(dir, `${safeName}.yaml`),
    path.join(dir, `${safeName}.yml`),
  ];
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) throw new Error(`Chain "${name}" not found`);
  return fs.readFileSync(filePath, "utf-8");
}

// ─── Dependency graph ─────────────────────────────────────────────────────────

export interface DependencyGraph {
  /** Steps grouped by execution wave (each wave can run in parallel) */
  waves: string[][];
}

export function buildDependencyGraph(chain: ChainDefinition): DependencyGraph {
  const stepIds = new Set(chain.steps.map((s) => s.id));

  // Validate all depends_on references exist
  for (const step of chain.steps) {
    for (const dep of step.depends_on ?? []) {
      if (!stepIds.has(dep)) {
        throw new Error(
          `Step "${step.id}" depends on unknown step "${dep}"`
        );
      }
    }
  }

  // Validate output var exists
  const outputVars = new Set(chain.steps.map((s) => s.output_var));
  if (!outputVars.has(chain.output)) {
    throw new Error(
      `Chain output "${chain.output}" does not match any step output_var`
    );
  }

  // Topological sort into waves using Kahn's algorithm
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep → steps that need it

  for (const step of chain.steps) {
    inDegree.set(step.id, step.depends_on?.length ?? 0);
    for (const dep of step.depends_on ?? []) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(step.id);
    }
  }

  const waves: string[][] = [];
  const remaining = new Set(chain.steps.map((s) => s.id));

  while (remaining.size > 0) {
    const wave = [...remaining].filter((id) => (inDegree.get(id) ?? 0) === 0);
    if (wave.length === 0) {
      throw new Error(
        `Circular dependency detected among steps: ${[...remaining].join(", ")}`
      );
    }
    waves.push(wave);
    for (const id of wave) {
      remaining.delete(id);
      for (const dependent of dependents.get(id) ?? []) {
        inDegree.set(dependent, (inDegree.get(dependent) ?? 1) - 1);
      }
    }
  }

  return { waves };
}
