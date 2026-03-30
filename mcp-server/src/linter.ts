/**
 * Chain linter — validates chains beyond Zod schema.
 * Catches: undefined variable refs, unreachable steps, unused outputs,
 * missing pre-tool fields, router route refs, evaluator targets, and more.
 */
import type { ChainDefinition, ChainStep } from "./types.js";
import { buildDependencyGraph } from "./loader.js";

export interface LintIssue {
  level: "error" | "warning" | "info";
  stepId?: string;
  message: string;
}

/** Extract all {variable} references from a string. */
function extractVarRefs(text: string): string[] {
  const matches = text.match(/\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/g) ?? [];
  return matches.map((m) => m.slice(1, -1));
}

export function lintChain(chain: ChainDefinition): LintIssue[] {
  const issues: LintIssue[] = [];
  const stepIds = new Set(chain.steps.map((s) => s.id));
  const outputVars = new Set(chain.steps.map((s) => s.output_var));
  const inputNames = new Set((chain.inputs ?? []).map((i) => i.name));

  // ── 1. Dependency graph validity ──────────────────────────────
  try {
    buildDependencyGraph(chain);
  } catch (err) {
    issues.push({ level: "error", message: (err as Error).message });
  }

  // ── 2. Output var matches a step ──────────────────────────────
  if (!outputVars.has(chain.output)) {
    issues.push({
      level: "error",
      message: `Chain output "${chain.output}" does not match any step's output_var`,
    });
  }

  // ── 3. Duplicate step IDs ─────────────────────────────────────
  const seenIds = new Set<string>();
  for (const step of chain.steps) {
    if (seenIds.has(step.id)) {
      issues.push({ level: "error", stepId: step.id, message: `Duplicate step ID "${step.id}"` });
    }
    seenIds.add(step.id);
  }

  // ── 4. Per-step validation ────────────────────────────────────
  for (const step of chain.steps) {
    // 4a. Check depends_on refs exist
    for (const dep of step.depends_on ?? []) {
      if (!stepIds.has(dep)) {
        issues.push({ level: "error", stepId: step.id, message: `depends_on "${dep}" does not exist` });
      }
    }

    // 4b. Check variable references in prompt
    const allVarRefs = extractVarRefs(step.prompt);
    for (const ref of allVarRefs) {
      const isInput = ref.startsWith("input.") ? inputNames.has(ref.replace("input.", "")) : false;
      const isInputShort = inputNames.has(ref);
      const isOutputVar = outputVars.has(ref);
      const isPreTool = (step.pre_tools ?? []).some((pt) => pt.inject_as === ref);
      const isBuiltin = ["item", "today", "now"].includes(ref);

      if (!isInput && !isInputShort && !isOutputVar && !isPreTool && !isBuiltin) {
        issues.push({
          level: "warning",
          stepId: step.id,
          message: `Variable "{${ref}}" may be undefined — not found in inputs, step outputs, or pre_tools`,
        });
      }
    }

    // 4c. Router: check route targets exist
    if (step.type === "router" && step.routes) {
      for (const [route, targets] of Object.entries(step.routes)) {
        for (const target of targets) {
          if (!stepIds.has(target)) {
            issues.push({
              level: "error",
              stepId: step.id,
              message: `Route "${route}" references unknown step "${target}"`,
            });
          }
        }
      }
    }

    // 4d. Evaluator: check retry_target exists
    if (step.type === "evaluator" && step.retry_target) {
      if (!stepIds.has(step.retry_target)) {
        issues.push({
          level: "error",
          stepId: step.id,
          message: `retry_target "${step.retry_target}" does not exist`,
        });
      }
    }

    // 4e. Evaluator: check input_var is reachable
    if (step.type === "evaluator" && step.input_var) {
      if (!outputVars.has(step.input_var) && !inputNames.has(step.input_var)) {
        issues.push({
          level: "warning",
          stepId: step.id,
          message: `input_var "${step.input_var}" is not a known output_var or input`,
        });
      }
    }

    // 4f. Merge: check inputs reference valid vars
    if (step.type === "merge" && step.inputs) {
      for (const input of step.inputs) {
        if (!outputVars.has(input) && !inputNames.has(input)) {
          issues.push({
            level: "warning",
            stepId: step.id,
            message: `Merge input "${input}" is not a known output_var`,
          });
        }
      }
    }

    // 4g. Webhook: check url is provided
    if (step.type === "webhook" && !step.webhook_url) {
      issues.push({ level: "error", stepId: step.id, message: `Webhook step missing "webhook_url"` });
    }

    // 4h. Subchain: check subchain name is provided
    if (step.type === "subchain" && !step.subchain) {
      issues.push({
        level: "error",
        stepId: step.id,
        message: `Subchain step is missing "subchain" field`,
      });
    }

    // 4h. Pre-tool field validation
    for (const pt of step.pre_tools ?? []) {
      if (pt.type === "web_search" && !pt.query) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool web_search missing "query"` });
      }
      if (pt.type === "http_fetch" && !pt.url) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool http_fetch missing "url"` });
      }
      if (pt.type === "read_file" && !pt.path) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool read_file missing "path"` });
      }
      if (pt.type === "bash" && !pt.command) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool bash missing "command"` });
      }
      if (pt.type === "env_var" && !pt.var_name) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool env_var missing "var_name"` });
      }
      if (pt.type === "write_file" && (!pt.path || !pt.content)) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool write_file missing "path" or "content"` });
      }
      if (pt.type === "mcp_call" && !pt.server) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool mcp_call missing "server"` });
      }
      if (pt.type === "mcp_call" && !pt.tool) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool mcp_call missing "tool"` });
      }
      // db_query validation
      if (pt.type === "db_query" && !pt.connection) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool db_query missing "connection"` });
      }
      if (pt.type === "db_query" && !pt.sql) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool db_query missing "sql"` });
      }
      // email validation
      if (pt.type === "email" && !pt.to) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool email missing "to"` });
      }
      if (pt.type === "email" && !pt.subject) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool email missing "subject"` });
      }
      // pdf_generate validation
      if (pt.type === "pdf_generate" && !pt.html && !pt.content) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool pdf_generate missing "html" or "content"` });
      }
      // ocr validation
      if (pt.type === "ocr" && !pt.image_path && !pt.path) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool ocr missing "image_path"` });
      }
      // state_load / state_save validation
      if ((pt.type === "state_load" || pt.type === "state_save") && !pt.key) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool ${pt.type} missing "key"` });
      }
      if (pt.type === "state_save" && !pt.value) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool state_save missing "value"` });
      }
      // vector_query / vector_index validation
      if (pt.type === "vector_query" && !pt.collection) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool vector_query missing "collection"` });
      }
      if (pt.type === "vector_index" && (!pt.collection || !pt.source)) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool vector_index missing "collection" or "source"` });
      }
      // json_parse validation
      if (pt.type === "json_parse" && !pt.input) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool json_parse missing "input"` });
      }
      // diff_inject validation
      if (pt.type === "diff_inject" && !pt.repo) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool diff_inject missing "repo"` });
      }
      // notify validation
      if (pt.type === "notify" && !pt.channel) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool notify missing "channel"` });
      }
      if (pt.type === "notify" && !pt.message) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool notify missing "message"` });
      }
      // screenshot validation
      if (pt.type === "screenshot" && !pt.url) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool screenshot missing "url"` });
      }
      // sandbox_exec validation
      if (pt.type === "sandbox_exec" && !pt.image) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool sandbox_exec missing "image"` });
      }
      if (pt.type === "sandbox_exec" && !pt.command) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool sandbox_exec missing "command"` });
      }
      // cost_gate validation
      if (pt.type === "cost_gate" && !pt.budget_usd) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool cost_gate missing "budget_usd"` });
      }
      // embed_compare validation
      if (pt.type === "embed_compare" && (!pt.text_a || !pt.text_b)) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool embed_compare missing "text_a" or "text_b"` });
      }
      // parallel_fetch validation
      if (pt.type === "parallel_fetch" && (!pt.urls || pt.urls.length === 0)) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool parallel_fetch missing "urls"` });
      }
      // template_render validation
      if (pt.type === "template_render" && !pt.template) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool template_render missing "template"` });
      }
      // graph_query validation
      if (pt.type === "graph_query" && !pt.triples && !pt.graph_query_subject) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool graph_query needs "triples" (write) or "graph_query_subject" (read)` });
      }
      // ast_parse validation
      if (pt.type === "ast_parse" && !pt.path) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool ast_parse missing "path"` });
      }
      // approval_request validation
      if (pt.type === "approval_request" && !pt.title) {
        issues.push({ level: "error", stepId: step.id, message: `Pre-tool approval_request missing "title"` });
      }
      // Validate http_fetch URL format
      if (pt.type === "http_fetch" && pt.url && !pt.url.includes("{")) {
        try { new URL(pt.url); }
        catch { issues.push({ level: "warning", stepId: step.id, message: `http_fetch URL may be invalid: "${pt.url}"` }); }
      }
      // Validate http_fetch body only with POST/PUT/PATCH
      if (pt.type === "http_fetch" && pt.body && (pt.method === "GET" || pt.method === "DELETE")) {
        issues.push({ level: "warning", stepId: step.id, message: `http_fetch body ignored for ${pt.method} requests` });
      }
    }
  }

  // ── 5. Unreachable steps (not in dependency graph output) ─────
  try {
    const graph = buildDependencyGraph(chain);
    const reachable = new Set(graph.waves.flat());
    for (const step of chain.steps) {
      if (!reachable.has(step.id)) {
        issues.push({
          level: "warning",
          stepId: step.id,
          message: `Step "${step.id}" is unreachable (not in any execution wave)`,
        });
      }
    }
  } catch {
    // Already reported by graph validation above
  }

  // ── 6. Unused output_vars ─────────────────────────────────────
  const referencedVars = new Set<string>();
  referencedVars.add(chain.output); // The chain output is always "used"
  for (const step of chain.steps) {
    const refs = extractVarRefs(step.prompt);
    for (const ref of refs) referencedVars.add(ref);
    // Check depends_on steps' output_vars
    if (step.type === "merge" && step.inputs) {
      for (const input of step.inputs) referencedVars.add(input);
    }
    if (step.type === "evaluator" && step.input_var) {
      referencedVars.add(step.input_var);
    }
    // Check pre_tool queries
    for (const pt of step.pre_tools ?? []) {
      for (const field of [pt.query, pt.url, pt.path, pt.content, pt.command, pt.body, pt.connection, pt.sql, pt.to, pt.subject, pt.html, pt.output_path, pt.image_path, pt.key, pt.value, pt.source, pt.input, pt.repo, pt.message, pt.webhook_url, pt.text_a, pt.text_b, pt.template, pt.title, pt.description, pt.mount, pt.image]) {
        if (field) for (const ref of extractVarRefs(field)) referencedVars.add(ref);
      }
      if (pt.headers) {
        for (const v of Object.values(pt.headers)) {
          for (const ref of extractVarRefs(v)) referencedVars.add(ref);
        }
      }
    }
    // Condition and loop
    if (step.condition) for (const ref of extractVarRefs(step.condition)) referencedVars.add(ref);
    if (step.early_exit_if) for (const ref of extractVarRefs(step.early_exit_if)) referencedVars.add(ref);
    if (step.loop_until) for (const ref of extractVarRefs(step.loop_until)) referencedVars.add(ref);
    if (step.items_var) referencedVars.add(step.items_var);
    // Evaluator criteria
    if (step.criteria) for (const ref of extractVarRefs(step.criteria)) referencedVars.add(ref);
    // Subchain input map
    if (step.subchain_input_map) {
      for (const val of Object.values(step.subchain_input_map)) {
        for (const ref of extractVarRefs(val)) referencedVars.add(ref);
      }
    }
    // Gate auto-approve condition
    if (step.gate_auto_approve_if) for (const ref of extractVarRefs(step.gate_auto_approve_if)) referencedVars.add(ref);
    // Transform fields
    if (step.template_str) for (const ref of extractVarRefs(step.template_str)) referencedVars.add(ref);
    // Webhook fields
    if (step.webhook_url) for (const ref of extractVarRefs(step.webhook_url)) referencedVars.add(ref);
    if (step.webhook_body) for (const ref of extractVarRefs(step.webhook_body)) referencedVars.add(ref);
    if (step.webhook_headers) {
      for (const v of Object.values(step.webhook_headers)) {
        for (const ref of extractVarRefs(v)) referencedVars.add(ref);
      }
    }
  }

  for (const step of chain.steps) {
    if (!referencedVars.has(step.output_var) && step.output_var !== chain.output) {
      issues.push({
        level: "info",
        stepId: step.id,
        message: `output_var "${step.output_var}" is never referenced by other steps`,
      });
    }
  }

  return issues;
}

/** Dry-run a chain: resolve variables, show execution plan, no LLM calls. */
export function dryRunChain(
  chain: ChainDefinition,
  input: Record<string, string>
): {
  issues: LintIssue[];
  plan: Array<{ wave: number; stepId: string; label: string; model: string; dependsOn: string[]; promptPreview: string }>;
  estimatedCost: { totalSteps: number; parallelWaves: number; models: Record<string, number> };
} {
  const issues = lintChain(chain);

  // Validate inputs
  for (const inputDef of chain.inputs ?? []) {
    if (!inputDef.optional && input[inputDef.name] === undefined) {
      issues.push({
        level: "error",
        message: `Missing required input: "${inputDef.name}"`,
      });
    }
  }

  // Build dependency graph
  let waves: string[][] = [];
  try {
    const graph = buildDependencyGraph(chain);
    waves = graph.waves;
  } catch {
    // Errors already captured in lint
  }

  // Resolve variables for preview
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    vars[`input.${k}`] = v;
    vars[k] = v;
  }

  // Mark step outputs as placeholders
  for (const step of chain.steps) {
    vars[step.output_var] = `<output of ${step.id}>`;
    for (const pt of step.pre_tools ?? []) {
      vars[pt.inject_as] = `<${pt.type}: ${pt.query || pt.url || pt.path || pt.command || pt.var_name || "data"}>`;
    }
  }

  // Build execution plan
  const plan: Array<{ wave: number; stepId: string; label: string; model: string; dependsOn: string[]; promptPreview: string }> = [];
  const models: Record<string, number> = {};

  for (let w = 0; w < waves.length; w++) {
    for (const stepId of waves[w]) {
      const step = chain.steps.find((s) => s.id === stepId)!;
      const model = step.model || "claude-sonnet-4-6";

      // Resolve prompt preview
      let preview = step.prompt;
      for (const [k, v] of Object.entries(vars)) {
        preview = preview.replace(new RegExp(`\\{${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}`, "g"), v);
      }
      // Truncate for display
      preview = preview.length > 200 ? preview.slice(0, 200) + "..." : preview;

      models[model] = (models[model] || 0) + 1;
      plan.push({
        wave: w + 1,
        stepId,
        label: step.label || step.id,
        model,
        dependsOn: step.depends_on || [],
        promptPreview: preview,
      });
    }
  }

  return {
    issues,
    plan,
    estimatedCost: {
      totalSteps: chain.steps.length,
      parallelWaves: waves.length,
      models,
    },
  };
}
