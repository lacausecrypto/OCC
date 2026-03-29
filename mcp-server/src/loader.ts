import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { z } from "zod";
import type { ChainDefinition } from "./types.js";

// ─── Validation schema ────────────────────────────────────────────────────────

const PreToolSchema = z.object({
  type: z.enum(["current_datetime", "http_fetch", "web_search", "read_file", "write_file", "bash", "env_var"]),
  inject_as: z.string().min(1),
  label: z.string().optional(),
  url: z.string().optional(),
  query: z.string().optional(),
  path: z.string().optional(),
  content: z.string().optional(),
  command: z.string().optional(),
  var_name: z.string().optional(),
});

const StepSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["agent", "router", "gate", "evaluator", "transform", "loop", "merge", "browser", "subchain", "debate", "webhook"]).optional(),
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
  on_fail: z.enum(["retry", "skip", "error"]).optional(),
  max_retries: z.number().optional(),
  retry_target: z.string().optional(),
  operation: z.enum(["json_extract", "regex_match", "template", "split", "merge", "truncate", "replace", "filter", "map", "join", "to_json", "from_json"]).optional(),
  json_path: z.string().optional(),
  regex: z.string().optional(),
  template_str: z.string().optional(),
  items_var: z.string().optional(),
  max_parallel: z.number().optional(),
  inputs: z.array(z.string()).optional(),
  strategy: z.enum(["concatenate", "json_array", "llm_summarize", "pick_best"]).optional(),
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
  subchain_input_map: z.record(z.string(), z.string()).optional(),
  // Debate
  debate_agents: z.array(z.object({ prompt: z.string(), model: z.string().optional() })).optional(),
  debate_rounds: z.number().optional(),
  debate_decision: z.enum(["voting", "consensus", "last_round"]).optional(),
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
});

// ─── Loader ───────────────────────────────────────────────────────────────────

export function getChainsDir(): string {
  return process.env.CHAINS_DIR ?? path.join(process.cwd(), "..", "chains");
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
  const dir = getChainsDir();
  const candidates = [
    path.join(dir, `${name}.yaml`),
    path.join(dir, `${name}.yml`),
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
  const dir = getChainsDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.yaml`);
  const content = yaml.dump(chain, { lineWidth: 120, quotingType: '"' });
  fs.writeFileSync(filePath, content, "utf-8");
}

export function deleteChain(name: string): void {
  const dir = getChainsDir();
  const candidates = [
    path.join(dir, `${name}.yaml`),
    path.join(dir, `${name}.yml`),
  ];
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) throw new Error(`Chain "${name}" not found`);
  fs.unlinkSync(filePath);
}

export function loadChainRaw(name: string): string {
  const dir = getChainsDir();
  const candidates = [
    path.join(dir, `${name}.yaml`),
    path.join(dir, `${name}.yml`),
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
  let remaining = new Set(chain.steps.map((s) => s.id));

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
